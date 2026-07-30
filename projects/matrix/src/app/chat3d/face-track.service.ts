import { Injectable, signal } from '@angular/core';
import { BLENDSHAPE_COUNT, quantizeBlendshapes } from './av-channel';
import { QuantizedBlendshapes } from './mesh-call.service';

/**
 * Camera face tracking for the DESKTOP-FIRST no-headset mode (XR-chat DESIGN
 * §6 Stage 2): a webcam-only desktop user must see their avatar blink, look
 * around and lip-sync live. This service owns the CAMERA side; the model runs
 * in the {@link ./face-track.worker} Web Worker (self-hosted MediaPipe
 * FaceLandmarker, VIDEO mode, GPU delegate with CPU fallback) so the UI
 * thread never blocks on inference.
 *
 * PRIVACY (opt-in only): the camera starts ONLY from the join menu's explicit
 * camera toggle — never implicitly. Frames go browser→worker on this device
 * and are closed after each inference; the ONLY derived output is the 52-float
 * blendshape vector: raw frames never leave the device (the mesh broadcasts
 * the QUANTIZED 52-byte vector, nothing else).
 *
 * The 52 floats drive BOTH:
 *  - the local avatar (raw {@link blendshapes} signal — eyes/brows/jaw); and
 *  - the peer broadcast ({@link latestQuantized} — MeshCallService sends it
 *    at 15Hz as the `chat3d` channel's blendshapes frame).
 *
 * CAPABILITY HONESTY: a refused camera, a failed worker/model load, or an
 * absent webcam resolve to status `unavailable` with a WHY note — the room
 * keeps running on the amplitude-mouth fallback (DESIGN §6: amplitude
 * fallback when tracking is off/dark).
 */

/** Frame capture cadence — 50ms ≈ 20Hz, inside the 15-24Hz VIDEO-mode band;
 *  in-flight frames are skipped so a slow device degrades to a lower rate
 *  instead of building a backlog. */
export const FACE_TRACK_INTERVAL_MS = 50;

/** Capture resolution — landmarking needs no more than QVGA-ish input, and a
 *  small bitmap keeps the per-frame transfer + inference cheap. */
export const FACE_TRACK_WIDTH = 320;
export const FACE_TRACK_HEIGHT = 240;

/** How long a posted frame may sit unanswered before the gate re-opens — a
 *  worker that dropped a frame (transient decode failure) must not wedge the
 *  capture loop shut forever. */
export const FRAME_INFLIGHT_TIMEOUT_MS = 500;

export type FaceTrackStatus = 'idle' | 'starting' | 'running' | 'unavailable';

/** The narrowed Worker surface (fakeable in specs). */
export interface FaceWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** The narrowed video-frame source the capture loop reads (fakeable). */
export interface FrameSourceLike {
  /** The live camera stream's tracks (stopped on {@link FaceTrackService.stop}). */
  stream: MediaStream;
  /** Grab the next frame as a transferable bitmap (null = not ready yet). */
  grabFrame(): Promise<ImageBitmap | null>;
  /** Release everything the source holds (video element, etc.). */
  close(): void;
}

@Injectable({ providedIn: 'root' })
export class FaceTrackService {
  // ── Injection seams (specs assign fakes; defaults are the real APIs) ──

  /** Builds the face-tracking worker (the bundled module worker). */
  workerFactory: () => FaceWorkerLike = () =>
    new Worker(new URL('./face-track.worker', import.meta.url), { type: 'module' }) as unknown as FaceWorkerLike;

  /** Opens the camera and wires a hidden <video> as the frame source. */
  frameSourceFactory: () => Promise<FrameSourceLike> = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: FACE_TRACK_WIDTH, height: FACE_TRACK_HEIGHT, frameRate: { ideal: 24 } },
      audio: false,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    return {
      stream,
      grabFrame: async () => {
        if (video.readyState < 2 || video.videoWidth === 0) {
          return null;
        }
        return createImageBitmap(video);
      },
      close: () => {
        video.pause();
        video.srcObject = null;
      },
    };
  };

  /** ms clock (fakeable). */
  now: () => number = () => Date.now();

  /** Most ms the worker/model load may take before an honest give-up. */
  loadTimeoutMs = 20_000;

  // ── Honest state surface ──

  readonly status = signal<FaceTrackStatus>('idle');
  /** Which delegate the worker landed on (GPU preferred, CPU fallback). */
  readonly delegate = signal<'GPU' | 'CPU' | null>(null);
  /** WHY tracking is not running ('' while it is / before it was asked). */
  readonly note = signal('');
  /** True while the model currently sees a face in frame. */
  readonly faceVisible = signal(false);
  /** Latest RAW 52-float vector — the local avatar's face drive (eyes, brows,
   *  jaw — the desktop-first requirement consumes THIS, not the wire bytes). */
  readonly blendshapes = signal<Float32Array | null>(null);

  private worker: FaceWorkerLike | null = null;
  private source: FrameSourceLike | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** When the in-flight frame was posted (the wedge-guard's clock). */
  private inFlightSinceMs = 0;
  private quantized: QuantizedBlendshapes | null = null;

  /**
   * Latest quantized vector + monotonic ts for the mesh broadcast (null until
   * the first detection, and after {@link stop} — the mesh's ts-diffing means
   * a stale vector is never resent).
   */
  latestQuantized(): QuantizedBlendshapes | null {
    return this.quantized;
  }

  /**
   * OPT-IN start (join-menu camera toggle only). Resolves true when tracking
   * reached `running`; false leaves an honest WHY note behind. Idempotent
   * while already starting/running.
   */
  async start(): Promise<boolean> {
    if (this.status() === 'running' || this.status() === 'starting') {
      return this.status() === 'running';
    }
    this.status.set('starting');
    this.note.set('');
    try {
      this.source = await this.frameSourceFactory();
    } catch {
      this.status.set('unavailable');
      this.note.set('Camera unavailable or refused — face tracking is off; your avatar\'s mouth follows your voice instead.');
      return false;
    }
    const ready = new Promise<boolean>((resolve) => {
      let worker: FaceWorkerLike;
      try {
        worker = this.workerFactory();
      } catch {
        resolve(false);
        return;
      }
      this.worker = worker;
      worker.onmessage = (ev) => {
        this.handleWorkerMessage(ev.data);
        const s = this.status();
        if (s === 'running' || s === 'unavailable') {
          resolve(s === 'running');
        }
      };
      worker.onerror = () => {
        this.status.set('unavailable');
        this.note.set('Face tracking failed to load — your avatar\'s mouth follows your voice instead.');
        resolve(false);
      };
      worker.postMessage({ t: 'init' });
      // A hung load (bad wasm path, wedged GPU) must resolve, not dangle.
      setTimeout(() => resolve(this.status() === 'running'), this.loadTimeoutMs);
    });
    const ok = await ready;
    if (!ok) {
      this.stop();
      this.status.set('unavailable');
      if (!this.note()) {
        this.note.set('Face tracking failed to load — your avatar\'s mouth follows your voice instead.');
      }
      return false;
    }
    this.captureTimer = setInterval(() => void this.captureOnce(), FACE_TRACK_INTERVAL_MS);
    return true;
  }

  /** Stop tracking: camera off, worker down, vectors cleared (amplitude
   *  fallback resumes because {@link latestQuantized} goes null). */
  stop(): void {
    if (this.captureTimer !== null) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.worker) {
      try {
        this.worker.postMessage({ t: 'close' });
      } catch { /* worker already gone */ }
      this.worker.terminate();
      this.worker = null;
    }
    this.source?.stream.getTracks().forEach((t) => t.stop());
    this.source?.close();
    this.source = null;
    this.inFlight = false;
    this.quantized = null;
    this.blendshapes.set(null);
    this.faceVisible.set(false);
    this.delegate.set(null);
    if (this.status() !== 'unavailable') {
      this.status.set('idle');
    }
  }

  /**
   * One capture tick (public so specs drive it deterministically): grab a
   * bitmap and hand it to the worker, transferred. Skipped while a previous
   * frame is still in flight — bounded latency at a degraded rate beats a
   * backlog.
   */
  async captureOnce(): Promise<void> {
    // Wedge guard: a frame the worker never answered (dropped on a transient
    // failure) re-opens the gate after FRAME_INFLIGHT_TIMEOUT_MS.
    if (this.inFlight && this.now() - this.inFlightSinceMs > FRAME_INFLIGHT_TIMEOUT_MS) {
      this.inFlight = false;
    }
    if (this.inFlight || !this.worker || !this.source || this.status() !== 'running') {
      return;
    }
    this.inFlight = true;
    this.inFlightSinceMs = this.now();
    try {
      const bitmap = await this.source.grabFrame();
      if (!bitmap) {
        this.inFlight = false;
        return;
      }
      this.worker.postMessage({ t: 'frame', bitmap, ts: this.now() }, [bitmap]);
    } catch {
      this.inFlight = false;
    }
  }

  /**
   * The worker message contract, host side (public — the specs' seam):
   * `ready` flips to running (with the delegate + an honest CPU note),
   * `error` to unavailable, `blendshapes` updates the raw signal + the
   * quantized broadcast vector and re-opens the frame gate.
   */
  handleWorkerMessage(data: unknown): void {
    const msg = data as { t?: string; delegate?: string; message?: string; values?: Float32Array; ts?: number; face?: boolean } | null;
    switch (msg?.t) {
      case 'ready': {
        const delegate = msg.delegate === 'GPU' ? 'GPU' : 'CPU';
        this.delegate.set(delegate);
        this.status.set('running');
        this.note.set(delegate === 'CPU'
          ? 'Face tracking is running on the CPU (no GPU delegate available) — expect a lower frame rate.'
          : '');
        return;
      }
      case 'error': {
        // Before `ready` this is a load failure; while RUNNING it is the
        // worker's persistent-detection-failure escalation — either way the
        // camera must not stay on for a dead tracker (privacy: no lit webcam
        // LED without tracking), so tear the pipeline down too.
        const wasRunning = this.status() === 'running';
        this.status.set('unavailable');
        this.note.set(wasRunning
          ? 'Face tracking stopped working (camera frames could not be processed) — your avatar\'s mouth follows your voice instead.'
          : 'Face tracking failed to load — your avatar\'s mouth follows your voice instead.');
        if (wasRunning) {
          this.stop(); // keeps 'unavailable'; releases camera + worker
        }
        return;
      }
      case 'blendshapes': {
        this.inFlight = false;
        const values = msg.values;
        if (!(values instanceof Float32Array) || values.length !== BLENDSHAPE_COUNT) {
          return;
        }
        this.faceVisible.set(msg.face === true);
        this.blendshapes.set(values);
        this.quantized = { values: quantizeBlendshapes(values), ts: msg.ts ?? this.now() };
        return;
      }
    }
  }
}
