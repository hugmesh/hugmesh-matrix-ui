import { TestBed } from '@angular/core/testing';
import { BFF_BASE_URL } from '../../matrix.service';
import {
  SynthResponse,
  VOICE_SYNTH_IO,
  VOICE_TTS_ENABLED,
  VOICE_TTS_ENDPOINT,
  VoiceSynthIo,
  VoiceSynthService,
  base64ToArrayBuffer,
} from './voice-synth.service';

/**
 * A fake decoded {@link AudioBuffer} — just the fields the service reads
 * (`duration`) plus enough of the shape to type-check. No real codec.
 */
function fakeBuffer(durationSec = 2): AudioBuffer {
  return { duration: durationSec, length: 44100 * durationSec, numberOfChannels: 1, sampleRate: 44100 } as AudioBuffer;
}

/** A valid base64 WAV-ish blob (content is irrelevant; io.decode is mocked). */
const AUDIO_B64 = btoa('RIFFxxxxWAVEfmt ');

const OK_RESPONSE: SynthResponse = {
  audioBase64: AUDIO_B64,
  sampleRate: 22_050,
  format: 'wav',
  durationMs: 2000,
};

/** A mockable {@link VoiceSynthIo} whose two collaborators are spies. */
class IoStub implements VoiceSynthIo {
  postSynth = jasmine.createSpy('postSynth').and.resolveTo(OK_RESPONSE as SynthResponse | null);
  decode = jasmine.createSpy('decode').and.resolveTo(fakeBuffer());
}

function makeService(enabled: boolean, io: VoiceSynthIo): VoiceSynthService {
  TestBed.configureTestingModule({
    providers: [
      VoiceSynthService,
      { provide: VOICE_TTS_ENABLED, useValue: enabled },
      { provide: VOICE_TTS_ENDPOINT, useValue: '/v1/synthesize' },
      { provide: BFF_BASE_URL, useValue: '' },
      { provide: VOICE_SYNTH_IO, useValue: io },
    ],
  });
  return TestBed.inject(VoiceSynthService);
}

describe('VoiceSynthService (dark-by-default TTS synth seam)', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('DARK by default (flag OFF)', () => {
    it('isEnabled() is false and synth() returns null with ZERO HTTP/io calls', async () => {
      const io = new IoStub();
      const svc = makeService(false, io);

      expect(svc.isEnabled()).toBeFalse();
      const clip = await svc.synth('hello there');

      expect(clip).toBeNull();
      // The dark gate is FIRST: the seam is never dialled, nothing is decoded.
      expect(io.postSynth).not.toHaveBeenCalled();
      expect(io.decode).not.toHaveBeenCalled();
    });
  });

  describe('flag ON', () => {
    it('happy path: POSTs the seam and returns a decoded SynthClip', async () => {
      const io = new IoStub();
      const svc = makeService(true, io);

      const clip = await svc.synth('hello there', { character: 'aria', voice: 'en_GB' });

      expect(clip).not.toBeNull();
      expect(clip!.buffer.duration).toBe(2);
      expect(clip!.durationMs).toBe(2000);

      // Dials the same-origin gateway seam (BFF_BASE_URL '' + endpoint), trimmed
      // text, format wav, and forwards voice/character.
      expect(io.postSynth).toHaveBeenCalledTimes(1);
      const [url, body] = io.postSynth.calls.mostRecent().args;
      expect(url).toBe('/v1/synthesize');
      expect(body).toEqual(jasmine.objectContaining({
        text: 'hello there',
        voice: 'en_GB',
        character: 'aria',
        format: 'wav',
      }));
      expect(io.decode).toHaveBeenCalledTimes(1);
    });

    it('trims the text before dialling and returns null for blank text (no HTTP)', async () => {
      const io = new IoStub();
      const svc = makeService(true, io);

      expect(await svc.synth('   ')).toBeNull();
      expect(await svc.synth('')).toBeNull();
      expect(io.postSynth).not.toHaveBeenCalled();

      await svc.synth('  hi  ');
      expect(io.postSynth.calls.mostRecent().args[1]).toEqual(jasmine.objectContaining({ text: 'hi' }));
    });

    it('derives durationMs from the decoded buffer when the backend omits it', async () => {
      const io = new IoStub();
      io.postSynth.and.resolveTo({ ...OK_RESPONSE, durationMs: 0 });
      io.decode.and.resolveTo(fakeBuffer(3)); // 3s → 3000ms
      const svc = makeService(true, io);

      const clip = await svc.synth('hello');
      expect(clip!.durationMs).toBe(3000);
    });

    describe('FAIL-SOFT (never throws, returns null)', () => {
      it('HTTP error / non-OK (io.postSynth → null) → null, no decode', async () => {
        const io = new IoStub();
        io.postSynth.and.resolveTo(null);
        const svc = makeService(true, io);

        await expectAsync(svc.synth('hello')).toBeResolvedTo(null);
        expect(io.decode).not.toHaveBeenCalled();
      });

      it('network throw in postSynth is swallowed to null', async () => {
        const io = new IoStub();
        io.postSynth.and.rejectWith(new Error('network down'));
        const svc = makeService(true, io);

        await expectAsync(svc.synth('hello')).toBeResolvedTo(null);
      });

      it('malformed response (no audioBase64) → null, no decode', async () => {
        const io = new IoStub();
        io.postSynth.and.resolveTo({ sampleRate: 22050, format: 'wav', durationMs: 1 } as unknown as SynthResponse);
        const svc = makeService(true, io);

        await expectAsync(svc.synth('hello')).toBeResolvedTo(null);
        expect(io.decode).not.toHaveBeenCalled();
      });

      it('empty audioBase64 → null, no decode', async () => {
        const io = new IoStub();
        io.postSynth.and.resolveTo({ ...OK_RESPONSE, audioBase64: '' });
        const svc = makeService(true, io);

        await expectAsync(svc.synth('hello')).toBeResolvedTo(null);
        expect(io.decode).not.toHaveBeenCalled();
      });

      it('decode error is swallowed to null', async () => {
        const io = new IoStub();
        io.decode.and.rejectWith(new Error('bad codec'));
        const svc = makeService(true, io);

        await expectAsync(svc.synth('hello')).toBeResolvedTo(null);
      });
    });
  });
});

describe('base64ToArrayBuffer', () => {
  it('decodes a base64 string to bytes', () => {
    const buf = base64ToArrayBuffer(btoa('AB'));
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([65, 66]));
  });

  it('returns an empty buffer for invalid base64 (fail-soft, no throw)', () => {
    expect(base64ToArrayBuffer('!!!not base64!!!').byteLength).toBe(0);
  });
});
