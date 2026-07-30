/**
 * SPEAKING detection on top of the amplitude→openness pipeline (openness.ts /
 * amplitude-mouth.service.ts): a participant is "speaking" while their live
 * mouth openness exceeds a small threshold, with a short HANGOVER so the flag
 * does not flicker off between syllables/words. Deliberately amplitude-only —
 * the same product decision as the mouth itself (no visemes, no VAD model):
 * "loud enough right now (or within the last ~150ms)" IS speaking.
 *
 * Pure (time is passed in), so specs can drive it deterministically with fake
 * analyser frames run through {@link nextOpenness} and fake clocks.
 */

/** Openness (0..1) above which a participant counts as actively speaking.
 *  Ordinary speech swings openness across most of 0..1 (see OPEN_RMS_REFERENCE)
 *  so this sits well above the smoothed noise floor while still catching quiet
 *  talkers. */
export const SPEAKING_OPENNESS_THRESHOLD = 0.08;

/** How long (ms) the speaking flag lingers after openness last crossed the
 *  threshold — bridges the inter-syllable dips so the stage spotlight and the
 *  mouth overlay don't strobe. */
export const SPEAKING_HANGOVER_MS = 150;

/**
 * Stateful per-stream speaking detector: threshold + hangover. One instance per
 * analysed stream (local mic / remote peer), stepped from the same loop that
 * samples the {@link MouthDrive} openness signal.
 */
export class SpeakingDetector {
  /** Timestamp (caller clock, ms) openness was last above the threshold. */
  private lastAboveMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly threshold: number = SPEAKING_OPENNESS_THRESHOLD,
    private readonly hangoverMs: number = SPEAKING_HANGOVER_MS,
  ) {}

  /**
   * Step the detector with the current smoothed openness at `nowMs` (any
   * monotonic ms clock — `performance.now()` in production, a fake in specs).
   * Returns the speaking flag: true while above the threshold, and for
   * {@link hangoverMs} after the last time it was.
   */
  update(openness: number, nowMs: number): boolean {
    if (Number.isFinite(openness) && openness > this.threshold) {
      this.lastAboveMs = nowMs;
      return true;
    }
    return nowMs - this.lastAboveMs <= this.hangoverMs;
  }

  /** Forget any prior loudness (call ended / stream swapped): silent again. */
  reset(): void {
    this.lastAboveMs = Number.NEGATIVE_INFINITY;
  }
}
