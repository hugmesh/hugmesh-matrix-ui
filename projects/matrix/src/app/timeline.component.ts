import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MESH_SENDER_PATTERN, MatrixService, Paginated, Reaction, ReadReceiptMap, RoomMember, TimelineEvent } from './matrix.service';
import { SessionService } from './session.service';
import { ReactionPickerComponent } from './reaction-picker.component';
import { accessibleName } from './accessible-name';
import { mountRoute } from './mount-route';

interface TimelineRow {
  event: TimelineEvent;
  dayLabel?: string;
}

/** One member's "seen by" indicator on a message row — the resolved presentation
 *  of a single read receipt (avatar/initial + accessible name). */
interface ReceiptChip {
  userId: string;
  /** Visible (possibly non-ASCII) member name; falls back to the user id. */
  name: string;
  /** ANNOUNCED name for the aria-label (ASCII screenReaderName when present). */
  ariaName: string;
  /** `url(...)` background for the avatar, or '' when the member has none. */
  avatarBg: string;
  /** Single-glyph fallback shown when there is no avatar image. */
  initial: string;
}

/**
 * Element Web TimelinePanel / MessagePanel. Renders m.room.message events with
 * sender + avatar, day separators, back-pagination, hover actions (react/reply/
 * thread/edit/delete), reaction pills, reply quotes, edited/redacted markers and
 * thread summary chips. Carries the `matrix-log` testid the E2E depends on.
 */
@Component({
  selector: 'hug-timeline',
  standalone: true,
  imports: [CommonModule, RouterLink, ReactionPickerComponent],
  templateUrl: './timeline.component.html',
  styleUrl: './timeline.component.scss',
})
export class TimelineComponent implements OnChanges {
  /** This remote's mount point — in-app links resolve against it
   *  (see mount-route.ts: absolute links bounce out of the remote). */
  readonly mount = mountRoute();
  private readonly matrix = inject(MatrixService);
  private readonly session = inject(SessionService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  @Input() roomId = '';
  /** Live events from the host sync loop (newest appended). Optional. */
  @Input() liveEvents: TimelineEvent[] | null = null;
  @Input() me: string | null = null;
  /** Latest-read-per-user map (mergeReadReceipts output) driving the "seen by"
   *  read-receipt indicator: each member's avatar anchors on the single event
   *  their receipt points at. */
  @Input() receipts: ReadReceiptMap = {};
  /** Joined roster, used to resolve a read-receipt user id to a display name +
   *  avatar (and ASCII screen-reader name) for the indicator. */
  @Input() members: RoomMember[] = [];

  @Output() reply = new EventEmitter<TimelineEvent>();
  @Output() edit = new EventEmitter<TimelineEvent>();
  @Output() thread = new EventEmitter<TimelineEvent>();

  private readonly loaded = signal<TimelineEvent[]>([]);
  private readonly live = signal<TimelineEvent[]>([]);
  private readonly receiptMap = signal<ReadReceiptMap>({});
  private readonly memberList = signal<RoomMember[]>([]);
  private readonly startToken = signal<string>('');
  readonly canPaginate = signal(true);
  readonly pickerFor = signal<string | null>(null);
  /** True when the initial history fetch was REJECTED (403/401 — typically a
   *  non-member deep-linking into a room they cannot see). Renders an explicit
   *  denied notice instead of a silently-empty log, so "no messages yet" and
   *  "you may not read this room" are never conflated. */
  readonly loadDenied = signal(false);

  imageUrls: Record<string, string> = {};
  fileUrls: Record<string, string> = {};

  /** Merged, de-duped, oldest-first message events with aggregated reactions.
   *  Renders m.room.message AND m.sticker: per MSC2545 a sticker is its OWN
   *  top-level event type (body + mxc url + info), NOT an m.room.message
   *  msgtype — filtering to m.room.message alone made every sent sticker
   *  invisible to the sender and every member (the picker's send-half had no
   *  render-half). */
  readonly rows = computed<TimelineRow[]>(() => {
    const map = new Map<string, TimelineEvent>();
    for (const e of this.loaded()) map.set(e.eventId, e);
    for (const e of this.live()) map.set(e.eventId, e);
    const merged = [...map.values()]
      .filter((e) => e.type === 'm.room.message' || e.type === 'm.sticker')
      .sort((a, b) => a.originServerTs - b.originServerTs);
    const out: TimelineRow[] = [];
    let lastDay = '';
    for (const e of merged) {
      const day = new Date(e.originServerTs).toDateString();
      const row: TimelineRow = { event: e };
      if (day !== lastDay) { row.dayLabel = day; lastDay = day; }
      out.push(row);
    }
    return out;
  });

  /**
   * Read-receipt render mapping: eventId → the members (excluding me) whose
   * LATEST read receipt anchors on that event — the "seen by" indicator. Built
   * by inverting the latest-read-per-user map so each reader appears on exactly
   * ONE event (the one their receipt points at), never on an earlier or later
   * one. Chips are sorted by name for a stable, deterministic order.
   */
  readonly readByEvent = computed<Record<string, ReceiptChip[]>>(() => {
    const map = this.receiptMap();
    const byEvent: Record<string, ReceiptChip[]> = {};
    for (const userId of Object.keys(map)) {
      // Never render our OWN read receipt — the "seen by" indicator is about
      // who ELSE has caught up to a message (Element convention).
      if (this.me && userId === this.me) continue;
      const eventId = map[userId].eventId;
      (byEvent[eventId] ??= []).push(this.receiptChip(userId));
    }
    for (const eventId of Object.keys(byEvent)) {
      byEvent[eventId].sort((a, b) => a.name.localeCompare(b.name));
    }
    return byEvent;
  });

  /** Resolve a read-receipt user id to its presentation (name/avatar/initial),
   *  reading the joined roster when the member is known and falling back to the
   *  bare user id otherwise. */
  private receiptChip(userId: string): ReceiptChip {
    const m = this.memberList().find((x) => x.userId === userId);
    const name = m?.displayName || userId;
    return {
      userId,
      name,
      ariaName: accessibleName(name, m?.screenReaderName),
      avatarBg: m?.avatarUrl ? `url(${this.matrix.mxcToHttp(m.avatarUrl, { thumbnail: true, w: 20, h: 20 })})` : '',
      initial: this.receiptInitial(name),
    };
  }

  /** First readable glyph for the avatar fallback: the leading alphanumeric of
   *  the display name, else the first localpart letter of the user id, upper-cased. */
  private receiptInitial(name: string): string {
    const source = name.replace(/^@/, '');
    const ch = (source.match(/[a-z0-9]/i)?.[0] ?? source.charAt(0) ?? '?');
    return ch.toUpperCase();
  }

  /** Whole-list aria summary for a row's receipt group, e.g. "Seen by Alice, Bob". */
  seenBySummary(chips: ReceiptChip[]): string {
    return `Seen by ${chips.map((c) => c.ariaName).join(', ')}`;
  }

  trackChip = (_: number, c: ReceiptChip) => c.userId;

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    if (changes['roomId'] && this.roomId) {
      this.loaded.set([]);
      this.live.set([]);
      this.startToken.set('');
      this.canPaginate.set(true);
      await this.loadInitial();
    }
    if (changes['liveEvents'] && this.liveEvents) {
      this.live.set(this.liveEvents);
      await this.hydrateMedia(this.liveEvents);
    }
    if (changes['receipts']) this.receiptMap.set(this.receipts ?? {});
    if (changes['members']) this.memberList.set(this.members ?? []);
  }

  private async loadInitial(): Promise<void> {
    this.loadDenied.set(false);
    let page: Paginated;
    try {
      page = await this.matrix.messages(this.roomId, { dir: 'b', limit: 50 });
    } catch {
      // History fetch rejected (non-member / signed-out deep link): show the
      // explicit denied notice rather than an indistinguishable empty log.
      this.loadDenied.set(true);
      this.canPaginate.set(false);
      return;
    }
    this.loaded.set(page.events);
    this.startToken.set(page.end);
    this.canPaginate.set(!!page.end);
    await this.aggregateReactions(page.events);
    await this.hydrateMedia(page.events);
  }

  async paginateBack(): Promise<void> {
    const from = this.startToken();
    let page: Paginated;
    try {
      page = await this.matrix.messages(this.roomId, { dir: 'b', from, limit: 50 });
    } catch {
      // Visibility revoked mid-session (matrix.service throws on 401/403):
      // stop offering pagination rather than crashing the back-scroll.
      this.canPaginate.set(false);
      return;
    }
    if (!page.events.length || !page.end) this.canPaginate.set(false);
    this.loaded.update((cur) => [...page.events, ...cur]);
    this.startToken.set(page.end);
    await this.aggregateReactions(page.events);
    await this.hydrateMedia(page.events);
  }

  /** Pull m.annotation relations per event to build reaction pills + thread counts. */
  private async aggregateReactions(events: TimelineEvent[]): Promise<void> {
    await Promise.all(events.map(async (e) => {
      if (e.type !== 'm.room.message') return;
      try {
        const annotations = await this.matrix.getRelations(this.roomId, e.eventId, 'm.annotation');
        const byKey = new Map<string, Reaction>();
        for (const a of annotations) {
          const key = a.relatesTo?.key ?? a.content?.['m.relates_to']?.key;
          if (!key) continue;
          const rx: Reaction = byKey.get(key) ?? { key, count: 0, senders: [] };
          rx.count++;
          rx.senders.push(a.sender);
          if (this.me && a.sender === this.me) rx.myEventId = a.eventId;
          byKey.set(key, rx);
        }
        e.reactions = [...byKey.values()];
        const threadReplies = await this.matrix.getRelations(this.roomId, e.eventId, 'm.thread');
        if (threadReplies.length) e.threadReplyCount = threadReplies.length;
      } catch { /* ignore */ }
    }));
    // trigger recompute
    this.loaded.update((v) => [...v]);
  }

  private async hydrateMedia(events: TimelineEvent[]): Promise<void> {
    for (const e of events) {
      const url = e.content?.url;
      if (!url || typeof url !== 'string' || !url.startsWith('mxc://')) continue;
      try {
        if (e.type === 'm.sticker') {
          // MSC2545 sticker: the content.url mxc is the sticker image itself,
          // rendered as an authenticated blob thumbnail like m.image.
          this.imageUrls[e.eventId] = await this.matrix.fetchMediaObjectUrl(url, { thumbnail: true, w: 160, h: 160, method: 'scale' });
        } else if (e.msgtype === 'm.image') {
          this.imageUrls[e.eventId] = await this.matrix.fetchMediaObjectUrl(url, { thumbnail: true, w: 240, h: 240, method: 'scale' });
        } else if (e.msgtype === 'm.file') {
          this.fileUrls[e.eventId] = await this.matrix.fetchMediaObjectUrl(url);
        }
      } catch { /* ignore */ }
    }
  }

  /** Whether this event is an MSC2545 m.sticker — rendered as an image whose
   *  accessible name carries the sticker body, with NO duplicate text row. */
  isSticker(e: TimelineEvent): boolean {
    return e.type === 'm.sticker';
  }

  /** Accessible name / alt for a rendered sticker image. */
  stickerAlt(e: TimelineEvent): string {
    return `Sticker: ${e.body || 'sticker'} from ${this.senderAriaName(e)}`;
  }

  trackRow = (_: number, r: TimelineRow) => r.event.eventId;

  /** Resolve a sender user id against the joined roster the host feeds in.
   *  Timeline events do NOT carry sender profile data (mapEvent never sets
   *  senderDisplayName/senderAvatarUrl — the CS-API events don't include it),
   *  so WITHOUT this lookup a group room shows raw @user:server mxids and
   *  blank avatars for every message. The roster is the same one receiptChip
   *  already resolves read-receipt readers from. */
  private memberOf(userId: string): RoomMember | undefined {
    return this.memberList().find((m) => m.userId === userId);
  }

  /** VISIBLE author name — the (possibly non-ASCII) display name as-is: the
   *  event's own senderDisplayName when a caller populated it, else the joined
   *  roster's display name, else the bare mxid (unknown/departed sender). */
  senderName(e: TimelineEvent): string {
    return e.senderDisplayName || this.memberOf(e.sender)?.displayName || e.sender;
  }

  /** ANNOUNCED author name for aria-label/alt — the ASCII screenReaderName when
   *  present (event fragment first, else the roster's), else the display name.
   *  Keeps the visible text UTF-8 while screen readers/tab order get the ASCII
   *  name (mirrors the server ScreenReaderNames rule via the shared
   *  {@link accessibleName} util). A mesh-bridged author is announced WITH its
   *  radio provenance ("… via LoRa mesh"), the same way the visible badge marks
   *  it, so screen-reader users are never told less. */
  senderAriaName(e: TimelineEvent): string {
    const name = accessibleName(this.senderName(e), e.senderScreenReaderName ?? this.memberOf(e.sender)?.screenReaderName);
    return this.isMeshEvent(e) ? `${name} via LoRa mesh` : name;
  }

  /** Whether this message arrived over the LoRa mesh: its sender lives in the
   *  bridge appservice's EXCLUSIVE @mesh-* namespace, OR the event carries a
   *  valid com.hugmesh.mesh provenance fragment (either alone suffices —
   *  a legacy bridge may omit the fragment). */
  isMeshEvent(e: TimelineEvent): boolean {
    return MESH_SENDER_PATTERN.test(e.sender ?? '') || !!e.mesh;
  }

  /** Compact badge text for a mesh-bridged message ("via LoRa mesh · !a1b2c3d4",
   *  or without the node id when no valid fragment came through). Null for an
   *  ordinary message — no badge is rendered. */
  meshBadge(e: TimelineEvent): string | null {
    if (!this.isMeshEvent(e)) return null;
    return e.mesh ? `via LoRa mesh · ${e.mesh.node}` : 'via LoRa mesh';
  }

  /** Badge title/tooltip: the radio details (node id, registration, RSSI/SNR
   *  when the bridge reported them) plus the honesty caution — LoRa node ids
   *  are a radio's SELF-REPORTED identity, never authenticated. */
  meshTitle(e: TimelineEvent): string {
    const parts = ['Received over the LoRa mesh bridge'];
    if (e.mesh) {
      parts.push(`node ${e.mesh.node}${e.mesh.registered ? ' (registered)' : ''}`);
      if (e.mesh.rssi !== undefined) parts.push(`RSSI ${e.mesh.rssi} dBm`);
      if (e.mesh.snr !== undefined) parts.push(`SNR ${e.mesh.snr} dB`);
    }
    return `${parts.join(', ')}. LoRa node ids are not cryptographically authenticated.`;
  }

  /** Author avatar `url(...)` background: the event's own senderAvatarUrl when
   *  a caller populated it, else the joined roster's avatar (events never carry
   *  one — see {@link memberOf}), else '' (the CSS initial fallback). */
  avatarBg(e: TimelineEvent): string {
    const url = e.senderAvatarUrl || this.memberOf(e.sender)?.avatarUrl;
    return url ? `url(${this.matrix.mxcToHttp(url, { thumbnail: true, w: 28, h: 28 })})` : '';
  }

  displayBody(e: TimelineEvent): string {
    const nc = e.content?.['m.new_content'];
    return (nc?.body ?? e.body ?? '').replace(/^\* /, '');
  }

  replyTo(e: TimelineEvent): string | null {
    const r = e.relatesTo?.['m.in_reply_to']?.event_id;
    if (r && e.relatesTo?.rel_type !== 'm.thread') return r;
    return null;
  }

  isMine(e: TimelineEvent): boolean {
    return !!this.me && e.sender === this.me;
  }

  /**
   * Whether the viewer may redact (Delete) this event: the AUTHOR always may
   * (self-redact), and a MOD/ADMIN tier (SessionService.isMod — additive, so an
   * admin qualifies too) may redact ANY member's message. Defence-in-depth only:
   * the homeserver still enforces the room's redact power level server-side, so
   * this gate must never OFFER the control to a plain user on someone else's
   * message — the moderation e2e asserts exactly that DENY.
   */
  canRedact(e: TimelineEvent): boolean {
    return this.isMine(e) || this.session.isMod();
  }

  myReactionMap(e: TimelineEvent): Record<string, string | undefined> {
    const map: Record<string, string | undefined> = {};
    for (const rx of e.reactions ?? []) if (rx.myEventId) map[rx.key] = rx.myEventId;
    return map;
  }

  openPicker(eventId: string): void {
    this.pickerFor.set(this.pickerFor() === eventId ? null : eventId);
  }

  /** Escape-dismiss from the reaction picker: close it and RESTORE focus to the
   *  React trigger that opened it (the APG "Escape returns focus to the button"
   *  contract — without this the keyboard user is stranded on a removed node). */
  dismissPicker(eventId: string): void {
    this.pickerFor.set(null);
    this.restoreReactFocus(eventId);
  }

  /** Move focus back to the React button for an event after its picker closes.
   *  Deferred to a microtask so it runs AFTER the picker is torn down (and after
   *  the picker's own open-time focus), guaranteeing the trigger — not the
   *  removed emoji or the document body — ends up focused (APG: Escape returns
   *  focus to the button). */
  private restoreReactFocus(eventId: string): void {
    queueMicrotask(() => {
      const btn = this.host.nativeElement.querySelector<HTMLButtonElement>(
        `[data-testid="btn-react-${eventId}"]`,
      );
      btn?.focus();
    });
  }

  async onReacted(eventId: string): Promise<void> {
    this.pickerFor.set(null);
    this.restoreReactFocus(eventId);
    const ev = this.rows().find((r) => r.event.eventId === eventId)?.event;
    if (ev) await this.aggregateReactions([ev]);
  }

  async toggleReaction(event: TimelineEvent, rx: Reaction): Promise<void> {
    if (rx.myEventId) {
      await this.matrix.redactEvent(this.roomId, rx.myEventId);
    } else {
      await this.matrix.sendReaction(this.roomId, event.eventId, rx.key);
    }
    await this.aggregateReactions([event]);
  }

  async del(event: TimelineEvent): Promise<void> {
    await this.matrix.redactEvent(this.roomId, event.eventId);
    event.redacted = true;
    this.loaded.update((v) => [...v]);
  }
}
