#!/usr/bin/env node
/**
 * Desktop-first face-tracking e2e (XR-chat DESIGN §6 Stage 2) — the
 * karma-independent runner behind `npm run e2e:face`.
 *
 * What it proves, end to end and with REAL parts only:
 *   headless Chromium + --use-fake-device-for-media-stream fed the committed
 *   face-clip.y4m  →  the REAL FaceTrackService (real getUserMedia camera
 *   open, real capture loop)  →  the REAL face-track.worker bundle  →  the
 *   REAL self-hosted MediaPipe FaceLandmarker (vendored wasm + the committed
 *   face_landmarker.task model, served under the same assets/mediapipe/
 *   layout production uses)  →  the emitted 52-float blendshape vectors.
 *
 * The assertions are on the VECTOR STREAM, not "worker started": the model
 * must actually DETECT the synthetic face (face=true samples) and the
 * jawOpen / eyeBlink* / eyeLook* channels must move over the clip's animation
 * (jaw cycles, gaze holds left+right, a three-frame blink) by honest minimum
 * ranges. Measured ranges are printed either way.
 *
 * Three scenarios run by default (subset via FACE_E2E_ONLY=gpu,cpu,nogl):
 *   gpu   GPU delegate (software WebGL via --enable-unsafe-swiftshader) —
 *         full tracking assertions.
 *   cpu   CPU inference delegate pinned via the worker's documented init
 *         `delegate` field, WebGL still present (the realistic fallback on
 *         devices whose GPU delegate is refused) — full tracking assertions.
 *   nogl  NO WebGL at all (--disable-gpu): tasks-vision 0.10.35 cannot
 *         ingest frames without GL (it texture-uploads every input type), so
 *         the assertion here is the HONEST FAILURE path — the worker's
 *         persistent-detection-failure escalation must flip the service to
 *         `unavailable` with a WHY note and release the camera by itself.
 *
 * Steps per scenario: esbuild-bundle the worker + harness (real sources,
 * root tsconfig; once) → serve harness + assets on a loopback port → spawn
 * Chrome with the fake camera → receive the result POST → assert → exit 0/1.
 */
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BUILD = path.join(HERE, '.build');
const CLIP = path.join(HERE, 'face-clip.y4m');
const WASM_DIR = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const MODEL = path.join(ROOT, 'projects', 'matrix', 'src', 'assets', 'mediapipe', 'face_landmarker.task');
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';
const SCENARIO_TIMEOUT_MS = 120_000;

// ── Honest minimum ranges (calibration table in this directory's README):
// measured ranges on healthy runs are 2.5-10x these floors, and the floors
// sit far above detector noise on a static face (<0.02).
const MIN_FACE_SAMPLES = 40;      // ≥40 face-detected vectors (~3s of stream)
const MIN_JAW_RANGE = 0.15;       // measured ~0.41 (jaw opens wide twice)
const MIN_BLINK_RANGE = 0.2;      // measured ~0.52/0.58 (three-frame blink)
const MIN_GAZE_RANGE = 0.25;      // measured ~0.81-0.89 (gaze holds L + R)

const SCENARIOS = {
  gpu: {
    label: 'GPU delegate (software WebGL)',
    chromeArgs: ['--enable-unsafe-swiftshader'],
    query: '',
    expect: 'tracking',
    pinnedDelegate: null,
  },
  cpu: {
    label: 'CPU delegate pinned (WebGL present — realistic fallback)',
    chromeArgs: ['--enable-unsafe-swiftshader'],
    query: '?delegate=CPU',
    expect: 'tracking',
    pinnedDelegate: 'CPU',
  },
  nogl: {
    label: 'no WebGL (--disable-gpu) — honest unavailable + camera released',
    chromeArgs: ['--disable-gpu'],
    query: '',
    expect: 'teardown',
    pinnedDelegate: null,
  },
};

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.map': 'application/json',
  '.json': 'application/json',
};

function esbuild(args) {
  return new Promise((res, rej) => {
    const p = spawn(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), args, {
      cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'],
    });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`esbuild exited ${code}`))));
    p.on('error', rej);
  });
}

async function bundle() {
  await mkdir(BUILD, { recursive: true });
  const common = [
    '--bundle', '--format=esm', '--platform=browser', '--target=es2022',
    `--tsconfig=${path.join(ROOT, 'tsconfig.json')}`, '--log-level=warning',
  ];
  await esbuild([
    path.join(ROOT, 'projects', 'matrix', 'src', 'app', 'chat3d', 'face-track.worker.ts'),
    `--outfile=${path.join(BUILD, 'face-track.worker.js')}`, ...common,
  ]);
  await esbuild([
    path.join(HERE, 'harness-main.ts'),
    `--outfile=${path.join(BUILD, 'harness-main.js')}`, ...common,
  ]);
}

async function serveFile(res, filePath) {
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    console.error(`  [server] 404 ${filePath}`);
    res.writeHead(404); res.end('not found: ' + filePath);
  }
}

function startServer(onResult, onError) {
  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.writeHead(200); res.end('ok');
      const body = Buffer.concat(chunks).toString('utf8');
      if (url === '/result') onResult(JSON.parse(body));
      else onError(new Error(`harness error: ${body}`));
      return;
    }
    if (url === '/' || url === '/harness.html') return serveFile(res, path.join(HERE, 'harness.html'));
    if (url === '/harness-main.js') return serveFile(res, path.join(BUILD, 'harness-main.js'));
    if (url === '/face-track.worker.js') return serveFile(res, path.join(BUILD, 'face-track.worker.js'));
    // Same assets/mediapipe/ layout the deployed remote serves (angular.json
    // maps the npm wasm dir there; the model is committed there).
    if (url.startsWith('/assets/mediapipe/wasm/')) {
      return serveFile(res, path.join(WASM_DIR, path.basename(url)));
    }
    if (url === '/assets/mediapipe/face_landmarker.task') return serveFile(res, MODEL);
    res.writeHead(404); res.end('not found');
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)));
}

/** One scenario: fresh server + fresh Chrome profile → harness result. */
async function runScenario(scenario) {
  let settle, fail;
  const finished = new Promise((res, rej) => { settle = res; fail = rej; });
  let done = false;
  const onResult = (r) => { if (!done) { done = true; settle(r); } };
  const onError = (e) => { if (!done) { done = true; fail(e); } };

  const server = await startServer(onResult, onError);
  const port = server.address().port;
  const profile = await mkdtemp(path.join(tmpdir(), 'face-e2e-'));
  const chromeErr = [];
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${CLIP}`,
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    ...scenario.chromeArgs,
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/harness.html${scenario.query}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', (d) => chromeErr.push(d));
  chrome.on('exit', (code) =>
    onError(new Error(`chrome exited early (${code})\n${Buffer.concat(chromeErr)}`)));
  const timer = setTimeout(() =>
    onError(new Error(`timed out after ${SCENARIO_TIMEOUT_MS}ms\n${Buffer.concat(chromeErr)}`)), SCENARIO_TIMEOUT_MS);

  try {
    return await finished;
  } finally {
    clearTimeout(timer);
    chrome.removeAllListeners('exit');
    chrome.kill('SIGKILL');
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

function measureRanges(result) {
  const names = result.names ?? [];
  const face = (result.samples ?? []).filter((s) => s.face);
  return (name) => {
    const i = names.indexOf(name);
    if (i < 0 || face.length === 0) return { min: NaN, max: NaN, range: NaN };
    let min = Infinity, max = -Infinity;
    for (const s of face) {
      const v = s.values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max, range: max - min };
  };
}

/** Assert + print one scenario's result; returns true when all checks pass. */
function report(key, scenario, result) {
  const samples = result.samples ?? [];
  const face = samples.filter((s) => s.face);
  const range = measureRanges(result);
  console.log(`\nscenario ${key}: ${scenario.label}`);
  console.log(`  status=${result.status} delegate=${result.delegate} started=${result.started}`);
  if (result.note) console.log(`  note: ${result.note}`);
  for (const ev of result.workerEvents ?? []) {
    console.log(`  worker event: ${JSON.stringify(ev)}`);
  }
  console.log(`  vectors emitted: ${samples.length} (face-detected: ${face.length})`);
  if (result.captureStats) console.log(`  capture stats: ${JSON.stringify(result.captureStats)}`);

  let checks;
  if (scenario.expect === 'teardown') {
    const workerError = (result.workerEvents ?? []).find(
      (ev) => ev && ev.t === 'error' && String(ev.message).includes('detection failing persistently'));
    checks = [
      ['start() succeeded (camera + worker + model all loaded)', result.started === true],
      ['worker escalated the persistent detection failure', workerError !== undefined],
      ['service flipped to unavailable', result.status === 'unavailable'],
      ['WHY note says tracking stopped working', String(result.note).includes('stopped working')],
      ['no blendshape vector was ever emitted', samples.length === 0],
      ['service released the camera BY ITSELF', result.cameraReleasedByService === true],
      ['stop() left the service clean', result.stoppedClean === true],
    ];
  } else {
    const watched = [
      'jawOpen',
      'eyeBlinkLeft', 'eyeBlinkRight',
      'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookInRight', 'eyeLookOutRight',
      'eyeLookUpLeft', 'eyeLookDownLeft', 'eyeLookUpRight', 'eyeLookDownRight',
      'browInnerUp',
    ];
    console.log('  measured ranges over face-detected samples:');
    const measured = {};
    for (const name of watched) {
      measured[name] = range(name);
      const r = measured[name];
      console.log(`    ${name.padEnd(18)} min ${r.min.toFixed(3)}  max ${r.max.toFixed(3)}  range ${r.range.toFixed(3)}`);
    }
    const badVector = samples.find((s) =>
      s.values.length !== result.blendshapeCount ||
      s.values.some((v) => !Number.isFinite(v) || v < -0.001 || v > 1.001));
    let tsMonotonic = true;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].ts < samples[i - 1].ts) { tsMonotonic = false; break; }
    }
    checks = [
      ['service started and reached running', result.started === true && result.status === 'running'],
      ['delegate reported (GPU or CPU)', result.delegate === 'GPU' || result.delegate === 'CPU'],
      ...(scenario.pinnedDelegate
        ? [[`pinned delegate honored (${scenario.pinnedDelegate})`, result.delegate === scenario.pinnedDelegate]]
        : []),
      [`face DETECTED on ≥${MIN_FACE_SAMPLES} vectors`, face.length >= MIN_FACE_SAMPLES],
      ['face detected on ≥60% of emitted vectors', samples.length > 0 && face.length / samples.length >= 0.6],
      ['every vector is 52 finite floats in [0,1]', samples.length > 0 && !badVector],
      ['vector timestamps monotonic non-decreasing', tsMonotonic],
      ['latest quantized vector present while running', result.latestQuantizedPresent === true],
      [`jawOpen range ≥ ${MIN_JAW_RANGE} (jaw cycles)`, measured['jawOpen'].range >= MIN_JAW_RANGE],
      [`eyeBlinkLeft range ≥ ${MIN_BLINK_RANGE} (blink)`, measured['eyeBlinkLeft'].range >= MIN_BLINK_RANGE],
      [`eyeBlinkRight range ≥ ${MIN_BLINK_RANGE} (blink)`, measured['eyeBlinkRight'].range >= MIN_BLINK_RANGE],
      [`eyeLookOutLeft range ≥ ${MIN_GAZE_RANGE} (gaze left)`, measured['eyeLookOutLeft'].range >= MIN_GAZE_RANGE],
      [`eyeLookInRight range ≥ ${MIN_GAZE_RANGE} (gaze left)`, measured['eyeLookInRight'].range >= MIN_GAZE_RANGE],
      [`eyeLookInLeft range ≥ ${MIN_GAZE_RANGE} (gaze right)`, measured['eyeLookInLeft'].range >= MIN_GAZE_RANGE],
      [`eyeLookOutRight range ≥ ${MIN_GAZE_RANGE} (gaze right)`, measured['eyeLookOutRight'].range >= MIN_GAZE_RANGE],
      ['camera tracks ended after stop()', result.cameraTracksEnded === true],
      ['stop() left the service clean (vectors cleared)', result.stoppedClean === true],
    ];
  }
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed++;
  }
  console.log(`  scenario ${key}: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})`);
  return failed === 0;
}

async function main() {
  const clipStat = await stat(CLIP).catch(() => null);
  if (!clipStat) {
    throw new Error(`missing ${CLIP} — regenerate with: node e2e/face-track/gen-clip.mjs`);
  }
  const only = (process.env.FACE_E2E_ONLY ?? Object.keys(SCENARIOS).join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const key of only) {
    if (!SCENARIOS[key]) throw new Error(`unknown FACE_E2E_ONLY scenario '${key}' (valid: ${Object.keys(SCENARIOS).join(',')})`);
  }
  console.log(`face-track e2e — real FaceTrackService + self-hosted MediaPipe over ${path.basename(CLIP)} (${(clipStat.size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`scenarios: ${only.join(', ')}`);
  await bundle();

  const outcomes = [];
  for (const key of only) {
    const result = await runScenario(SCENARIOS[key]);
    outcomes.push([key, report(key, SCENARIOS[key], result)]);
  }
  const failedKeys = outcomes.filter(([, ok]) => !ok).map(([k]) => k);
  console.log(failedKeys.length === 0
    ? `\nface-track e2e: PASS (${outcomes.length}/${outcomes.length} scenarios)`
    : `\nface-track e2e: FAIL (failing scenarios: ${failedKeys.join(', ')})`);
  return failedKeys.length === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
