import {
  DEFAULT_SMOOTHING,
  OPEN_RMS_REFERENCE,
  frameRms,
  nextOpenness,
  rmsToOpenness,
  smoothOpenness,
} from './openness';

/**
 * Pure amplitude → mouth-openness math (B3 Wave A). No Web-Audio / DOM: these run
 * against plain `Float32Array`/`Uint8Array` buffers and scalars, so the mouth
 * behaviour (silence → closed, loud → open, eased smoothing, clamped) is provable
 * without a real AudioContext.
 */
describe('openness (amplitude → mouth math)', () => {
  describe('frameRms', () => {
    it('is 0 for an empty buffer (a not-yet-started analyser reads as silence)', () => {
      expect(frameRms(new Float32Array(0))).toBe(0);
      expect(frameRms(new Uint8Array(0))).toBe(0);
    });

    it('is 0 for a silent float frame (all zeros)', () => {
      expect(frameRms(new Float32Array(256))).toBe(0);
    });

    it('is 0 for a silent BYTE frame (all 128 = the DC centre)', () => {
      const silent = new Uint8Array(256).fill(128);
      expect(frameRms(silent)).toBe(0);
    });

    it('computes RMS of a constant-amplitude float frame', () => {
      // A frame that is entirely +0.5 has RMS 0.5.
      const buf = new Float32Array(64).fill(0.5);
      expect(frameRms(buf)).toBeCloseTo(0.5, 6);
    });

    it('re-centres byte samples to [-1,1] before squaring', () => {
      // 192 = 128 + 64 → +0.5 after re-centring → RMS 0.5.
      const buf = new Uint8Array(64).fill(192);
      expect(frameRms(buf)).toBeCloseTo(0.5, 6);
    });

    it('squares (sign-independent): +v and -v give the same RMS', () => {
      const pos = new Float32Array(32).fill(0.3);
      const neg = new Float32Array(32).fill(-0.3);
      expect(frameRms(pos)).toBeCloseTo(frameRms(neg), 9);
    });
  });

  describe('rmsToOpenness', () => {
    it('maps silence (rms 0) to fully closed (0)', () => {
      expect(rmsToOpenness(0)).toBe(0);
    });

    it('maps rms at/above the reference to fully open (1), clamped', () => {
      expect(rmsToOpenness(OPEN_RMS_REFERENCE)).toBe(1);
      expect(rmsToOpenness(OPEN_RMS_REFERENCE * 4)).toBe(1);
    });

    it('scales a mid rms linearly against the reference', () => {
      expect(rmsToOpenness(OPEN_RMS_REFERENCE / 2)).toBeCloseTo(0.5, 6);
    });

    it('never divides by zero: a non-positive reference falls back to the default', () => {
      expect(rmsToOpenness(OPEN_RMS_REFERENCE, 0)).toBe(1);
      expect(rmsToOpenness(OPEN_RMS_REFERENCE, -5)).toBe(1);
    });

    it('is 0 for a non-finite / negative rms (never NaN out)', () => {
      expect(rmsToOpenness(NaN)).toBe(0);
      expect(rmsToOpenness(-0.1)).toBe(0);
      // Infinity is non-finite → guarded to 0 (no divide-into-Infinity artefact).
      expect(rmsToOpenness(Infinity)).toBe(0);
    });
  });

  describe('smoothOpenness (exponential moving average)', () => {
    it('eases toward the target rather than snapping (default smoothing)', () => {
      const out = smoothOpenness(0, 1, DEFAULT_SMOOTHING);
      // One step covers exactly `smoothing` of the gap.
      expect(out).toBeCloseTo(DEFAULT_SMOOTHING, 6);
      expect(out).toBeLessThan(1);
    });

    it('smoothing=1 snaps straight to the target', () => {
      expect(smoothOpenness(0, 1, 1)).toBe(1);
      expect(smoothOpenness(0.2, 0.9, 1)).toBeCloseTo(0.9, 6);
    });

    it('smoothing=0 freezes at the previous value (ignores the target)', () => {
      expect(smoothOpenness(0.4, 1, 0)).toBeCloseTo(0.4, 6);
    });

    it('clamps out-of-range smoothing to [0,1]', () => {
      expect(smoothOpenness(0, 1, 5)).toBe(1); // clamped to 1 → snap
      expect(smoothOpenness(0.4, 1, -3)).toBeCloseTo(0.4, 6); // clamped to 0 → freeze
    });

    it('clamps prev/target into [0,1] (never overshoots)', () => {
      const out = smoothOpenness(2, 2, 0.5); // both clamped to 1
      expect(out).toBeLessThanOrEqual(1);
      expect(out).toBeGreaterThanOrEqual(0);
    });

    it('converges toward the target over repeated frames', () => {
      let v = 0;
      for (let i = 0; i < 30; i++) {
        v = smoothOpenness(v, 1, DEFAULT_SMOOTHING);
      }
      expect(v).toBeGreaterThan(0.9); // eased most of the way to open
      expect(v).toBeLessThanOrEqual(1);
    });
  });

  describe('nextOpenness (the full per-frame step)', () => {
    it('silence in → stays closed (~0)', () => {
      const v = nextOpenness(0, new Float32Array(128));
      expect(v).toBe(0);
    });

    it('a loud frame opens the mouth from rest (toward 1) but eased under 1', () => {
      const loud = new Float32Array(128).fill(0.6); // well above the reference
      const v = nextOpenness(0, loud);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1); // one eased step, not a snap
    });

    it('reaches near-fully-open when a loud frame is sustained', () => {
      const loud = new Float32Array(128).fill(0.6);
      let v = 0;
      for (let i = 0; i < 40; i++) {
        v = nextOpenness(v, loud);
      }
      expect(v).toBeGreaterThan(0.9);
      expect(v).toBeLessThanOrEqual(1);
    });

    it('honours a custom reference + smoothing override', () => {
      const buf = new Float32Array(64).fill(0.1);
      // reference 0.1 → target 1; smoothing 1 → snap.
      expect(nextOpenness(0, buf, { reference: 0.1, smoothing: 1 })).toBe(1);
    });
  });
});
