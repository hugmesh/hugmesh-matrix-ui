import { Component, Input, OnChanges, OnDestroy, OnInit, Signal, SimpleChanges, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatrixService, ReadReceiptMap, RoomMember, RoomSummary, TimelineEvent } from './matrix.service';
import { TimelineComponent } from './timeline.component';
import { ComposerComponent } from './composer.component';
import { HugCharacterPanelComponent } from './vn/hug-character-panel.component';
import { DEFAULT_EXPRESSION, Expression, expressionForEvent } from './vn/expression';
import { ChatThemeRootDirective } from './theme/chat-theme-root.directive';
import { Chat3dStateService } from './chat3d/chat3d-state.service';

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
  private readonly matrix = inject(MatrixService);
  private readonly route = inject(ActivatedRoute);
  private readonly chat3d = inject(Chat3dStateService);

  /** When embedded by the chat shell, the host passes the room id directly. */
  @Input() roomIdInput: string | null = null;
  /** Live sync feed (timeline events + typing + folded read receipts) for this
   *  room, optional. May be a writable or computed signal depending on the
   *  host. `receipts` is the latest-read-per-user map the timeline's "seen by"
   *  indicator anchors each reader's avatar from. */
  @Input() syncRoom: Signal<{ timeline: TimelineEvent[]; typing: string[]; receipts?: ReadReceiptMap } | null> = signal(null);

  readonly roomId = signal<string | null>(null);
  readonly summary = signal<RoomSummary | null>(null);
  readonly me = signal<string | null>(null);
  readonly memberCount = signal(0);
  /** Joined members, kept so the timeline can resolve a read-receipt user id to
   *  a display name + avatar for the "Read by <name>" indicator. */
  readonly members = signal<RoomMember[]>([]);

  /** Whether this room's `systems.hugmesh.chat3d` state parses ENABLED —
   *  the 3D-room button renders only then (an off/unset/unreadable state
   *  simply hides the door; the join route re-checks for deep links). */
  readonly chat3dEnabled = signal(false);

  /** The latest-read-per-user map the timeline renders the "seen by" indicator
   *  from (empty when the host feeds no receipts / on the deep-link route). */
  readonly readReceipts = computed<ReadReceiptMap>(() => this.syncRoom()?.receipts ?? {});

  readonly composerMode = signal<ComposerMode>('send');
  readonly composerTarget = signal<TimelineEvent | null>(null);

  readonly liveEvents = computed(() => this.syncRoom()?.timeline ?? null);
  readonly typingUsers = computed(() => (this.syncRoom()?.typing ?? []).filter((u) => u !== this.me()));

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
  /** The event id we last advertised a read receipt for, so the send-on-view
   *  effect fires ONCE per newly-arrived latest event (not on every re-render). */
  private lastReadEventId: string | null = null;

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
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['roomIdInput'] && this.roomIdInput) void this.load(this.roomIdInput);
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private async load(id: string): Promise<void> {
    this.roomId.set(id);
    try {
      this.summary.set(await this.matrix.roomSummary(id));
    } catch { this.summary.set(null); }
    try {
      const members = await this.matrix.joinedMembers(id);
      this.memberCount.set(members.length);
      // Keep the roster so the timeline can name a read-receipt author
      // ("Read by <name>") and render their avatar rather than a bare user id.
      this.members.set(members);
    } catch { /* ignore */ }
    // Fail-soft: the service resolves null on unset/denied/malformed — the
    // 3D-room button just stays hidden.
    const chat3d = await this.chat3d.getChat3dState(id);
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
