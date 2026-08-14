import { Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { MatrixService, MatrixRoom, RoomMember } from './matrix.service';
import { StageParticipant, VnStageComponent } from './vn/stage/vn-stage.component';
import { VnSceneControlsComponent } from './vn/stage/vn-scene-controls.component';
import { VnSceneState, VnSceneStateService } from './vn/scenes/vn-scene-state.service';
import { AmplitudeMouthService, MouthDrive, defaultReducedMotion } from './vn/voice/amplitude-mouth.service';
import { SpeakingDetector } from './vn/voice/speaking';
import { CharacterPackService } from './vn/character-pack.service';
import { DEFAULT_EXPRESSION, Expression, expressionForEvent } from './vn/expression';

/**
 * How the call renders: `video` = the original camera-tile call (default,
 * byte-identical behaviour); `vn-voice` = audio-only visual-novel mode — the
 * same WebRTC call and m.call.* signalling, but getUserMedia asks for the MIC
 * ONLY and the media surface is a <hug-vn-stage> acting out the conversation.
 */
export type CallMode = 'video' | 'vn-voice';

/**
 * LAST-RESORT stage sprite: a neutral person silhouette as an inline data: SVG
 * (script-inert, self-contained — no fetch, can never fail). Used when a
 * participant has neither a VN character pack frame nor a Matrix avatar.
 */
export const NEUTRAL_SILHOUETTE_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
      '<circle cx="80" cy="52" r="26" fill="#8a8a97"/>' +
      '<path d="M24 152c0-32 25-50 56-50s56 18 56 50z" fill="#8a8a97"/>' +
      '</svg>',
  );

/** The newest room message, projected into the stage's VN dialogue box. */
export interface DialogueLine {
  eventId: string;
  sender: string;
  senderName: string;
  /** Rendered dialogue text — clamped to {@link MAX_DIALOGUE_CHARS}. */
  body: string;
  /** The untruncated message body, exposed via title/aria on the text span. */
  fullBody: string;
}

/** Ignore polled remote scene state this long after a LOCAL picker edit, so an
 *  in-flight optimistic write isn't flickered back by a stale 1Hz read. */
const SCENE_EDIT_GRACE_MS = 2_000;

/**
 * LIMIT MAX_DIALOGUE_CHARS=500: most rendered dialogue-bar text. Message
 * bodies are unbounded user input; the VN dialogue box is a caption bar, so a
 * novel-length body is clamped with an ellipsis (the full text stays available
 * via the span's title + aria-label). 500 chars comfortably fits several
 * wrapped caption lines without letting one message flood the stage.
 */
export const MAX_DIALOGUE_CHARS = 500;

/**
 * LIMIT MAX_SEEN_EVENTS=2000: most m.call event ids remembered for dedupe.
 * `seen` otherwise grows one entry per m.call.* event for the life of the
 * view (ICE-candidate storms on flaky networks + hour-long calls add up).
 * roomEvents() only ever returns the newest 200 timeline events, so ids that
 * fell out of that window can never reappear — pruning to the ids still in
 * the current window is lossless for dedupe purposes.
 */
const MAX_SEEN_EVENTS = 2000;

/**
 * LIMIT MAX_QUEUED_CANDIDATES=64: most remote ICE candidates queued while the
 * peer connection / remote description doesn't exist yet. A real handshake
 * produces well under 64; an endless pre-answer trickle (buggy or hostile
 * peer) must not grow the queue unboundedly. Overflow drops the oldest —
 * newest candidates are the ones most likely still valid.
 */
const MAX_QUEUED_CANDIDATES = 64;

/**
 * Matrix 1:1 call. Real WebRTC (RTCPeerConnection + getUserMedia); the
 * Matrix room carries the signalling as m.call.invite / m.call.answer /
 * m.call.candidate events. Federated into the hugmesh.net host and
 * rendered at /social/matrix/call. This is our custom hugmesh-matrix-ui
 * call module — it does not depend on Element.
 *
 * TWO RENDER MODES ({@link CallMode}, `?mode=` query param):
 *  - `video` (default): the original camera+mic call with local/remote <video>
 *    tiles — signalling, ICE handling and template unchanged.
 *  - `vn-voice`: the VISUAL-NOVEL voice chat. getUserMedia is AUDIO-ONLY (no
 *    camera permission is ever requested); instead of video tiles the view
 *    renders <hug-vn-stage> with both participants as VN characters (sticker
 *    pack → avatar → silhouette, resolved exactly like hug-character-panel),
 *    their mouths driven live from each audio stream through the existing
 *    amplitude machinery (AmplitudeMouthService + openness.ts + the
 *    SpeakingDetector hangover — amplitude-only, no visemes, by product
 *    decision). The shared room scene (net.hugmesh.vn.scene state) is
 *    editable in-call via <hug-vn-scene-controls> and polled on the SAME 1Hz
 *    tick as the m.call signalling, so both sides see scene changes; the
 *    newest m.room.message is typewriter-revealed in the stage dialogue box.
 */
@Component({
  selector: 'hug-matrix-call',
  standalone: true,
  imports: [CommonModule, VnStageComponent, VnSceneControlsComponent],
  templateUrl: './matrix-call.component.html',
  styleUrl: './matrix-call.component.scss',
})
export class MatrixCallComponent implements OnInit, OnDestroy {
  private readonly matrix = inject(MatrixService);
  private readonly route = inject(ActivatedRoute);
  private readonly mouth = inject(AmplitudeMouthService);
  private readonly packs = inject(CharacterPackService);
  private readonly sceneStateSvc = inject(VnSceneStateService);
  // Optional: each exists only in its own mode's template branch.
  @ViewChild('local') localVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('remote') remoteVideo?: ElementRef<HTMLVideoElement>;
  /** VN mode's remote-voice sink (audio must still PLAY, there's just no tile). */
  @ViewChild('remoteAudio') remoteAudio?: ElementRef<HTMLAudioElement>;
  /** VN mode's scene picker host — remote scene changes are pushed into it so
   *  its radiogroup/rows stay honest when the OTHER side redecorates. */
  @ViewChild(VnSceneControlsComponent) private sceneControls?: VnSceneControlsComponent;

  readonly room = signal<MatrixRoom | null>(null);
  readonly state = signal<'idle' | 'calling' | 'ringing' | 'connected' | 'failed'>('idle');
  /** The render mode, parsed from `?mode=` (unknown values ⇒ `video`). */
  readonly mode = signal<CallMode>('video');
  /**
   * WebRTC ICE servers (TURN/STUN relays) fetched ONCE per component lifecycle in
   * {@link ngOnInit} from the homeserver's VoIP endpoint. Empty by default — when
   * no TURN relay is configured (coturn ships dark/disabled), this stays `[]` and
   * {@link newPc} falls back to host-only candidates, byte-identical to the prior
   * hard-coded behaviour. A signal so the template can show an honest "host/LAN
   * only" capability note (see {@link turnAvailable}) without re-reading on render.
   */
  private readonly iceServers = signal<RTCIceServer[]>([]);
  /** True once a TURN/STUN relay was returned by the homeserver — drives the
   *  capability-gating note so screen-reader/sighted users know WHY a call may not
   *  traverse a WAN/NAT (no relay ⇒ host/LAN-only). */
  readonly turnAvailable = signal(false);
  private readonly me = signal<string | null>(null);
  private pc?: RTCPeerConnection;
  private local?: MediaStream;
  private seen = new Set<string>();
  private poll?: ReturnType<typeof setInterval>;
  private callId = '';
  /** Remote offer recorded from an incoming m.call.invite, consumed by {@link join}. */
  private pendingOffer?: RTCSessionDescriptionInit;
  /** Remote ICE candidates queued until the peer connection + remote description exist. */
  private remoteCands: RTCIceCandidateInit[] = [];

  // ───────────────────────── VN voice mode state ─────────────────────────

  /** The other member of the 1:1 call, learned from their invite/answer sender. */
  readonly remoteUserId = signal<string | null>(null);
  /** The shared per-room scene (picker edits + the 1Hz remote poll converge here). */
  readonly sceneState = signal<VnSceneState | null>(null);
  /** The newest room message for the stage dialogue box (null ⇒ box hidden). */
  readonly dialogue = signal<DialogueLine | null>(null);
  /** Joined-member roster: display/screen-reader names + avatar fallbacks. */
  private readonly members = signal<Map<string, RoomMember>>(new Map());
  /** Resolved sprite image per userId (sticker → avatar → silhouette). */
  private readonly images = signal<Record<string, string>>({});
  /** Live expression per userId, derived from their latest message (B2 rules). */
  private readonly expressions = signal<Record<string, Expression>>({});
  /** The `userId|expression` key each userId's image was resolved for, so a new
   *  expression re-picks the frame but a same-key tick never refetches. */
  private readonly resolvedImageKey = new Map<string, string>();
  /** blob: object URLs we created and must revoke on destroy. */
  private objectUrls: string[] = [];

  /** ONE AudioContext for both analysers (one analyser per stream via drive()). */
  private audioCtx?: AudioContext;
  private localDrive?: MouthDrive;
  private remoteDrive?: MouthDrive;
  private readonly localDetector = new SpeakingDetector();
  private readonly remoteDetector = new SpeakingDetector();
  private readonly localOpenness = signal(0);
  private readonly remoteOpenness = signal(0);
  private readonly localSpeaking = signal(false);
  private readonly remoteSpeaking = signal(false);
  /** rAF handle of the per-frame openness/speaking sampler (0 = not running). */
  private vnRaf = 0;
  /** When the LOCAL user last edited the scene (see SCENE_EDIT_GRACE_MS). */
  private lastLocalSceneEditMs = 0;

  /** View heading + region label, honest per mode. */
  readonly title = computed(() =>
    this.mode() === 'vn-voice' ? 'Visual novel voice chat' : 'Matrix video call');

  /** The stage cast: local user + remote peer, first-seen order (max 2 in a 1:1). */
  readonly stageParticipants = computed<StageParticipant[]>(() => {
    const out: StageParticipant[] = [];
    const meId = this.me();
    if (meId) {
      out.push(this.toStageParticipant(meId, this.localSpeaking(), this.localOpenness()));
    }
    const remote = this.remoteUserId();
    if (remote && remote !== meId) {
      out.push(this.toStageParticipant(remote, this.remoteSpeaking(), this.remoteOpenness()));
    }
    return out;
  });

  /** The dialogue as a keyed single-row list: recreating the node per eventId
   *  restarts the CSS typewriter reveal (see the .dialogue-line animation). */
  readonly dialogueLines = computed<DialogueLine[]>(() => {
    const line = this.dialogue();
    return line ? [line] : [];
  });

  trackDialogue(_i: number, line: DialogueLine): string {
    return line.eventId;
  }

  /**
   * Contextual help for the call controls, keyed off the current call state so a
   * sighted user reads WHY a button is enabled/disabled and a screen-reader user
   * hears it announced (the template wires this via aria-describedby + an
   * aria-live region). Honest about the WebRTC flow: you start a call, the other
   * side joins a ringing call, and either side can hang up once it is in progress.
   */
  get callHelp(): string {
    let help: string;
    if (!this.room()) {
      // No room resolved yet — but the TURN capability note below still
      // applies (it is a deployment property, not a room property), so fall
      // through to it instead of returning early: the honest "host/LAN-only"
      // caveat must be readable before a room is ever picked (the offline e2e
      // idle-state scenario asserts exactly that).
      help = 'Open this view from a room (or with a ?room= link) to enable the call controls.';
      if (!this.turnAvailable()) {
        help += ' Calls are host/LAN-only until a TURN relay is configured.';
      }
      return help;
    }
    switch (this.state()) {
      case 'idle': help = this.mode() === 'vn-voice'
        ? 'Start call places a voice call into this room — your characters act it out on the stage. Join is available when someone else is calling you.'
        : 'Start call places a video call into this room. Join is available when someone else is calling you.'; break;
      case 'ringing': help = this.mode() === 'vn-voice'
        ? 'Someone is calling this room — choose Join call to answer with your microphone.'
        : 'Someone is calling this room — choose Join call to answer with your camera and microphone.'; break;
      case 'calling': help = 'Your call is connecting. Hang up ends it.'; break;
      case 'connected': help = 'You are connected. Hang up ends the call for you.'; break;
      case 'failed': help = 'The call failed to connect. Hang up to reset, then try Start call again.'; break;
      default: help = 'Use Start call to begin, Join call to answer, and Hang up to end the call.'; break;
    }
    // Capability-gating honesty: when no TURN relay is configured (the default —
    // coturn ships disabled), only host candidates are gathered, so calls cannot
    // traverse a WAN/NAT. Surface that to both sighted and screen-reader users so a
    // failed cross-internet call is understood as a missing-relay capability, not a
    // bug. Suppressed once a relay is available, so the default ON-LAN copy is clean.
    if (!this.turnAvailable()) {
      help += ' Calls are host/LAN-only until a TURN relay is configured.';
    }
    return help;
  }

  async ngOnInit(): Promise<void> {
    // Parse the render mode FIRST (synchronously) so the initial template pass
    // already mounts the right media surface (VN stage vs video tiles).
    const wantedMode = this.route.snapshot.queryParamMap.get('mode');
    this.mode.set(wantedMode === 'vn-voice' ? 'vn-voice' : 'video');
    // FAIL-SOFT: neither identity nor the room list may sink init — a rejected
    // fetch would otherwise skip the ICE fetch + the 1Hz signalling poll below
    // and leave the whole call view dead instead of degraded (idle, no room).
    this.me.set(await this.matrix.whoami().catch(() => null));
    const rooms = await this.matrix.joinedRooms().catch(() => []);
    const wanted = this.route.snapshot.queryParamMap.get('room');
    const pick = wanted ? (rooms.find((r) => r.roomId === wanted) ?? { roomId: wanted, name: wanted }) : rooms[0];
    if (pick) this.room.set(pick);
    if (pick && this.mode() === 'vn-voice') void this.loadVnContext(pick.roomId);
    // Fetch the WebRTC ICE (TURN/STUN) credentials ONCE, here, rather than on every
    // call so we don't hammer the homeserver or churn short-lived credentials. The
    // service degrades to [] on any failure/absence, so an empty result simply
    // preserves today's host-only behaviour (see newPc()).
    const ice = await this.matrix.turnServer();
    this.iceServers.set(ice);
    this.turnAvailable.set(ice.length > 0);
    this.poll = setInterval(() => this.pump(), 1000);
  }
  ngOnDestroy(): void {
    if (this.poll) clearInterval(this.poll);
    this.cleanup();
    // The sprite images may still be on screen through hangup/redial, so their
    // object URLs are only released when the view itself goes away.
    for (const url of this.objectUrls.splice(0)) URL.revokeObjectURL(url);
  }

  private newPc(): RTCPeerConnection {
    // Use the TURN/STUN relays fetched in ngOnInit if the homeserver advertised any;
    // otherwise this is [] and only host candidates are gathered — byte-identical to
    // the prior hard-coded host-only behaviour (LAN/localhost suffices, WAN may not).
    const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    pc.onicecandidate = (e) => {
      if (e.candidate) this.matrix.sendEvent(this.room()!.roomId, 'm.call.candidate',
        { call_id: this.callId, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (this.mode() === 'vn-voice') this.attachRemoteAudio(stream);
      else if (this.remoteVideo) this.remoteVideo.nativeElement.srcObject = stream;
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this.state.set('connected');
      else if (s === 'failed') this.state.set('failed');
    };
    return pc;
  }

  private async media(): Promise<void> {
    // VN voice mode is AUDIO-ONLY by design: the camera permission is never
    // requested — the characters, not the webcams, are the picture.
    const constraints: MediaStreamConstraints =
      this.mode() === 'vn-voice' ? { audio: true } : { video: true, audio: true };
    this.local = await navigator.mediaDevices.getUserMedia(constraints);
    if (this.mode() === 'vn-voice') {
      this.attachLocalAudio(this.local);
    } else if (this.localVideo) {
      this.localVideo.nativeElement.srcObject = this.local;
    }
    this.local.getTracks().forEach((t) => this.pc!.addTrack(t, this.local!));
  }

  async start(): Promise<void> {
    if (!this.room()) return;
    this.state.set('calling');
    this.callId = `c${Date.now()}`;
    this.pc = this.newPc();
    await this.media();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.matrix.sendEvent(this.room()!.roomId, 'm.call.invite', { call_id: this.callId, offer });
  }

  async join(): Promise<void> {
    // Driven by an incoming invite recorded in `pendingOffer`.
    if (!this.room() || !this.pendingOffer) return;
    this.pc = this.newPc();
    await this.media();
    await this.pc.setRemoteDescription(this.pendingOffer);
    await this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.matrix.sendEvent(this.room()!.roomId, 'm.call.answer', { call_id: this.callId, answer });
    this.state.set('calling');
  }

  /** Apply queued remote ICE candidates once the pc + remote description exist
   *  (candidates can arrive before the callee has built its peer connection). */
  private async flushCandidates(): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription) return;
    for (const c of this.remoteCands.splice(0)) {
      try { await this.pc.addIceCandidate(c); } catch { /* ignore */ }
    }
  }

  private async pump(): Promise<void> {
    const r = this.room(); if (!r) return;
    // roomEvents filters by type-prefix CLIENT-side, so ONE unfiltered 1Hz fetch
    // serves both the m.call.* signalling and (in VN mode) the dialogue feed —
    // the same single /messages request the video call always made.
    const all = await this.matrix.roomEvents(r.roomId);
    // dir=b returns newest-first; reverse so an invite is handled before its
    // trailing candidates.
    const events = all.filter((e) => (e.type || '').startsWith('m.call')).reverse();
    // Cap the dedupe set (see MAX_SEEN_EVENTS): prune to the ids still inside
    // the fetch window — anything older can never be returned again.
    if (this.seen.size > MAX_SEEN_EVENTS) {
      const window = new Set(events.map((e) => e.event_id));
      this.seen = new Set([...this.seen].filter((id) => window.has(id)));
    }
    for (const e of events) {
      if (this.seen.has(e.event_id) || e.sender === this.me()) continue;
      this.seen.add(e.event_id);
      if (e.type === 'm.call.invite' && this.state() === 'idle') {
        this.callId = e.content.call_id; this.pendingOffer = e.content.offer; this.state.set('ringing');
        this.remoteUserId.set(e.sender);
      } else if (e.type === 'm.call.answer' && this.pc) {
        this.remoteUserId.set(e.sender);
        await this.pc.setRemoteDescription(e.content.answer); await this.flushCandidates();
      } else if (e.type === 'm.call.candidate') {
        this.remoteCands.push(e.content.candidate);
        // Bound the pre-answer queue (see MAX_QUEUED_CANDIDATES): drop oldest.
        if (this.remoteCands.length > MAX_QUEUED_CANDIDATES) {
          this.remoteCands.splice(0, this.remoteCands.length - MAX_QUEUED_CANDIDATES);
        }
        await this.flushCandidates();
      }
    }
    if (this.mode() === 'vn-voice') {
      this.pumpDialogue(all);
      await this.pumpSceneState(r.roomId);
      this.ensureParticipantImages();
    }
  }

  hangup(): void { this.cleanup(); this.state.set('idle'); }
  private cleanup(): void {
    this.local?.getTracks().forEach((t) => t.stop());
    this.pc?.close(); this.pc = undefined; this.pendingOffer = undefined;
    this.localDrive?.stop(); this.localDrive = undefined;
    this.remoteDrive?.stop(); this.remoteDrive = undefined;
    this.stopVnSampler();
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => undefined);
      this.audioCtx = undefined;
    }
  }

  // ───────────────────────── VN voice mode wiring ─────────────────────────

  /** Picker edits (and its initial load) land here: optimistic stage update +
   *  a grace window so the 1Hz poll can't flicker the optimistic state back. */
  onSceneEdited(next: VnSceneState): void {
    this.lastLocalSceneEditMs = Date.now();
    this.sceneState.set(next);
  }

  /** Load the roster (names + avatar fallbacks) and my own sprite image. The
   *  scene itself arrives via <hug-vn-scene-controls>' load → stateChange. */
  private async loadVnContext(roomId: string): Promise<void> {
    try {
      const members = await this.matrix.joinedMembers(roomId);
      this.members.set(new Map(members.map((m) => [m.userId, m])));
    } catch { /* fail-soft: sprites fall back to user ids + silhouettes */ }
    this.ensureParticipantImages();
  }

  /** Project the newest m.room.message into the stage dialogue box and fold its
   *  sentiment/`vn.expression` into the sender's live expression (B2 priority). */
  private pumpDialogue(events: { event_id: string; type: string; sender: string; content: any }[]): void {
    const msg = events.find(
      (e) => e.type === 'm.room.message' && typeof e.content?.body === 'string' && e.content.body,
    );
    if (!msg || msg.event_id === this.dialogue()?.eventId) return;
    const member = this.members().get(msg.sender);
    // Clamp the RENDERED caption (see MAX_DIALOGUE_CHARS) — the full body
    // stays reachable through the dialogue text's title/aria-label.
    const fullBody: string = msg.content.body;
    const body = fullBody.length > MAX_DIALOGUE_CHARS ? `${fullBody.slice(0, MAX_DIALOGUE_CHARS)}…` : fullBody;
    this.dialogue.set({
      eventId: msg.event_id,
      sender: msg.sender,
      senderName: member?.displayName || msg.sender,
      body,
      fullBody,
    });
    const expression = expressionForEvent(msg.content, msg.content.body);
    if (this.expressions()[msg.sender] !== expression) {
      this.expressions.update((m) => ({ ...m, [msg.sender]: expression }));
    }
  }

  /** Pull the shared scene on the SAME 1Hz tick as the m.call poll (no second
   *  loop). Remote-null (unset/denied) never clobbers a local optimistic state,
   *  and a fresh local edit wins for SCENE_EDIT_GRACE_MS. */
  private async pumpSceneState(roomId: string): Promise<void> {
    if (Date.now() - this.lastLocalSceneEditMs < SCENE_EDIT_GRACE_MS) return;
    // MODERATED read: a below-power-level sender's scene is ignored and rapid
    // flips are coalesced, so a hostile member cannot flip/spam the stage.
    const remote = await this.sceneStateSvc.getModeratedSceneState(roomId);
    if (!remote || JSON.stringify(remote) === JSON.stringify(this.sceneState())) return;
    this.sceneState.set(remote);
    // Keep the picker honest too (its radiogroup/placed rows), not just the stage.
    this.sceneControls?.state.set(remote);
  }

  private toStageParticipant(userId: string, speaking: boolean, openness: number): StageParticipant {
    const member = this.members().get(userId);
    return {
      userId,
      displayName: member?.displayName || userId,
      screenReaderName: member?.screenReaderName,
      imgUrl: this.images()[userId] ?? NEUTRAL_SILHOUETTE_URL,
      speaking,
      openness,
      expression: this.expressions()[userId] ?? DEFAULT_EXPRESSION,
    };
  }

  /** Kick (idempotent) image resolution for everyone currently on stage. */
  private ensureParticipantImages(): void {
    const meId = this.me();
    if (meId) void this.ensureImage(meId);
    const remote = this.remoteUserId();
    if (remote) void this.ensureImage(remote);
  }

  /** Resolve `userId`'s sprite for their CURRENT expression exactly once per
   *  `userId|expression` (the pack itself is TTL-cached in CharacterPackService). */
  private async ensureImage(userId: string): Promise<void> {
    const expression = this.expressions()[userId] ?? DEFAULT_EXPRESSION;
    const key = `${userId}|${expression}`;
    if (this.resolvedImageKey.get(userId) === key) return;
    this.resolvedImageKey.set(userId, key); // claim first: de-dupes concurrent ticks
    const url = await this.resolveParticipantImage(userId, expression);
    if (this.resolvedImageKey.get(userId) !== key) return; // superseded meanwhile
    this.images.update((m) => ({ ...m, [userId]: url }));
  }

  /**
   * The sprite-image FALLBACK CHAIN, mirroring hug-character-panel's primary
   * path: ① the sender's MSC2545 `im.ponies.user_emotes` sticker frame for the
   * current expression (CharacterPackService + authenticated blob object URL) →
   * ② their Matrix avatar (roster, then profile; via mxcToHttp under
   * fetchMediaObjectUrl — authenticated media needs the blob path, never a bare
   * src) → ③ the neutral silhouette. Never throws, never returns ''.
   */
  private async resolveParticipantImage(userId: string, expression: Expression): Promise<string> {
    try {
      const pack = await this.packs.resolveCharacterPack(userId);
      const image = this.packs.imageFor(pack, expression);
      if (image) {
        const url = await this.matrix.fetchMediaObjectUrl(image.url, { thumbnail: true, w: 160, h: 160, method: 'scale' });
        if (url) { this.objectUrls.push(url); return url; }
      }
    } catch { /* fall through to the avatar */ }
    try {
      let avatar = this.members().get(userId)?.avatarUrl;
      if (!avatar) avatar = (await this.matrix.getProfile(userId)).avatarUrl;
      if (avatar) {
        const url = await this.matrix.fetchMediaObjectUrl(avatar, { thumbnail: true, w: 160, h: 160, method: 'crop' });
        if (url) { this.objectUrls.push(url); return url; }
      }
    } catch { /* fall through to the silhouette */ }
    return NEUTRAL_SILHOUETTE_URL;
  }

  /** Feed the LOCAL mic stream into its own analyser → mouth drive. */
  private attachLocalAudio(stream: MediaStream): void {
    this.localDrive?.stop();
    this.localDetector.reset();
    this.localDrive = this.driveFor(stream);
  }

  /** Play the remote stream (audio sink) and feed it into ITS OWN analyser. */
  private attachRemoteAudio(stream: MediaStream): void {
    if (this.remoteAudio) this.remoteAudio.nativeElement.srcObject = stream;
    this.remoteDrive?.stop();
    this.remoteDetector.reset();
    this.remoteDrive = this.driveFor(stream);
  }

  /** One analyser per stream through the EXISTING amplitude machinery. Fail-soft:
   *  no Web Audio ⇒ no drive ⇒ mouths stay closed, the call itself unaffected. */
  private driveFor(stream: MediaStream): MouthDrive | undefined {
    try {
      const ctx = (this.audioCtx ??= new AudioContext());
      void ctx.resume().catch(() => undefined);
      const source = ctx.createMediaStreamSource(stream);
      const drive = this.mouth.drive(source, ctx);
      this.startVnSampler();
      return drive;
    } catch {
      return undefined;
    }
  }

  /**
   * The per-frame sampler mirroring both drives' openness signals into ours and
   * stepping the speaking detectors (threshold + ~150ms hangover) — the same
   * rAF-mirror pattern as hug-character-panel's pumpOpenness. Not started under
   * prefers-reduced-motion: the drives pin openness to 0 there anyway, so the
   * stage stays static with zero per-frame work.
   */
  private startVnSampler(): void {
    if (this.vnRaf !== 0 || defaultReducedMotion()) return;
    const step = (): void => {
      const now = performance.now();
      const lo = this.localDrive?.openness() ?? 0;
      const ro = this.remoteDrive?.openness() ?? 0;
      this.localOpenness.set(lo);
      this.remoteOpenness.set(ro);
      this.localSpeaking.set(this.localDetector.update(lo, now));
      this.remoteSpeaking.set(this.remoteDetector.update(ro, now));
      this.vnRaf = requestAnimationFrame(step);
    };
    this.vnRaf = requestAnimationFrame(step);
  }

  private stopVnSampler(): void {
    if (this.vnRaf !== 0) {
      cancelAnimationFrame(this.vnRaf);
      this.vnRaf = 0;
    }
    this.localOpenness.set(0);
    this.remoteOpenness.set(0);
    this.localSpeaking.set(false);
    this.remoteSpeaking.set(false);
    this.localDetector.reset();
    this.remoteDetector.reset();
  }
}
