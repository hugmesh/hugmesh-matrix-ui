import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatrixService, RoomSummary } from './matrix.service';
import { SessionService } from './session.service';
import {
  DEFAULT_MESH_DEVICE,
  MESH_BRIDGE_STATE_TYPE,
  MeshBridgeStateService,
} from './mesh/mesh-bridge-state.service';
import {
  CHAT3D_DEFAULT_PARTICIPANTS,
  CHAT3D_MAX_PARTICIPANTS,
  CHAT3D_MIN_PARTICIPANTS,
  CHAT3D_STATE_TYPE,
  Chat3dRoomStyle,
  Chat3dStateService,
  DEFAULT_CHAT3D_STYLE,
} from './chat3d/chat3d-state.service';
import { CHAT3D_SCENE_TYPE } from './chat3d/chat3d-scene.service';
import { CHAT3D_AVATAR_TYPE } from './chat3d/chat3d-avatar.service';
import { senderMayDriveScene } from './vn/scenes/vn-scene-moderation';
import { mountRoute } from './mount-route';

/** Localpart of the Meshtastic bridge appservice bot (`@meshbridge:<server>`). */
export const MESH_BRIDGE_BOT_LOCALPART = 'meshbridge';

/**
 * Element Web RoomSettingsDialog. Edit room name (m.room.name), topic
 * (m.room.topic) and avatar (m.room.avatar), invite users, view/edit power
 * levels (m.room.power_levels), configure the Meshtastic LoRa-mesh bridge
 * (net.hugmesh.mesh.bridge), configure the Shadows-of-the-Net 3D chat
 * room (net.hugmesh.chat3d) and leave the room.
 */
@Component({
  selector: 'hug-room-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './room-settings.component.html',
  styleUrl: './room-settings.component.scss',
})
export class RoomSettingsComponent implements OnInit, OnDestroy {
  /** This remote's mount point — in-app links resolve against it
   *  (see mount-route.ts: absolute links bounce out of the remote). */
  readonly mount = mountRoute();
  private readonly matrix = inject(MatrixService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly session = inject(SessionService);
  private readonly meshBridge = inject(MeshBridgeStateService);
  private readonly chat3d = inject(Chat3dStateService);

  readonly roomId = signal<string | null>(null);
  readonly busy = signal(false);
  readonly status = signal('');
  /** The loaded fields below are SIGNALS on purpose: MatrixService reads through
   *  a raw `fetch`, and a plain field assigned after that await left the page
   *  un-rendered. A signal write schedules the re-render
   *  (room-settings.load-render.spec.ts). */
  readonly name = signal('');
  readonly topic = signal('');
  inviteUser = '';

  // ── Mesh bridge (LoRa) ──
  /** The controls' working copy of the room's mesh-bridge state (loaded from the
   *  net.hugmesh.mesh.bridge state event; defaults = bridge off). */
  readonly meshEnabled = signal(false);
  readonly meshDevice = signal(DEFAULT_MESH_DEVICE);
  readonly meshChannel = signal(0);

  // ── 3D chat room (Shadows of the Net) ──
  /** The controls' working copy of the room's chat3d state (loaded from the
   *  net.hugmesh.chat3d state event; defaults = room off, noir style,
   *  8 seats, media on, stage moderator-only). */
  readonly chat3dEnabled = signal(false);
  readonly chat3dStyle = signal<Chat3dRoomStyle>(DEFAULT_CHAT3D_STYLE);
  readonly chat3dMaxParticipants = signal(CHAT3D_DEFAULT_PARTICIPANTS);
  readonly chat3dAllowMedia = signal(true);
  readonly chat3dStageModOnly = signal(true);
  /** Bounds surfaced to the template's number input. */
  readonly chat3dMinSeats = CHAT3D_MIN_PARTICIPANTS;
  readonly chat3dMaxSeats = CHAT3D_MAX_PARTICIPANTS;

  // ── SOCIAL LOCAL-ONLY (domain lock) ──
  /** True when the caller is Matrix DOMAIN-LOCKED (the `matrix_domainlocked`
   *  restriction marker the admin-bff folds into the session roles[]). Inviting a
   *  user is a CROSS-DOMAIN / FEDERATION target whenever the invitee lives on a
   *  different homeserver, so a domain-locked caller cannot invite remote users —
   *  the invite control is greyed-out with WHY-helptext while same-domain invites
   *  stay usable. Defence-in-depth only; the homeserver/BFF still enforces it. */
  readonly domainLocked = computed(() => this.session.isMatrixDomainLocked());

  /** The caller's own homeserver name, derived from their Matrix user id
   *  (`@alice:example.org` → `example.org`). Resolved via the hsproxy
   *  {@link MatrixService.whoami} (the browser no longer holds the Matrix user id
   *  in the session). Used to tell a LOCAL invite from a cross-domain
   *  (federation) one when the account is domain-locked, and to derive the mesh
   *  bridge bot's MXID (`@meshbridge:<own server>`). */
  readonly localServer = signal('');
  /** The caller's own full Matrix user id (whoami), for the power-level gate on
   *  the mesh-bridge controls. Empty until whoami resolves. */
  readonly myUserId = signal('');
  private avatarMxc: string | null = null;
  private readonly summary = signal<RoomSummary | null>(null);

  private sub?: { unsubscribe(): void };

  ngOnInit(): void {
    // Resolve the caller's own homeserver via the hsproxy (the browser no longer
    // stores the Matrix user id), so the domain-lock LOCAL-vs-federation check has
    // a source. Best-effort: an empty result just treats every invite as local.
    void this.matrix.whoami().then((uid) => {
      this.myUserId.set(uid ?? '');
      this.localServer.set(this.serverOf(uid ?? ''));
    });
    this.sub = this.route.paramMap.subscribe(async (pm) => {
      const rid = pm.get('roomId');
      this.roomId.set(rid);
      if (rid) await this.load(rid);
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private async load(rid: string): Promise<void> {
    const summary = await this.matrix.roomSummary(rid);
    this.summary.set(summary);
    this.name.set(summary.name ?? '');
    this.topic.set(summary.topic ?? '');
    // Fail-soft: an unset/unreadable/malformed bridge event renders as "off".
    const mesh = await this.meshBridge.getMeshBridgeState(rid);
    this.meshEnabled.set(mesh?.enabled ?? false);
    this.meshDevice.set(mesh?.device ?? DEFAULT_MESH_DEVICE);
    this.meshChannel.set(mesh?.meshChannel ?? 0);
    // Fail-soft: an unset/unreadable/malformed chat3d event renders as "off"
    // with the parse's safe defaults for the sub-settings.
    const c3d = await this.chat3d.getChat3dState(rid);
    this.chat3dEnabled.set(c3d?.enabled ?? false);
    this.chat3dStyle.set(c3d?.style ?? DEFAULT_CHAT3D_STYLE);
    this.chat3dMaxParticipants.set(c3d?.maxParticipants ?? CHAT3D_DEFAULT_PARTICIPANTS);
    this.chat3dAllowMedia.set(c3d?.allowMedia ?? true);
    this.chat3dStageModOnly.set(c3d?.stageModOnly ?? true);
  }

  /** The server portion of a Matrix user id (`@bob:other.org` → `other.org`). */
  private serverOf(userId: string): string {
    const i = userId.indexOf(':');
    return i >= 0 ? userId.slice(i + 1).trim() : '';
  }

  /** Whether the currently-typed invite target is on a DIFFERENT homeserver than
   *  the caller — i.e. a cross-domain (federation) invite. Empty/local-server/
   *  not-yet-a-full-id inputs are treated as local (not remote). */
  inviteIsRemote(): boolean {
    const server = this.serverOf(this.inviteUser.trim());
    return server !== '' && this.localServer() !== '' && server !== this.localServer();
  }

  /** Whether the invite control must be blocked: only when the caller is
   *  domain-locked AND the typed target is a cross-domain/federation user. A
   *  domain-locked caller may still invite users on their own homeserver. */
  inviteBlocked(): boolean {
    return this.domainLocked() && this.inviteIsRemote();
  }

  /** WHY-helptext for the invite field when a domain-locked caller is the one
   *  composing. Always explains the lock so the (sometimes-disabled) control is
   *  never a bare disabled control. */
  get inviteHelp(): string {
    if (!this.domainLocked()) return '';
    return this.inviteIsRemote()
      ? 'Your account is domain-locked: you can only invite users on your own domain. Cross-domain (federation) invites are unavailable.'
      : 'Your account is domain-locked: invites are limited to users on your own domain.';
  }

  powerUsers(): { userId: string; level: number }[] {
    const users = this.summary()?.powerLevels?.users ?? {};
    return Object.keys(users).map((userId) => ({ userId, level: users[userId] }));
  }

  // ── Mesh bridge (LoRa) ──

  /** Whether the caller may change the room's mesh-bridge state: their power
   *  level clears the room's required-to-send threshold for the
   *  {@link MESH_BRIDGE_STATE_TYPE} state event (per-event override, else
   *  `state_default`), floored at moderator PL — the same generic guard the VN
   *  scene uses ({@link senderMayDriveScene}). Defence-in-depth only: the
   *  homeserver still enforces the power level on the PUT; this gate only
   *  decides whether the controls are OFFERED (greyed-out with WHY-helptext
   *  otherwise, never a bare disabled control). */
  canEditMeshBridge(): boolean {
    return senderMayDriveScene(this.summary()?.powerLevels ?? null, this.myUserId() || null, MESH_BRIDGE_STATE_TYPE);
  }

  /** WHY-helptext for the mesh-bridge controls when the caller's power level is
   *  below the room's threshold — the (disabled) controls are never bare. */
  get meshHelp(): string {
    return this.canEditMeshBridge()
      ? ''
      : 'Your power level in this room is below what changing the mesh bridge requires (moderator). Ask a room moderator to change it.';
  }

  /** The mesh bridge bot's MXID on the caller's OWN homeserver
   *  (`@meshbridge:<server>` — the server is derived from whoami, never
   *  hardcoded). Empty while whoami has not resolved. */
  meshBotMxid(): string {
    const server = this.localServer();
    return server ? `@${MESH_BRIDGE_BOT_LOCALPART}:${server}` : '';
  }

  /** Save the mesh-bridge section: write the (normalized) state event and, when
   *  ENABLING, also invite the bridge bot so the appservice can join and relay.
   *  An invite failure is tolerated as success — the bot being already
   *  invited/joined is the common re-save case. Disabling only writes the
   *  state; the bridge leaves the room on its own. */
  async saveMeshBridge(): Promise<void> {
    const rid = this.roomId();
    if (!rid) return;
    // Power-level gate: refuse here too (defence-in-depth with the disabled
    // controls) and surface the WHY. The homeserver would reject the PUT anyway.
    if (!this.canEditMeshBridge()) {
      this.status.set(this.meshHelp);
      return;
    }
    this.busy.set(true);
    try {
      const ok = await this.meshBridge.setMeshBridgeState(rid, {
        enabled: this.meshEnabled(),
        device: this.meshDevice(),
        meshChannel: this.meshChannel(),
      });
      if (!ok) {
        this.status.set('Mesh bridge save failed — the room may not allow you to change its settings.');
        return;
      }
      if (this.meshEnabled()) {
        const bot = this.meshBotMxid();
        if (bot) {
          // Tolerate an already-invited/already-joined bot: the state write is
          // what turns the bridge on; a rejected re-invite is not a failure.
          try {
            await this.matrix.invite(rid, bot);
          } catch { /* already invited/joined — fine */ }
        }
      }
      this.status.set('Mesh bridge settings saved');
    } finally {
      this.busy.set(false);
    }
  }

  // ── 3D chat room (Shadows of the Net) ──

  /** Whether the caller may change the room's 3D chat setting: same generic
   *  power-level guard as the mesh bridge ({@link senderMayDriveScene},
   *  moderator floor 50) applied to the {@link CHAT3D_STATE_TYPE} state event.
   *  Defence-in-depth only — the homeserver still enforces the PUT; this gate
   *  decides whether the controls are OFFERED (greyed with WHY-helptext
   *  otherwise, never a bare disabled control). */
  canEditChat3d(): boolean {
    return senderMayDriveScene(this.summary()?.powerLevels ?? null, this.myUserId() || null, CHAT3D_STATE_TYPE);
  }

  /** WHY-helptext for the chat3d controls when the caller's power level is
   *  below the room's threshold — the (disabled) controls are never bare. */
  get chat3dHelp(): string {
    return this.canEditChat3d()
      ? ''
      : 'Your power level in this room is below what changing the 3D chat room requires (moderator). Ask a room moderator to change it.';
  }

  /**
   * Save the 3D chat-room section: write the (normalized) state event and,
   * when ENABLING, ALSO write the `m.room.power_levels` per-event overrides
   * that let ORDINARY members participate — without them the Matrix default
   * `state_default` (50) would silently block every non-moderator from
   * publishing their avatar or placing media:
   *
   *   - `net.hugmesh.chat3d.avatar` → 0   (everyone dresses themselves)
   *   - `net.hugmesh.chat3d.scene`  → 50 when stage is moderator-only,
   *                                          else 0
   *
   * The override write re-reads the CURRENT power-levels content and merges
   * only the `events` entries (never clobbering users/defaults). A failed
   * override is TOLERATED with an honest note — the room still enables, but
   * members may be unable to publish until an admin fixes the levels (writing
   * m.room.power_levels often needs a higher level than writing our state).
   */
  async saveChat3d(): Promise<void> {
    const rid = this.roomId();
    if (!rid) return;
    // Power-level gate: refuse here too (defence-in-depth with the disabled
    // controls) and surface the WHY. The homeserver would reject the PUT anyway.
    if (!this.canEditChat3d()) {
      this.status.set(this.chat3dHelp);
      return;
    }
    this.busy.set(true);
    try {
      const ok = await this.chat3d.setChat3dState(rid, {
        enabled: this.chat3dEnabled(),
        style: this.chat3dStyle(),
        maxParticipants: this.chat3dMaxParticipants(),
        allowMedia: this.chat3dAllowMedia(),
        stageModOnly: this.chat3dStageModOnly(),
      });
      if (!ok) {
        this.status.set('3D chat room save failed — the room may not allow you to change its settings.');
        return;
      }
      if (this.chat3dEnabled() && !(await this.writeChat3dPowerOverrides(rid))) {
        this.status.set('3D chat room settings saved — but the power-level overrides could not be written, '
          + 'so members may be unable to publish their avatars or place media. Ask a room admin to allow '
          + 'the net.hugmesh.chat3d.avatar and .scene events.');
        return;
      }
      this.status.set('3D chat room settings saved');
    } finally {
      this.busy.set(false);
    }
  }

  /** Merge the chat3d per-event PL overrides into the room's CURRENT
   *  m.room.power_levels content (read-modify-write; only the two `events`
   *  entries change). False on any failure — including an unreadable PL event,
   *  because PUTting a fabricated power_levels object would wipe the room's
   *  real user levels. */
  private async writeChat3dPowerOverrides(rid: string): Promise<boolean> {
    let current: unknown;
    try {
      current = await this.matrix.getStateEvent(rid, 'm.room.power_levels');
    } catch {
      return false;
    }
    if (!current || typeof current !== 'object') {
      return false;
    }
    const pl = current as Record<string, unknown>;
    const events = {
      ...(pl['events'] && typeof pl['events'] === 'object' ? (pl['events'] as Record<string, unknown>) : {}),
      [CHAT3D_AVATAR_TYPE]: 0,
      [CHAT3D_SCENE_TYPE]: this.chat3dStageModOnly() ? 50 : 0,
    };
    try {
      await this.matrix.setStateEvent(rid, 'm.room.power_levels', { ...pl, events });
      return true;
    } catch {
      return false;
    }
  }

  async onAvatar(ev: Event): Promise<void> {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.status.set('Uploading avatar…');
    try {
      const up = await this.matrix.uploadMedia(file, file.name);
      this.avatarMxc = up.mxcUri;
      this.status.set('Avatar uploaded — save to apply');
    } catch (e: unknown) {
      this.status.set(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async save(): Promise<void> {
    const rid = this.roomId();
    if (!rid) return;
    this.busy.set(true);
    try {
      await this.matrix.setStateEvent(rid, 'm.room.name', { name: this.name() });
      await this.matrix.setStateEvent(rid, 'm.room.topic', { topic: this.topic() });
      if (this.avatarMxc) await this.matrix.setStateEvent(rid, 'm.room.avatar', { url: this.avatarMxc });
      this.status.set('Saved');
    } catch (e: unknown) {
      this.status.set(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy.set(false);
    }
  }

  async doInvite(): Promise<void> {
    const rid = this.roomId();
    const u = this.inviteUser.trim();
    if (!rid || !u) return;
    // SOCIAL LOCAL-ONLY: a domain-locked caller cannot invite a cross-domain
    // (federation) user. Refuse the federation target here too (defence-in-depth
    // with the disabled control) and surface the WHY, keeping local invites live.
    if (this.inviteBlocked()) {
      this.status.set(this.inviteHelp);
      return;
    }
    try {
      await this.matrix.invite(rid, u);
      // Only a server-ACCEPTED invite clears the field and claims "Invited" —
      // announcing success on a 403/404 was a silent-failure honesty bug.
      this.inviteUser = '';
      this.status.set('Invited');
    } catch (e: unknown) {
      this.status.set(`Invite failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async leave(): Promise<void> {
    const rid = this.roomId();
    if (!rid) return;
    try {
      await this.matrix.leaveRoom(rid);
    } catch (e: unknown) {
      // ANNOUNCED failure — do not navigate away pretending the leave worked.
      this.status.set(`Could not leave the room: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await this.router.navigate(['rooms'], { relativeTo: this.mount });
  }
}
