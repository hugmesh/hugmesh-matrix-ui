import { Injectable, InjectionToken, inject } from '@angular/core';
import { MatrixService } from '../../matrix.service';
import { VoiceSynthService } from './voice-synth.service';
import { nextOpenness, DEFAULT_FFT_SIZE } from './openness';

/**
 * The RECORDED VOICE CLIP payoff (Phase B3 Wave B).
 *
 * {@link CharacterCaptureService.recordAndSend} captures the SPEAKING VN
 * character — the animating portrait (the same amplitude MOUTH as the live
 * panel, drawn onto an off-screen canvas) PLUS its TTS audio — into a single
 * `video/webm` clip via {@link MediaRecorder}, uploads it to the content repo,
 * and posts it to the room as an `m.video` message. It reuses Wave A end to end:
 * the audio comes from {@link VoiceSynthService.synth} (the dark synth seam), and
 * the mouth openness is the SAME pure {@link nextOpenness} RMS math the live panel
 * uses — so the recorded frame matches what a viewer sees on-screen.
 *
 * DARK BY DEFAULT — gated on the SAME `voice.tts.enabled` flag as Wave A (read
 * transitively through {@link VoiceSynthService.isEnabled}). With the flag off,
 * `recordAndSend` is a total NO-OP: no synth call, no capture, no upload, no send.
 * The TTS backend is held for a spike, so this ships behind the flag and is fully
 * exercised in tests against mocks.
 *
 * FAIL-SOFT everywhere: a flag-off, a `null` synth, no character image, a
 * recorder error, or an upload/send error all resolve WITHOUT sending and WITHOUT
 * throwing — with FULL teardown (recorder stopped, AudioContext closed, rAF
 * cancelled, captureStream tracks stopped, object URLs revoked). A MAX-duration
 * cap guarantees a stuck recorder can never run forever.
 *
 * UNTAINTED CANVAS: the character image passed in MUST be the sanitized `data:`
 * SVG or the `blob:` (object-URL) mxc the panel already renders — both are
 * same-origin/untainted, so `canvas.captureStream()` never throws a
 * `SecurityError`. A raw cross-origin `http(s)` mxc would TAINT the canvas and is
 * rejected up-front.
 */
@Injectable({ providedIn: 'root' })
export class CharacterCaptureService {
  private readonly matrix = inject(MatrixService);
  private readonly synth = inject(VoiceSynthService);
  /** Injected media collaborators; defaults to the real browser APIs. */
  private readonly io = inject(CAPTURE_IO, { optional: true }) ?? defaultCaptureIo();

  /** Whether capture is possible at all (same dark flag as Wave A voice). */
  isEnabled(): boolean {
    return this.synth.isEnabled();
  }

  /**
   * Synthesize `text` in `characterCtx.character`'s voice, RECORD the animating
   * portrait + audio into a `video/webm` clip, upload it, and post it to
   * `roomId` as an `m.video` message. Returns the sent event id, or `null` when
   * nothing was sent (flag off / no synth / no image / any error). NEVER throws.
   *
   * The WIRE `url` is ALWAYS the returned mxc — never the local `blob:` clip URL.
   */
  async recordAndSend(
    roomId: string,
    text: string,
    characterCtx: CharacterCaptureContext,
  ): Promise<string | null> {
    // DARK: same flag as Wave A. No backend deployed → no capture, no send.
    if (!this.isEnabled()) {
      return null;
    }
    if (!roomId || !(text && text.trim())) {
      return null;
    }
    // UNTAINTED CANVAS guard: only a same-origin data:/blob: image may be drawn.
    const imageSrc = characterCtx?.imageSrc ?? '';
    if (!isUntaintedImageSrc(imageSrc)) {
      return null;
    }

    // Synthesize FIRST (Wave A seam). null → flag off (defensive) / blank / failure.
    const clip = await this.synth.synth(text.trim(), { character: characterCtx.character });
    if (!clip || !clip.buffer) {
      return null;
    }

    const maxMs = clampMaxMs(characterCtx.maxDurationMs);
    try {
      const blob = await this.capture(clip.buffer, imageSrc, characterCtx, maxMs);
      if (!blob || blob.size === 0) {
        return null;
      }
      const durationMs = Math.min(Math.round(clip.buffer.duration * 1000) || clip.durationMs || 0, maxMs);
      // Report the ACTUAL clamped capture edge as w/h (not a hardcoded const).
      return await this.send(roomId, blob, durationMs, clampSize(characterCtx.size));
    } catch {
      // Fail-soft: any capture/upload/send error → no send, no throw.
      return null;
    }
  }

  /**
   * Run ONE capture session: build the audio graph (source → capture dest +
   * analyser [+ audible destination]), draw the portrait + amplitude mouth onto
   * an off-screen canvas on a rAF loop, wire the canvas video track + capture
   * audio track into a {@link MediaRecorder}, start everything together, and stop
   * on the source `ended` OR the max-duration cap — then assemble the chunks into
   * a `video/webm` {@link Blob}. Tears EVERYTHING down on success AND error.
   */
  private async capture(
    buffer: AudioBuffer,
    imageSrc: string,
    ctx: CharacterCaptureContext,
    maxMs: number,
  ): Promise<Blob | null> {
    const fps = clampFps(ctx.fps);
    const size = clampSize(ctx.size);
    const anchor = normalizeAnchor(ctx.mouthAnchor);

    // Load the (untainted) character image BEFORE any capture starts.
    const image = await this.io.loadImage(imageSrc);
    if (!image) {
      return null;
    }

    const audio = this.io.createAudioContext();
    const canvas = this.io.createCanvas(size, size);
    const c2d = canvas.getContext('2d');
    if (!c2d) {
      await safeClose(audio);
      return null;
    }

    // ── Audio graph ──────────────────────────────────────────────────────────
    // source → captureDest (the recorded AUDIO track) + analyser (drives mouth).
    // Optionally also → audio.destination so the capture is audible live.
    const source = audio.createBufferSource();
    source.buffer = buffer;
    const captureDest = audio.createMediaStreamDestination();
    const analyser = audio.createAnalyser();
    analyser.fftSize = DEFAULT_FFT_SIZE;
    source.connect(captureDest);
    source.connect(analyser);
    if (ctx.audible && audio.destination) {
      try {
        source.connect(audio.destination);
      } catch {
        /* audible playback is best-effort — never block capture */
      }
    }
    const samples = new Float32Array(analyser.frequencyBinCount);

    // ── Video: off-screen canvas captureStream ────────────────────────────────
    const canvasStream = canvas.captureStream(fps);
    const videoTrack = canvasStream.getVideoTracks()[0];
    const audioTrack = captureDest.stream.getAudioTracks()[0];
    const tracks: MediaStreamTrackLike[] = [];
    if (videoTrack) tracks.push(videoTrack);
    if (audioTrack) tracks.push(audioTrack);
    const recStream = this.io.createStream(tracks);
    const recorder = this.io.createRecorder(recStream, { mimeType: 'video/webm' });

    const chunks: BlobPart[] = [];
    let openness = 0;
    let rafHandle = 0;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    // Backstop timer: force-settles if recorder.stop() returns but onstop never
    // fires (a misbehaving MediaRecorder), so the promise can't hang and teardown
    // still runs (no track/AudioContext leak).
    let stopFallback: ReturnType<typeof setTimeout> | null = null;
    let torndown = false;

    // ── Teardown (idempotent) — runs on end, error, and cancel. NO leak. ───────
    const teardown = (): void => {
      if (torndown) {
        return;
      }
      torndown = true;
      if (rafHandle !== 0) {
        this.io.cancelRaf(rafHandle);
        rafHandle = 0;
      }
      if (stopTimer !== null) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
      if (stopFallback !== null) {
        clearTimeout(stopFallback);
        stopFallback = null;
      }
      try {
        source.stop();
      } catch {
        /* not started / already stopped — ignore */
      }
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
      try {
        analyser.disconnect();
      } catch {
        /* ignore */
      }
      // Stop every captureStream track so the camera-light-style capture ends.
      for (const t of tracks) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      void safeClose(audio);
    };

    return await new Promise<Blob | null>((resolve) => {
      let settled = false;
      const finish = (blob: Blob | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        teardown();
        resolve(blob);
      };

      recorder.ondataavailable = (e: BlobEventLike) => {
        if (e && e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      recorder.onstop = () => {
        // Assemble the recorded chunks into ONE webm blob.
        const blob = this.io.assembleBlob(chunks, 'video/webm');
        finish(blob);
      };
      recorder.onerror = () => finish(null);

      // Stop the recorder exactly once, whichever trigger fires first.
      let stopping = false;
      const stopRecorder = (): void => {
        if (stopping) {
          return;
        }
        stopping = true;
        if (rafHandle !== 0) {
          this.io.cancelRaf(rafHandle);
          rafHandle = 0;
        }
        try {
          // Arm the backstop BEFORE stop() so a SYNCHRONOUS onstop during stop()
          // clears it via teardown, while a stop() that returns without ever
          // firing onstop is still force-settled after STOP_FALLBACK_MS.
          stopFallback = setTimeout(
            () => finish(this.io.assembleBlob(chunks, 'video/webm')),
            STOP_FALLBACK_MS,
          );
          recorder.stop();
        } catch {
          // If stop() throws, there will be no onstop — settle directly.
          finish(this.io.assembleBlob(chunks, 'video/webm'));
        }
      };

      // ── Draw loop: portrait + amplitude mouth, matching the live panel. ──────
      const draw = (): void => {
        analyser.getFloatTimeDomainData(samples);
        openness = nextOpenness(openness, samples);
        c2d.clearRect(0, 0, size, size);
        try {
          c2d.drawImage(image, 0, 0, size, size);
        } catch {
          /* a bad frame must not kill the recording */
        }
        // The amplitude MOUTH: an ellipse at the anchor, ry scaled by openness —
        // the canvas-2D analogue of the panel's SVG overlay (same openness math).
        const cx = anchor.x * size;
        const cy = anchor.y * size;
        const ry = openness * (MOUTH_MAX_RY_RATIO * size);
        if (ry > 0.5) {
          c2d.save();
          c2d.fillStyle = MOUTH_FILL;
          c2d.beginPath();
          c2d.ellipse(cx, cy, MOUTH_RX_RATIO * size, ry, 0, 0, Math.PI * 2);
          c2d.fill();
          c2d.restore();
        }
        rafHandle = this.io.requestRaf(draw);
      };

      try {
        source.onended = () => stopRecorder();
        recorder.start();
        source.start();
        rafHandle = this.io.requestRaf(draw);
        // MAX-duration cap: a stuck recorder / a source that never ends can't
        // run forever — force a stop after the cap.
        stopTimer = setTimeout(() => stopRecorder(), maxMs);
      } catch {
        finish(null);
      }
    });
  }

  /** Upload the clip as a `video/webm` File, then post it as an `m.video` message. */
  private async send(roomId: string, blob: Blob, durationMs: number, size: number): Promise<string | null> {
    const file = this.io.toFile([blob], 'character-voice.webm', 'video/webm');
    const uploaded = await this.matrix.uploadMedia(file);
    const mxc = uploaded?.mxcUri ?? '';
    // The WIRE url MUST be the mxc — never the local blob:/File URL.
    if (!mxc || !mxc.startsWith('mxc://')) {
      return null;
    }
    const content = {
      msgtype: 'm.video',
      body: 'Character voice clip',
      url: mxc,
      info: {
        mimetype: 'video/webm',
        size: blob.size,
        duration: durationMs,
        w: size,
        h: size,
      },
    };
    return await this.matrix.sendEvent(roomId, 'm.room.message', content, freshTxnId());
  }
}

/** The default portrait edge (px) — mirrors the live panel's 160x160 stage. */
export const CAPTURE_SIZE = 160;
/** Default capture frame rate. */
const DEFAULT_FPS = 24;
/** Default / hard max clip duration (ms) — a stuck recorder can't outrun this. */
const DEFAULT_MAX_MS = 15_000;
/**
 * Backstop window (ms) after `recorder.stop()`: if `onstop` never fires, the
 * capture promise is force-settled from the chunks gathered so far — so it can
 * never hang and teardown always runs. Well above a real recorder's flush time.
 */
export const STOP_FALLBACK_MS = 3000;
/** Mouth ellipse half-width as a ratio of the canvas edge. */
const MOUTH_RX_RATIO = 11 / 160;
/** Mouth ellipse MAX half-height (openness=1) as a ratio of the canvas edge. */
const MOUTH_MAX_RY_RATIO = 22 / 160;
/** The drawn mouth fill (a dark maw, decorative). */
const MOUTH_FILL = 'rgba(40,20,25,0.85)';
/** Lower-centre fallback mouth anchor (0..1 of the canvas), matching the panel. */
const FALLBACK_ANCHOR = { x: 0.5, y: 0.72 };

/**
 * The context for one capture: WHICH character image to draw (a same-origin
 * `data:`/`blob:` src — the panel's `src()`), the character id for voice
 * mapping, the mouth anchor (0..1 of the canvas), and optional knobs.
 */
export interface CharacterCaptureContext {
  /**
   * The character `<img>` source to draw — MUST be the sanitized `data:` SVG or
   * the `blob:` object-URL mxc (same-origin/untainted). A raw cross-origin
   * `http(s)` mxc is rejected (it would taint the canvas → SecurityError).
   */
  imageSrc: string;
  /** The VN character id, so the synth backend can map it to a voice. */
  character?: string;
  /** Mouth anchor (0..1 of the canvas); defaults to the lower-centre. */
  mouthAnchor?: { x: number; y: number } | null;
  /** Portrait edge in px (default {@link CAPTURE_SIZE}). */
  size?: number;
  /** Capture frame rate (default 24). */
  fps?: number;
  /** Max clip duration cap in ms (default/hard-max {@link DEFAULT_MAX_MS}). */
  maxDurationMs?: number;
  /** Also route the audio to the speakers during capture (default false). */
  audible?: boolean;
}

/**
 * Whether `src` is a SAME-ORIGIN, UNTAINTED image source safe to `drawImage`
 * onto a canvas we then `captureStream`. Only `data:` (the sanitized composed
 * SVG) and `blob:` (an authenticated mxc object URL) qualify — a raw
 * cross-origin `http(s)` mxc would taint the canvas and make `captureStream`
 * throw a `SecurityError`, so it is rejected here.
 */
export function isUntaintedImageSrc(src: string): boolean {
  if (typeof src !== 'string' || src.length === 0) {
    return false;
  }
  return src.startsWith('data:image/') || src.startsWith('blob:');
}

/** Clamp the max-duration to a sane, bounded window (never 0/∞). */
function clampMaxMs(ms: number | undefined): number {
  if (!Number.isFinite(ms) || (ms as number) <= 0) {
    return DEFAULT_MAX_MS;
  }
  return Math.min(ms as number, DEFAULT_MAX_MS);
}

/** Clamp fps to a small positive range. */
function clampFps(fps: number | undefined): number {
  if (!Number.isFinite(fps) || (fps as number) <= 0) {
    return DEFAULT_FPS;
  }
  return Math.min(Math.max(Math.round(fps as number), 1), 60);
}

/** Clamp the canvas edge to a positive, bounded size. */
function clampSize(size: number | undefined): number {
  if (!Number.isFinite(size) || (size as number) <= 0) {
    return CAPTURE_SIZE;
  }
  return Math.min(Math.max(Math.round(size as number), 16), 512);
}

/** Normalize a mouth anchor to a finite 0..1 pair, else the fallback. */
function normalizeAnchor(a: { x: number; y: number } | null | undefined): { x: number; y: number } {
  if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) {
    return { x: clamp01(a.x), y: clamp01(a.y) };
  }
  return FALLBACK_ANCHOR;
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

/** A fresh Matrix txn id for the m.video send (idempotency key). */
function freshTxnId(): string {
  return `vnclip-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Best-effort close of an AudioContext (may already be closed). */
async function safeClose(audio: CaptureAudioContextLike): Promise<void> {
  try {
    await audio.close();
  } catch {
    /* ignore */
  }
}

// ─────────────────────────── Injectable media surfaces ───────────────────────
// Everything the capture touches — MediaRecorder, canvas.captureStream, the
// AudioContext, the image loader, Blob/File assembly, and rAF — goes through the
// narrow CaptureIo below, so a UNIT test drives the whole happy path against
// fakes with NO real encoding, canvas, or Web Audio.

/** The narrowed MediaRecorder surface we use (fakeable). */
export interface MediaRecorderLike {
  ondataavailable: ((e: BlobEventLike) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e?: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
  readonly state?: string;
}

/** The `dataavailable` event shape we read (just the blob chunk). */
export interface BlobEventLike {
  readonly data: Blob;
}

/** The narrowed AudioContext surface the capture graph needs (fakeable). */
export interface CaptureAudioContextLike {
  readonly destination: AudioNode | null;
  createBufferSource(): CaptureBufferSourceLike;
  createMediaStreamDestination(): MediaStreamAudioDestinationLike;
  createAnalyser(): CaptureAnalyserLike;
  close(): Promise<void>;
}

/** The narrowed source node — connect to several destinations + start/stop. */
export interface CaptureBufferSourceLike {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  connect(destination: any): void;
  disconnect(): void;
  start(): void;
  stop(): void;
}

/** A MediaStreamAudioDestinationNode — exposes the capture audio stream. */
export interface MediaStreamAudioDestinationLike {
  readonly stream: MediaStreamLike;
}

/** The narrowed analyser (drives the mouth openness during capture). */
export interface CaptureAnalyserLike {
  fftSize: number;
  readonly frequencyBinCount: number;
  getFloatTimeDomainData(array: Float32Array): void;
  connect?(destination: any): void;
  disconnect(): void;
}

/** A media stream we can pull tracks from (audio + video). */
export interface MediaStreamLike {
  getVideoTracks(): MediaStreamTrackLike[];
  getAudioTracks(): MediaStreamTrackLike[];
}

/** A single media track — the one thing we do to it on teardown is stop(). */
export interface MediaStreamTrackLike {
  stop(): void;
  readonly kind?: string;
}

/** The narrowed off-screen canvas the portrait is drawn onto + captured from. */
export interface CaptureCanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
  captureStream(fps?: number): MediaStreamLike;
}

/** An image the capture can drawImage — a loaded HTMLImageElement (or fake). */
export type CaptureImageLike = CanvasImageSource;

/**
 * The full injectable media surface. Production ({@link defaultCaptureIo}) uses
 * real browser APIs; a spec provides a stub whose recorder emits a fake webm
 * blob, whose audio nodes are fakes, and whose image loader resolves a fake —
 * so unit tests never need a real codec, canvas, or Web Audio device.
 */
export interface CaptureIo {
  /** Load `src` (a data:/blob: URL) into a drawable image, or null on error. */
  loadImage(src: string): Promise<CaptureImageLike | null>;
  createAudioContext(): CaptureAudioContextLike;
  createCanvas(width: number, height: number): CaptureCanvasLike;
  createStream(tracks: MediaStreamTrackLike[]): MediaStreamLike;
  createRecorder(stream: MediaStreamLike, opts: { mimeType: string }): MediaRecorderLike;
  assembleBlob(parts: BlobPart[], mimeType: string): Blob;
  toFile(parts: BlobPart[], name: string, mimeType: string): File;
  requestRaf(cb: () => void): number;
  cancelRaf(handle: number): void;
}

/** DI token for {@link CaptureIo} — tests provide a stub. */
export const CAPTURE_IO = new InjectionToken<CaptureIo>('CHARACTER_CAPTURE_IO');

/**
 * The production {@link CaptureIo}: real `MediaRecorder`, an off-screen
 * `<canvas>` + `captureStream`, a real `AudioContext` + nodes, an
 * `HTMLImageElement` loader, and `Blob`/`File` assembly. Kept out of the service
 * body so the spec can swap the whole thing with fakes.
 */
export function defaultCaptureIo(): CaptureIo {
  return {
    loadImage(src: string): Promise<CaptureImageLike | null> {
      return new Promise((resolve) => {
        try {
          const img = new Image();
          // The src is a same-origin data:/blob: URL — no crossOrigin needed, and
          // the canvas stays UNTAINTED so captureStream() won't SecurityError.
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = src;
          // Some impls resolve decoded synchronously for data: URLs.
          if (img.complete && img.naturalWidth > 0) {
            resolve(img);
          }
        } catch {
          resolve(null);
        }
      });
    },
    createAudioContext(): CaptureAudioContextLike {
      const Ctor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
      return new Ctor() as unknown as CaptureAudioContextLike;
    },
    createCanvas(width: number, height: number): CaptureCanvasLike {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas as unknown as CaptureCanvasLike;
    },
    createStream(tracks: MediaStreamTrackLike[]): MediaStreamLike {
      return new MediaStream(tracks as unknown as MediaStreamTrack[]) as unknown as MediaStreamLike;
    },
    createRecorder(stream: MediaStreamLike, opts: { mimeType: string }): MediaRecorderLike {
      return new MediaRecorder(stream as unknown as MediaStream, opts) as unknown as MediaRecorderLike;
    },
    assembleBlob(parts: BlobPart[], mimeType: string): Blob {
      return new Blob(parts, { type: mimeType });
    },
    toFile(parts: BlobPart[], name: string, mimeType: string): File {
      return new File(parts, name, { type: mimeType });
    },
    requestRaf(cb: () => void): number {
      return requestAnimationFrame(cb);
    },
    cancelRaf(handle: number): void {
      cancelAnimationFrame(handle);
    },
  };
}
