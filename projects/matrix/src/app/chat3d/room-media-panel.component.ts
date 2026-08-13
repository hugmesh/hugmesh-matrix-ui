import { Component, Input, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatrixService, TimelineEvent } from '../matrix.service';
import {
  DEFAULT_SCENE_MIN_POWER_LEVEL, parseRoomPowerLevels, requiredScenePowerLevel, senderPowerLevel,
} from '../vn/scenes/vn-scene-moderation';
import { Chat3dState } from './chat3d-state.service';
import {
  CHAT3D_SCENE_TYPE, Chat3dPlacement, Chat3dSceneService, MAX_PLACEMENT_LABEL_LENGTH,
  PlacementKind, STAGE_SURFACE_ID,
} from './chat3d-scene.service';

/** The scene's placeable surfaces, in display order (6 table + 4 screen + stage). */
export const PANEL_SURFACES: readonly string[] = [
  'table-1', 'table-2', 'table-3', 'table-4', 'table-5', 'table-6',
  'screen-1', 'screen-2', 'screen-3', 'screen-4',
  STAGE_SURFACE_ID,
];

/** LIMIT: most timeline events scanned for media (4 back-pages of 50). */
export const MEDIA_SCAN_EVENT_LIMIT = 200;
/** Page size of each /messages back-scroll fetch. */
export const MEDIA_SCAN_PAGE_SIZE = 50;
/** LIMIT: most thread roots listed. */
export const THREADS_LIMIT = 50;

/** One placeable channel item (media message, thread root, or pinned event). */
export interface MediaPanelItem {
  eventId: string;
  kind: PlacementKind;
  label: string;
  /** mxc of the underlying media (null for threads/plain pinned events). */
  mxcUri: string | null;
  section: 'media' | 'thread' | 'pinned';
}

/**
 * The 3D room's CHANNEL MEDIA panel (XR-chat DESIGN §6 Stage 2): lists the
 * room's recent media messages (back-paginated, capped), its thread roots and
 * its pinned events, and lets a member PLACE any of them onto a scene surface
 * (table-1..6 / screen-1..4 / stage) by writing the shared
 * `net.hugmesh.chat3d.scene` state — the host's poll then pushes the
 * placement (with texture bytes for images, a poster frame for video) into
 * the game. Placement here is the WRITE side; every guard on the RECEIVE side
 * (Chat3dSceneService's moderated read) still applies to whatever we write.
 *
 * GATING HONESTY (mesh-bridge control precedent) — three independent rules,
 * each offered-but-greyed with its OWN WHY-helptext, never hidden, so members
 * learn the rule instead of wondering:
 *   - `allowMedia` off ⇒ the whole placement surface is greyed;
 *   - the room's POWER LEVELS may not let me write the scene event at all
 *     (the enable flow requires level 50 whenever `stageModOnly` — its DEFAULT
 *     — so in a default room only moderators can place anything);
 *   - `stageModOnly` greys the stage option below moderator PL.
 *
 * VIDEO V1 is poster-frame + open-in-panel: the surface texture is the
 * server-side thumbnail; pressing Open plays the real file HERE in the panel
 * (authenticated object URL). Rendering live video as a WebGL texture inside
 * the game needs a DOM-overlay/video-texture bridge — documented follow-up,
 * out of v1 scope (DESIGN §10).
 */
@Component({
  selector: 'hug-chat3d-media-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './room-media-panel.component.html',
  styleUrl: './room-media-panel.component.scss',
})
export class RoomMediaPanelComponent implements OnInit, OnDestroy {
  private readonly matrix = inject(MatrixService);
  private readonly scene = inject(Chat3dSceneService);

  /** The Matrix room whose media/threads/pins are listed. */
  @Input({ required: true }) roomId!: string;
  /** The room's parsed chat3d config (allowMedia/stageModOnly gates). */
  @Input() config: Chat3dState | null = null;
  /** The placement the user last activated INSIDE the scene (game callback) —
   *  highlighted here so "click table → see which channel item it is" works. */
  @Input() activated: Chat3dPlacement | null = null;

  readonly surfaces = PANEL_SURFACES;
  readonly loading = signal(true);
  readonly mediaItems = signal<MediaPanelItem[]>([]);
  readonly threadItems = signal<MediaPanelItem[]>([]);
  readonly pinnedItems = signal<MediaPanelItem[]>([]);
  /** Non-empty after a refused/failed placement write (WHY, not silence). */
  readonly placeNote = signal('');
  /** My power level in the room (stage gate input). */
  private readonly myPowerLevel = signal(0);
  /**
   * The power level the room REQUIRES to send {@link CHAT3D_SCENE_TYPE} — the
   * per-event override, else `state_default`. NOT floored at moderator: this is
   * the homeserver's actual write rule, so it answers "will my PUT be accepted?"
   * rather than "would a receiver apply it?". -1 = not read yet / unreadable.
   */
  private readonly requiredScenePl = signal(-1);
  /** The open-in-panel viewer: an item + its authenticated object URL. */
  readonly viewer = signal<{ item: MediaPanelItem; url: string } | null>(null);

  /** Chosen target surface per eventId (the row's select model). */
  readonly chosenSurface: Record<string, string> = {};

  /** blob: URLs created for the viewer — revoked on destroy. */
  private objectUrls: string[] = [];

  /**
   * Whether the room's POWER LEVELS let me write the scene event at all.
   *
   * This is not a nicety: the chat3d enable flow writes
   * `events[chat3d.scene] = stageModOnly ? 50 : 0`, and `stageModOnly` DEFAULTS
   * ON — so in the default configuration an ordinary member's placement PUT is
   * refused by the homeserver outright. Ignoring the power level here offered
   * every PL-0 member a live Place button whose only possible outcome was a
   * failure note.
   *
   * Fail-OPEN while the level is unknown (-1): the homeserver is the real
   * authority and {@link place} surfaces a refusal honestly, so a transient
   * power-level read failure must not grey the panel out for everyone.
   */
  readonly canWriteScene = computed(() =>
    this.requiredScenePl() < 0 || this.myPowerLevel() >= this.requiredScenePl());
  /** Whether members may place at all (config gate AND the room's write rule —
   *  greyed + WHY below, never hidden). */
  readonly canPlace = computed(() => this.config?.allowMedia !== false && this.canWriteScene());
  /** Whether I clear the stage surface's moderator gate. */
  readonly canPlaceStage = computed(() =>
    this.config?.stageModOnly === false || this.myPowerLevel() >= DEFAULT_SCENE_MIN_POWER_LEVEL);

  /** WHY-helptext when placement is off for this room — the two reasons are
   *  different rules with different remedies, so they say different things. */
  readonly placeHelp = computed(() => {
    if (this.config?.allowMedia === false) {
      return 'Media placement is turned off for this room (allowMedia) — a room moderator can enable it in the room settings.';
    }
    if (!this.canWriteScene()) {
      return 'Only moderators can place media in this room: its power levels require level '
        + `${this.requiredScenePl()} to change the 3D scene and you are level ${this.myPowerLevel()}. `
        + 'Turning "Stage is moderator-only" off in the room settings opens placement to every member.';
    }
    return '';
  });
  /** WHY-helptext when the stage option is greyed for me. */
  readonly stageHelp = computed(() =>
    this.canPlaceStage() ? '' : 'The stage spotlight is moderator-only in this room (stageModOnly) — pick a table or screen surface instead.');

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      await Promise.all([
        this.loadMyPowerLevel(),
        this.loadMedia(),
        this.loadThreads(),
        this.loadPinned(),
      ]);
    } finally {
      this.loading.set(false);
    }
  }

  ngOnDestroy(): void {
    for (const url of this.objectUrls.splice(0)) {
      URL.revokeObjectURL(url);
    }
  }

  /** The activated placement's matching listed item (null when unknown). */
  activatedItem(): MediaPanelItem | null {
    const act = this.activated;
    if (!act) {
      return null;
    }
    const all = [...this.mediaItems(), ...this.threadItems(), ...this.pinnedItems()];
    return all.find((i) => i.eventId === act.eventId) ?? null;
  }

  /**
   * PLACE: upsert this item onto the chosen surface in the shared scene state
   * (one item per surface — placing replaces that surface's previous row;
   * other surfaces are preserved). The write is normalized/clamped by the
   * scene service; a refusal (power level, disabled room) surfaces WHY.
   */
  async place(item: MediaPanelItem): Promise<void> {
    const surfaceId = this.chosenSurface[item.eventId] || '';
    if (!surfaceId || !this.canPlace()) {
      return;
    }
    if (surfaceId === STAGE_SURFACE_ID && !this.canPlaceStage()) {
      return;
    }
    this.placeNote.set('');
    const current = (await this.scene.getSceneState(this.roomId))?.placements ?? [];
    const next: Chat3dPlacement[] = [
      ...current.filter((p) => p.surfaceId !== surfaceId),
      {
        surfaceId,
        eventId: item.eventId,
        kind: item.kind,
        label: item.label.slice(0, MAX_PLACEMENT_LABEL_LENGTH),
      },
    ];
    const ok = await this.scene.setSceneState(this.roomId, { placements: next });
    if (!ok) {
      this.placeNote.set('Could not place this item — you may not have permission to change the room scene.');
    }
  }

  /** REMOVE a surface's placement (only shown for surfaces I could write). */
  async clearSurface(surfaceId: string): Promise<void> {
    const current = (await this.scene.getSceneState(this.roomId))?.placements ?? [];
    if (!current.some((p) => p.surfaceId === surfaceId)) {
      return;
    }
    const ok = await this.scene.setSceneState(this.roomId, {
      placements: current.filter((p) => p.surfaceId !== surfaceId),
    });
    if (!ok) {
      this.placeNote.set('Could not clear that surface — you may not have permission to change the room scene.');
    }
  }

  /** OPEN-IN-PANEL: authenticated object URL for the item's media (video v1
   *  plays here — the in-scene surface shows only its poster frame). */
  async open(item: MediaPanelItem): Promise<void> {
    if (!item.mxcUri) {
      return;
    }
    const url = await this.matrix.fetchMediaObjectUrl(item.mxcUri);
    if (!url) {
      this.placeNote.set('Could not load that media item.');
      return;
    }
    this.objectUrls.push(url);
    this.viewer.set({ item, url });
  }

  closeViewer(): void {
    this.viewer.set(null);
  }

  private async loadMyPowerLevel(): Promise<void> {
    try {
      const me = await this.matrix.whoami();
      if (!me) {
        return;
      }
      const pl = parseRoomPowerLevels(await this.matrix.getStateEvent(this.roomId, 'm.room.power_levels'));
      this.myPowerLevel.set(senderPowerLevel(pl, me));
      // Floor 0: what the ROOM demands to send the event, not the receive-side
      // moderator floor — this answers "will the homeserver accept my PUT?".
      this.requiredScenePl.set(requiredScenePowerLevel(pl, CHAT3D_SCENE_TYPE, 0));
    } catch { /* fail-soft: stage stays greyed at PL 0, placement stays offered */ }
  }

  /** Back-paginate /messages, keeping media messages, scanning at most
   *  {@link MEDIA_SCAN_EVENT_LIMIT} events (a busy room must not turn the
   *  panel-open into an unbounded history walk). */
  private async loadMedia(): Promise<void> {
    const items: MediaPanelItem[] = [];
    let from: string | undefined;
    let scanned = 0;
    try {
      while (scanned < MEDIA_SCAN_EVENT_LIMIT) {
        const page = await this.matrix.messages(this.roomId, { from, dir: 'b', limit: MEDIA_SCAN_PAGE_SIZE });
        if (page.events.length === 0) {
          break;
        }
        scanned += page.events.length;
        for (const e of page.events) {
          const item = this.toMediaItem(e);
          if (item) {
            items.push(item);
          }
        }
        if (!page.end) {
          break;
        }
        from = page.end;
      }
    } catch { /* fail-soft: whatever was collected renders */ }
    this.mediaItems.set(items);
  }

  private async loadThreads(): Promise<void> {
    try {
      const page = await this.matrix.getThreads(this.roomId);
      this.threadItems.set(page.events.slice(0, THREADS_LIMIT).map((e) => ({
        eventId: e.eventId,
        kind: 'thread' as PlacementKind,
        label: (e.body || e.sender || e.eventId).slice(0, MAX_PLACEMENT_LABEL_LENGTH),
        mxcUri: null,
        section: 'thread' as const,
      })));
    } catch { /* fail-soft: section stays empty */ }
  }

  private async loadPinned(): Promise<void> {
    try {
      const ids = await this.matrix.getPinnedEvents(this.roomId);
      const settled = await Promise.allSettled(ids.map((id) => this.matrix.getEvent(this.roomId, id)));
      const items: MediaPanelItem[] = [];
      for (const s of settled) {
        if (s.status !== 'fulfilled') {
          continue; // a redacted/unfetchable pin is skipped, not fatal
        }
        const item = this.toMediaItem(s.value) ?? {
          eventId: s.value.eventId,
          kind: 'file' as PlacementKind, // renders as a label plaque
          label: (s.value.body || s.value.sender || s.value.eventId).slice(0, MAX_PLACEMENT_LABEL_LENGTH),
          mxcUri: null,
          section: 'pinned' as const,
        };
        items.push({ ...item, section: 'pinned' });
      }
      this.pinnedItems.set(items);
    } catch { /* fail-soft: section stays empty */ }
  }

  /** Map a timeline event to a placeable media item (null = not media). */
  private toMediaItem(e: TimelineEvent): MediaPanelItem | null {
    if (e.type !== 'm.room.message' || e.redacted) {
      return null;
    }
    const kind: PlacementKind | null =
      e.msgtype === 'm.image' ? 'image'
        : e.msgtype === 'm.video' ? 'video'
          : e.msgtype === 'm.file' ? 'file'
            : null;
    if (!kind) {
      return null;
    }
    const mxc = typeof e.content?.url === 'string' && e.content.url.startsWith('mxc://') ? e.content.url : null;
    return {
      eventId: e.eventId,
      kind,
      label: (e.body || e.sender || e.eventId).slice(0, MAX_PLACEMENT_LABEL_LENGTH),
      mxcUri: mxc,
      section: 'media',
    };
  }
}
