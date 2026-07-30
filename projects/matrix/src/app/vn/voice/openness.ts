/**
 * The AMPLITUDE → MOUTH-OPENNESS math (Phase B3 Wave A) — a pair of PURE,
 * unit-testable functions with NO Web-Audio / DOM dependency.
 *
 * Per an explicit product decision this is AMPLITUDE-ONLY: there are no visemes,
 * no phoneme timeline, no art. The character's mouth simply opens/closes with how
 * LOUD the playing TTS audio is right now. So all we need from a frame of
 * AnalyserNode time-domain data is a single scalar 0..1 "openness", smoothed over
 * time so the mouth eases rather than chatters.
 *
 * Keeping the math here (separate from {@link AmplitudeMouthService}, which only
 * owns the AnalyserNode + rAF wiring) lets the spec drive these directly with a
 * plain `Float32Array`/`Uint8Array` — no mocked AudioContext needed.
 */

/** Default analyser FFT size we read time-domain samples at (a power of two). */
export const DEFAULT_FFT_SIZE = 1024;

/**
 * The RMS at which the mouth is considered FULLY open (openness = 1). Normal
 * speech RMS sits well below 1.0 (a value near silence is ~0, a loud vowel is
 * roughly 0.2–0.4), so we scale by this reference and clamp. Empirically chosen
 * so ordinary TTS speech swings the mouth across most of its 0..1 range without
 * pinning fully open on every syllable.
 */
export const OPEN_RMS_REFERENCE = 0.18;

/**
 * Per-frame easing factor applied to the smoothed openness (an exponential
 * moving average). 0 = frozen (ignore new frames), 1 = no smoothing (snap to the
 * raw value). ~0.35 eases the mouth over a few frames so it does not buzz.
 */
export const DEFAULT_SMOOTHING = 0.35;

/**
 * RMS (root-mean-square) loudness of a TIME-DOMAIN frame, normalised to 0..1.
 *
 * Accepts either form the Web Audio `AnalyserNode` exposes:
 *  - `Float32Array` (`getFloatTimeDomainData`) — samples already in [-1, 1].
 *  - `Uint8Array`   (`getByteTimeDomainData`)  — samples in [0, 255], centred at
 *    128; we re-centre to [-1, 1] before squaring.
 *
 * Returns 0 for an empty/absent buffer (so a not-yet-started analyser reads as
 * silence → mouth closed). The result is the raw per-frame loudness; the caller
 * scales it to openness via {@link rmsToOpenness}.
 */
export function frameRms(buffer: Float32Array | Uint8Array): number {
  const n = buffer.length;
  if (n === 0) {
    return 0;
  }
  let sumSquares = 0;
  if (buffer instanceof Uint8Array) {
    for (let i = 0; i < n; i++) {
      // Byte samples are centred at 128; map [0,255] → [-1,1].
      const v = (buffer[i] - 128) / 128;
      sumSquares += v * v;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = buffer[i];
      sumSquares += v * v;
    }
  }
  return Math.sqrt(sumSquares / n);
}

/**
 * Map a raw per-frame RMS to a target openness in [0, 1] by scaling against
 * {@link OPEN_RMS_REFERENCE} and clamping. Pure; no smoothing (that is applied
 * across frames by {@link smoothOpenness}).
 *
 * `reference` is overridable for tuning/tests; a value <= 0 falls back to the
 * default so a caller can never divide by zero.
 */
export function rmsToOpenness(rms: number, reference: number = OPEN_RMS_REFERENCE): number {
  if (!Number.isFinite(rms) || rms <= 0) {
    return 0;
  }
  const ref = reference > 0 ? reference : OPEN_RMS_REFERENCE;
  const raw = rms / ref;
  return raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
}

/**
 * Exponential-moving-average smoothing between the PREVIOUS smoothed openness and
 * the new TARGET, both in [0, 1]. `smoothing` is the weight of the new target
 * (0 = ignore it, 1 = snap to it); out-of-range values are clamped. Pure — the
 * caller threads the returned value back in as `prev` next frame.
 */
export function smoothOpenness(prev: number, target: number, smoothing: number = DEFAULT_SMOOTHING): number {
  const a = smoothing < 0 ? 0 : smoothing > 1 ? 1 : smoothing;
  const p = clamp01(prev);
  const t = clamp01(target);
  return p + a * (t - p);
}

/**
 * The full per-frame step used by the rAF loop: raw RMS of the frame → target
 * openness → EMA-smoothed against the previous openness. Pure and directly
 * unit-testable with a plain buffer + previous value.
 */
export function nextOpenness(
  prev: number,
  buffer: Float32Array | Uint8Array,
  opts?: { reference?: number; smoothing?: number },
): number {
  const target = rmsToOpenness(frameRms(buffer), opts?.reference);
  return smoothOpenness(prev, target, opts?.smoothing);
}

/** Clamp a number to [0, 1] (NaN → 0). */
function clamp01(v: number): number {
  if (!Number.isFinite(v) || v <= 0) {
    return 0;
  }
  return v >= 1 ? 1 : v;
}
