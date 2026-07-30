import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatrixService, MatrixRoom, ReadReceiptMap, TimelineEvent, mergeReadReceipts } from './matrix.service';
import { RoomListComponent } from './room-list.component';
import { RoomViewComponent } from './room-view.component';
import { ChatThemeRootDirective } from './theme/chat-theme-root.directive';

/**
 * Standalone Matrix chat shell. Federated into the hugmesh.systems host and
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
  imports: [CommonModule, RouterLink, RoomListComponent, RoomViewComponent],
  // The shell host doubles as a chat-theme root: ChatThemeService stamps the
  // user's data-matrix-*/--hugm-chat-* theming here (never on <body>), scoped
  // by the :host rules this component's stylesheet includes.
  hostDirectives: [ChatThemeRootDirective],
  templateUrl: './matrix-chat.component.html',
  styleUrl: './matrix-chat.component.scss',
})
export class MatrixChatComponent implements OnInit, OnDestroy {
  private readonly matrix = inject(MatrixService);
  private readonly route = inject(ActivatedRoute);

  readonly userId = signal<string | null>(null);
  readonly rooms = signal<MatrixRoom[]>([]);
  readonly current = signal<MatrixRoom | null>(null);

  /** Per-room live timeline + typing + folded read receipts from the sync loop.
   *  `receipts` is the running latest-read-per-user map (mergeReadReceipts),
   *  NOT the raw per-delta receipts — a reader's position moves forward across
   *  incremental syncs, so it must be accumulated, never replaced per delta. */
  private readonly syncRooms = signal<Record<string, { timeline: TimelineEvent[]; typing: string[]; receipts: ReadReceiptMap }>>({});
  readonly currentSync = computed(() => {
    const id = this.current()?.roomId;
    return id ? (this.syncRooms()[id] ?? null) : null;
  });

  private since: string | undefined;
  private running = false;

  async ngOnInit(): Promise<void> {
    this.userId.set(await this.matrix.whoami());
    const rooms = await this.matrix.joinedRoomsDetailed();
    this.rooms.set(rooms);

    const wanted = this.route.snapshot.queryParamMap.get('room');
    const pick = wanted
      ? (rooms.find((r) => r.roomId === wanted) ?? { roomId: wanted, name: wanted })
      : rooms[0];
    if (pick) this.select(pick);

    this.running = true;
    void this.syncLoop();
  }

  ngOnDestroy(): void {
    this.running = false;
  }

  onRooms(rooms: MatrixRoom[]): void {
    this.rooms.set(rooms);
  }

  select(room: MatrixRoom): void {
    this.current.set(room);
  }

  /** Replaces the original 1.5s setInterval poll with a long-poll sync loop
   *  feeding per-room signals. */
  private async syncLoop(): Promise<void> {
    while (this.running) {
      try {
        const state = await this.matrix.sync(this.since, 30000);
        this.since = state.nextBatch;
        const next: Record<string, { timeline: TimelineEvent[]; typing: string[]; receipts: ReadReceiptMap }> = { ...this.syncRooms() };
        for (const roomId of Object.keys(state.rooms)) {
          const r = state.rooms[roomId];
          const prev = next[roomId]?.timeline ?? [];
          // Append new timeline events, de-duped by eventId.
          const seen = new Set(prev.map((e) => e.eventId));
          const merged = [...prev];
          for (const e of r.timeline) if (!seen.has(e.eventId)) merged.push(e);
          // Fold this delta's receipts into the running latest-read-per-user
          // map so a reader whose receipt advanced re-anchors onto the newer
          // event (and drops off the older one) rather than showing on both.
          const receipts = mergeReadReceipts(next[roomId]?.receipts ?? {}, r.ephemeral.receipts);
          next[roomId] = { timeline: merged.slice(-200), typing: r.ephemeral.typing, receipts };
        }
        this.syncRooms.set(next);
        // Refresh the room list (names/unread) when new rooms appear.
        if (Object.keys(state.rooms).some((id) => !this.rooms().find((r) => r.roomId === id))) {
          this.rooms.set(await this.matrix.joinedRoomsDetailed());
        }
      } catch {
        // Back off briefly on transient sync failure.
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  }
}
