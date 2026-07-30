import { SPEAKING_HANGOVER_MS, SPEAKING_OPENNESS_THRESHOLD, SpeakingDetector } from './speaking';
import { nextOpenness } from './openness';

/** A fake time-domain analyser frame: every sample at `amplitude` (a plain
 *  Float32Array, exactly what AnalyserNode.getFloatTimeDomainData yields). */
function frame(amplitude: number, length = 512): Float32Array {
  return new Float32Array(length).fill(amplitude);
}

describe('SpeakingDetector (amplitude → speaking mapping)', () => {
  it('is silent before any input', () => {
    expect(new SpeakingDetector().update(0, 1_000)).toBeFalse();
  });

  it('flips speaking ON while openness exceeds the threshold', () => {
    const det = new SpeakingDetector();
    expect(det.update(SPEAKING_OPENNESS_THRESHOLD + 0.01, 0)).toBeTrue();
    expect(det.update(0.9, 16)).toBeTrue();
  });

  it('does NOT trip at or below the threshold (smoothed noise floor stays quiet)', () => {
    const det = new SpeakingDetector();
    expect(det.update(SPEAKING_OPENNESS_THRESHOLD, 0)).toBeFalse();
    expect(det.update(SPEAKING_OPENNESS_THRESHOLD - 0.01, 16)).toBeFalse();
  });

  it('HANGOVER: stays speaking through a sub-threshold dip within ~150ms, then releases', () => {
    const det = new SpeakingDetector();
    expect(det.update(0.5, 1_000)).toBeTrue();
    // Inter-syllable dip: openness collapses but the flag lingers…
    expect(det.update(0, 1_000 + SPEAKING_HANGOVER_MS - 1)).toBeTrue();
    expect(det.update(0, 1_000 + SPEAKING_HANGOVER_MS)).toBeTrue();
    // …and releases once the hangover elapses.
    expect(det.update(0, 1_000 + SPEAKING_HANGOVER_MS + 1)).toBeFalse();
  });

  it('a new loud frame during the hangover re-arms it', () => {
    const det = new SpeakingDetector();
    det.update(0.5, 0);
    det.update(0.5, 100); // still loud at t=100 → hangover now runs from 100
    expect(det.update(0, 100 + SPEAKING_HANGOVER_MS)).toBeTrue();
    expect(det.update(0, 100 + SPEAKING_HANGOVER_MS + 1)).toBeFalse();
  });

  it('reset() forgets prior loudness immediately', () => {
    const det = new SpeakingDetector();
    det.update(0.9, 0);
    det.reset();
    expect(det.update(0, 1)).toBeFalse();
  });

  it('NaN / non-finite openness never trips it', () => {
    const det = new SpeakingDetector();
    expect(det.update(Number.NaN, 0)).toBeFalse();
    expect(det.update(Number.NEGATIVE_INFINITY, 16)).toBeFalse();
  });

  // ── The full pipeline: fake ANALYSER FRAMES → openness → speaking ──────────
  describe('fed from fake analyser frames through nextOpenness (the real pipeline)', () => {
    it('a burst of loud speech frames turns speaking on; sustained silence turns it off', () => {
      const det = new SpeakingDetector();
      let openness = 0;
      let now = 0;
      let flag = false;

      // ~10 frames of a loud vowel (|sample| 0.3 ≈ RMS 0.3 → openness → 1).
      for (let i = 0; i < 10; i++) {
        openness = nextOpenness(openness, frame(0.3));
        now += 16;
        flag = det.update(openness, now);
      }
      expect(openness).toBeGreaterThan(SPEAKING_OPENNESS_THRESHOLD);
      expect(flag).toBeTrue();

      // Sustained silence: the EMA decays below the threshold and, once the
      // 150ms hangover elapses, the flag releases.
      for (let i = 0; i < 60; i++) {
        openness = nextOpenness(openness, frame(0));
        now += 16;
        flag = det.update(openness, now);
      }
      expect(openness).toBeLessThan(SPEAKING_OPENNESS_THRESHOLD);
      expect(flag).toBeFalse();
    });

    it('near-silent background frames never trip speaking', () => {
      const det = new SpeakingDetector();
      let openness = 0;
      let now = 0;
      for (let i = 0; i < 30; i++) {
        // A whisper-level noise floor (|sample| 0.005 → openness ≈ 0.03).
        openness = nextOpenness(openness, frame(0.005));
        now += 16;
        expect(det.update(openness, now)).toBeFalse();
      }
    });
  });
});
