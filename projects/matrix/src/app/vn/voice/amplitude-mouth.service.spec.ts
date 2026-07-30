import { TestBed } from '@angular/core/testing';
import {
  AmplitudeMouthService,
  AnalyserNodeLike,
  MouthAudioContextLike,
  MouthSourceLike,
  RafScheduler,
} from './amplitude-mouth.service';
import { OPEN_RMS_REFERENCE } from './openness';

/**
 * A fake {@link AnalyserNode} that fills the time-domain buffer with a fixed
 * amplitude each read, so the rAF loop produces a deterministic, rising openness.
 */
class FakeAnalyser implements AnalyserNodeLike {
  fftSize = 0;
  disconnectCalls = 0;
  constructor(private readonly amplitude: number) {}
  get frequencyBinCount(): number {
    // The service sets fftSize before reading frequencyBinCount; mirror the real
    // relationship (bin count = fftSize / 2), defaulting to a small non-zero size.
    return (this.fftSize || 1024) / 2;
  }
  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(this.amplitude);
  }
  disconnect(): void {
    this.disconnectCalls++;
  }
}

/** A fake AudioContext that hands out a single {@link FakeAnalyser}. */
class FakeCtx implements MouthAudioContextLike {
  constructor(readonly analyser: FakeAnalyser) {}
  createAnalyser(): AnalyserNodeLike {
    return this.analyser;
  }
}

/** A fake source that records the analyser it was connected to. */
class FakeSource implements MouthSourceLike {
  connectedTo: unknown = null;
  connect(destination: unknown): void {
    this.connectedTo = destination;
  }
}

/**
 * A controllable rAF: `request` queues callbacks; `flush(n)` runs up to `n`
 * pending frames. Lets a test step the loop deterministically without real time.
 */
class FakeRaf implements RafScheduler {
  private queue = new Map<number, FrameRequestCallback>();
  private seq = 1;
  cancelled: number[] = [];
  request(cb: FrameRequestCallback): number {
    const h = this.seq++;
    this.queue.set(h, cb);
    return h;
  }
  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.queue.delete(handle);
  }
  /** Run up to `frames` currently-pending callbacks (each may enqueue the next). */
  flush(frames: number): void {
    for (let i = 0; i < frames; i++) {
      const next = this.queue.entries().next();
      if (next.done) {
        return;
      }
      const [h, cb] = next.value;
      this.queue.delete(h);
      cb(performance.now());
    }
  }
  pending(): number {
    return this.queue.size;
  }
}

describe('AmplitudeMouthService (AnalyserNode → openness)', () => {
  let svc: AmplitudeMouthService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [AmplitudeMouthService] });
    svc = TestBed.inject(AmplitudeMouthService);
  });

  it('drives openness UP from a loud analyser frame over rAF frames', () => {
    const analyser = new FakeAnalyser(0.6); // well above the reference → target 1
    const ctx = new FakeCtx(analyser);
    const source = new FakeSource();
    const raf = new FakeRaf();

    const drive = svc.drive(source, ctx, { reducedMotion: () => false, raf });

    expect(drive.openness()).toBe(0); // starts closed
    // Source is wired into the analyser we created (fftSize configured too).
    expect(source.connectedTo).toBe(analyser);
    expect(analyser.fftSize).toBeGreaterThan(0);

    raf.flush(1);
    const afterOne = drive.openness();
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(1); // eased, not snapped

    raf.flush(30);
    expect(drive.openness()).toBeGreaterThan(afterOne); // keeps rising toward open
    expect(drive.openness()).toBeGreaterThan(0.9);

    drive.stop();
  });

  it('a SILENT analyser keeps the mouth closed (openness ~0)', () => {
    const ctx = new FakeCtx(new FakeAnalyser(0));
    const raf = new FakeRaf();
    const drive = svc.drive(new FakeSource(), ctx, { reducedMotion: () => false, raf });

    raf.flush(20);
    expect(drive.openness()).toBe(0);
    drive.stop();
  });

  it('respects a custom reference implicitly via the openness math (loud → near 1)', () => {
    // Sanity that the reference used is the shared one (loud > reference → opens).
    const ctx = new FakeCtx(new FakeAnalyser(OPEN_RMS_REFERENCE * 2));
    const raf = new FakeRaf();
    const drive = svc.drive(new FakeSource(), ctx, { reducedMotion: () => false, raf });
    raf.flush(40);
    expect(drive.openness()).toBeGreaterThan(0.9);
    drive.stop();
  });

  describe('REDUCED MOTION', () => {
    it('pins openness to 0, creates NO analyser, and schedules NO rAF loop', () => {
      const analyser = new FakeAnalyser(0.9);
      const ctx = new FakeCtx(analyser);
      const createSpy = spyOn(ctx, 'createAnalyser').and.callThrough();
      const source = new FakeSource();
      const raf = new FakeRaf();

      const drive = svc.drive(source, ctx, { reducedMotion: () => true, raf });

      expect(drive.openness()).toBe(0);
      raf.flush(10); // even if something were queued
      expect(drive.openness()).toBe(0); // stays static
      expect(createSpy).not.toHaveBeenCalled(); // no analyser attached
      expect(source.connectedTo).toBeNull(); // source untouched
      expect(raf.pending()).toBe(0); // no loop scheduled

      drive.stop(); // still safe/idempotent
      expect(drive.openness()).toBe(0);
    });
  });

  describe('NO LEAK (cleanup)', () => {
    it('stop() cancels the rAF, disconnects the analyser, and resets openness to 0', () => {
      const analyser = new FakeAnalyser(0.6);
      const ctx = new FakeCtx(analyser);
      const raf = new FakeRaf();
      const drive = svc.drive(new FakeSource(), ctx, { reducedMotion: () => false, raf });

      raf.flush(5);
      expect(drive.openness()).toBeGreaterThan(0);

      drive.stop();

      expect(analyser.disconnectCalls).toBe(1);
      expect(raf.cancelled.length).toBeGreaterThan(0);
      expect(drive.openness()).toBe(0);

      // After stop, no further frames advance openness (loop is dead).
      raf.flush(10);
      expect(drive.openness()).toBe(0);
    });

    it('stop() is idempotent (a second call is a no-op, no double-disconnect)', () => {
      const analyser = new FakeAnalyser(0.6);
      const drive = svc.drive(new FakeSource(), new FakeCtx(analyser), {
        reducedMotion: () => false,
        raf: new FakeRaf(),
      });
      drive.stop();
      drive.stop();
      expect(analyser.disconnectCalls).toBe(1);
    });
  });
});
