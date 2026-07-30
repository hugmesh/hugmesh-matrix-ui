import { Injectable, InjectionToken, inject } from '@angular/core';
import { BFF_BASE_URL } from '../../matrix.service';

/**
 * The DARK flag gating character voice (Phase B3 Wave A). DEFAULT FALSE — the
 * Piper TTS backend is held behind a spike and NOT deployed, so {@link
 * VoiceSynthService.synth} short-circuits to `null` and makes NO HTTP call until
 * an operator flips this on. Overridable via the shared `__HUG_VOICE_TTS__`
 * global hook (same convention as `__HUG_BFF_URL__`/`__HUG_MATRIX_URL__`) or by
 * re-providing the token in tests.
 */
export const VOICE_TTS_ENABLED = new InjectionToken<boolean>('voice.tts.enabled', {
  factory: () => (globalThis as any).__HUG_VOICE_TTS__ === true,
});

/**
 * The path the gateway exposes the Piper TTS synth seam under. Relative by
 * default (same-origin via the fe-gateway, like the BFF calls) and prefixed with
 * {@link BFF_BASE_URL} at call time; overridable via `__HUG_VOICE_TTS_PATH__`
 * or the token in tests.
 */
export const VOICE_TTS_ENDPOINT = new InjectionToken<string>('voice.tts.endpoint', {
  factory: () => (globalThis as any).__HUG_VOICE_TTS_PATH__ ?? '/v1/synthesize',
});

/** Optional knobs for a single synth request. */
export interface SynthOptions {
  /** Piper voice id (the backend picks a default when absent). */
  voice?: string;
  /** A VN character id, so the backend can map it to a configured voice. */
  character?: string;
}

/**
 * The synth seam response shape. `audioBase64` is a base64-encoded WAV the client
 * decodes to an {@link AudioBuffer}. A `visemes` field MAY be present but is
 * IGNORED — this is amplitude-only (the explicit product decision); the mouth is
 * driven by audio loudness, never a phoneme timeline.
 */
export interface SynthResponse {
  audioBase64: string;
  sampleRate: number;
  format: string;
  durationMs: number;
}

/** A decoded clip ready to play + drive the amplitude mouth. */
export interface SynthClip {
  /** The decoded PCM audio. */
  buffer: AudioBuffer;
  /** Source clip length (ms) as reported by the backend (metadata only). */
  durationMs: number;
}

/**
 * The HTTP+decode collaborators, injected so unit tests need NEITHER a live TTS
 * backend NOR a real audio codec. {@link postSynth} performs the seam POST;
 * {@link decode} turns the raw WAV bytes into an {@link AudioBuffer}. A test
 * overrides both with stubs (e.g. resolve a fake {@link SynthResponse} and a
 * fake {@link AudioBuffer}); production uses `fetch` + Web Audio `decodeAudioData`.
 */
export interface VoiceSynthIo {
  postSynth(url: string, body: unknown): Promise<SynthResponse | null>;
  decode(wav: ArrayBuffer, sampleRate: number): Promise<AudioBuffer>;
}

/** DI token for {@link VoiceSynthIo} — tests provide a stub. */
export const VOICE_SYNTH_IO = new InjectionToken<VoiceSynthIo>('VOICE_SYNTH_IO');

/**
 * Client TTS synth for the VN character VOICE (Phase B3 Wave A).
 *
 * {@link synth} POSTs `{ text, voice?, character?, format:'wav' }` to the gateway
 * synth seam ({@link VOICE_TTS_ENDPOINT}), expects
 * `{ audioBase64, sampleRate, format, durationMs }`, and decodes the WAV into an
 * {@link AudioBuffer} the playback path can drive an amplitude mouth from.
 *
 * DARK BY DEFAULT — gated on {@link VOICE_TTS_ENABLED} (default FALSE): with the
 * flag off, `synth` resolves `null` and makes NO HTTP call (the Piper backend is
 * held for a spike). FAIL-SOFT everywhere: a flag-off, an HTTP error, a malformed
 * response, or a decode error all resolve to `null` and NEVER throw — so a caller
 * can `await synth(...)` and simply skip playback on `null` (no surprise audio,
 * no broken UI). The HTTP + decode are injectable ({@link VoiceSynthIo}) so the
 * spec exercises the happy path against a mocked synth buffer with no real codec.
 */
@Injectable({ providedIn: 'root' })
export class VoiceSynthService {
  private readonly enabled = inject(VOICE_TTS_ENABLED);
  private readonly endpoint = inject(VOICE_TTS_ENDPOINT);
  private readonly bffBaseUrl = inject(BFF_BASE_URL);
  /** Injected HTTP+decode collaborators; defaults to the real fetch/Web-Audio io. */
  private readonly io = inject(VOICE_SYNTH_IO, { optional: true }) ?? defaultVoiceSynthIo();

  /** Whether voice is enabled at all (drives the panel's Speak-control disabled state). */
  isEnabled(): boolean {
    return this.enabled === true;
  }

  /**
   * Synthesize `text` into a decoded {@link SynthClip}, or `null`.
   *
   * Returns `null` WITHOUT any HTTP call when the dark flag is off or `text` is
   * blank. Otherwise POSTs the synth seam, decodes the WAV, and returns the
   * buffer; ANY failure (network, non-OK, malformed JSON, empty audio, decode
   * error) is swallowed to `null`. Never throws.
   */
  async synth(text: string, opts?: SynthOptions): Promise<SynthClip | null> {
    if (!this.enabled) {
      // DARK: no backend deployed — do not even dial the seam.
      return null;
    }
    const trimmed = (text ?? '').trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      const url = `${this.bffBaseUrl}${this.endpoint}`;
      const body = {
        text: trimmed,
        voice: opts?.voice,
        character: opts?.character,
        format: 'wav' as const,
      };
      const res = await this.io.postSynth(url, body);
      if (!res || typeof res.audioBase64 !== 'string' || res.audioBase64.length === 0) {
        return null;
      }
      const wav = base64ToArrayBuffer(res.audioBase64);
      if (wav.byteLength === 0) {
        return null;
      }
      const sampleRate = Number.isFinite(res.sampleRate) && res.sampleRate > 0 ? res.sampleRate : 22_050;
      const buffer = await this.io.decode(wav, sampleRate);
      if (!buffer) {
        return null;
      }
      const durationMs = Number.isFinite(res.durationMs) && res.durationMs > 0
        ? res.durationMs
        : Math.round(buffer.duration * 1000);
      return { buffer, durationMs };
    } catch {
      // Fail-soft: never surface a synth error to the caller.
      return null;
    }
  }
}

/**
 * The production {@link VoiceSynthIo}: a credentialed fetch to the synth seam +
 * Web-Audio `decodeAudioData`. Lazily constructs a short-lived `AudioContext`
 * ONLY to decode (decoding needs a context; playback owns its own), and closes
 * it after. Kept out of the service body so the spec can swap the whole thing.
 */
export function defaultVoiceSynthIo(): VoiceSynthIo {
  return {
    async postSynth(url: string, body: unknown): Promise<SynthResponse | null> {
      // credentials:'include' carries the HttpOnly bff_ cookie, like every BFF call.
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        return null;
      }
      return (await r.json()) as SynthResponse;
    },
    async decode(wav: ArrayBuffer, _sampleRate: number): Promise<AudioBuffer> {
      const Ctor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
      const ctx: AudioContext = new Ctor();
      try {
        // decodeAudioData wants its own copy of the buffer (some impls detach it).
        return await ctx.decodeAudioData(wav.slice(0));
      } finally {
        // Best-effort close; decoding does not need the context kept open.
        try {
          await ctx.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** Decode a base64 string to an ArrayBuffer (browser `atob`); '' / bad → empty. */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  try {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes.buffer;
  } catch {
    return new ArrayBuffer(0);
  }
}
