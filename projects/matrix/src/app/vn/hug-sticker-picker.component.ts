import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatrixService } from '../matrix.service';
import { CharacterPackService, PackImage, UserEmotesPack } from './character-pack.service';
import { EXPRESSIONS } from './expression';

/** One ready-to-render sticker tile: the pack shortcode, its label/body, and an
 *  authenticated blob object URL for the `<img>`. */
interface StickerTile {
  /** The pack image key (an {@link Expression} shortcode for a VN pack). */
  shortcode: string;
  /** The mxc:// of the sticker (sent verbatim as the m.sticker `url`). */
  mxc: string;
  /** Human-readable label (image body ?? shortcode) — the alt + accessible name. */
  label: string;
  /** The authenticated blob: object URL for the `<img src>` (we own + revoke it). */
  src: string;
  /** Pixel size hints from the pack, when present (fed into m.sticker `info`). */
  w?: number;
  h?: number;
  /** The pack image's mimetype hint, when present. */
  mimetype?: string;
}

/** The MSC2545-default sticker dimensions used when the pack carries no `info`.
 *  m.sticker requires `info.w`/`info.h`; a square 256 is a sane, spec-valid
 *  default for a VN expression frame. */
const DEFAULT_STICKER_DIM = 256;
/** The default `info.mimetype` — B1 #89 registers PNG frames. */
const DEFAULT_STICKER_MIME = 'image/png';

/**
 * SEND-HALF of the VN sticker round-trip (Phase B1): a MSC2545 sticker picker
 * for matrix-ui's CUSTOM client — a standard Matrix client would already surface
 * the `im.ponies.user_emotes` pack in its own picker, but matrix-ui has none.
 *
 * On open it resolves the CURRENT user's own active VN sticker pack (the same
 * `im.ponies.user_emotes` account-data B1 #89 registers) via the shared
 * {@link CharacterPackService} — NO duplicate account-data read — and renders a
 * grid of that pack's images. Each tile is a single `<img>` whose `src` is an
 * AUTHENTICATED blob object URL ({@link MatrixService.fetchMediaObjectUrl}); the
 * mxc is NEVER injected via `innerHTML`/`bypassSecurityTrust*`, the same
 * `<img>`/blob XSS boundary B2's panel uses.
 *
 * Clicking a tile SENDS an MSC2545-correct `m.sticker` event
 * ({@link MatrixService.sendEvent}(roomId, 'm.sticker', …)) into {@link roomId}
 * with a fresh txnId, then {@link picked}-emits so the host can close the picker.
 *
 * FAIL-SOFT by construction: a resolve error, no pack, or a pack with no usable
 * images shows a friendly EMPTY STATE — never a crash, never an uncaught throw —
 * and a send error surfaces non-fatally (an inline status, logged) rather than
 * propagating.
 *
 * A11y (HugMesh UI standard): the grid is a roving-tabindex `role="menu"` —
 * one Tab stop in, then Arrow/Home/End move the active tile and Enter/Space send;
 * Escape {@link dismissed}-emits so the host closes the picker AND restores focus
 * to the toggle. Each tile's accessible name is "Send <label> sticker" and its
 * `<img>` carries a matching alt.
 */
@Component({
  selector: 'hug-sticker-picker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './hug-sticker-picker.component.html',
  styleUrl: './hug-sticker-picker.component.scss',
})
export class HugStickerPickerComponent implements AfterViewInit, OnDestroy {
  private readonly matrix = inject(MatrixService);
  private readonly packs = inject(CharacterPackService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** The room the sticker is sent into. */
  @Input() roomId = '';

  /** Emitted after a sticker is successfully sent (host closes the picker). */
  @Output() picked = new EventEmitter<string>();
  /** Emitted when the user dismisses with Escape (host closes + restores focus). */
  @Output() dismissed = new EventEmitter<void>();

  /** The current user's own sticker tiles (empty ⇒ the empty state). */
  readonly tiles = signal<StickerTile[]>([]);
  /** True while the pack is resolving (drives the loading copy). */
  readonly loading = signal(true);
  /** Non-fatal status (e.g. a send error) surfaced inline, never thrown. */
  readonly status = signal('');
  /** Index of the roving-focusable tile (the single Tab stop into the grid). */
  readonly activeIndex = signal(0);
  /** True once a send is in flight, to ignore double-activation. */
  private sending = false;

  /** The blob: object URLs we created and must revoke on destroy. */
  private readonly objectUrls: string[] = [];

  ngAfterViewInit(): void {
    // Resolve the pack on open; once tiles render, move focus INTO the grid so a
    // keyboard user lands on the first sticker (APG "opening a menu focuses an
    // item"). When there is no pack the empty state takes focus management.
    void this.load();
  }

  ngOnDestroy(): void {
    this.revokeAll();
  }

  /** The accessible name / alt for a tile: "Send <label> sticker". */
  tileLabel(t: StickerTile): string {
    return `Send ${t.label} sticker`;
  }

  /**
   * Resolve the CURRENT user's pack (fail-soft) and build the tiles. Any error,
   * a missing pack, or a pack with no usable images leaves `tiles` empty so the
   * template shows the friendly empty state — this never throws.
   */
  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const me = await this.matrix.whoami();
      if (!me) {
        this.tiles.set([]);
        return;
      }
      const pack = await this.packs.resolveCharacterPack(me);
      const tiles = await this.buildTiles(pack);
      this.tiles.set(tiles);
      if (tiles.length > 0) {
        this.activeIndex.set(0);
        // Focus the first tile after the *ngFor renders it.
        queueMicrotask(() => this.focusTile(0));
      }
    } catch {
      // Fail-soft: an unexpected error shows the empty state, never a crash.
      this.tiles.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Build the render tiles from a resolved pack, in the canonical {@link
   * EXPRESSIONS} order first (so a VN pack reads neutral→…→smug) then any
   * remaining custom shortcodes. Each image's mxc is fetched as an authenticated
   * blob object URL; an image that fails to fetch is skipped (fail-soft).
   */
  private async buildTiles(pack: UserEmotesPack | null): Promise<StickerTile[]> {
    if (!pack) {
      return [];
    }
    const shortcodes = this.orderedShortcodes(pack);
    const tiles: StickerTile[] = [];
    for (const shortcode of shortcodes) {
      const image = pack.images[shortcode];
      const tile = await this.toTile(shortcode, image, pack);
      if (tile) {
        tiles.push(tile);
      }
    }
    return tiles;
  }

  /** Canonical expressions first (in B1 enum order), then any extra shortcodes. */
  private orderedShortcodes(pack: UserEmotesPack): string[] {
    const present = new Set(Object.keys(pack.images));
    const ordered: string[] = [];
    for (const expr of EXPRESSIONS) {
      if (present.has(expr)) {
        ordered.push(expr);
        present.delete(expr);
      }
    }
    // Stable order for any non-canonical shortcodes the pack may carry.
    for (const extra of Object.keys(pack.images)) {
      if (present.has(extra)) {
        ordered.push(extra);
      }
    }
    return ordered;
  }

  /** Resolve one pack image into a render tile (or null if its media won't fetch). */
  private async toTile(shortcode: string, image: PackImage, pack: UserEmotesPack): Promise<StickerTile | null> {
    let src = '';
    try {
      src = await this.matrix.fetchMediaObjectUrl(image.url, { thumbnail: true, w: 128, h: 128, method: 'scale' });
    } catch {
      src = '';
    }
    if (!src) {
      return null;
    }
    this.objectUrls.push(src);
    const info = this.imageInfo(pack, shortcode);
    return {
      shortcode,
      mxc: image.url,
      label: image.body && image.body.trim().length > 0 ? image.body : shortcode,
      src,
      w: info?.w,
      h: info?.h,
      mimetype: info?.mimetype,
    };
  }

  /** Read the raw pack image `info` (w/h/mimetype) when present — the pack the
   *  parsing service normalises drops `info`, so we read it off the raw entry the
   *  service exposes only via the parsed PackImage; defaults are applied at send. */
  private imageInfo(pack: UserEmotesPack, shortcode: string): { w?: number; h?: number; mimetype?: string } | null {
    const raw = (pack.images[shortcode] as unknown as Record<string, unknown>)?.['info'];
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const r = raw as Record<string, unknown>;
    return {
      w: typeof r['w'] === 'number' ? (r['w'] as number) : undefined,
      h: typeof r['h'] === 'number' ? (r['h'] as number) : undefined,
      mimetype: typeof r['mimetype'] === 'string' ? (r['mimetype'] as string) : undefined,
    };
  }

  /**
   * SEND the tile as an MSC2545-correct `m.sticker`. Per the Matrix spec an
   * m.sticker is its OWN top-level event type carrying `body` + `url`(mxc) +
   * `info`. We supply sane `info` defaults (image/png, 256×256) when the pack
   * lacks dimensions. A fresh txnId per send. Optimistic UX: on success close via
   * {@link picked}; a send error is surfaced inline (logged), NEVER thrown.
   */
  async send(tile: StickerTile): Promise<void> {
    if (!this.roomId || this.sending) {
      return;
    }
    this.sending = true;
    this.status.set('');
    const content = {
      body: tile.label,
      url: tile.mxc,
      info: {
        mimetype: tile.mimetype ?? DEFAULT_STICKER_MIME,
        w: tile.w ?? DEFAULT_STICKER_DIM,
        h: tile.h ?? DEFAULT_STICKER_DIM,
      },
      // Org ext so other clients can recover the VN expression; ignored by
      // clients that don't understand it (the sticker still renders). Canonical
      // wire prefix follows the .net domain move; events written by older
      // builds carry `systems.hugmesh.vn` / `systems.snapdragon.vn` instead —
      // a future READER of this field must accept all three spellings.
      'net.hugmesh.vn': { expression: tile.shortcode },
    };
    try {
      const eventId = await this.matrix.sendEvent(this.roomId, 'm.sticker', content);
      this.picked.emit(eventId);
    } catch (e: unknown) {
      // Non-fatal: surface the failure inline (and log) rather than propagate.
      console.warn('m.sticker send failed', e);
      this.status.set('Could not send sticker. Please try again.');
    } finally {
      this.sending = false;
    }
  }

  /** Roving-tabindex keyboard nav across the sticker grid + Escape to dismiss. */
  onKeydown(ev: KeyboardEvent, index: number): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.dismissed.emit();
      return;
    }
    const last = this.tiles().length - 1;
    if (last < 0) {
      return;
    }
    let next = index;
    switch (ev.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index === 0 ? last : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    ev.preventDefault();
    this.activeIndex.set(next);
    this.focusTile(next);
  }

  /** Escape on the empty state also dismisses (keyboard users aren't stranded). */
  onEmptyKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.dismissed.emit();
    }
  }

  private focusTile(index: number): void {
    const buttons = this.host.nativeElement.querySelectorAll<HTMLButtonElement>('button.sticker-btn');
    buttons.item(index)?.focus();
  }

  private revokeAll(): void {
    for (const url of this.objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.objectUrls.length = 0;
  }
}
