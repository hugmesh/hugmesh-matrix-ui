import { Injectable, signal, Signal } from '@angular/core';
import { DEFAULT_FFT_SIZE, nextOpenness } from './openness';

/**
 * The Web-Audio surface {@link AmplitudeMouthService} needs, narrowed to exactly
 * the methods it calls. Production passes a real {@link AudioContext}; tests pass
 * a tiny fake (a fake `createAnalyser`, a `currentTime`, ...) so the rAF/analyser
 * wiring is exercised WITHOUT a real audio device or codec.
 */
export interface MouthAudioContextLike {
  createAnalyser(): AnalyserNodeLike;
}

/** The {@link AnalyserNode} surface we use — narrowed for fakeability. */
export interface AnalyserNodeLike {
  fftSize: number;
  readonly frequencyBinCount: number;
  getFloatTimeDomainData(array: Float32Array): void;
  disconnect(): void;
}

/**
 * A connectable source (the playing `AudioBufferSourceNode`). Narrowed to just
 * the one `connect` we call. Its parameter is widened to `any` so a REAL
 * `AudioBufferSourceNode` (whose `connect` demands a full `AudioNode`) is
 * structurally assignable here, while a test can still pass a tiny fake source
 * with a one-arg `connect(analyser)`.
 */
export interface MouthSourceLike {
  connect(destination: any): void;
}

/** The rAF pair, injectable so a test can drive frames deterministically. */
export interface RafScheduler {
  request(cb: FrameRequestCallback): number;
  cancel(handle: number): void;
}

/** prefers-reduced-motion probe, injectable so a test can force either branch. */
export type ReducedMotionProbe = () => boolean;

/** A live mouth-drive handle: the openness signal + a stop()/cleanup. */
export interface MouthDrive {
  /** Smoothed openness 0..1; pinned to 0 under reduced motion or when stopped. */
  readonly openness: Signal<number>;
  /** Stop driving: cancel the rAF loop, disconnect the analyser, reset to 0. */
  stop(): void;
}

/**
 * Drives an AMPLITUDE-ONLY mouth from a playing audio source (Phase B3 Wave A).
 *
 * Given a playing source node + its {@link AudioContext}, {@link drive} attaches
 * an {@link AnalyserNode}, then on a `requestAnimationFrame` loop reads the
 * time-domain frame, computes a SMOOTHED openness 0..1 (pure math in
 * `openness.ts`), and exposes it as a signal the panel binds the mouth overlay's
 * open-height to.
 *
 * REDUCED MOTION: when `prefers-reduced-motion: reduce` matches, openness is
 * PINNED to 0 (closed) and NO rAF loop runs — the mouth stays static (a11y; no
 * animation, no per-frame work).
 *
 * NO LEAK: {@link MouthDrive.stop} (called on audio end, an explicit stop, or
 * panel destroy) cancels the rAF, disconnects the analyser, and resets openness
 * to 0. The service does NOT own/close the AudioContext (the playback path owns
 * it) — it only disconnects the analyser it created.
 */
@Injectable({ providedIn: 'root' })
export class AmplitudeMouthService {
  /** Default rAF scheduler — the browser's `requestAnimationFrame`/`cancel`. */
  private readonly raf: RafScheduler = {
    request: (cb) => requestAnimationFrame(cb),
    cancel: (h) => cancelAnimationFrame(h),
  };

  /**
   * Attach an analyser to `source` and start driving the openness signal from its
   * loudness. Returns a {@link MouthDrive} the caller MUST `stop()` on end/destroy.
   *
   * `ctx` is the playing source's AudioContext; `reducedMotion`/`raf` are
   * injectable for tests (defaults read the real media query + rAF). With reduced
   * motion the openness stays 0 and no loop is scheduled.
   */
  drive(
    source: MouthSourceLike,
    ctx: MouthAudioContextLike,
    deps?: { reducedMotion?: ReducedMotionProbe; raf?: RafScheduler },
  ): MouthDrive {
    const openness = signal(0);
    const reduced = (deps?.reducedMotion ?? defaultReducedMotion)();

    // REDUCED MOTION: static closed mouth, no analyser frames, no rAF loop.
    if (reduced) {
      return {
        openness,
        stop: () => openness.set(0),
      };
    }

    const raf = deps?.raf ?? this.raf;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = DEFAULT_FFT_SIZE;
    source.connect(analyser);
    const samples = new Float32Array(analyser.frequencyBinCount);

    let handle = 0;
    let stopped = false;

    const tick = (): void => {
      if (stopped) {
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      openness.set(nextOpenness(openness(), samples));
      handle = raf.request(tick);
    };
    handle = raf.request(tick);

    return {
      openness,
      stop: () => {
        if (stopped) {
          return;
        }
        stopped = true;
        raf.cancel(handle);
        try {
          analyser.disconnect();
        } catch {
          /* already disconnected — ignore */
        }
        openness.set(0);
      },
    };
  }
}

/** Real `prefers-reduced-motion: reduce` probe (false when matchMedia absent). */
export function defaultReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
