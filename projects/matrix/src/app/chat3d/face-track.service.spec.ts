import { TestBed } from '@angular/core/testing';
import { BLENDSHAPE_COUNT, JAW_OPEN_INDEX } from './av-channel';
import { FaceTrackService, FaceWorkerLike, FrameSourceLike } from './face-track.service';

class FakeWorker implements FaceWorkerLike {
  posted: { message: unknown; transfer?: Transferable[] }[] = [];
  terminated = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Deliver a worker→service message through the real handler wiring. */
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function fakeBitmap(): ImageBitmap {
  return { close: jasmine.createSpy('close'), width: 320, height: 240 } as unknown as ImageBitmap;
}

describe('FaceTrackService (worker message contract, opt-in camera, honest fallback)', () => {
  let svc: FaceTrackService;
  let worker: FakeWorker;
  let workerFactoryCalls: number;
  let tracks: { stop: jasmine.Spy }[];
  let sourceClosed: boolean;
  let nextBitmap: ImageBitmap | null;
  let fakeNow: number;
  let cameraRefused: boolean;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(FaceTrackService);
    worker = new FakeWorker();
    workerFactoryCalls = 0;
    tracks = [{ stop: jasmine.createSpy('stop') }];
    sourceClosed = false;
    nextBitmap = fakeBitmap();
    fakeNow = 50_000;
    cameraRefused = false;
    svc.now = () => fakeNow;
    svc.workerFactory = () => {
      workerFactoryCalls++;
      return worker;
    };
    svc.frameSourceFactory = async (): Promise<FrameSourceLike> => {
      if (cameraRefused) {
        throw new DOMException('denied', 'NotAllowedError');
      }
      return {
        stream: { getTracks: () => tracks } as unknown as MediaStream,
        grabFrame: async () => nextBitmap,
        close: () => {
          sourceClosed = true;
        },
      };
    };
  });

  afterEach(() => svc.stop());

  /** start() + worker ready handshake in one step. */
  async function started(delegate: 'GPU' | 'CPU' = 'GPU'): Promise<boolean> {
    const p = svc.start();
    // Let start() reach the init postMessage before the ready reply.
    await Promise.resolve();
    await Promise.resolve();
    worker.emit({ t: 'ready', delegate });
    return p;
  }

  it('is OPT-IN: no camera, no worker until start() is called', () => {
    expect(svc.status()).toBe('idle');
    expect(workerFactoryCalls).toBe(0);
    expect(svc.latestQuantized()).toBeNull();
  });

  it('start() sends init, and the ready handshake flips to running (GPU, no note)', async () => {
    const ok = await started('GPU');
    expect(ok).toBeTrue();
    expect(svc.status()).toBe('running');
    expect(svc.delegate()).toBe('GPU');
    expect(svc.note()).toBe('');
    expect(worker.posted[0].message).toEqual({ t: 'init' });
  });

  it('a CPU-delegate ready is honest about the lower frame rate', async () => {
    await started('CPU');
    expect(svc.status()).toBe('running');
    expect(svc.delegate()).toBe('CPU');
    expect(svc.note().toLowerCase()).toContain('cpu');
  });

  it('a refused camera resolves unavailable with a WHY note and NEVER builds the worker', async () => {
    cameraRefused = true;
    const ok = await svc.start();
    expect(ok).toBeFalse();
    expect(svc.status()).toBe('unavailable');
    expect(svc.note().toLowerCase()).toContain('voice');
    expect(workerFactoryCalls).toBe(0);
  });

  it('a worker load error resolves unavailable, stops the camera and keeps the amplitude-fallback note', async () => {
    const p = svc.start();
    await Promise.resolve();
    await Promise.resolve();
    worker.emit({ t: 'error', message: 'wasm exploded' });
    const ok = await p;
    expect(ok).toBeFalse();
    expect(svc.status()).toBe('unavailable');
    expect(svc.note().toLowerCase()).toContain('voice');
    expect(tracks[0].stop).toHaveBeenCalled(); // camera released on failure
    expect(worker.terminated).toBeTrue();
  });

  it('a PERSISTENT detection failure while running tears the pipeline down: camera off, honest WHY note', async () => {
    // The worker escalates DETECT_FAILURE_LIMIT consecutive detect failures
    // to an error message; the service must not leave the camera capturing
    // for a dead tracker (found by the e2e:face no-WebGL scenario).
    await started();
    worker.emit({ t: 'blendshapes', values: new Float32Array(BLENDSHAPE_COUNT), ts: 1, face: true });
    expect(svc.latestQuantized()).not.toBeNull();
    worker.emit({ t: 'error', message: 'detection failing persistently: TypeError: …' });
    expect(svc.status()).toBe('unavailable');
    expect(svc.note()).toContain('stopped working');
    expect(tracks[0].stop).toHaveBeenCalled();     // camera released BY the service
    expect(worker.terminated).toBeTrue();
    expect(svc.blendshapes()).toBeNull();          // amplitude fallback resumes
    expect(svc.latestQuantized()).toBeNull();
  });

  it('captureOnce() transfers a frame to the worker and gates until the reply', async () => {
    await started();
    await svc.captureOnce();
    const frames = worker.posted.filter((p) => (p.message as { t: string }).t === 'frame');
    expect(frames.length).toBe(1);
    expect((frames[0].message as { ts: number }).ts).toBe(fakeNow);
    expect(frames[0].transfer).toEqual([nextBitmap as unknown as Transferable]);
    // Gate closed: a second capture before the reply sends nothing.
    await svc.captureOnce();
    expect(worker.posted.filter((p) => (p.message as { t: string }).t === 'frame').length).toBe(1);
    // The blendshapes reply re-opens the gate.
    worker.emit({ t: 'blendshapes', values: new Float32Array(BLENDSHAPE_COUNT), ts: fakeNow, face: true });
    await svc.captureOnce();
    expect(worker.posted.filter((p) => (p.message as { t: string }).t === 'frame').length).toBe(2);
  });

  it('WEDGE GUARD: an unanswered frame re-opens the gate after the in-flight timeout', async () => {
    await started();
    await svc.captureOnce();
    await svc.captureOnce();
    expect(worker.posted.filter((p) => (p.message as { t: string }).t === 'frame').length).toBe(1);
    fakeNow += 600; // > FRAME_INFLIGHT_TIMEOUT_MS
    await svc.captureOnce();
    expect(worker.posted.filter((p) => (p.message as { t: string }).t === 'frame').length).toBe(2);
  });

  it('a blendshapes reply updates the raw vector, the face flag AND the quantized broadcast vector', async () => {
    await started();
    const values = new Float32Array(BLENDSHAPE_COUNT);
    values[JAW_OPEN_INDEX] = 0.5;
    worker.emit({ t: 'blendshapes', values, ts: 123, face: true });
    expect(svc.faceVisible()).toBeTrue();
    expect(svc.blendshapes()).toBe(values);
    const q = svc.latestQuantized()!;
    expect(q.ts).toBe(123);
    expect(q.values.length).toBe(BLENDSHAPE_COUNT);
    expect(q.values[JAW_OPEN_INDEX]).toBe(128);
  });

  it('REJECTS a malformed blendshapes reply (wrong length / wrong type)', async () => {
    await started();
    worker.emit({ t: 'blendshapes', values: new Float32Array(10), ts: 1, face: true });
    worker.emit({ t: 'blendshapes', values: [0.1, 0.2], ts: 2, face: true });
    worker.emit({ t: 'blendshapes' });
    expect(svc.blendshapes()).toBeNull();
    expect(svc.latestQuantized()).toBeNull();
  });

  it('face lost keeps the vector flowing but drops the face flag', async () => {
    await started();
    worker.emit({ t: 'blendshapes', values: new Float32Array(BLENDSHAPE_COUNT), ts: 1, face: true });
    expect(svc.faceVisible()).toBeTrue();
    worker.emit({ t: 'blendshapes', values: new Float32Array(BLENDSHAPE_COUNT), ts: 2, face: false });
    expect(svc.faceVisible()).toBeFalse();
  });

  it('stop() releases the camera + worker and clears the vectors (amplitude fallback resumes)', async () => {
    await started();
    worker.emit({ t: 'blendshapes', values: new Float32Array(BLENDSHAPE_COUNT), ts: 1, face: true });
    expect(svc.latestQuantized()).not.toBeNull();
    svc.stop();
    expect(worker.terminated).toBeTrue();
    expect(worker.posted[worker.posted.length - 1].message).toEqual({ t: 'close' });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(sourceClosed).toBeTrue();
    expect(svc.status()).toBe('idle');
    expect(svc.blendshapes()).toBeNull();
    expect(svc.latestQuantized()).toBeNull();
    expect(svc.faceVisible()).toBeFalse();
  });
});
