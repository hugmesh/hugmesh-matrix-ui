import { Component, computed, input } from '@angular/core';

/**
 * The amplitude-driven MOUTH OVERLAY, EXTRACTED as a reusable piece of the
 * technique {@link HugCharacterPanelComponent} renders inline (B3 Wave A): a
 * generated `<ellipse>` whose open-height scales with audio loudness, layered
 * as OUR OWN trusted markup OVER a character `<img>` — never injected into the
 * character SVG, so the `<img>` XSS boundary stays intact. Amplitude-only by
 * product decision (openness 0..1 from RMS) — deliberately NO visemes.
 *
 * Same numbers as the panel: a 160-unit box, rx 11, max open-height 22 — but
 * rendered at 100% of the host so the stage can scale it with each sprite.
 * Decorative: aria-hidden, pointer-events none; under reduced motion the
 * DRIVE pins openness to 0 (see openness.ts), so the mouth stays closed here
 * with no extra handling.
 */
@Component({
  selector: 'hug-mouth-overlay',
  standalone: true,
  template: `
    <svg class="mouth-overlay" data-testid="mouth-overlay"
         aria-hidden="true" focusable="false"
         viewBox="0 0 160 160" preserveAspectRatio="xMidYMid meet">
      <ellipse class="mouth-shape" data-testid="mouth-shape"
               [attr.cx]="cx()" [attr.cy]="cy()"
               rx="11" [attr.ry]="ry()" />
    </svg>
  `,
  styles: `
    :host { position: absolute; inset: 0; pointer-events: none; display: block; }
    .mouth-overlay { width: 100%; height: 100%; display: block; }
    .mouth-shape { fill: #000; }
  `,
})
export class MouthOverlayComponent {
  /** Box edge + geometry mirrored from hug-character-panel (160px portrait). */
  private static readonly BOX = 160;
  /** Max mouth opening (box units) at openness=1 — the panel's MOUTH_MAX_H. */
  private static readonly MOUTH_MAX_H = 22;

  /** Live mouth openness 0..1 (RMS-derived; see vn/voice/openness.ts). */
  readonly openness = input<number>(0);
  /** Mouth centre anchor as 0..1 of the character box (panel's fallback: lower-centre). */
  readonly anchor = input<{ x: number; y: number }>({ x: 0.5, y: 0.72 });

  readonly cx = computed(() => Math.round(this.clamp01(this.anchor().x) * MouthOverlayComponent.BOX));
  readonly cy = computed(() => Math.round(this.clamp01(this.anchor().y) * MouthOverlayComponent.BOX));
  readonly ry = computed(() => Math.round(this.clamp01(this.openness()) * MouthOverlayComponent.MOUTH_MAX_H));

  private clamp01(v: number): number {
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }
}
