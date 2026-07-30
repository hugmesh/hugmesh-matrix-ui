#!/usr/bin/env node
/**
 * Regenerates e2e/face-track/face-clip.y4m — the committed synthetic face
 * clip the face-track e2e feeds Chrome's fake camera
 * (--use-file-for-fake-video-capture). See clip-gen.html for the drawing +
 * animation; this script serves that page to headless Chrome, receives the
 * raw I420 planes back, and writes the .y4m.
 *
 * Usage: node e2e/face-track/gen-clip.mjs
 * Requires google-chrome-stable (same binary the e2e itself uses).
 *
 * Geometry/timing constants MUST match clip-gen.html.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_W = 256, OUT_H = 192, FPS = 12;          // must match clip-gen.html
const FRAME_BYTES = OUT_W * OUT_H * 1.5;
const OUT_FILE = path.join(HERE, 'face-clip.y4m');
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';
const TIMEOUT_MS = 60_000;

async function main() {
  let resolveFrames, rejectFrames;
  const framesArrived = new Promise((res, rej) => { resolveFrames = res; rejectFrames = rej; });

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/clip-gen.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(await readFile(path.join(HERE, 'clip-gen.html')));
      return;
    }
    if (req.method === 'POST' && (req.url === '/frames' || req.url === '/error')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.writeHead(200); res.end('ok');
      const body = Buffer.concat(chunks);
      if (req.url === '/error') rejectFrames(new Error(`page error: ${body}`));
      else resolveFrames(body);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const profile = await mkdtemp(path.join(tmpdir(), 'face-clip-gen-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--mute-audio', `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/clip-gen.html`,
  ], { stdio: 'ignore' });

  const timer = setTimeout(() => rejectFrames(new Error('timed out waiting for frames')), TIMEOUT_MS);
  try {
    const body = await framesArrived;
    clearTimeout(timer);
    if (body.length % FRAME_BYTES !== 0) {
      throw new Error(`bad payload: ${body.length} bytes is not a multiple of ${FRAME_BYTES}`);
    }
    const nFrames = body.length / FRAME_BYTES;
    const parts = [Buffer.from(`YUV4MPEG2 W${OUT_W} H${OUT_H} F${FPS}:1 Ip A1:1 C420\n`)];
    for (let i = 0; i < nFrames; i++) {
      parts.push(Buffer.from('FRAME\n'));
      parts.push(body.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES));
    }
    const y4m = Buffer.concat(parts);
    await writeFile(OUT_FILE, y4m);
    console.log(`wrote ${OUT_FILE}: ${nFrames} frames ${OUT_W}x${OUT_H}@${FPS}fps, ${(y4m.length / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    chrome.kill('SIGKILL');
    server.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
