import {
  Component, ElementRef, Input, OnDestroy, OnInit, ViewChild, computed, effect,
  inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { MatrixService, firstStateEvent } from '../matrix.service';
import {
  Chat3dState, Chat3dStateService, parseChat3dState, CHAT3D_STATE_TYPE, LEGACY_CHAT3D_STATE_TYPES,
} from './chat3d-state.service';
import { Chat3dSceneService, Chat3dPlacement } from './chat3d-scene.service';
import { Chat3dAvatarService, Chat3dAvatarState } from './chat3d-avatar.service';
import {
  GAMES_BASE_URL, GameMessage, HostEnvelope, MAX_MEDIA_BYTES, chat3dFrameUrl, hostMsg,
  mxidLocalpart, originAllowed, parseGameMessage, RosterEntry,
} from './chat3d-bridge';
import { MeshCallService } from './mesh-call.service';
import { FaceTrackService } from './face-track.service';
import { blendshapesToBase64 } from './av-channel';
import { RoomMediaPanelComponent } from './room-media-panel.component';
import { Chat3dStageService } from './chat3d-stage.service';
import { DEFAULT_EXPRESSION, Expression, expressionForEvent } from '../vn/expression';

/** Cadence of the room-state poll feeding the game (matches the 1Hz
 *  matrix-call pump precedent — room state is SLOW config, not motion). */
export const CHAT3D_POLL_MS = 1_000;

/**
 * How many recent timeline events the expression pass scans per poll. It only
 * needs the NEWEST message per participant, and the room caps at 16 of them, so
 * a short window is enough: a member who has not spoken inside it simply
 * resolves to `neutral`, which is what their avatar already wears.
 */
export const EXPRESSION_SCAN_LIMIT = 30;

/** LIMIT: most placement texture byte-buffers cached (11 surfaces exist;
 *  a few re-placements should not grow the cache unboundedly). */
export const MAX_TEXTURE_CACHE = 24;

/** LIMIT: distinct (call, subject) slots held while waiting for the game's
 *  `ready` handshake. 12 call types × 16 avatars + 11 surfaces fits well
 *  inside this; the cap is the backstop against a handshake that never comes. */
export const MAX_QUEUED_ENVELOPES = 256;

/**
 * LIMIT: participants pushed into the game per poll. The room cap tops out at
 * 16 (CHAT3D_MAX_PARTICIPANTS), so 32 never clips honest use — but the avatar
 * roster is derived from ROOM STATE, and a huge channel where hundreds of
 * members once opened the 3D view would otherwise push hundreds of ≤8KB avatar
 * envelopes into the iframe on the first tick. Selection is the sorted-mxid
 * prefix so every client picks the SAME set (plus its own row, always).
 */
export const MAX_ROSTER_ENTRIES = 32;

/**
 * What a member already INSIDE the room is told when a moderator switches the
 * 3D room off. It names the kill switch's real effect — the A/V legs are torn
 * down, not merely "nothing more will load" — because that is what actually
 * happens (see {@link Chat3dHostComponent.pollOnce}).
 */
export const DISABLED_NOTE =
  'The 3D room has been disabled in this channel. Your microphone, camera and voice '
  + 'connections have been shut down. You can leave this view — nothing more will load.';

/**
 * Texture bytes → the base64 string the §5 `placeMedia(…, pngBase64)` call
 * carries. Chunked so a multi-hundred-KB image cannot blow the argument limit
 * of `String.fromCharCode(...spread)`.
 */
export function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Hosts the embedded "Shadows of the Net" 3D room: an iframe onto the
 * hugmesh-games wasm bundle (`mode=matrix` — the game does NO Matrix/games
 * I/O of its own in this mode) plus the host side of the versioned §5
 * postMessage bridge. This component is the game's ONLY window onto the room:
 *
 *   - on join it publishes MY avatar snapshot as room state, then
 *   - polls the room state at {@link CHAT3D_POLL_MS} (single roomState fetch
 *     per tick feeding the enabled-check, the MODERATED scene read, the avatar
 *     roster and the stage grant) and pushes diffs into the game (roster/avatar/
 *     placeMedia/clearMedia/stage — image placements carry REAL texture bytes,
 *     video placements their poster frame),
 *   - derives each participant's face `expression` from their newest timeline
 *     message on the same tick (the 2D VN stage's `expressionForEvent` signal),
 *   - joins the {@link MeshCallService} A/V mesh (voice + the `chat3d` data
 *     channel) and relays: peers' poses/openness/blendshapes/speaking INTO
 *     the game, my localPose/blendshapes OUT to the peers,
 *   - starts opt-in camera {@link FaceTrackService} when the join menu asked
 *     for it — the local 52-float vector drives my avatar's face in the game
 *     AND the quantized peer broadcast,
 *   - relays validated game callbacks out (localPose → the pose broadcast;
 *     vrState drives the VR badge; mediaActivate highlights the placement in
 *     the channel-media panel).
 *
 * TRUST BOUNDARY: every inbound message must pass the games-origin allow-list
 * AND come from the embedded frame's own contentWindow, then survives
 * {@link parseGameMessage}'s clamps; every outbound postMessage pins the games
 * origin as targetOrigin (never '*'). The iframe carries
 * `allow="xr-spatial-tracking; microphone; camera; autoplay"` and deliberately
 * NO sandbox attribute — Godot needs full script/wasm execution, and the
 * origin separation (games origin ≠ our origin) is the isolation boundary.
 *
 * CAPABILITY HONESTY (turnAvailable-note precedent): every dark/degraded leg
 * says WHY — no TURN relay (host/LAN-only voice), refused mic (listen-only),
 * refused camera / failed tracker (amplitude fallback), mesh strain (≥8), and
 * a full mesh (not admitted).
 */
@Component({
  selector: 'hug-chat3d-host',
  standalone: true,
  imports: [CommonModule, RouterLink, RoomMediaPanelComponent],
  templateUrl: './chat3d-host.component.html',
  styleUrl: './chat3d-host.component.scss',
})
export class Chat3dHostComponent implements OnInit, OnDestroy {
  private readonly matrix = inject(MatrixService);
  private readonly chat3dState = inject(Chat3dStateService);
  private readonly scene = inject(Chat3dSceneService);
  private readonly avatars = inject(Chat3dAvatarService);
  private readonly stageGrants = inject(Chat3dStageService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly gamesBase = inject(GAMES_BASE_URL);
  readonly mesh = inject(MeshCallService);
  readonly faceTrack = inject(FaceTrackService);

  /** The Matrix room this 3D view belongs to. */
  @Input({ required: true }) roomId!: string;
  /** MY published appearance (built by the join menu). */
  @Input({ required: true }) avatar!: Chat3dAvatarState;
  /** Join-menu mic choice — drives the A/V mesh's audio leg. */
  @Input() micEnabled = false;
  /** Join-menu camera-tracking choice — starts the opt-in face tracker. */
  @Input() cameraEnabled = false;

  @ViewChild('gameFrame') frame?: ElementRef<HTMLIFrameElement>;

  /** True once the game shim's `ready` handshake arrived (queue flushed). */
  readonly ready = signal(false);
  /** True while the game reports an active WebXR/OpenXR session. */
  readonly vrActive = signal(false);
  /** Non-empty when the room's chat3d state stopped parsing enabled. */
  readonly disabledNote = signal('');
  /** Non-empty when publishing MY avatar state failed (others see a silhouette). */
  readonly avatarNote = signal('');
  /** Label of the last surface the user activated in-scene ('' = none). */
  readonly activatedLabel = signal('');
  /** The activated placement itself (the channel-media panel highlights it). */
  readonly activatedPlacement = signal<Chat3dPlacement | null>(null);
  /** The latest parsed room config (the media panel's gating input). */
  readonly config = signal<Chat3dState | null>(null);
  /** Whether the channel-media panel is shown. */
  readonly mediaPanelOpen = signal(false);
  /** Who currently holds the spotlit stage platform ('' = nobody). */
  readonly stageHolder = signal('');
  /** Whether I may write the stage grant in this room (moderator, or any member
   *  when the room turned `stageModOnly` off) — the button's gate. */
  readonly mayDriveStage = signal(false);
  /** True while I am the stage holder (the button flips to "Leave the stage"). */
  readonly onStage = computed(() => !!this.myUserId() && this.stageHolder() === this.myUserId());
  /** WHY-helptext when the stage control is greyed (never hidden). */
  readonly stageHelp = computed(() => (this.mayDriveStage()
    ? ''
    : 'The stage spotlight is moderator-only in this room (stageModOnly) — a moderator can hand it over.'));

  /**
   * The honest A/V capability notes (one per dark/degraded leg, all visible
   * at once when several apply — turnAvailable precedent).
   */
  readonly avNotes = computed<string[]>(() => {
    const notes: string[] = [];
    if (!this.mesh.active()) {
      return notes;
    }
    if (!this.mesh.admitted()) {
      notes.push('The A/V mesh is full for this room — you can watch, but voice and live motion are off until a seat frees up.');
    }
    if (this.micEnabled && this.mesh.micNote()) {
      notes.push(this.mesh.micNote());
    }
    if (!this.mesh.turnAvailable()) {
      notes.push('Voice is host/LAN-only until a TURN relay is configured.');
    }
    if (this.mesh.meshWarning()) {
      notes.push('Large room: voice runs peer-to-peer and strains beyond 8 participants — expect degraded audio.');
    }
    if (this.mesh.staleInviteNote()) {
      notes.push(this.mesh.staleInviteNote());
    }
    if (this.cameraEnabled && this.faceTrack.note()) {
      notes.push(this.faceTrack.note());
    }
    return notes;
  });

  /** The games origin every message is checked/pinned against. */
  readonly gamesOrigin = new URL(this.gamesBase).origin;
  /** OUR origin, handed to the game as `?origin=` so its in-frame shim knows
   *  which parent it may talk to (see {@link chat3dFrameUrl}). */
  readonly hostOrigin = globalThis.location?.origin ?? '';
  /** The iframe URL (games wasm bundle in matrix mode). Trusted-resource-
   *  wrapped ONCE from config — never from user/room input. */
  readonly frameSrc: SafeResourceUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
    chat3dFrameUrl(this.gamesBase, this.hostOrigin),
  );

  /** My own mxid (whoami), '' until resolved. */
  readonly myUserId = signal('');
  /** The last local pose the game reported — the mesh's pose broadcast reads
   *  this at 10Hz and relays it to every peer. */
  readonly lastLocalPose = signal<{ x: number; z: number; yaw: number; seat: number } | null>(null);

  /**
   * MY live face → the game (the desktop-first acceptance: a webcam-only
   * user sees their OWN avatar blink/look/lip-sync). The mesh broadcasts the
   * same vector to peers on its own 15Hz tick; this effect drives the LOCAL
   * render each time the tracker emits.
   */
  private readonly localFaceEffect = effect(() => {
    const raw = this.faceTrack.blendshapes();
    const me = this.myUserId();
    if (!raw || !me) {
      return;
    }
    const quantized = this.faceTrack.latestQuantized();
    if (quantized) {
      this.send(hostMsg.blendshapes(me, blendshapesToBase64(quantized.values)));
    }
  });

  /**
   * Outbound messages held until the game's `ready` handshake, COALESCED by
   * (type, subject) — every §5 call is an idempotent state-setter, so only the
   * newest value per participant/surface is worth replaying. Without this the
   * queue is unbounded: the pose/openness/blendshapes/speaking ticks alone push
   * tens of envelopes a second per peer for as long as the handshake is
   * missing, and a game that never announces itself grows it for the whole
   * session.
   */
  private readonly outQueue = new Map<string, HostEnvelope>();
  /** Last-pushed placement per surface (JSON) for diffing. */
  private pushedPlacements = new Map<string, string>();
  /** Last-pushed avatar per user (JSON) for diffing. */
  private pushedAvatars = new Map<string, string>();
  /** Last-pushed expression per user (absent = the `neutral` every rig starts on). */
  private pushedExpressions = new Map<string, Expression>();
  /** Last-pushed stage holder ('' = nobody) for diffing. */
  private pushedStage = '';
  /** Last-pushed roster JSON (resent only on change). */
  private pushedRoster = '';
  /** Current placements by surface (for the mediaActivate label lookup). */
  private currentPlacements = new Map<string, Chat3dPlacement>();
  /** Texture bytes per `eventId|kind` (null = fetch failed → label plaque). */
  private readonly textureCache = new Map<string, ArrayBuffer | null>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onMessage = (ev: MessageEvent) => this.handleMessage(ev);

  async ngOnInit(): Promise<void> {
    window.addEventListener('message', this.onMessage);
    // Resolve who I am, then publish my avatar snapshot as room state so every
    // participant (present and future) can dress my character. Fail-soft: a
    // refused publish demotes me to a silhouette on others' screens — say so.
    const me = (await this.matrix.whoami().catch(() => null)) ?? '';
    this.myUserId.set(me);
    if (me) {
      const ok = await this.avatars.publishMyAvatar(this.roomId, me, this.avatar);
      if (!ok) {
        this.avatarNote.set('Could not publish your avatar to the room — other members may see you as a silhouette.');
      }
      this.startAv(me);
    } else {
      this.avatarNote.set('Could not resolve your Matrix identity — other members may see you as a silhouette.');
    }
    this.pollTimer = setInterval(() => void this.pollOnce(), CHAT3D_POLL_MS);
    void this.pollOnce();
  }

  /**
   * Join the A/V mesh (ALWAYS — the `chat3d` data channel is the only pose/
   * face transport in matrix mode, so even a mic-off member needs it to see
   * others move) and start the opt-in camera tracker when asked. Peer traffic
   * relays into the game through the same queue-or-send chokepoint as room
   * state, so nothing is lost before the ready handshake.
   */
  private startAv(me: string): void {
    this.mesh.poseProvider = () => this.lastLocalPose();
    this.mesh.blendshapesProvider = () => this.faceTrack.latestQuantized();
    this.mesh.onPeerPose = (userId, pose) =>
      this.send(hostMsg.pose(userId, pose.x, pose.z, pose.yaw, pose.seat));
    this.mesh.onPeerOpenness = (userId, openness) =>
      this.send(hostMsg.openness(userId, openness));
    this.mesh.onPeerBlendshapes = (userId, values) =>
      this.send(hostMsg.blendshapes(userId, blendshapesToBase64(values)));
    this.mesh.onPeerSpeaking = (userId, speaking) =>
      this.send(hostMsg.speaking(userId, speaking));
    void this.mesh.join(this.roomId, me, { micEnabled: this.micEnabled });
    if (this.cameraEnabled) {
      void this.faceTrack.start();
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onMessage);
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopAv();
    // RETRACT my avatar: without it I stay a 3D participant of this room
    // forever (Matrix keeps the state event), rendering in every scene and
    // holding one of the room's admission seats. Fire-and-forget — ngOnDestroy
    // cannot await, and a failed retract is covered by the receive-side
    // membership bind once I actually leave the channel.
    const me = this.myUserId();
    if (me) {
      void this.avatars.retractMyAvatar(this.roomId, me);
    }
    this.localFaceEffect.destroy();
  }

  /** Tear down every LIVE capture + peer connection (mic, camera, RTCPeer-
   *  Connections, the mesh's timers). Used by both teardown paths: leaving the
   *  view, and the room's 3D setting being switched off under us. */
  private stopAv(): void {
    void this.mesh.leave();
    this.faceTrack.stop();
  }

  /**
   * Blank the game's world and forget every diff baseline. Paired with
   * {@link stopAv} on the moderator kill switch: a disabled room must not keep
   * rendering the roster and the placed channel media, and a later re-enable
   * must re-push the whole world rather than diff against a stale baseline.
   */
  private emptyTheRoom(): void {
    this.send(hostMsg.roster([]));
    for (const surfaceId of this.pushedPlacements.keys()) {
      this.send(hostMsg.clearMedia(surfaceId));
    }
    if (this.pushedStage) {
      this.send(hostMsg.stage(this.pushedStage, false)); // the spotlight goes out too
    }
    this.pushedRoster = '';
    this.pushedAvatars.clear();
    this.pushedExpressions.clear();
    this.pushedStage = '';
    this.stageHolder.set('');
    this.pushedPlacements.clear();
    this.currentPlacements = new Map();
  }

  /**
   * ONE poll tick: a single roomState fetch feeds (a) the enabled check,
   * (b) the moderated scene read, (c) the avatar roster and (d) the mesh's
   * participant/cap inputs; diffs are pushed into the game. Public so specs
   * can await a deterministic tick.
   */
  async pollOnce(): Promise<void> {
    let events;
    try {
      events = await this.matrix.roomState(this.roomId);
    } catch {
      return; // transient — keep the last pushed world
    }
    // Canonical config first, then each pre-rebrand generation (read-only —
    // see LEGACY_CHAT3D_STATE_TYPES): a room enabled under an older branding
    // must still boot its 3D view.
    const config = parseChat3dState(
      firstStateEvent(events, [CHAT3D_STATE_TYPE, ...LEGACY_CHAT3D_STATE_TYPES])?.content,
    );
    this.config.set(config);
    if (!config?.enabled) {
      // KILL SWITCH, not a notice: a moderator switching the 3D room off must
      // actually stop the live capture of everyone already inside. Returning
      // here without this left the mic captured, every RTCPeerConnection open,
      // the pose/blendshapes/openness ticks broadcasting and the m.call.*
      // signalling answering for as long as the tab stayed on the route —
      // while the screen said "nothing more will load".
      //
      // Idempotent: a room that stays disabled must not re-tear-down (and
      // re-push an empty world) on every 1Hz poll.
      if (!this.disabledNote()) {
        this.disabledNote.set(DISABLED_NOTE);
        this.stopAv();
        this.emptyTheRoom();
      }
      return;
    }
    if (this.disabledNote()) {
      // Re-enabled under us: the A/V legs were torn down above, bring them
      // back, and let the diffs below re-push the whole world.
      this.disabledNote.set('');
      const me = this.myUserId();
      if (me) {
        this.startAv(me);
      }
    }
    this.mesh.setMaxParticipants(config.maxParticipants);

    // Avatars + roster (identity-, membership- and sender-bound by the service),
    // capped deterministically — see MAX_ROSTER_ENTRIES.
    const avatarStates = await this.avatars.getAvatarStates(this.roomId, events);
    const me = this.myUserId();
    const keep = new Set(Object.keys(avatarStates).sort().slice(0, MAX_ROSTER_ENTRIES));
    if (me && avatarStates[me]) {
      keep.add(me); // never drop MY OWN row — I must see my own character
    }
    const kept = [...keep].sort().map((userId) => [userId, avatarStates[userId]] as const);
    const roster: RosterEntry[] = kept.map(([userId, s]) => ({
      userId,
      // Fall back to the LOCALPART, not the full mxid: that is the tag the game
      // draws today from the id alone, so the nametag reads the same whether or
      // not the game honours this field (see mxidLocalpart).
      name: s.name || mxidLocalpart(userId),
    }));
    const rosterJson = JSON.stringify(roster);
    if (rosterJson !== this.pushedRoster) {
      this.pushedRoster = rosterJson;
      this.send(hostMsg.roster(roster));
    }
    for (const [userId] of [...this.pushedAvatars]) {
      if (!keep.has(userId)) {
        this.pushedAvatars.delete(userId); // gone from the roster — re-push if they return
      }
    }
    for (const [userId, s] of kept) {
      const json = JSON.stringify(s);
      if (this.pushedAvatars.get(userId) !== json) {
        this.pushedAvatars.set(userId, json);
        // ONLY the §5 signature — `mode`/`sticker`/`name` used to ride along
        // outside it as a "forward-compatible slot for billboard mode". They
        // were never forward-compatible: the game reads either an `args` array
        // or the signature-named fields, so an extra key is invisible to it,
        // and a `mxc://` URL is unusable from the games origin anyway (no
        // access token, not an HTTP URL) — a sticker could only ever reach the
        // room as BYTES, over a channel neither side has. A billboard member
        // therefore ships `configJson: null` and the game keeps its
        // deterministic stand-in rig for them, which is what the join menu now
        // says will happen. `name` is not lost: it rides in every roster row.
        this.send(hostMsg.avatar(userId, s.config));
      }
    }
    // The avatar-state publishers ARE the room's 3D participants — feed the
    // mesh so pairs form/teardown as members join/leave the 3D view.
    this.mesh.setParticipants(kept.map(([userId]) => userId));

    // The two channels the game receives from nobody until now: face expression
    // and the stage grant. Both are scoped to `keep` — the game `ensure()`s an
    // avatar for any user id it is handed, so a message about a non-participant
    // conjures a rig for somebody who is not in the room.
    this.mayDriveStage.set(this.stageGrants.mayDriveStage(events, me));
    this.pushStage(await this.stageGrants.getStageHolder(this.roomId, events), keep);
    await this.pushExpressions(keep);

    // Moderated scene → placeMedia/clearMedia diffs. Image placements carry
    // REAL texture bytes; video placements their server-side poster frame.
    const sceneState = await this.scene.getModeratedSceneState(this.roomId, undefined, events);
    const placements = sceneState?.placements ?? [];
    const next = new Map(placements.map((p) => [p.surfaceId, p] as const));
    for (const surfaceId of this.pushedPlacements.keys()) {
      if (!next.has(surfaceId)) {
        this.pushedPlacements.delete(surfaceId);
        this.send(hostMsg.clearMedia(surfaceId));
      }
    }
    for (const [surfaceId, p] of next) {
      const json = JSON.stringify(p);
      if (this.pushedPlacements.get(surfaceId) !== json) {
        this.pushedPlacements.set(surfaceId, json);
        const bytes = await this.textureBytesFor(p);
        // Base64, NOT the ArrayBuffer: the game JSON.stringify()s its inbound
        // queue before GDScript reads it, so a structured clone arrives as {}.
        this.send(hostMsg.placeMedia(
          surfaceId,
          { eventId: p.eventId, kind: p.kind, label: p.label },
          bytes ? bytesToBase64(bytes) : null,
        ));
      }
    }
    this.currentPlacements = next;
  }

  /**
   * PRODUCER for the §5 `expression(userId, label)` channel — the SAME live
   * signal the 2D VN stage runs on (`expressionForEvent`: an explicit
   * `vn.expression` field > the rule-based sentiment derivation of the body >
   * `neutral`), applied per participant instead of only to the newest sender.
   *
   * The game received, dispatched and unit-tested this channel while the host
   * had no producer at all, so every avatar in every 3D room wore `neutral`
   * forever. One `/messages` page per poll answers "what is each participant's
   * newest message?"; the 3D view is its own route, so there is no live sync
   * feed here to piggy-back on the way `room-view` does.
   *
   * Diffed against the last pushed label, with "never pushed" treated as the
   * `neutral` every rig already starts on — so a quiet room sends nothing.
   */
  private async pushExpressions(roster: Set<string>): Promise<void> {
    for (const userId of [...this.pushedExpressions.keys()]) {
      if (!roster.has(userId)) {
        this.pushedExpressions.delete(userId); // left the room — re-push if they return
      }
    }
    if (!roster.size) {
      return;
    }
    let page;
    try {
      page = await this.matrix.messages(this.roomId, { dir: 'b', limit: EXPRESSION_SCAN_LIMIT });
    } catch {
      return; // denied/transient — keep the expressions the game already has
    }
    // `dir: 'b'` pages BACKWARDS: newest first, so the first hit per sender IS
    // their latest message.
    const latest = new Map<string, Expression>();
    for (const ev of page.events ?? []) {
      if (ev.type !== 'm.room.message' || ev.redacted) {
        continue;
      }
      if (!roster.has(ev.sender) || latest.has(ev.sender)) {
        continue;
      }
      latest.set(ev.sender, expressionForEvent(ev.content, ev.body));
    }
    for (const userId of roster) {
      const next = latest.get(userId) ?? DEFAULT_EXPRESSION;
      const prev = this.pushedExpressions.get(userId) ?? DEFAULT_EXPRESSION;
      if (next === prev) {
        continue;
      }
      this.pushedExpressions.set(userId, next);
      this.send(hostMsg.expression(userId, next));
    }
  }

  /**
   * PRODUCER for the §5 `stage(userId, bool)` channel — the moderator-gated
   * stage grant ({@link Chat3dStageService}), diffed into the revoke/grant pair
   * the game expects (it tracks ONE holder, so handing the platform over means
   * clearing the previous one first).
   *
   * Same dead-channel story as `expression`: the game teleports a rig onto the
   * platform and lights the spotlight on this call, and refuses to invent a
   * grant of its own in matrix mode because the host page owns them. Nothing
   * here owned them. A grant naming somebody outside the 3D roster is ignored.
   */
  private pushStage(holder: string | null, roster: Set<string>): void {
    const next = holder && roster.has(holder) ? holder : '';
    this.stageHolder.set(next);
    if (next === this.pushedStage) {
      return;
    }
    if (this.pushedStage) {
      this.send(hostMsg.stage(this.pushedStage, false));
    }
    if (next) {
      this.send(hostMsg.stage(next, true));
    }
    this.pushedStage = next;
  }

  /**
   * Take the stage, or step off it. Optimistic only in the UI sense: the poll
   * re-reads the room state and is the single source of what the game is told,
   * so a refused PUT simply leaves the platform where it was.
   */
  async toggleStage(): Promise<void> {
    const me = this.myUserId();
    if (!me || !this.mayDriveStage()) {
      return;
    }
    await this.stageGrants.setStageHolder(this.roomId, this.onStage() ? null : me);
    await this.pollOnce();
  }

  /**
   * Texture bytes for a placement: image = the full authenticated bytes,
   * video = its poster-frame thumbnail (v1 — playback happens in the panel;
   * live video-as-WebGL-texture is the documented DOM-overlay follow-up,
   * DESIGN §10), file/thread = none (label plaque). Cached per event+kind;
   * a failed fetch caches null so a dead mxc is not re-fetched every diff.
   */
  private async textureBytesFor(p: Chat3dPlacement): Promise<ArrayBuffer | null> {
    if (p.kind !== 'image' && p.kind !== 'video') {
      return null;
    }
    const cacheKey = `${p.eventId}|${p.kind}`;
    if (this.textureCache.has(cacheKey)) {
      return this.textureCache.get(cacheKey) ?? null;
    }
    let bytes: ArrayBuffer | null = null;
    try {
      const event = await this.matrix.getEvent(this.roomId, p.eventId);
      const mxc = typeof event.content?.url === 'string' && event.content.url.startsWith('mxc://')
        ? event.content.url
        : null;
      if (mxc) {
        bytes = p.kind === 'video'
          ? await this.matrix.fetchMediaBytes(mxc, { thumbnail: true, w: 640, h: 360, method: 'scale' })
          : await this.matrix.fetchMediaBytes(mxc);
      }
    } catch {
      bytes = null; // plaque fallback
    }
    // SIZE CAP (both sides of the bridge enforce the same number). A Matrix
    // room happily carries a 40 MB attachment; base64 inflates it by 4/3 and
    // the whole string is then structured-cloned into the iframe and
    // JSON-parsed inside the wasm heap. The game's own cap sits in a code path
    // only an ArrayBuffer argument reaches, so on the base64 transport that
    // actually shipped it never runs — nothing bounded this at all.
    // Refuse it HERE and say why; the surface still gets its label plaque.
    if (bytes && bytes.byteLength > MAX_MEDIA_BYTES) {
      console.warn(
        `[chat3d] placement ${p.surfaceId} (${p.eventId}) is ${bytes.byteLength} bytes — over the `
        + `${MAX_MEDIA_BYTES}-byte texture cap; sending the label plaque instead of the image.`,
      );
      bytes = null;
    }
    if (this.textureCache.size >= MAX_TEXTURE_CACHE) {
      // Simple full reset — 11 surfaces exist, this is a rare housekeeping.
      this.textureCache.clear();
    }
    this.textureCache.set(cacheKey, bytes);
    return bytes;
  }

  /**
   * Inbound bridge chokepoint. Drops anything that (1) is not from the games
   * origin allow-list, (2) is not from OUR embedded frame's contentWindow, or
   * (3) fails {@link parseGameMessage}'s envelope/clamp validation — silently
   * (no error oracle for a hostile frame). Public so specs can drive it with
   * synthetic MessageEvents.
   */
  handleMessage(ev: MessageEvent): void {
    if (!originAllowed(ev.origin, [this.gamesOrigin])) {
      return;
    }
    const frameWindow = this.frame?.nativeElement?.contentWindow ?? null;
    if (!frameWindow || ev.source !== frameWindow) {
      return;
    }
    const msg = parseGameMessage(ev.data);
    if (!msg) {
      return;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: GameMessage): void {
    // ANY validated game→host message proves the game's JS shim is installed,
    // listening and origin-matched — it cannot emit before `_install_js()`
    // ran. The game re-announces `ready` only a bounded number of times, so a
    // host that attached late (slow room-state chain, tab throttling) would
    // otherwise hold its queue forever; localPose alone arrives ~10Hz for the
    // life of the session.
    this.markReady();
    switch (msg.t) {
      case 'ready':
        break; // the handshake itself carries no payload
      case 'localPose':
        this.lastLocalPose.set({ x: msg.x, z: msg.z, yaw: msg.yaw, seat: msg.seat });
        break;
      case 'mediaActivate': {
        const p = this.currentPlacements.get(msg.surfaceId);
        this.activatedLabel.set(p ? (p.label || p.eventId) : '');
        this.activatedPlacement.set(p ?? null);
        if (p) {
          this.mediaPanelOpen.set(true); // "what IS that?" → show the panel
        }
        break;
      }
      case 'vrState':
        this.vrActive.set(msg.active);
        break;
    }
  }

  /**
   * The game announced itself (or proved it is listening): identify the local
   * player, then replay the coalesced world snapshot. Idempotent.
   */
  private markReady(): void {
    if (this.ready()) {
      return;
    }
    this.ready.set(true);
    const me = this.myUserId();
    if (me) {
      this.postToGame(hostMsg.setLocal(me));
    }
    const queued = [...this.outQueue.values()];
    this.outQueue.clear();
    for (const envelope of queued) {
      this.postToGame(envelope);
    }
  }

  /** Coalescing key: one slot per (call, participant-or-surface). */
  private static queueKey(envelope: HostEnvelope): string {
    const subject = envelope['userId'] ?? envelope['surfaceId'] ?? '';
    return `${String(envelope['t'])}|${String(subject)}`;
  }

  /** Queue-or-send: before the `ready` handshake outbound messages are held
   *  (coalesced + capped, so the game misses no STATE but a missing handshake
   *  cannot leak memory); after it they post straight through. */
  private send(envelope: HostEnvelope): void {
    if (!this.ready()) {
      const key = Chat3dHostComponent.queueKey(envelope);
      this.outQueue.delete(key); // re-insert so the newest value keeps its slot
      this.outQueue.set(key, envelope);
      while (this.outQueue.size > MAX_QUEUED_ENVELOPES) {
        this.outQueue.delete(this.outQueue.keys().next().value!);
      }
      return;
    }
    this.postToGame(envelope);
  }

  /**
   * The single outbound postMessage chokepoint — targetOrigin is ALWAYS the
   * games origin (never '*'), so our room data can only ever reach the frame
   * we embedded. Public as the spec seam for asserting outbound traffic.
   *
   * No transfer list: every §5 payload is JSON-shaped (textures are base64
   * strings) because the game serializes its inbound queue before decoding it.
   */
  postToGame(envelope: HostEnvelope): void {
    this.frame?.nativeElement?.contentWindow?.postMessage(envelope, this.gamesOrigin);
  }

  /** Ask the game to start its XR session. MUST stay behind a user gesture
   *  (browser WebXR requirement) — it is only ever called from the button,
   *  and NEVER queued (a queued enterVR would fire outside the gesture and be
   *  refused by the browser), so the button stays disabled until `ready`. */
  enterVr(): void {
    if (!this.ready()) {
      return;
    }
    this.postToGame(hostMsg.enterVR());
  }

  toggleMediaPanel(): void {
    this.mediaPanelOpen.update((open) => !open);
  }
}
