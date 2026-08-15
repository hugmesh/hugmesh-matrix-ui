import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatrixService, MatrixRoom, SyncRoomFeed, mergeSyncRoom } from './matrix.service';
import { RoomListComponent } from './room-list.component';
import { RoomViewComponent } from './room-view.component';
import { ChatThemeRootDirective } from './theme/chat-theme-root.directive';
import { mountRoute } from './mount-route';
import { ClientConnectBannerComponent } from './client-connect/client-connect-banner.component';
import { VIEW_RELOAD_EVENT } from './shell-events';
import { MemberListComponent } from './member-list.component';
import { wideViewport } from './wide-viewport';

/**
 * Standalone Matrix chat shell. Federated into the hugmesh.net host and
 * rendered at /social/matrix for logged-in users. Evolved from the original
 * polled chat into a 3-pane Element-like shell: <hug-room-list> on the left and
 * <hug-room-view> (timeline + composer) in the center, driven by a sync()
 * long-poll loop. Room selection follows the ?room= query param (preserving the
 * original behaviour) and falls back to the first joined room.
 *
 * The embedded <hug-room-view> renders the matrix-log / matrix-input /
 * matrix-send testids the E2E depends on; this shell keeps matrix-view /
 * matrix-whoami at the default route.
 */
@Component({
  selector: 'hug-matrix-chat',
  standalone: true,
  imports: [CommonModule, RouterLink, RoomListComponent, RoomViewComponent, ClientConnectBannerComponent,
    MemberListComponent],
  // The shell host doubles as a chat-theme root: ChatThemeService stamps the
  // user's data-matrix-*/--hugm-chat-* theming here (never on <body>), scoped
  // by the :host rules this component's stylesheet includes.
  hostDirectives: [ChatThemeRootDirective],
  templateUrl: './matrix-chat.component.html',
  styleUrl: './matrix-chat.component.scss',
})
export class MatrixChatComponent implements OnInit, OnDestroy {
  /** Whether there is spare width for the members pane beside list + timeline. */
  readonly showMembersPane = wideViewport();

  /** This remote's mount point — in-app links resolve against it
   *  (see mount-route.ts: absolute links bounce out of the remote). */
  readonly mount = mountRoute();
  /** Pause before retrying after a rejected/failed sync, so one bad response
   *  cannot turn the long-poll into a hot loop. */
  private static readonly SYNC_BACKOFF_MS = 2000;

  private readonly matrix = inject(MatrixService);
  private readonly route = inject(ActivatedRoute);

  readonly userId = signal<string | null>(null);
  readonly rooms = signal<MatrixRoom[]>([]);
  readonly current = signal<MatrixRoom | null>(null);

  /** Per-room live timeline + typing + folded read receipts from the sync loop.
   *  `receipts` is the running latest-read-per-user map (mergeReadReceipts),
   *  NOT the raw per-delta receipts — a reader's position moves forward across
   *  incremental syncs, so it must be accumulated, never replaced per delta. */
  private readonly syncRooms = signal<Record<string, SyncRoomFeed>>({});
  readonly currentSync = computed(() => {
    const id = this.current()?.roomId;
    return id ? (this.syncRooms()[id] ?? null) : null;
  });

  private since: string | undefined;
  private running = false;
  private querySub?: { unsubscribe(): void };

  async ngOnInit(): Promise<void> {
    this.userId.set(await this.matrix.whoami());
    const rooms = await this.matrix.joinedRoomsDetailed();
    this.rooms.set(rooms);

    // REACTIVE ?room=: a snapshot read here would only honour the query param
    // present at init — later in-app navigation (a room link, the call view's
    // back-link) changed the URL but never the selected room. Subscribing
    // keeps selection following the param for the component's lifetime; the
    // FIRST emission covers what the old snapshot read did (rooms are already
    // loaded above, so the lookup can match a joined room). Mirrors the
    // paramMap subscription room-view.component holds and tears down.
    // Only ACT when the param VALUE changes: Angular re-emits queryParamMap on
    // every same-route navigation, so a future navigation that merely carries
    // the old ?room= along (e.g. queryParamsHandling: 'merge' adding an
    // unrelated param) would otherwise snap selection back to a stale room the
    // user has already clicked away from. The sentinel starts as undefined —
    // distinct from the null of "no param" — so the FIRST emission always acts.
    let lastSeenRoomParam: string | null | undefined;
    this.querySub = this.route.queryParamMap.subscribe((qm) => {
      const wanted = qm.get('room');
      if (wanted === lastSeenRoomParam) return;
      lastSeenRoomParam = wanted;
      if (wanted) {
        if (wanted !== this.current()?.roomId) {
          // A room we're not joined to (deep link) still selects a synthetic
          // row so the view can attempt to render/join it.
          this.select(this.rooms().find((r) => r.roomId === wanted) ?? { roomId: wanted, name: wanted });
        }
      } else if (!this.current()) {
        const first = this.rooms()[0];
        if (first) this.select(first);
      }
    });

    this.running = true;
    void this.syncLoop();

    // Shell RELOAD button: re-read the room list in place. The shell also
    // re-navigates the outlet (which re-creates this component), but the
    // in-place refresh lands FIRST and costs nothing, and it is the only path
    // that works when this remote runs standalone (`ng serve matrix`).
    if (typeof window !== 'undefined') {
      window.addEventListener(VIEW_RELOAD_EVENT, this.onShellReload);
    }
  }

  ngOnDestroy(): void {
    this.running = false;
    this.querySub?.unsubscribe();
    if (typeof window !== 'undefined') {
      window.removeEventListener(VIEW_RELOAD_EVENT, this.onShellReload);
    }
  }

  /** Re-fetch the joined room list on the shell's reload signal. A property (not
   *  a method) so add/removeEventListener share one function reference. Goes
   *  through mergeCounts so a refresh never wipes the folded unread badges. */
  private readonly onShellReload = (): void => {
    void this.matrix.joinedRoomsDetailed()
      .then((rooms) => this.rooms.set(this.mergeCounts(rooms)))
      .catch(() => { /* keep the last known list rather than blanking it */ });
  };

  onRooms(rooms: MatrixRoom[]): void {
    this.rooms.set(this.mergeCounts(rooms));
  }

  /** Carry unread/highlight badge counts forward from the current rooms() rows
   *  onto a freshly-fetched room list. joinedRoomsDetailed() hydrates rows from
   *  state + account data and NEVER sees unread counts — those only ride /sync
   *  deltas, and a delta only mentions rooms with NEW activity — so replacing
   *  rooms() with fresh rows verbatim would wipe every folded badge and nothing
   *  would ever restore them. Fresh rows with no previous counterpart (a
   *  just-appeared room) keep their (empty) counts until a delta supplies some. */
  private mergeCounts(fresh: MatrixRoom[]): MatrixRoom[] {
    const previous = new Map(this.rooms().map((r) => [r.roomId, r]));
    return fresh.map((r) => {
      const prev = previous.get(r.roomId);
      return prev ? { ...r, unreadCount: prev.unreadCount, highlightCount: prev.highlightCount } : r;
    });
  }

  select(room: MatrixRoom): void {
    this.current.set(room);
    // Clicking a room clears its badge IMMEDIATELY: the on-screen room is
    // being read, and waiting for the server to fold our read receipt into
    // the next sync delta would leave a stale badge for a visible beat.
    if (room.unreadCount || room.highlightCount) {
      this.rooms.update((rooms) => rooms.map((r) =>
        r.roomId === room.roomId ? { ...r, unreadCount: 0, highlightCount: 0 } : r,
      ));
    }
  }

  /** Replaces the original 1.5s setInterval poll with a long-poll sync loop
   *  feeding per-room signals. */
  private async syncLoop(): Promise<void> {
    while (this.running) {
      try {
        const state = await this.matrix.sync(this.since, 30000);
        // A REJECTED sync (401 after the session expired, a 503 from the
        // hsproxy) resolves INSTANTLY with the empty placeholder — it does not
        // throw — so without this back-off the loop re-requested with zero delay
        // and pinned a core while hammering the BFF for the life of the tab.
        if (state.failed) {
          await new Promise((res) => setTimeout(res, MatrixChatComponent.SYNC_BACKOFF_MS));
          continue;
        }
        this.since = state.nextBatch;
        const next: Record<string, SyncRoomFeed> = { ...this.syncRooms() };
        for (const roomId of Object.keys(state.rooms)) {
          // Shared fold (append+dedupe timeline, replace typing, accumulate
          // receipts) — see mergeSyncRoom: the deep-linked room view runs the
          // SAME merge on its own feed, and the two must not drift.
          next[roomId] = mergeSyncRoom(next[roomId], state.rooms[roomId]);
        }
        this.syncRooms.set(next);
        // UNREAD BADGES: fold each delta's unread/highlight counts into the
        // room rows — sync() has always parsed them, but they never reached
        // rooms(), leaving room-list's unread badge permanently dead markup.
        // The CURRENTLY SELECTED room is forced to 0: it is being read on
        // screen (our own receipts zero it server-side on the next delta;
        // forcing it here avoids a one-delta badge flicker). Rooms absent
        // from this delta keep their existing counts, and so do rooms whose
        // delta carries UNDEFINED counts — the CS-API allows a joined-room
        // delta without an unread_notifications block (purely ephemeral
        // typing/receipt deltas; ruma-based servers skip-serialize empty
        // blocks), and that absence means "no change", NOT zero.
        this.rooms.update((rooms) => rooms.map((r) => {
          const delta = state.rooms[r.roomId];
          if (!delta) return r;
          const onScreen = r.roomId === this.current()?.roomId;
          return {
            ...r,
            unreadCount: onScreen ? 0 : (delta.unreadCount ?? r.unreadCount),
            highlightCount: onScreen ? 0 : (delta.highlightCount ?? r.highlightCount),
          };
        }));
        // Refresh the room list (names) when new rooms appear — through
        // mergeCounts, because the fresh rows carry no unread counts and a
        // verbatim set() would wipe every badge folded above for good.
        if (Object.keys(state.rooms).some((id) => !this.rooms().find((r) => r.roomId === id))) {
          this.rooms.set(this.mergeCounts(await this.matrix.joinedRoomsDetailed()));
        }
      } catch {
        // Back off briefly on transient sync failure.
        await new Promise((res) => setTimeout(res, MatrixChatComponent.SYNC_BACKOFF_MS));
      }
    }
  }
}
