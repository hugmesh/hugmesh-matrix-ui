# face-track e2e — real camera→worker→MediaPipe pipeline (`npm run e2e:face`)

The desktop-first face-tracking e2e required by XR-chat DESIGN §6 Stage 2.
Headless Chromium's **fake camera device plays the committed
[`face-clip.y4m`](./face-clip.y4m)** into the **real `FaceTrackService`** (real
`getUserMedia`, real capture loop). The service drives the **real
`face-track.worker`** bundle, which runs the **real self-hosted MediaPipe
FaceLandmarker**: wasm from the pinned `@mediapipe/tasks-vision` package and the
committed `face_landmarker.task` model, served under the same `assets/mediapipe/`
layout production uses. Assertions are on the **emitted 52-float blendshape vector
stream**, never on "the worker started".

It does not use karma or Playwright. A plain node runner ([`run.mjs`](./run.mjs))
bundles the real worker and a thin harness page with esbuild, serves them on a
loopback port, and launches `google-chrome-stable --headless=new` with

```
--use-fake-ui-for-media-stream
--use-fake-device-for-media-stream
--use-file-for-fake-video-capture=e2e/face-track/face-clip.y4m
```

The vector stream comes back over a result POST. The harness page substitutes only
the service's **documented injection seams** (`workerFactory`, pointing at the
sibling worker bundle, and observation-only wrappers that count pipeline stages).
Every production code path runs.

## Scenarios

| scenario | environment | asserts |
|---|---|---|
| `gpu` | software WebGL (`--enable-unsafe-swiftshader`) | full tracking (16 checks) |
| `cpu` | CPU inference delegate pinned via the worker init message's documented `delegate` field, WebGL present | full tracking + pin honored (17 checks) |
| `nogl` | `--disable-gpu` — no WebGL at all | the HONEST FAILURE path (7 checks): tasks-vision 0.10.35 texture-uploads every input type (ImageBitmap **and** ImageData), so frame ingestion is impossible without GL; the worker's persistent-detection-failure escalation must flip the service to `unavailable` with a "stopped working" WHY note and **release the camera by itself** |

Run a subset with `FACE_E2E_ONLY=gpu,cpu`; override the browser with
`CHROME_BIN=…`.

## The committed clip

`face-clip.y4m` — 24 frames, 256×192 @ 12fps, C420, 1.69 MB (Chrome's file capture
consumes raw y4m, and loops it). The face is synthetic but **detection-validated**.
MediaPipe's BlazeFace detector rejects flat cartoon line-art, so this face is shaded
to make the real detector fire. The e2e asserts `face=true` on ≥60% of vectors, so a
clip regression cannot pass silently. Animation timeline (frame numbers in
[`clip-gen.html`](./clip-gen.html)):

- 0–7: full jaw open/close cycle → `jawOpen`
- 8–11: gaze hold LEFT → `eyeLookOutLeft`/`eyeLookInRight`
- 12–15: gaze hold RIGHT → `eyeLookInLeft`/`eyeLookOutRight`
- 16–18: three-frame blink (closed lids drawn shut) → `eyeBlinkLeft/Right`
- 19: eyes wide, brows raised → `browInnerUp`
- 20–23: second softer jaw cycle

Regenerate with `npm run e2e:face:clip`. Headless Chrome draws the frames on a
canvas and converts them to I420 in-page; the node server writes the y4m. ffmpeg is
not involved.

## Assertion floors vs measured ranges (calibration)

Floors sit about 2.5–3.5× below healthy measured ranges and far above detector noise
on a static face (<0.02). Measured on 2026-07-23, Chrome 149, GPU (swiftshader) and
CPU delegates:

| channel | floor | measured (gpu) | measured (cpu) |
|---|---|---|---|
| `jawOpen` | 0.15 | ~0.41 | ~0.40 |
| `eyeBlinkLeft` / `Right` | 0.20 | ~0.52 / 0.58 | ~0.61 / 0.65 |
| `eyeLookOutLeft` / `InRight` (gaze left) | 0.25 | ~0.88 / 0.88 | ~0.88 / 0.88 |
| `eyeLookInLeft` / `OutRight` (gaze right) | 0.25 | ~0.81 / 0.81 | ~0.81 / 0.80 |

Structural checks on top: ≥40 face-detected vectors, ≥60% detection rate, every
vector 52 finite floats in [0,1], monotonic timestamps, a quantized broadcast vector
present, camera tracks ended after `stop()`, clean teardown.

## Real bugs this harness caught (fixed on this branch)

All three are fixed on `main`.

1. **`ModuleFactory not set.`** — the emscripten wasm loader is UMD-tail-only;
   dynamically `import()`ed by tasks-vision's module-worker fallback its
   `var ModuleFactory` never reached the global scope, so the landmarker could
   NEVER load in a module worker (which the production Angular build is).
   Fixed by the worker's `ensureModuleFactoryBridge()` (a global
   `module.exports` setter forwarding to `self.ModuleFactory`, surviving both
   MediaPipe's post-init clear and dynamic-import caching on the GPU→CPU
   retry).
2. **`ReferenceError: custom_dbg is not defined`** — the loader's fallback
   `function custom_dbg` is declared inside an `if` block; fine in sloppy
   classic scripts (Annex B), block-scoped in strict module execution, so the
   first wasm debug line crashed init. The bridge pre-defines the global.
3. **Silent persistent detection failure** — the worker dropped EVERY failing
   frame silently (by-design for single bad frames), so a structurally broken
   environment (no WebGL) left the camera on forever with a dead tracker.
   Now `DETECT_FAILURE_LIMIT` consecutive failures escalate to an honest
   worker error, and the service tears the pipeline down (camera released,
   `unavailable` + WHY note) — the `nogl` scenario proves it end to end.
