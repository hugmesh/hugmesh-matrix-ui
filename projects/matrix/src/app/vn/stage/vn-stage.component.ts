import { Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SceneService } from '../scenes/scene.service';
import { MAX_PROPS, VnPlacedProp } from '../scenes/vn-scene-state.service';
import { MouthOverlayComponent } from './mouth-overlay.component';
import { accessibleName } from '../../accessible-name';

/**
 * One character on the stage. `imgUrl` is whatever the caller resolved for the
 * participant — a sticker-pack frame blob:, a composed drawable data: SVG, or
 * an avatar object URL (the same `<img src>`-only XSS boundary as
 * hug-character-panel: the stage NEVER innerHTML-injects it).
 */
export interface StageParticipant {
  userId: string;
  displayName?: string;
  /** Optional ASCII screen-reader name announced over displayName (org a11y contract). */
  screenReaderName?: string;
  /** Resolved character/sticker/avatar image URL for the sprite `<img>`. */
  imgUrl: string;
  /** Whether this participant is currently speaking (drives spotlight + mouth). */
  speaking: boolean;
  /** Live amplitude-derived mouth openness 0..1 (see vn/voice/openness.ts). */
  openness: number;
  /** Optional canonical expression label, folded into the sprite alt text. */
  expression?: string;
}

/** Internal per-sprite render row: participant + resolved VN layout slot. */
interface SpriteRow {
  participant: StageParticipant;
  /** Horizontal centre as % of stage width. */
  xPct: number;
  /** Mirrored so side characters face INTO the scene (classic VN blocking). */
  flip: boolean;
  /** Back-row (staggered) placement for 3–4 participants: smaller + behind. */
  back: boolean;
  /** Dimmed because someone ELSE is the active speaker. */
  dimmed: boolean;
}

/**
 * Classic VN sprite blocking per participant count:
 *  1 → centre; 2 → left/right facing in; 3–4 → staggered front/back rows.
 */
const SPRITE_LAYOUTS: Record<number, { x: number; flip: boolean; back: boolean }[]> = {
  1: [{ x: 50, flip: false, back: false }],
  2: [
    { x: 30, flip: false, back: false },
    { x: 70, flip: true, back: false },
  ],
  3: [
    { x: 20, flip: false, back: true },
    { x: 50, flip: false, back: false },
    { x: 80, flip: true, back: true },
  ],
  4: [
    { x: 14, flip: false, back: true },
    { x: 38, flip: false, back: false },
    { x: 62, flip: true, back: false },
    { x: 86, flip: true, back: true },
  ],
};

/** Most sprites the stage arranges (extra participants are not rendered). */
const MAX_SPRITES = 4;

/** A placed prop's base width as % of stage width at scale 1 (400/1600). */
const PROP_BASE_WIDTH_PCT = 25;

/**
 * `hug-vn-stage` — the REUSABLE visual-novel presentation surface (net-new):
 * a letterboxed 16:9 stage rendering, back to front:
 *
 *  1. the shared SCENE background (manifest SVG via {@link SceneService};
 *     null scene → a plain dark stage, fail-soft),
 *  2. the PROP layer (decorative, absolutely positioned by the normalized 0..1
 *     coords the shared room state carries; unknown prop ids render nothing),
 *  3. up to 4 CHARACTER SPRITES in classic VN blocking (1 centre / 2 facing in
 *     / 3–4 staggered), bottom-aligned with name plates. The ACTIVE SPEAKER
 *     gets full saturation + a gentle rise; non-speakers dim slightly
 *     (saturation is the non-motion cue, and prefers-reduced-motion disables
 *     the rise). A speaking sprite's mouth openness renders via the extracted
 *     {@link MouthOverlayComponent} — the SAME overlay-over-`<img>` technique
 *     (and XSS boundary) as hug-character-panel, amplitude-only, no visemes,
 *  4. a content-projected bottom DIALOGUE/CAPTION bar styled as a classic VN
 *     text box (`<ng-content>`; empty projection hides the box).
 *
 * Presentation-only: all inputs are signal inputs, no fetches besides the
 * scene manifest (delegated to SceneService), no Matrix awareness — the VN
 * call view (or any host) feeds it resolved participants + the shared state.
 */
@Component({
  selector: 'hug-vn-stage',
  standalone: true,
  imports: [CommonModule, MouthOverlayComponent],
  templateUrl: './vn-stage.component.html',
  styleUrl: './vn-stage.component.scss',
})
export class VnStageComponent {
  private readonly scenes = inject(SceneService);

  /** Shared scene id (manifest `vn_scene_*`) or null for a plain stage. */
  readonly scene = input<string | null>(null);
  /** Placed props from the shared room state (normalized 0..1 coords). */
  readonly props = input<VnPlacedProp[]>([]);
  /** Stage participants in seating order; only the first 4 are arranged. */
  readonly participants = input<StageParticipant[]>([]);

  constructor() {
    // Kick the (cached, fail-soft) manifest load so scene/prop URLs resolve.
    void this.scenes.load();
  }

  /** Resolved scene background URL (null → no background img, fail-soft). */
  readonly backgroundUrl = computed(() => this.scenes.sceneUrl(this.scene()));

  /** Placed props with resolved URLs; unknown prop ids are dropped (fail-soft).
   *  Defensively re-capped at MAX_PROPS: the shared-state parse already clamps,
   *  but `props` is a public input any host can feed, so the stage itself
   *  never renders an unbounded prop list. */
  readonly placedProps = computed(() => {
    const out: { prop: VnPlacedProp; url: string; widthPct: number }[] = [];
    for (const prop of this.props().slice(0, MAX_PROPS)) {
      const url = this.scenes.propUrl(prop.propId);
      if (!url) {
        continue;
      }
      out.push({ prop, url, widthPct: PROP_BASE_WIDTH_PCT * prop.scale });
    }
    return out;
  });

  /** The (max 4) sprites with their VN layout slots + speaker dim state. */
  readonly sprites = computed<SpriteRow[]>(() => {
    const cast = this.participants().slice(0, MAX_SPRITES);
    if (cast.length === 0) {
      return [];
    }
    const layout = SPRITE_LAYOUTS[cast.length] ?? SPRITE_LAYOUTS[MAX_SPRITES];
    const anySpeaking = cast.some((p) => p.speaking);
    return cast.map((participant, i) => ({
      participant,
      xPct: layout[i].x,
      flip: layout[i].flip,
      back: layout[i].back,
      dimmed: anySpeaking && !participant.speaking,
    }));
  });

  /** Meaningful sprite alt, matching hug-character-panel's convention. */
  alt(p: StageParticipant): string {
    const name = accessibleName(p.displayName || p.userId || 'Participant', p.screenReaderName ?? null);
    return p.expression ? `${name} character, ${p.expression}` : `${name} character`;
  }

  /** Visible name-plate text (display name, falling back to the Matrix id). */
  plateName(p: StageParticipant): string {
    return p.displayName || p.userId;
  }

  trackSprite(_i: number, row: SpriteRow): string {
    return row.participant.userId;
  }
}
