import { Injectable, Signal, inject, signal } from '@angular/core';
import { VoiceSynthService, SynthOptions } from './voice-synth.service';
import { AmplitudeMouthService, MouthDrive } from './amplitude-mouth.service';

/**
 * One in-progress speak session: the openness signal to bind the mouth to, a
 * `speaking` flag, and a `stop()`. Returned by {@link VoicePlaybackService.speak}.
 */
export interface SpeakSession {
  /** Smoothed mouth openness 0..1 (0 at rest / reduced-motion / after end). */
  readonly openness: Signal<number>;
  /** Whether audio is currently playing. */
  readonly speaking: Signal<boolean>;
  /** Stop playback + the mouth NOW (idempotent). */
  stop(): void;
}

/**
 * The minimal `AudioContext` surface playback owns — narrowed so a test passes a
 * fake context whose source/analyser nodes are fakes (the buffer is already
 * decoded, so `decodeAudioData` is never used here).
 */
export interface PlaybackAudioContext {
  readonly destination: AudioNode;
  createBufferSource(): AudioBufferSourceNode;
  createAnalyser(): AnalyserNode;
  close(): Promise<void>;
  resume?(): Promise<void>;
  state?: string;
}

/** Factory for the playback AudioContext — injectable so tests pass a fake. */
export type AudioContextFactory = () => PlaybackAudioContext;

/**
 * Plays a decoded character-voice clip and drives the amplitude mouth (Phase B3
 * Wave A). This is the small ORCHESTRATION layer the panel's "Speak" control
 * calls: {@link speak} synthesizes text via {@link VoiceSynthService} (DARK by
 * default → `null`, no playback), creates a fresh {@link AudioContext}, plays the
 * buffer through it, hands the live source to {@link AmplitudeMouthService} to
 * drive the openness signal, and on `ended`/`stop()` tears EVERYTHING down (stop
 * the source, stop the mouth drive, close the context) — NO leak.
 *
 * EXPLICIT-ACTION ONLY: there is no auto-play; the room/panel calls `speak` from
 * a user gesture. With the dark flag off, `speak` resolves `null` and nothing
 * plays (the control is disabled up-front anyway).
 */
@Injectable({ providedIn: 'root' })
export class VoicePlaybackService {
  private readonly synth = inject(VoiceSynthService);
  private readonly mouth = inject(AmplitudeMouthService);

  /** Whether voice is enabled at all (the panel disables Speak when false). */
  isEnabled(): boolean {
    return this.synth.isEnabled();
  }

  /**
   * Synthesize + play `text`, returning a {@link SpeakSession} (openness signal +
   * stop) — or `null` when nothing plays (flag off, blank text, synth/decode
   * failure). NEVER throws. The session's `openness` is the LIVE signal the mouth
   * drive updates each rAF frame; it returns to 0 once playback ends (the source's
   * `ended` runs the same teardown as `stop()`).
   *
   * `audioContextFactory` is injectable for tests (default = real `AudioContext`).
   */
  async speak(
    text: string,
    opts?: SynthOptions & { audioContextFactory?: AudioContextFactory },
  ): Promise<SpeakSession | null> {
    const clip = await this.synth.synth(text, opts);
    if (!clip) {
      // DARK flag / blank / synth-or-decode failure → no playback, no surprise audio.
      return null;
    }

    const speaking = signal(false);

    let ctx: PlaybackAudioContext | null = null;
    let drive: MouthDrive | null = null;
    let source: AudioBufferSourceNode | null = null;
    // A closed/idle openness signal used when teardown beats a drive being made.
    const idleOpenness = signal(0);
    let torndown = false;

    const teardown = (): void => {
      if (torndown) {
        return;
      }
      torndown = true;
      speaking.set(false);
      // Stop the mouth drive first (cancels rAF, disconnects analyser, openness→0).
      try {
        drive?.stop();
      } catch {
        /* ignore */
      }
      idleOpenness.set(0);
      // Stop + detach the source.
      try {
        source?.stop();
      } catch {
        /* already stopped / not started — ignore */
      }
      try {
        source?.disconnect();
      } catch {
        /* ignore */
      }
      // Close the context we own (best-effort).
      try {
        void ctx?.close();
      } catch {
        /* ignore */
      }
    };

    try {
      const factory = opts?.audioContextFactory ?? defaultAudioContextFactory;
      ctx = factory();
      if (ctx.state === 'suspended' && ctx.resume) {
        // A gesture-created context may start suspended; resume so it plays.
        try {
          await ctx.resume();
        } catch {
          /* ignore */
        }
      }
      source = ctx.createBufferSource();
      source.buffer = clip.buffer;
      // Source → speakers; the mouth drive attaches its OWN analyser to the source.
      source.connect(ctx.destination);
      drive = this.mouth.drive(source, ctx);
      source.onended = () => teardown();
      source.start();
      speaking.set(true);
    } catch {
      // Anything during setup → tear down and report no session (fail-soft).
      teardown();
      return null;
    }

    // The live openness is the drive's signal; if reduced-motion it is pinned 0.
    const openness = drive.openness;
    return {
      openness,
      speaking,
      stop: teardown,
    };
  }
}

/** Real playback AudioContext factory. */
export function defaultAudioContextFactory(): PlaybackAudioContext {
  const Ctor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  return new Ctor() as PlaybackAudioContext;
}
