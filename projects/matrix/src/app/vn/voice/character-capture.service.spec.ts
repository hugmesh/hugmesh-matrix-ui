import { TestBed } from '@angular/core/testing';
import { MatrixService } from '../../matrix.service';
import { VoiceSynthService, SynthClip } from './voice-synth.service';
import {
  CAPTURE_IO,
  CAPTURE_SIZE,
  CharacterCaptureService,
  CaptureIo,
  CaptureAnalyserLike,
  CaptureAudioContextLike,
  CaptureBufferSourceLike,
  CaptureCanvasLike,
  CaptureImageLike,
  MediaRecorderLike,
  MediaStreamAudioDestinationLike,
  MediaStreamLike,
  MediaStreamTrackLike,
  BlobEventLike,
  isUntaintedImageSrc,
  STOP_FALLBACK_MS,
} from './character-capture.service';

/**
 * A fake decoded {@link AudioBuffer} — just the fields the capture reads
 * (`duration`) plus enough shape to type-check. No real codec.
 */
function fakeBuffer(durationSec = 2): AudioBuffer {
  return { duration: durationSec, length: 44100 * durationSec, numberOfChannels: 1, sampleRate: 44100 } as AudioBuffer;
}

/** A fake track that records whether stop() was called (teardown assertion). */
class FakeTrack implements MediaStreamTrackLike {
  stopped = 0;
  constructor(readonly kind: 'audio' | 'video') {}
  stop(): void {
    this.stopped++;
  }
}

/** A fake source node — records connect/disconnect/start/stop and holds onended. */
class FakeSource implements CaptureBufferSourceLike {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connected: unknown[] = [];
  disconnects = 0;
  starts = 0;
  stops = 0;
  connect(destination: unknown): void {
    this.connected.push(destination);
  }
  disconnect(): void {
    this.disconnects++;
  }
  start(): void {
    this.starts++;
  }
  stop(): void {
    this.stops++;
  }
}

/** A fake analyser — fills the frame with a fixed amplitude, records disconnect. */
class FakeAnalyser implements CaptureAnalyserLike {
  fftSize = 0;
  disconnects = 0;
  reads = 0;
  constructor(private readonly amplitude = 0.4) {}
  get frequencyBinCount(): number {
    return (this.fftSize || 1024) / 2;
  }
  getFloatTimeDomainData(array: Float32Array): void {
    this.reads++;
    array.fill(this.amplitude);
  }
  disconnect(): void {
    this.disconnects++;
  }
}

class FakeStreamDest implements MediaStreamAudioDestinationLike {
  constructor(readonly stream: MediaStreamLike) {}
}

/** A fake AudioContext handing out our fakes + recording close(). */
class FakeAudioContext implements CaptureAudioContextLike {
  readonly destination = {} as unknown as AudioNode;
  closes = 0;
  readonly source = new FakeSource();
  readonly analyser: FakeAnalyser;
  readonly audioTrack = new FakeTrack('audio');
  readonly captureStream: FakeStream;
  constructor(amplitude = 0.4) {
    this.analyser = new FakeAnalyser(amplitude);
    this.captureStream = new FakeStream([], [this.audioTrack]);
  }
  createBufferSource(): CaptureBufferSourceLike {
    return this.source;
  }
  createMediaStreamDestination(): MediaStreamAudioDestinationLike {
    return new FakeStreamDest(this.captureStream);
  }
  createAnalyser(): CaptureAnalyserLike {
    return this.analyser;
  }
  async close(): Promise<void> {
    this.closes++;
  }
}

/** A fake media stream exposing preset audio/video tracks. */
class FakeStream implements MediaStreamLike {
  constructor(
    private readonly video: MediaStreamTrackLike[],
    private readonly audio: MediaStreamTrackLike[],
  ) {}
  getVideoTracks(): MediaStreamTrackLike[] {
    return this.video;
  }
  getAudioTracks(): MediaStreamTrackLike[] {
    return this.audio;
  }
}

/** A fake off-screen canvas → captureStream yields a single video track. */
class FakeCanvas implements CaptureCanvasLike {
  width = 0;
  height = 0;
  readonly videoTrack = new FakeTrack('video');
  readonly ctx = {
    clearRect: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    ellipse: () => {},
    fill: () => {},
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(_id: '2d'): CanvasRenderingContext2D | null {
    return this.ctx;
  }
  captureStream(_fps?: number): MediaStreamLike {
    return new FakeStream([this.videoTrack], []);
  }
}

/**
 * A fake {@link MediaRecorderLike}. `stop()` emits ONE data chunk (a fake webm
 * blob) then fires `onstop` — the canonical success path. `emitError()` fires
 * `onerror`. `chunkSize` lets a test force an empty/zero-size blob.
 */
class FakeRecorder implements MediaRecorderLike {
  ondataavailable: ((e: BlobEventLike) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  state = 'inactive';
  starts = 0;
  stops = 0;
  constructor(
    private readonly io: FakeCaptureIo,
    private readonly chunkSize = 512,
    private readonly suppressOnstop = false,
  ) {}
  start(): void {
    this.starts++;
    this.state = 'recording';
  }
  stop(): void {
    this.stops++;
    this.state = 'inactive';
    if (this.chunkSize > 0 && this.ondataavailable) {
      this.ondataavailable({ data: this.io.makeBlob(this.chunkSize) });
    }
    // suppressOnstop models a misbehaving recorder whose stop() returns but never
    // fires onstop — the STOP_FALLBACK_MS backstop must still settle + tear down.
    if (!this.suppressOnstop) {
      this.onstop?.();
    }
  }
  emitError(): void {
    this.onerror?.();
  }
}

/**
 * A controllable rAF: `request` queues callbacks; `flush(n)` runs up to `n`
 * pending frames; `cancelled` records cancels (teardown/leak assertions).
 */
class FakeRaf {
  private queue = new Map<number, () => void>();
  private seq = 1;
  cancelled: number[] = [];
  request(cb: () => void): number {
    const h = this.seq++;
    this.queue.set(h, cb);
    return h;
  }
  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.queue.delete(handle);
  }
  flush(frames: number): void {
    for (let i = 0; i < frames; i++) {
      const next = this.queue.entries().next();
      if (next.done) return;
      const [h, cb] = next.value;
      this.queue.delete(h);
      cb();
    }
  }
  pending(): number {
    return this.queue.size;
  }
}

/**
 * The fake {@link CaptureIo}. Hands the capture our fake recorder / audio graph /
 * canvas / image, a controllable rAF, and blob/file factories that produce
 * inspectable fakes — so the WHOLE capture path runs with NO real codec, canvas,
 * Web-Audio, or network.
 */
class FakeCaptureIo implements CaptureIo {
  readonly raf = new FakeRaf();
  readonly audio: FakeAudioContext;
  readonly canvas: FakeCanvas;
  recorder!: FakeRecorder;
  /** null → loadImage resolves null (no image). */
  image: CaptureImageLike | null = {} as CaptureImageLike;
  /** recorder chunk size — 0 forces an empty/zero-size assembled blob. */
  recorderChunkSize = 512;
  /** when true, the fake recorder's stop() never fires onstop (backstop test). */
  suppressOnstop = false;
  /** The MediaStream the recorder was built from (for track assertions). */
  recorderStream: MediaStreamLike | null = null;
  lastFile: File | null = null;
  loadImageCalls: string[] = [];

  constructor(opts?: { amplitude?: number }) {
    this.audio = new FakeAudioContext(opts?.amplitude);
    this.canvas = new FakeCanvas(CAPTURE_SIZE, CAPTURE_SIZE);
  }

  async loadImage(src: string): Promise<CaptureImageLike | null> {
    this.loadImageCalls.push(src);
    return this.image;
  }
  createAudioContext(): CaptureAudioContextLike {
    return this.audio;
  }
  createCanvas(_w: number, _h: number): CaptureCanvasLike {
    return this.canvas;
  }
  createStream(tracks: MediaStreamTrackLike[]): MediaStreamLike {
    return new FakeStream(
      tracks.filter((t) => t.kind === 'video'),
      tracks.filter((t) => t.kind === 'audio'),
    );
  }
  createRecorder(stream: MediaStreamLike, _opts: { mimeType: string }): MediaRecorderLike {
    this.recorderStream = stream;
    this.recorder = new FakeRecorder(this, this.recorderChunkSize, this.suppressOnstop);
    return this.recorder;
  }
  /** A fake webm blob of `size` bytes. */
  makeBlob(size: number): Blob {
    return new Blob([new Uint8Array(size)], { type: 'video/webm' });
  }
  assembleBlob(parts: BlobPart[], mimeType: string): Blob {
    return new Blob(parts, { type: mimeType });
  }
  toFile(parts: BlobPart[], name: string, mimeType: string): File {
    this.lastFile = new File(parts, name, { type: mimeType });
    return this.lastFile;
  }
  requestRaf(cb: () => void): number {
    return this.raf.request(cb);
  }
  cancelRaf(handle: number): void {
    this.raf.cancel(handle);
  }
}

class SynthStub {
  enabled = true;
  clip: SynthClip | null = { buffer: fakeBuffer(2), durationMs: 2000 };
  isEnabled = jasmine.createSpy('isEnabled').and.callFake(() => this.enabled);
  synth = jasmine.createSpy('synth').and.callFake(() => Promise.resolve(this.clip));
}

class MatrixStub {
  uploadMedia = jasmine.createSpy('uploadMedia')
    .and.resolveTo({ contentUri: 'mxc://snap/clip', mxcUri: 'mxc://snap/clip' });
  sendEvent = jasmine.createSpy('sendEvent').and.resolveTo('$evt:1');
}

const DATA_SRC = 'data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E';

function makeService(io: FakeCaptureIo, synth: SynthStub, matrix: MatrixStub): CharacterCaptureService {
  TestBed.configureTestingModule({
    providers: [
      CharacterCaptureService,
      { provide: CAPTURE_IO, useValue: io },
      { provide: VoiceSynthService, useValue: synth },
      { provide: MatrixService, useValue: matrix },
    ],
  });
  return TestBed.inject(CharacterCaptureService);
}

/**
 * Drive one capture to completion: run a couple of draw frames, then trigger
 * the source `ended` (the canonical stop) so the fake recorder emits its chunk
 * and fires onstop. Returns the recordAndSend promise's resolution.
 */
async function driveHappy(
  svc: CharacterCaptureService,
  io: FakeCaptureIo,
  ctx: Partial<Parameters<CharacterCaptureService['recordAndSend']>[2]> = {},
): Promise<string | null> {
  const p = svc.recordAndSend('!room:test', 'hello there', { imageSrc: DATA_SRC, character: 'aria', ...ctx });
  // Let synth + capture setup settle so the recorder + rAF exist.
  await Promise.resolve();
  await Promise.resolve();
  io.raf.flush(3); // a few draw frames (refreshes analyser samples first)
  io.audio.source.onended?.(); // audio ended → stop the recorder → onstop → blob
  return p;
}

describe('CharacterCaptureService (recorded voice clip → m.video, dark by default)', () => {
  let io: FakeCaptureIo;
  let synth: SynthStub;
  let matrix: MatrixStub;

  beforeEach(() => {
    io = new FakeCaptureIo();
    synth = new SynthStub();
    matrix = new MatrixStub();
  });

  afterEach(() => TestBed.resetTestingModule());

  describe('DARK by default (flag OFF)', () => {
    it('recordAndSend returns null and makes ZERO synth/upload/send calls', async () => {
      synth.enabled = false;
      const svc = makeService(io, synth, matrix);

      expect(svc.isEnabled()).toBeFalse();
      const result = await svc.recordAndSend('!room:test', 'hello', { imageSrc: DATA_SRC });

      expect(result).toBeNull();
      expect(synth.synth).not.toHaveBeenCalled();
      expect(matrix.uploadMedia).not.toHaveBeenCalled();
      expect(matrix.sendEvent).not.toHaveBeenCalled();
    });
  });

  describe('flag ON — happy path', () => {
    it('synths → captures a non-empty webm → uploads a video/webm File → posts m.video with the mxc url', async () => {
      const svc = makeService(io, synth, matrix);

      const id = await driveHappy(svc, io);

      // synth ran once with the trimmed text + character.
      expect(synth.synth).toHaveBeenCalledTimes(1);
      expect(synth.synth.calls.mostRecent().args[0]).toBe('hello there');
      expect(synth.synth.calls.mostRecent().args[1]).toEqual(jasmine.objectContaining({ character: 'aria' }));

      // Uploaded a video/webm File built from the captured (non-empty) blob.
      expect(matrix.uploadMedia).toHaveBeenCalledTimes(1);
      const file = matrix.uploadMedia.calls.mostRecent().args[0] as File;
      expect(file instanceof File).toBeTrue();
      expect(file.type).toBe('video/webm');
      expect(file.size).toBeGreaterThan(0);

      // Posted as an m.room.message / m.video with the mxc + info metadata.
      expect(matrix.sendEvent).toHaveBeenCalledTimes(1);
      const [room, type, content] = matrix.sendEvent.calls.mostRecent().args;
      expect(room).toBe('!room:test');
      expect(type).toBe('m.room.message');
      expect(content.msgtype).toBe('m.video');
      expect(content.url).toBe('mxc://snap/clip');
      expect(content.info.mimetype).toBe('video/webm');
      expect(content.info.duration).toBeGreaterThan(0);
      expect(content.info.size).toBeGreaterThan(0);
      expect(content.info.w).toBe(CAPTURE_SIZE);
      expect(content.info.h).toBe(CAPTURE_SIZE);

      // Returns the sent event id.
      expect(id).toBe('$evt:1');
    });

    it('WIRE url is the mxc — never the local blob:/File url', async () => {
      const svc = makeService(io, synth, matrix);
      await driveHappy(svc, io);

      const content = matrix.sendEvent.calls.mostRecent().args[2];
      expect(content.url).toBe('mxc://snap/clip');
      expect(content.url.startsWith('mxc://')).toBeTrue();
      expect(content.url.startsWith('blob:')).toBeFalse();
      expect(content.url.startsWith('data:')).toBeFalse();
    });

    it('reports the clamped ctx.size as m.video info.w/h (not a hardcoded const)', async () => {
      const svc = makeService(io, synth, matrix);
      await driveHappy(svc, io, { size: 96 });

      const content = matrix.sendEvent.calls.mostRecent().args[2];
      expect(content.info.w).toBe(96);
      expect(content.info.h).toBe(96);
    });
  });

  describe('UNTAINTED-SRC guard', () => {
    it('rejects an http(s):// imageSrc → null, no synth/upload/send', async () => {
      const svc = makeService(io, synth, matrix);
      const result = await svc.recordAndSend('!room:test', 'hi', { imageSrc: 'https://evil.example/x.png' });

      expect(result).toBeNull();
      expect(synth.synth).not.toHaveBeenCalled();
      expect(matrix.uploadMedia).not.toHaveBeenCalled();
      expect(matrix.sendEvent).not.toHaveBeenCalled();
    });

    it('isUntaintedImageSrc accepts data:image/ and blob:, rejects http(s)/empty', () => {
      expect(isUntaintedImageSrc(DATA_SRC)).toBeTrue();
      expect(isUntaintedImageSrc('blob:https://snap/abc')).toBeTrue();
      expect(isUntaintedImageSrc('http://x/y.png')).toBeFalse();
      expect(isUntaintedImageSrc('https://x/y.png')).toBeFalse();
      expect(isUntaintedImageSrc('')).toBeFalse();
      expect(isUntaintedImageSrc(undefined as unknown as string)).toBeFalse();
    });

    it('a blob: imageSrc IS accepted (goes on to synth + capture + send)', async () => {
      const svc = makeService(io, synth, matrix);
      const id = await driveHappy(svc, io, { imageSrc: 'blob:https://snap/abc' });
      expect(synth.synth).toHaveBeenCalled();
      expect(matrix.sendEvent).toHaveBeenCalled();
      expect(id).toBe('$evt:1');
    });
  });

  describe('FAIL-SOFT (never throws, returns null, never sends)', () => {
    it('synth returns null → null, no upload/send', async () => {
      synth.clip = null;
      const svc = makeService(io, synth, matrix);

      const result = await svc.recordAndSend('!room:test', 'hi', { imageSrc: DATA_SRC });

      expect(result).toBeNull();
      expect(synth.synth).toHaveBeenCalled();
      expect(matrix.uploadMedia).not.toHaveBeenCalled();
      expect(matrix.sendEvent).not.toHaveBeenCalled();
    });

    it('recorder.onerror fires → null, no upload/send, full teardown', async () => {
      const svc = makeService(io, synth, matrix);

      const p = svc.recordAndSend('!room:test', 'hi', { imageSrc: DATA_SRC });
      await Promise.resolve();
      await Promise.resolve();
      io.raf.flush(2);
      io.recorder.emitError();

      await expectAsync(p).toBeResolvedTo(null);
      expect(matrix.uploadMedia).not.toHaveBeenCalled();
      expect(matrix.sendEvent).not.toHaveBeenCalled();
      // Teardown still ran.
      expect(io.audio.closes).toBe(1);
      expect(io.audio.source.stops).toBe(1);
    });

    it('uploadMedia rejects → null, no send', async () => {
      matrix.uploadMedia.and.rejectWith(new Error('upload down'));
      const svc = makeService(io, synth, matrix);

      const result = await driveHappy(svc, io);

      expect(result).toBeNull();
      expect(matrix.sendEvent).not.toHaveBeenCalled();
    });

    it('uploadMedia returns no mxc → null, no send', async () => {
      matrix.uploadMedia.and.resolveTo({ contentUri: '', mxcUri: '' });
      const svc = makeService(io, synth, matrix);

      const result = await driveHappy(svc, io);

      expect(result).toBeNull();
      expect(matrix.sendEvent).not.toHaveBeenCalled();
    });

    it('empty/zero-size blob → null, no upload/send', async () => {
      io.recorderChunkSize = 0; // recorder emits nothing → assembled blob is empty
      const svc = makeService(io, synth, matrix);

      const result = await driveHappy(svc, io);

      expect(result).toBeNull();
      expect(matrix.uploadMedia).not.toHaveBeenCalled();
      expect(matrix.sendEvent).not.toHaveBeenCalled();
    });

    it('a null loaded image → null, no upload/send (never throws)', async () => {
      io.image = null;
      const svc = makeService(io, synth, matrix);

      const result = await driveHappy(svc, io);

      expect(result).toBeNull();
      expect(matrix.uploadMedia).not.toHaveBeenCalled();
      expect(matrix.sendEvent).not.toHaveBeenCalled();
    });
  });

  describe('TEARDOWN / NO LEAK', () => {
    it('on SUCCESS: source stop+disconnect, analyser disconnect, all tracks stop, ctx close, rAF cancelled', async () => {
      const svc = makeService(io, synth, matrix);
      await driveHappy(svc, io);

      expect(io.audio.source.stops).toBe(1);
      expect(io.audio.source.disconnects).toBe(1);
      expect(io.audio.analyser.disconnects).toBe(1);
      expect(io.canvas.videoTrack.stopped).toBeGreaterThan(0);
      expect(io.audio.audioTrack.stopped).toBeGreaterThan(0);
      expect(io.audio.closes).toBe(1);
      expect(io.raf.cancelled.length).toBeGreaterThan(0);
      expect(io.raf.pending()).toBe(0); // no dangling draw frame
    });

    it('on ERROR: the same full teardown runs (no leak on the failure path)', async () => {
      const svc = makeService(io, synth, matrix);
      const p = svc.recordAndSend('!room:test', 'hi', { imageSrc: DATA_SRC });
      await Promise.resolve();
      await Promise.resolve();
      io.raf.flush(1);
      io.recorder.emitError();
      await p;

      expect(io.audio.source.stops).toBe(1);
      expect(io.audio.source.disconnects).toBe(1);
      expect(io.audio.analyser.disconnects).toBe(1);
      expect(io.canvas.videoTrack.stopped).toBeGreaterThan(0);
      expect(io.audio.audioTrack.stopped).toBeGreaterThan(0);
      expect(io.audio.closes).toBe(1);
      expect(io.raf.cancelled.length).toBeGreaterThan(0);
      expect(io.raf.pending()).toBe(0);
    });
  });

  describe('MAX-DURATION CAP', () => {
    it('a source whose onended never fires still stops via setTimeout(maxMs) and resolves a blob', async () => {
      jasmine.clock().install();
      try {
        const svc = makeService(io, synth, matrix);
        const p = svc.recordAndSend('!room:test', 'hello', {
          imageSrc: DATA_SRC,
          maxDurationMs: 50, // small cap
        });
        // Settle synth + capture setup (real microtasks, clock only mocks timers).
        await Promise.resolve();
        await Promise.resolve();
        io.raf.flush(2);

        // onended is deliberately NOT fired; advance past the cap to force the stop.
        expect(io.recorder.stops).toBe(0);
        jasmine.clock().tick(51);
        expect(io.recorder.stops).toBe(1); // the cap stopped the recorder

        const id = await p;
        expect(id).toBe('$evt:1'); // a blob was assembled + sent
        expect(matrix.sendEvent).toHaveBeenCalled();
        // duration is capped to maxMs.
        const content = matrix.sendEvent.calls.mostRecent().args[2];
        expect(content.info.duration).toBeLessThanOrEqual(50);
      } finally {
        jasmine.clock().uninstall();
      }
    });
  });

  describe('STOP backstop (recorder.stop() returns but onstop never fires)', () => {
    it('the cap stops the recorder, then the backstop force-settles + tears down (no hang, no leak)', async () => {
      jasmine.clock().install();
      try {
        io.suppressOnstop = true; // stop() emits a chunk but never fires onstop
        const svc = makeService(io, synth, matrix);
        const p = svc.recordAndSend('!room:test', 'hello', { imageSrc: DATA_SRC, maxDurationMs: 50 });
        await Promise.resolve();
        await Promise.resolve();
        io.raf.flush(2);

        // The cap fires → stopRecorder → recorder.stop() (no onstop) + arms backstop.
        jasmine.clock().tick(51);
        expect(io.recorder.stops).toBe(1);
        expect(io.audio.closes).toBe(0); // not yet settled — onstop never came

        // The backstop fires → finish(assembled chunks) → full teardown.
        jasmine.clock().tick(STOP_FALLBACK_MS + 1);
        const id = await p;

        expect(id).toBe('$evt:1'); // the gathered chunk was assembled + sent
        expect(io.audio.closes).toBe(1); // teardown ran (AudioContext closed)
        expect(io.audio.source.stops).toBe(1);
        expect(io.audio.audioTrack.stopped).toBeGreaterThan(0);
        expect(io.canvas.videoTrack.stopped).toBeGreaterThan(0);
      } finally {
        jasmine.clock().uninstall();
      }
    });
  });

  describe('input guards', () => {
    it('blank text → null, no synth (dark-safe on empty input)', async () => {
      const svc = makeService(io, synth, matrix);
      expect(await svc.recordAndSend('!room:test', '   ', { imageSrc: DATA_SRC })).toBeNull();
      expect(synth.synth).not.toHaveBeenCalled();
    });

    it('missing roomId → null, no synth', async () => {
      const svc = makeService(io, synth, matrix);
      expect(await svc.recordAndSend('', 'hi', { imageSrc: DATA_SRC })).toBeNull();
      expect(synth.synth).not.toHaveBeenCalled();
    });
  });
});
