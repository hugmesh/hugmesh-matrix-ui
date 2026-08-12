import { Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatrixService, MatrixRoom, PendingInvite } from './matrix.service';
import { SessionService } from './session.service';

/**
 * Element Web LeftPanel / RoomList. Lists joined rooms grouped into Rooms vs
 * People (DMs via m.direct), shows avatar / name / last-message preview /
 * unread badge, and offers create-room, start-DM and join-by-alias controls.
 */
@Component({
  selector: 'hug-room-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './room-list.component.html',
  styleUrl: './room-list.component.scss',
})
export class RoomListComponent implements OnInit {
  private readonly matrix = inject(MatrixService);
  private readonly session = inject(SessionService);

  /** Optionally fed by the host shell so the list reuses the sync data. */
  @Input() rooms = signal<MatrixRoom[]>([]);
  @Input() selectedRoomId: string | null = null;
  @Output() roomSelected = new EventEmitter<MatrixRoom>();
  @Output() roomsChanged = new EventEmitter<MatrixRoom[]>();

  readonly showCreate = signal(false);
  readonly showDm = signal(false);
  /** Flips true once Create is submitted so the required-name error + aria-invalid
   *  only show after an attempt, not on first render (WCAG 3.3.1). */
  readonly submittedCreate = signal(false);

  // ── SOCIAL LOCAL-ONLY (matrix_domainlocked) enforcement surface ──
  /** Additive domain-lock restriction marker (SessionService contract): when
   *  present, the join-by-alias + start-DM federation targets are steered
   *  LOCAL-ONLY with why-helptext, while local interaction stays fully usable.
   *  Defence-in-depth — the homeserver MRF still force-locals server-side. */
  readonly domainLocked = computed(() => this.session.isMatrixDomainLocked());
  /** ANNOUNCED join failure / federation-rejection notice (role=alert). */
  readonly joinError = signal('');
  /** ANNOUNCED start-DM failure / federation-rejection notice (role=alert). */
  readonly dmError = signal('');
  /** ANNOUNCED create-room failure notice (role=alert): a malformed invitee,
   *  a domain-lock rejection, or the server refusing the create. Distinct from
   *  the required-name validation error (create-room-error) — before this, a
   *  server rejection silently swallowed the whole dialog state. */
  readonly createError = signal('');

  // ── Pending invites (rooms.invite — the invitee's side of an invite) ──
  /** The caller's pending room invites, loaded via a one-shot sync parse. */
  readonly invites = signal<PendingInvite[]>([]);
  /** ANNOUNCED accept/decline failure notice (role=alert). */
  readonly inviteError = signal('');

  /** WHY-helptext for the domain-lock restriction, reused by the notices. */
  get lockWhy(): string {
    return 'Your account is domain-locked: only rooms and people on your own server are reachable, so cross-domain (federation) targets are unavailable.';
  }
  joinAlias = '';
  newName = '';
  newTopic = '';
  newAlias = '';
  newPreset: 'private_chat' | 'public_chat' | 'trusted_private_chat' = 'private_chat';
  /** Optional comma/whitespace-separated Matrix ids to invite AT room creation
   *  (createRoom's `invite` array) — without this, making a group chat was two
   *  disconnected steps (create, then invite one-by-one from room settings). */
  newInvites = '';
  dmUser = '';

  readonly people = computed(() => this.rooms().filter((r) => r.isDirect));
  readonly groups = computed(() => this.rooms().filter((r) => !r.isDirect));

  async ngOnInit(): Promise<void> {
    // Pending invites load regardless of whether the host fed the joined
    // rooms — an invited-but-not-joined room appears in NEITHER list.
    void this.loadInvites();
    if (!this.rooms().length) await this.reload();
  }

  private async reload(): Promise<void> {
    const rooms = await this.matrix.joinedRoomsDetailed();
    this.rooms.set(rooms);
    this.roomsChanged.emit(rooms);
  }

  /** Refresh the pending-invite rows (fail-soft — an error, or a host
   *  embedding a partial service stub, leaves the section hidden rather than
   *  blocking the joined-room list). */
  private async loadInvites(): Promise<void> {
    try {
      this.invites.set((await this.matrix.pendingInvites?.()) ?? []);
    } catch { /* fail-soft: no invite section */ }
  }

  /** Accept a pending invite: join the room, drop its row locally, then
   *  refresh the joined lists so the room moves into Rooms/People. The local
   *  drop is authoritative — the server acknowledged the join, so the invite
   *  is resolved; re-fetching pendingInvites() here could race a lagging sync
   *  and resurrect the row (decline uses the same local-drop rule). Failures
   *  are ANNOUNCED. */
  async acceptInvite(inv: PendingInvite): Promise<void> {
    this.inviteError.set('');
    try {
      await this.matrix.joinRoom(inv.roomId);
      this.invites.update((list) => list.filter((i) => i.roomId !== inv.roomId));
      await this.reload();
    } catch (e: any) {
      this.inviteError.set(`Could not accept the invite to "${inv.name}": ${e?.message ?? e}`);
    }
  }

  /** Decline a pending invite (Matrix decline = leave the invited room).
   *  Failures are ANNOUNCED; the row only disappears on server success. */
  async declineInvite(inv: PendingInvite): Promise<void> {
    this.inviteError.set('');
    try {
      await this.matrix.leaveRoom(inv.roomId);
      this.invites.update((list) => list.filter((i) => i.roomId !== inv.roomId));
    } catch (e: any) {
      this.inviteError.set(`Could not decline the invite to "${inv.name}": ${e?.message ?? e}`);
    }
  }

  inviteBg(inv: PendingInvite): string {
    return inv.avatarUrl ? `url(${this.matrix.mxcToHttp(inv.avatarUrl, { thumbnail: true, w: 24, h: 24 })})` : '';
  }

  trackInvite = (_: number, inv: PendingInvite) => inv.roomId;

  bg(r: MatrixRoom): string {
    return r.avatarUrl ? `url(${this.matrix.mxcToHttp(r.avatarUrl, { thumbnail: true, w: 24, h: 24 })})` : '';
  }

  select(r: MatrixRoom): void {
    this.roomSelected.emit(r);
  }

  async create(ev: Event): Promise<void> {
    ev.preventDefault();
    this.submittedCreate.set(true);
    this.createError.set('');
    if (!this.newName.trim()) return;
    // Parse the optional invite list: comma/whitespace separated Matrix user
    // ids. A malformed entry is rejected UP FRONT naming the bad value — the
    // homeserver would 400 the whole create otherwise, losing the dialog state
    // with a far less actionable message.
    const invites = this.newInvites.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    const bad = invites.find((u) => !u.startsWith('@'));
    if (bad) {
      this.createError.set(`"${bad}" is not a Matrix user id — invitees must look like @user:server.`);
      return;
    }
    // Domain-locked defence-in-depth (mirrors startDm): a PROVABLY cross-domain
    // invitee is rejected up front with the why-notice; the homeserver MRF is
    // the source of truth and enforces the same thing server-side.
    if (this.domainLocked()) {
      for (const u of invites) {
        if (await this.isCrossDomain(u)) {
          this.createError.set(`Cannot invite "${u}" — they are on another server. ${this.lockWhy}`);
          return;
        }
      }
    }
    try {
      await this.matrix.createRoom({
        name: this.newName.trim(),
        topic: this.newTopic.trim() || undefined,
        preset: this.newPreset,
        room_alias_name: this.newAlias.trim() || undefined,
        invite: invites.length ? invites : undefined,
      });
    } catch (e: any) {
      // ANNOUNCED failure — the dialog stays open with its state intact so
      // the user can correct and retry (never silently swallowed).
      this.createError.set(
        `Could not create the room "${this.newName.trim()}": ${e?.message ?? e}.` +
          (this.domainLocked() ? ` ${this.lockWhy}` : ''),
      );
      return;
    }
    this.newName = this.newTopic = this.newAlias = this.newInvites = '';
    this.submittedCreate.set(false);
    this.showCreate.set(false);
    await this.reload();
  }

  async startDm(ev: Event): Promise<void> {
    ev.preventDefault();
    const user = this.dmUser.trim();
    if (!user) return;
    this.dmError.set('');
    // Domain-locked defence-in-depth: a PROVABLY cross-domain DM target is
    // rejected up front with the why-notice (the homeserver MRF is the source
    // of truth and enforces the same thing server-side). Local targets are
    // never blocked here.
    if (this.domainLocked() && (await this.isCrossDomain(user))) {
      this.dmError.set(`Cannot start a direct message with "${user}" — they are on another server. ${this.lockWhy}`);
      return;
    }
    try {
      const roomId = await this.matrix.createRoom({ is_direct: true, invite: [user], preset: 'trusted_private_chat' });
      const me = await this.matrix.whoami();
      if (me) {
        const md = (await this.matrix.getAccountData<Record<string, string[]>>(me, 'm.direct')) ?? {};
        md[user] = [...(md[user] ?? []), roomId];
        await this.matrix.setAccountData(me, 'm.direct', md);
      }
      this.dmUser = '';
      this.showDm.set(false);
      await this.reload();
    } catch (e: any) {
      // ANNOUNCED failure — for a domain-locked caller the server-side
      // rejection is explained by the lock (never silently swallowed).
      this.dmError.set(
        `Could not start a direct message with "${user}": ${e?.message ?? e}.` +
          (this.domainLocked() ? ` ${this.lockWhy}` : ''),
      );
    }
  }

  async joinByAlias(): Promise<void> {
    const a = this.joinAlias.trim();
    if (!a) return;
    this.joinError.set('');
    // Domain-locked defence-in-depth: a PROVABLY cross-domain alias/id is
    // rejected up front with the why-notice; otherwise the join is attempted
    // and a server-side rejection is announced (the homeserver MRF decides).
    if (this.domainLocked() && (await this.isCrossDomain(a))) {
      this.joinError.set(`"${a}" is on another server. ${this.lockWhy}`);
      return;
    }
    try {
      await this.matrix.joinRoom(a);
      this.joinAlias = '';
      await this.reload();
    } catch (e: any) {
      this.joinError.set(
        `Could not join "${a}": ${e?.message ?? e}.` + (this.domainLocked() ? ` ${this.lockWhy}` : ''),
      );
    }
  }

  /** True when the target's server part is KNOWN to differ from the caller's
   *  own homeserver. Unknowable cases (no server part, whoami unavailable)
   *  return false so the defence-in-depth gate never blocks a local action. */
  private async isCrossDomain(target: string): Promise<boolean> {
    const targetServer = this.serverOf(target);
    if (!targetServer) return false;
    const me = await this.matrix.whoami().catch(() => null);
    const myServer = me ? this.serverOf(me) : null;
    return !!myServer && targetServer !== myServer;
  }

  /** The server part of a Matrix id/alias (`@u:server` / `#a:server` / `!r:server`). */
  private serverOf(id: string): string | null {
    const i = id.indexOf(':');
    return i > 0 ? id.slice(i + 1) : null;
  }
}
