/**
 * In-page entry of the face-track e2e (XR-chat DESIGN §6 Stage 2): runs the
 * REAL {@link FaceTrackService} — real getUserMedia (Chrome's fake device fed
 * by the committed face-clip.y4m), the real face-track.worker bundle, real
 * self-hosted MediaPipe wasm + model — and streams every emitted 52-float
 * blendshape vector back to run.mjs for assertion.
 *
 * The ONLY substitution is the `workerFactory` injection seam (the service's
 * designated fake/rewire point): the bundler emits the worker as a sibling
 * file, so the factory points at './face-track.worker.js' instead of the
 * Angular build's `new URL(...)` chunk. The worker CODE is the real one.
 * The factory + frame-source wrappers below are OBSERVATION-only (pipeline
 * stage counters so a dead stream is diagnosable) with one exception: when
 * run.mjs passes `?delegate=CPU|GPU`, the init message is re-posted with the
 * worker's documented delegate pin — that is the worker's own testability
 * contract, not a bypass.
 */
import { FaceTrackService } from '../../projects/matrix/src/app/chat3d/face-track.service';
import { BLENDSHAPE_COUNT, BLENDSHAPE_NAMES } from '../../projects/matrix/src/app/chat3d/av-channel';

/** Face-visible vectors to collect before reporting (~8s at 15-20Hz). */
const TARGET_FACE_SAMPLES = 120;
/** Hard cap on the collection phase (model load happens before this). */
const COLLECT_TIMEOUT_MS = 45_000;

interface Sample { ts: number; face: boolean; values: number[] }

async function post(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  const pinDelegate = new URLSearchParams(window.location.search).get('delegate');
  const svc = new FaceTrackService();

  /** Pipeline-stage counters (observation only — the real code paths run
   *  unchanged) so a zero-vector run pinpoints WHERE the stream died. */
  const captureStats = { grabOk: 0, grabNull: 0, grabThrow: 0, framesPosted: 0 };
  svc.workerFactory = () => {
    const worker = new Worker(new URL('./face-track.worker.js', window.location.href), { type: 'module' });
    const origPost = worker.postMessage.bind(worker);
    (worker as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage = (m, t) => {
      const msg = m as { t?: string } | null;
      if (msg?.t === 'frame') captureStats.framesPosted++;
      if (msg?.t === 'init' && (pinDelegate === 'CPU' || pinDelegate === 'GPU')) {
        origPost({ ...(m as object), delegate: pinDelegate } as never, t as never);
        return;
      }
      origPost(m as never, t as never);
    };
    return worker;
  };
  let cameraStream: MediaStream | null = null;
  const origSourceFactory = svc.frameSourceFactory.bind(svc);
  svc.frameSourceFactory = async () => {
    const source = await origSourceFactory();
    cameraStream = source.stream;
    const origGrab = source.grabFrame.bind(source);
    source.grabFrame = async () => {
      try {
        const bitmap = await origGrab();
        if (bitmap) captureStats.grabOk++; else captureStats.grabNull++;
        return bitmap;
      } catch (e) {
        captureStats.grabThrow++;
        throw e;
      }
    };
    return source;
  };

  const samples: Sample[] = [];
  /** Non-blendshape worker events (ready/error) verbatim — honest failure
   *  diagnostics for the runner's report. */
  const workerEvents: unknown[] = [];
  const orig = svc.handleWorkerMessage.bind(svc);
  svc.handleWorkerMessage = (data: unknown): void => {
    orig(data);
    const msg = data as { t?: string; values?: Float32Array; ts?: number; face?: boolean } | null;
    if (msg?.t === 'blendshapes' && msg.values instanceof Float32Array) {
      samples.push({ ts: msg.ts ?? 0, face: msg.face === true, values: Array.from(msg.values) });
    } else {
      workerEvents.push(data);
    }
  };

  const started = await svc.start();
  const deadline = Date.now() + COLLECT_TIMEOUT_MS;
  while (
    started &&
    Date.now() < deadline &&
    svc.status() !== 'unavailable' && // the honest-teardown scenarios end here
    samples.filter((s) => s.face).length < TARGET_FACE_SAMPLES
  ) {
    await new Promise((r) => setTimeout(r, 250));
  }

  const statusBeforeStop = svc.status();
  /** Captured BEFORE the harness's own stop(): in the honest-teardown
   *  scenario the SERVICE must already have ended every camera track itself
   *  (no lit webcam LED for a dead tracker). */
  const cameraReleasedByService =
    cameraStream !== null && (cameraStream as MediaStream).getTracks().every((t) => t.readyState === 'ended');
  const result = {
    started,
    status: statusBeforeStop,
    delegate: svc.delegate(),
    note: svc.note(),
    faceVisibleAtEnd: svc.faceVisible(),
    latestQuantizedPresent: svc.latestQuantized() !== null,
    blendshapeCount: BLENDSHAPE_COUNT,
    names: [...BLENDSHAPE_NAMES],
    workerEvents,
    captureStats,
    samples,
  };
  svc.stop();
  const stoppedClean =
    (svc.status() === 'idle' || svc.status() === 'unavailable') &&
    svc.blendshapes() === null && svc.latestQuantized() === null;
  const cameraTracksEnded =
    cameraStream !== null && (cameraStream as MediaStream).getTracks().every((t) => t.readyState === 'ended');
  await post('/result', { ...result, stoppedClean, cameraReleasedByService, cameraTracksEnded });
}

main().catch((e) => post('/error', { message: String((e as Error)?.stack ?? e) }));
