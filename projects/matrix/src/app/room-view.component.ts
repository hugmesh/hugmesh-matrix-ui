import { Component, Input, OnChanges, OnDestroy, OnInit, Signal, SimpleChanges, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatrixService, ReadReceiptMap, RoomMember, RoomSummary, SyncRoomFeed, TimelineEvent, mergeSyncRoom } from './matrix.service';
import { TimelineComponent } from './timeline.component';
import { ComposerComponent } from './composer.component';
import { HugCharacterPanelComponent } from './vn/hug-character-panel.component';
import { DEFAULT_EXPRESSION, Expression, expressionForEvent } from './vn/expression';
import { ChatThemeRootDirective } from './theme/chat-theme-root.directive';
import { Chat3dStateService } from './chat3d/chat3d-state.service';
import { mountRoute } from './mount-route';
import { VIEW_RELOAD_EVENT } from './shell-events';

type ComposerMode = 'send' | 'reply' | 'edit' | 'thread';

/**
 * Element Web RoomView: header (name/topic/avatar/member count + settings/search/
 * member buttons) hosting <hug-timeline> + <hug-composer> and a typing
 * indicator. Drives read receipts / read markers for the latest event. Deep
 * linkable per room (rooms/:roomId), falling back to ?room= for host compat.
 */
@Component({
  selector: 'hug-room-view',
  standalone: true,
  imports: [CommonModule, RouterLink, TimelineComponent, ComposerComponent, HugCharacterPanelComponent],
  // Chat-theme root: covers the deep-linked rooms/:roomId route (when embedded
  // by the chat shell both hosts carry the same attributes — harmless).
  hostDirectives: [ChatThemeRootDirective],
  templateUrl: './room-view.component.html',
  styleUrl: './room-view.component.scss',
})
export class RoomViewComponent implements OnInit, OnChanges, OnDestroy {
  /** This remote's mount point — in-app links resolve against it
   *  (see mount-route.ts: absolute links bounce out of the remote). */
  readonly mount = mountRoute();
  /** Long-poll window for the standalone route's own sync (matches the chat
   *  shell's, so both hold the connection for the same duration). */
  private static readonly SYNC_TIMEOUT_MS = 30000;
  /** Pause before retrying after a rejected/failed sync — without it a hard
   *  failure turns the long-poll into a hot loop. */
  private static readonly SYNC_BACKOFF_MS = 2000;

  private readonly matrix = inject(MatrixService);
  private readonly route = inject(ActivatedRoute);
  private readonly chat3d = inject(Chat3dStateService);

  /** When embedded by the chat shell, the host passes the room id directly. */
  @Input() roomIdInput: string | null = null;

  /**
   * The host-supplied live feed, held in a signal OF the feed signal.
   *
   * TWO bugs live here, both of which showed up as "my message sends but never
   * appears":
   *
   *  1. REACTIVE CAPTURE. `liveEvents` is a computed that reads
   *     `this.syncRoom()`. If it is ever evaluated while `syncRoom` is still the
   *     default placeholder signal — a signal that by construction never changes
   *     — the computed caches `null` against a dead producer and NEVER
   *     recomputes, no matter how many deltas the host pushes afterwards.
   *     Wrapping the input in its own signal makes the ASSIGNMENT itself a
   *     tracked change, so the computeds re-run when the real feed arrives
   *     regardless of evaluation order.
   *  2. NO FEED AT ALL on the deep-link route. `rooms/:roomId` renders this
   *     component directly (room-list links straight to it), and nothing binds
   *     `syncRoom` there — so the timeline was frozen at its initial history
   *     page for the whole visit. See {@link ownSyncLoop}.
   */
  private readonly hostFeed = signal<Signal<{ timeline: TimelineEvent[]; typing: string[]; receipts?: ReadReceiptMap } | null> | null>(null);

  /** Live sync feed (timeline events + typing + folded read receipts) for this
   *  room, optional. May be a writable or computed signal depending on the
   *  host. `receipts` is the latest-read-per-user map the timeline's "seen by"
   *  indicator anchors each reader's avatar from. */
  @Input()
  set syncRoom(feed: Signal<{ timeline: TimelineEvent[]; typing: string[]; receipts?: ReadReceiptMap } | null>) {
    this.hostFeed.set(feed);
  }
  get syncRoom(): Signal<{ timeline: TimelineEvent[]; typing: string[]; receipts?: ReadReceiptMap } | null> {
    return this.hostFeed() ?? this.ownFeed;
  }

  /** This component's OWN feed, driven by {@link ownSyncLoop} and used only when
   *  no host bound `syncRoom` (the `rooms/:roomId` deep-link route). */
  private readonly ownFeed = signal<SyncRoomFeed | null>(null);

  readonly roomId = signal<string | null>(null);
  readonly summary = signal<RoomSummary | null>(null);
  readonly me = signal<string | null>(null);
  readonly memberCount = signal(0);
  /** Joined members, kept so the timeline can resolve a read-receipt user id to
   *  a display name + avatar for the "Read by <name>" indicator. */
  readonly members = signal<RoomMember[]>([]);

  /** Whether this room's `net.hugmesh.chat3d` state parses ENABLED —
   *  the 3D-room button renders only then (an off/unset/unreadable state
   *  simply hides the door; the join route re-checks for deep links). */
  readonly chat3dEnabled = signal(false);

  /** The ACTIVE feed value: the host's when one is bound, else this component's
   *  own loop. Reading `hostFeed()` inside the computed is what makes the input
   *  assignment a tracked dependency (see {@link hostFeed}); every derived
   *  signal below goes through here so none of them can capture a dead
   *  producer. */
  private readonly feed = computed(() => (this.hostFeed() ?? this.ownFeed)());

  /** The latest-read-per-user map the timeline renders the "seen by" indicator
   *  from (empty until a delta carries receipts). */
  readonly readReceipts = computed<ReadReceiptMap>(() => this.feed()?.receipts ?? {});

  readonly composerMode = signal<ComposerMode>('send');
  readonly composerTarget = signal<TimelineEvent | null>(null);

  readonly liveEvents = computed(() => this.feed()?.timeline ?? null);
  readonly typingUsers = computed(() => (this.feed()?.typing ?? []).filter((u) => u !== this.me()));

  // ── VN live character (B2, Path A) ───────────────────────────────────────
  // The latest message-bearing timeline event drives an OPTIONAL character
  // beside the timeline: its sender owns the character, its content the
  // expression. Non-message events (typing/receipts/state) never re-trigger it.
  /** The newest `m.room.message` in the live timeline (the expression trigger). */
  readonly latestMessage = computed<TimelineEvent | null>(() => {
    const events = this.liveEvents();
    if (!events) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === 'm.room.message' && !ev.redacted) return ev;
    }
    return null;
  });
  /** The sender whose character the panel shows (null ⇒ panel hidden). */
  readonly characterOwner = signal<string | null>(null);
  /** That sender's visible display name (alt text only). */
  readonly characterOwnerName = signal<string | null>(null);
  /** That sender's ASCII screen-reader name (announced over the display name). */
  readonly characterOwnerSrName = signal<string | null>(null);
  /** The live expression: `vn.expression` > sentiment > `neutral` (B2 priority). */
  readonly characterExpression = signal<Expression>(DEFAULT_EXPRESSION);

  private sub?: { unsubscribe(): void };
  /** Whether {@link ownSyncLoop} should keep polling (false under the chat shell
   *  and after destroy). */
  private ownLoopRunning = false;
  /** The event id we last advertised a read receipt for, so the send-on-view
   *  effect fires ONCE per newly-arrived latest event (not on every re-render). */
  private lastReadEventId: string | null = null;
  /** m.room.member event ids the roster-refresh effect has already processed,
   *  so each membership change triggers exactly ONE joinedMembers refetch —
   *  the live feed re-emits the whole timeline array on every delta, and
   *  without this dedupe every unrelated message would refetch the roster. */
  private readonly seenMemberEventIds = new Set<string>();

  constructor() {
    // React to each new timeline message: derive the owner + expression that
    // drive <hug-character-panel>. Pure signal math — the panel itself
    // resolves the pack (fail-soft) and renders nothing when there is none.
    effect(() => {
      const ev = this.latestMessage();
      if (!ev) {
        this.characterOwner.set(null);
        return;
      }
      this.characterOwner.set(ev.sender);
      this.characterOwnerName.set(ev.senderDisplayName ?? ev.sender);
      this.characterOwnerSrName.set(ev.senderScreenReaderName ?? null);
      this.characterExpression.set(expressionForEvent(ev.content, ev.body));
    });

    // SEND-ON-VIEW: as the live sync feed delivers a new newest event for the
    // room currently on screen, advertise our own read position up to it
    // (sendReceipt m.read + setReadMarker) — this is what makes OUR avatar the
    // "seen by" indicator on OTHER members' screens. Deduped by lastReadEventId
    // so a re-render of the same latest event never re-sends; fail-soft.
    effect(() => {
      const id = this.roomId();
      const events = this.liveEvents();
      if (!id || !events || !events.length) return;
      const latest = events[events.length - 1];
      if (!latest || latest.eventId === this.lastReadEventId) return;
      this.lastReadEventId = latest.eventId;
      void this.markRead(id, latest.eventId);
    });

    // LIVE ROSTER: members/memberCount load once in load(id), so anyone who
    // joins AFTER the room is opened never appears — the roster the timeline
    // resolves sender names/avatars from and the "{{N}} members" header both
    // go stale (a new joiner's messages would show their raw mxid). Watch the
    // live feed for m.room.member events and re-fetch the joined roster once
    // per NEW membership event (deduped by eventId — the feed re-emits the
    // whole array every delta). Fail-soft: a rejected refetch keeps the last
    // known roster rather than blanking it.
    effect(() => {
      const id = this.roomId();
      const events = this.liveEvents();
      if (!id || !events) return;
      let changed = false;
      for (const ev of events) {
        if (ev.type !== 'm.room.member' || this.seenMemberEventIds.has(ev.eventId)) continue;
        this.seenMemberEventIds.add(ev.eventId);
        changed = true;
      }
      if (changed) void this.refreshMembers(id);
    });
  }

  /** Re-fetch the joined roster after a live membership change (fail-soft —
   *  a rejected fetch keeps the previous roster; shared shape with load()). */
  private async refreshMembers(roomId: string): Promise<void> {
    try {
      const members = await this.matrix.joinedMembers(roomId);
      // STALE-ROOM GUARD: the user may have switched rooms while this fetch
      // was in flight; a late resolution for the PREVIOUS room must never
      // overwrite the CURRENT room's roster — the timeline resolves every
      // sender name/avatar from members(), so room B would caption its
      // messages with room A's identities.
      if (this.roomId() !== roomId) return;
      this.memberCount.set(members.length);
      this.members.set(members);
    } catch { /* ignore — keep the last known roster */ }
  }

  /** Advertise our read position up to `eventId` (public m.read receipt + the
   *  fully-read / read marker). Fail-soft: a rejected receipt never disrupts
   *  the view. Shared by the send-on-view effect and the post-send handler. */
  private async markRead(roomId: string, eventId: string): Promise<void> {
    this.lastReadEventId = eventId;
    try {
      await this.matrix.sendReceipt(roomId, eventId);
      await this.matrix.setReadMarker(roomId, eventId, eventId);
    } catch { /* ignore */ }
  }

  async ngOnInit(): Promise<void> {
    // FAIL-SOFT: whoami only garnishes the view (isMine highlighting); a
    // rejected fetch (BFF down, proxy answering non-JSON) must not sink this
    // await and skip the paramMap subscription below — that would blank the
    // ENTIRE room view instead of degrading it. Mirrors room-list's pattern.
    this.me.set(await this.matrix.whoami().catch(() => null));
    this.sub = this.route.paramMap.subscribe((pm) => {
      const fromRoute = pm.get('roomId');
      const fromQuery = this.route.snapshot.queryParamMap.get('room');
      const id = this.roomIdInput ?? fromRoute ?? fromQuery;
      if (id) void this.load(id);
    });

    // STANDALONE ROUTE: nothing bound `syncRoom`, so nobody is feeding this
    // view — run our own long-poll. Inputs are assigned BEFORE ngOnInit, so
    // `hostFeed()` being null here reliably means "no host". Under the chat
    // shell this is skipped and we keep consuming the shell's single loop, so
    // the two never both sync.
    if (this.hostFeed() === null) {
      this.ownLoopRunning = true;
      void this.ownSyncLoop();
    }

    // Shell RELOAD button: refresh in place rather than being torn down (the
    // shell also re-navigates, but a soft refresh keeps the composer draft and
    // scroll position when the re-navigation resolves to the same component).
    if (typeof window !== 'undefined') {
      window.addEventListener(VIEW_RELOAD_EVENT, this.onShellReload);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['roomIdInput'] && this.roomIdInput) void this.load(this.roomIdInput);
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.ownLoopRunning = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener(VIEW_RELOAD_EVENT, this.onShellReload);
    }
  }

  /** Re-read the room's summary/roster on the shell's reload signal. Bound as a
   *  property so add/removeEventListener see the SAME function reference — a
   *  method reference would be a new bound function each call and never
   *  unregister. */
  private readonly onShellReload = (): void => {
    const id = this.roomId();
    if (id) void this.load(id);
  };

  /**
   * The deep-link route's OWN live feed. A room opened at `rooms/:roomId` is not
   * inside the 3-pane shell, so no sync loop is feeding it: without this the
   * timeline showed the initial history page and nothing else for the whole
   * visit — the exact "sent messages don't appear" symptom, on the exact route
   * the room list links to.
   *
   * Deliberately a FULL sync (no room filter) rather than a per-room one: the
   * CS-API's `since` token is a whole-account cursor, so a filtered loop would
   * still advance it past OTHER rooms' events, and a later unfiltered consumer
   * in the same tab would silently skip them. We simply ignore the rooms we are
   * not showing.
   */
  private async ownSyncLoop(): Promise<void> {
    let since: string | undefined;
    while (this.ownLoopRunning) {
      try {
        const state = await this.matrix.sync(since, RoomViewComponent.SYNC_TIMEOUT_MS);
        // A rejected sync returns INSTANTLY with the empty placeholder, so
        // treating it as an ordinary empty delta would spin the loop.
        if (state.failed) {
          await new Promise((res) => setTimeout(res, RoomViewComponent.SYNC_BACKOFF_MS));
          continue;
        }
        since = state.nextBatch;
        const id = this.roomId();
        const delta = id ? state.rooms[id] : undefined;
        if (delta) this.ownFeed.update((prev) => mergeSyncRoom(prev, delta));
      } catch {
        await new Promise((res) => setTimeout(res, RoomViewComponent.SYNC_BACKOFF_MS));
      }
    }
  }

  private async load(id: string): Promise<void> {
    // roomId is set FIRST so the stale-room guards below (and the ones in
    // refreshMembers) compare against the room the user most recently picked:
    // a rapid A→B switch leaves load(A)'s awaits resolving AFTER load(B) has
    // already populated the view, and an unguarded write-back would overwrite
    // room B's summary/roster with room A's — the timeline resolves every
    // sender name/avatar from members(), so B's messages would carry A's
    // identities. Each write is guarded after ITS await (any await is a seam
    // a newer load can slip through).
    this.roomId.set(id);
    try {
      const summary = await this.matrix.roomSummary(id);
      if (this.roomId() !== id) return;
      this.summary.set(summary);
    } catch {
      if (this.roomId() !== id) return;
      this.summary.set(null);
    }
    try {
      const members = await this.matrix.joinedMembers(id);
      if (this.roomId() !== id) return;
      this.memberCount.set(members.length);
      // Keep the roster so the timeline can name a read-receipt author
      // ("Read by <name>") and render their avatar rather than a bare user id.
      this.members.set(members);
    } catch { /* ignore */ }
    // Fail-soft: the service resolves null on unset/denied/malformed — the
    // 3D-room button just stays hidden.
    const chat3d = await this.chat3d.getChat3dState(id);
    if (this.roomId() !== id) return;
    this.chat3dEnabled.set(chat3d?.enabled === true);
  }

  avatarBg(): string {
    const url = this.summary()?.avatarUrl;
    return url ? `url(${this.matrix.mxcToHttp(url, { thumbnail: true, w: 36, h: 36 })})` : '';
  }

  onReply(ev: TimelineEvent): void {
    this.composerTarget.set(ev);
    this.composerMode.set('reply');
  }

  onEdit(ev: TimelineEvent): void {
    this.composerTarget.set(ev);
    this.composerMode.set('edit');
  }

  onThread(ev: TimelineEvent): void {
    this.composerTarget.set(ev);
    this.composerMode.set('thread');
  }

  onModeReset(): void {
    this.composerTarget.set(null);
    this.composerMode.set('send');
  }

  async onSent(): Promise<void> {
    // Advance read marker / receipt to the latest visible event right after a
    // send (the sync feed's own send-on-view effect also covers this, but this
    // keeps the marker current even before the echo syncs back).
    const id = this.roomId();
    if (!id) return;
    try {
      const page = await this.matrix.messages(id, { dir: 'b', limit: 1 });
      const latest = page.events[page.events.length - 1] ?? page.events[0];
      if (latest) await this.markRead(id, latest.eventId);
    } catch { /* ignore */ }
  }
}
