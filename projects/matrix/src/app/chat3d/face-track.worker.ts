/// <reference lib="webworker" />
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { BLENDSHAPE_COUNT } from './av-channel';

/**
 * The camera face-tracking Web Worker (XR-chat DESIGN §6 Stage 2): MediaPipe
 * FaceLandmarker in VIDEO running mode, entirely SELF-HOSTED — the wasm
 * runtime is vendored under `assets/mediapipe/wasm/` (see angular.json's
 * `@mediapipe/tasks-vision` asset mapping) and the `face_landmarker.task`
 * model ships in the remote's own assets, so NOTHING is fetched from Google.
 * Default asset URLs resolve against THIS WORKER's own location (the worker
 * chunk sits at the deployed remote root, next to `assets/`), overridable via
 * the init message for non-standard hosting.
 *
 * PRIVACY: camera frames come IN (ImageBitmaps, transferred); the only thing
 * that ever goes OUT is the 52-float blendshape vector — no image data leaves
 * this worker in any direction, and the worker itself makes no network calls
 * beyond loading its vendored wasm/model.
 *
 * Message contract (mirrored by FaceTrackService and its specs):
 *   in : {t:'init', wasmBase?, modelUrl?, delegate?}
 *        → load; GPU delegate first with CPU fallback, unless `delegate`
 *          pins one (diagnostics/e2e — the service itself never pins)
 *   out: {t:'ready', delegate:'GPU'|'CPU'}  | {t:'error', message}
 *   in : {t:'frame', bitmap, ts}            (bitmap transferred)
 *   out: {t:'blendshapes', values: Float32Array(52), ts, face: boolean}
 *   out: {t:'error', message}               (persistent detection failure —
 *                                            see DETECT_FAILURE_LIMIT)
 *   in : {t:'close'}                        → release the landmarker + exit
 *
 * A frame arriving while the previous detect is still running is DROPPED
 * (bounded latency beats a growing backlog at 15-24Hz).
 *
 * KNOWN LIMIT (proven by the e2e:face no-GL leg): tasks-vision 0.10.35
 * texture-uploads EVERY input type — ImageBitmap and ImageData alike — so an
 * environment with no WebGL at all (--disable-gpu) cannot ingest frames even
 * with the CPU inference delegate; the persistent-failure escalation turns
 * that into the honest `unavailable` + camera-released state.
 */

let landmarker: FaceLandmarker | null = null;
let busy = false;

/** A single bad frame is dropped silently and the next frame retries — but
 *  EVERY frame failing means detection is structurally broken (e.g. the CPU
 *  delegate can't read this frame source), and eternal silence would leave
 *  the camera on with a dead tracker. After this many CONSECUTIVE failures
 *  the worker reports an honest error instead (the service then shuts the
 *  camera down and falls back to the amplitude mouth, with a WHY note). */
export const DETECT_FAILURE_LIMIT = 10;
let consecutiveDetectFailures = 0;
let lastDetectError: unknown = null;

/**
 * Makes the emscripten wasm loader work inside a MODULE worker (which this
 * worker is — both here and in the Angular production build).
 *
 * tasks-vision loads `vision_wasm_internal.js` via `importScripts()`; in a
 * module worker that throws and its fallback dynamic-`import()`s the file
 * instead. But the loader is UMD-tail-only (`var ModuleFactory = …` then
 * `module.exports = ModuleFactory`): executed as an ES module its
 * `ModuleFactory` stays MODULE-scoped, `self.ModuleFactory` is never set, and
 * FaceLandmarker creation dies with "ModuleFactory not set." (found by the
 * e2e:face harness — the karma specs fake this worker and can't see it).
 *
 * The bridge exposes a global `module.exports` SETTER that forwards the
 * factory to `self.ModuleFactory`, which the UMD tail then feeds. Two more
 * wrinkles it covers:
 *  - dynamic `import()` CACHES: a GPU→CPU retry re-imports the loader without
 *    re-running the UMD tail, so `self.ModuleFactory` must survive MediaPipe's
 *    post-init `self.ModuleFactory = undefined` cleanup — the accessor keeps
 *    the last real factory and ignores the `undefined` clear;
 *  - `module.exports.default = ModuleFactory` reads back through the getter.
 * No eval, no blob: URLs — the loader stays a plain same-origin import, so
 * the page CSP (`script-src 'self' 'wasm-unsafe-eval'`) still holds.
 *
 * It also pre-defines a global `custom_dbg`: the loader's
 * `custom_emscripten_dbgn` helper declares its fallback
 * `function custom_dbg(){…}` INSIDE an `if` block — fine in sloppy classic
 * scripts (Annex B hoists it), but modules are strict, the declaration stays
 * block-scoped, and the first wasm debug line then dies with
 * `ReferenceError: custom_dbg is not defined`, taking landmarker init with
 * it. With the global pre-defined, the loader's `typeof (custom_dbg)` check
 * finds it and the broken block never runs.
 */
function ensureModuleFactoryBridge(): void {
  const g = self as unknown as Record<string, unknown>;
  if (typeof g['custom_dbg'] !== 'function') {
    // eslint-disable-next-line no-console -- emscripten debug sink (worker-local)
    g['custom_dbg'] = (...args: unknown[]) => console.warn(...args);
  }
  if (g['module']) {
    return; // already bridged (or a loader that brings its own CJS shim)
  }
  let factory: unknown;
  Object.defineProperty(self, 'ModuleFactory', {
    configurable: true,
    get: () => factory,
    set: (v: unknown) => {
      if (v !== undefined) {
        factory = v;
      }
    },
  });
  g['exports'] = {};
  g['module'] = {
    get exports() {
      return factory;
    },
    set exports(v: unknown) {
      factory = v;
    },
  };
}

/** GPU first (a WebGL context inside the worker), CPU wasm as the fallback —
 *  headless/CI/older devices commonly refuse the GPU delegate. */
async function init(wasmBase: string, modelUrl: string, only?: 'GPU' | 'CPU'): Promise<void> {
  ensureModuleFactoryBridge();
  let lastError: unknown = null;
  for (const delegate of only ? [only] : (['GPU', 'CPU'] as const)) {
    try {
      const fileset = await FilesetResolver.forVisionTasks(wasmBase);
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
      postMessage({ t: 'ready', delegate });
      return;
    } catch (e) {
      lastError = e;
    }
  }
  postMessage({ t: 'error', message: String(lastError) });
}

function detect(bitmap: ImageBitmap, ts: number): void {
  if (!landmarker || busy) {
    bitmap.close();
    return;
  }
  busy = true;
  try {
    const result = landmarker.detectForVideo(bitmap, ts);
    const categories = result.faceBlendshapes?.[0]?.categories ?? [];
    const values = new Float32Array(BLENDSHAPE_COUNT);
    for (const c of categories) {
      // The model emits categories in canonical index order; trust the index
      // field (bounds-checked) rather than array position.
      if (Number.isInteger(c.index) && c.index >= 0 && c.index < BLENDSHAPE_COUNT) {
        values[c.index] = c.score;
      }
    }
    postMessage({ t: 'blendshapes', values, ts, face: categories.length > 0 }, { transfer: [values.buffer] });
    consecutiveDetectFailures = 0;
  } catch (e) {
    // A single bad frame is dropped silently; the next frame retries. A
    // persistent failure streak escalates to an honest error (see above).
    lastDetectError = e;
    if (++consecutiveDetectFailures >= DETECT_FAILURE_LIMIT) {
      postMessage({ t: 'error', message: `detection failing persistently: ${String(lastDetectError)}` });
    }
  } finally {
    busy = false;
    bitmap.close();
  }
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { t?: string; wasmBase?: string; modelUrl?: string; delegate?: string; bitmap?: ImageBitmap; ts?: number } | null;
  switch (msg?.t) {
    case 'init': {
      const wasmBase = msg.wasmBase || new URL('assets/mediapipe/wasm', self.location.href).toString();
      const modelUrl = msg.modelUrl || new URL('assets/mediapipe/face_landmarker.task', self.location.href).toString();
      void init(wasmBase, modelUrl, msg.delegate === 'GPU' || msg.delegate === 'CPU' ? msg.delegate : undefined);
      return;
    }
    case 'frame':
      if (msg.bitmap) {
        detect(msg.bitmap, msg.ts ?? 0);
      }
      return;
    case 'close':
      landmarker?.close();
      landmarker = null;
      self.close();
      return;
  }
};
