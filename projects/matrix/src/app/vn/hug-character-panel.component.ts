import { Component, Input, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatrixService } from '../matrix.service';
import { CharacterPackService, UserEmotesPack } from './character-pack.service';
import { SvgRigService } from './services/svg-rig.service';
import { VnCharacter } from './models/vn-character';
import { PartManifest } from './models/vn-manifest';
import { DEFAULT_EXPRESSION, Expression, isExpression } from './expression';
import { accessibleName } from '../accessible-name';
import { VoicePlaybackService, SpeakSession } from './voice/voice-playback.service';
import { CharacterCaptureService } from './voice/character-capture.service';

/**
 * LIVE VN-character render beside the room timeline (Phase B2, Path A).
 *
 * Given a room participant ({@link ownerId}) with an ACTIVE VN character and the
 * current {@link expression} (driven live by the timeline), it shows that
 * character as a single `<img>`:
 *
 *  - PRIMARY — sticker pack frame: resolve the owner's MSC2545
 *    `im.ponies.user_emotes` pack (B1 #89) via {@link CharacterPackService}, pick
 *    the image for the current expression (priority handled upstream:
 *    `vn.expression` > sentiment > `neutral`), and render its mxc via an
 *    authenticated blob object URL.
 *  - DRAWABLE fallback — composed SVG: when a {@link character}/{@link pack}
 *    drawable model is supplied (no sticker pack), compose the SVG with
 *    {@link SvgRigService}, CLIENT-SANITIZE it, and render the resulting
 *    `data:image/svg+xml` URL.
 *
 * The render is ALWAYS an `<img>` — never `[innerHTML]`/`bypassSecurityTrustHtml`
 * — so a composed/user-drawn SVG is script-inert (the XSS boundary). FAIL-SOFT:
 * if no pack and no drawable resolve, the panel renders NOTHING (no character, no
 * layout break), so wiring it into a room is non-intrusive.
 */
@Component({
  selector: 'hug-character-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './hug-character-panel.component.html',
  styleUrl: './hug-character-panel.component.scss',
})
export class HugCharacterPanelComponent implements OnDestroy {
  private readonly matrix = inject(MatrixService);
  private readonly packs = inject(CharacterPackService);
  private readonly rig = inject(SvgRigService);
  private readonly voice = inject(VoicePlaybackService);
  private readonly capture = inject(CharacterCaptureService);

  /** The participant whose character is shown. Changing it re-resolves the pack. */
  @Input() set ownerId(value: string | null) {
    if (value === this._ownerId()) {
      return;
    }
    this._ownerId.set(value);
    void this.resolve();
  }
  get ownerId(): string | null {
    return this._ownerId();
  }
  private readonly _ownerId = signal<string | null>(null);

  /** The display name of the owner, used only for the `<img>` alt text. */
  @Input() ownerName: string | null = null;
  /** Optional ASCII screen-reader name for the owner (announced over ownerName). */
  @Input() ownerScreenReaderName: string | null = null;

  /** The current expression. Setting it re-picks the frame (no re-fetch). */
  @Input() set expression(value: string | null | undefined) {
    const next: Expression = isExpression(value) ? value : DEFAULT_EXPRESSION;
    if (next === this._expression()) {
      return;
    }
    this._expression.set(next);
    void this.pickFrame();
  }
  get expression(): Expression {
    return this._expression();
  }
  private readonly _expression = signal<Expression>(DEFAULT_EXPRESSION);

  /** Optional drawable character + its pack — the composed-SVG fallback path. */
  @Input() set character(value: VnCharacter | null) {
    this._character = value;
    void this.pickFrame();
  }
  private _character: VnCharacter | null = null;
  @Input() characterPack: PartManifest | null = null;

  /** The resolved sticker pack (null = none). */
  private readonly pack = signal<UserEmotesPack | null>(null);
  /** The `<img src>` for the current frame (blob: for mxc, data: for SVG, '' = hidden). */
  readonly src = signal<string>('');
  /** Whether a character is currently shown (drives the host's *ngIf). */
  readonly shown = signal<boolean>(false);
  /**
   * The current render mode. The amplitude MOUTH OVERLAY renders ONLY on the
   * `drawable` path (our own composed SVG portrait) — a sticker-pack character is
   * a full-face mxc whose mouth is baked into the art, so it gets a STATIC mouth
   * (no overlay). `none` = nothing shown.
   */
  private readonly mode = signal<'sticker' | 'drawable' | 'none'>('none');

  /** A blob: object URL we own and must revoke on swap/destroy (data: URLs aren't). */
  private objectUrl: string | null = null;

  // ───────────────────────────── Voice (B3 Wave A) ─────────────────────────────

  /** The optional text the Speak control voices (the message body, room-wired). */
  @Input() speakText: string | null = null;

  /** The room to POST a recorded voice clip to (B3 Wave B). Null → record disabled. */
  @Input() roomId: string | null = null;

  /** The live speak session (null = not speaking); we stop it on swap/destroy. */
  private session: SpeakSession | null = null;
  /** Whether audio is currently playing (drives the Speak/Stop label + state). */
  readonly speaking = signal<boolean>(false);
  /** The live mouth openness 0..1 (the drive's signal while speaking, else 0). */
  private readonly opennessSignal = signal<number>(0);

  /**
   * Whether the amplitude mouth OVERLAY should render: drawable mode + actively
   * speaking. A sticker-pack character never shows the overlay (static mouth).
   */
  readonly showMouth = computed(() => this.mode() === 'drawable' && this.speaking());

  /**
   * The mouth overlay's open-height in px (0..MOUTH_MAX_H), scaled by openness.
   * Decorative; the overlay is `aria-hidden`. Closed (0) when not speaking.
   */
  readonly mouthOpenPx = computed(() => Math.round(this.opennessSignal() * HugCharacterPanelComponent.MOUTH_MAX_H));

  /** Max mouth opening in px at openness=1, within the 160x160 portrait. */
  private static readonly MOUTH_MAX_H = 22;
  /** Portrait edge (px) — the overlay positions within this box. */
  private static readonly PORTRAIT = 160;
  /** Fallback mouth anchor (lower-centre) as 0..1 of the portrait. */
  private static readonly FALLBACK_ANCHOR = { x: 0.5, y: 0.72 };

  /** Whether the Speak control is usable: voice flag ON + a character shown + text. */
  canSpeak(): boolean {
    return this.voice.isEnabled() && this.shown() && !!(this.speakText && this.speakText.trim());
  }

  /** Accessible name for the Speak control — fixed, descriptive, not decorative. */
  speakLabel(): string {
    return this.speaking() ? 'Stop character voice' : 'Play character voice';
  }

  // ─────────────────────── Recorded voice clip (B3 Wave B) ─────────────────────

  /** Whether a clip is currently being recorded + posted (drives the indicator). */
  readonly recording = signal<boolean>(false);

  /**
   * Whether the "Record voice clip" control is usable: voice flag ON + a
   * character shown + text to speak + a room to post to + not already recording.
   */
  canRecord(): boolean {
    return (
      this.capture.isEnabled() &&
      this.shown() &&
      !!(this.speakText && this.speakText.trim()) &&
      !!(this.roomId && this.roomId.trim()) &&
      !this.recording()
    );
  }

  /** aria-live status text for the recording indicator (empty when idle). */
  recordStatus(): string {
    return this.recording() ? 'Recording and sending character voice clip' : '';
  }

  /**
   * Record the character SPEAKING {@link speakText} — the animating portrait +
   * its TTS audio — into a `.webm` and post it to {@link roomId} as an `m.video`
   * message. EXPLICIT user action only (never auto-run). No-op (and the control
   * is disabled) when the dark flag is off, nothing is shown, or there is no text
   * / room. Fail-soft: the capture service never throws and never sends on error;
   * this only toggles the recording indicator around the call.
   */
  async recordClip(): Promise<void> {
    if (!this.canRecord()) {
      return;
    }
    const room = (this.roomId ?? '').trim();
    const text = (this.speakText ?? '').trim();
    const imageSrc = this.src();
    this.recording.set(true);
    try {
      await this.capture.recordAndSend(room, text, {
        imageSrc,
        character: this._character?.packId,
        mouthAnchor: this.mouthAnchor(),
      });
    } catch {
      // FAIL-SOFT: the capture service is documented never to throw, but this UI
      // handler must not reject even if it somehow does — swallow and clear up.
    } finally {
      // Whether it sent, was a no-op, or failed soft, the indicator clears.
      this.recording.set(false);
    }
  }

  /**
   * The mouth overlay's centre position, in px within the 160x160 portrait, from
   * the manifest 'mouth' slot anchor (0..1 of the pack canvas) — falling back to
   * the lower-centre when the pack ships no 'mouth' slot. Pure: drives `left`/`top`.
   */
  mouthLeftPx(): number {
    return Math.round(this.mouthAnchor().x * HugCharacterPanelComponent.PORTRAIT);
  }
  mouthTopPx(): number {
    return Math.round(this.mouthAnchor().y * HugCharacterPanelComponent.PORTRAIT);
  }

  /** Resolve the 'mouth' slot anchor from the drawable pack, else the fallback. */
  private mouthAnchor(): { x: number; y: number } {
    const slot = this.characterPack?.slots?.find((s) => s.slot === 'mouth');
    const a = slot?.anchor;
    if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) {
      return { x: a.x, y: a.y };
    }
    return HugCharacterPanelComponent.FALLBACK_ANCHOR;
  }

  /**
   * Toggle character voice: if speaking, STOP; else synthesize {@link speakText}
   * and play it, driving the amplitude mouth. EXPLICIT user action only — never
   * auto-played. No-op (and the control is disabled) when the dark flag is off,
   * nothing is shown, or there is no text. Fail-soft: a null session (flag off /
   * synth failure) simply leaves the mouth at rest.
   */
  async speak(): Promise<void> {
    if (this.speaking()) {
      this.stopSpeaking();
      return;
    }
    if (!this.canSpeak()) {
      return;
    }
    const text = (this.speakText ?? '').trim();
    const session = await this.voice.speak(text, { character: this._character?.packId });
    if (!session) {
      // DARK flag / synth-or-decode failure → mouth stays at rest, no audio.
      return;
    }
    this.session = session;
    this.speaking.set(true);
    // Poll the live drive's openness into our signal each frame while speaking.
    this.pumpOpenness();
    // The session flips `speaking` to false on audio end; mirror that to close up.
    this.watchSession();
  }

  /** Stop any in-progress speak session and return the mouth to rest. */
  stopSpeaking(): void {
    this.session?.stop();
    this.session = null;
    this.speaking.set(false);
    this.opennessSignal.set(0);
    if (this.rafHandle !== 0) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
  }

  /** rAF handle for the openness pump (mirrors the drive signal into ours). */
  private rafHandle = 0;

  /**
   * Mirror the live session's openness signal into {@link opennessSignal} each
   * animation frame (signals are pull-based; the template binds OUR signal, so we
   * sample the drive's on a frame loop while speaking). Stops itself when the
   * session ends.
   */
  private pumpOpenness(): void {
    const sess = this.session;
    if (!sess) {
      return;
    }
    const step = (): void => {
      const cur = this.session;
      if (!cur || cur !== sess) {
        return;
      }
      this.opennessSignal.set(cur.openness());
      this.rafHandle = requestAnimationFrame(step);
    };
    this.rafHandle = requestAnimationFrame(step);
  }

  /** Watch the session's `speaking` flag (flipped false on audio end) to close up. */
  private watchSession(): void {
    const sess = this.session;
    if (!sess) {
      return;
    }
    const poll = (): void => {
      if (this.session !== sess) {
        return; // superseded or stopped
      }
      if (!sess.speaking()) {
        this.stopSpeaking();
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  ngOnDestroy(): void {
    this.stopSpeaking();
    this.revoke();
  }

  /** The `<img>` alt: "<owner> character, <expression>" — meaningful, not decorative. */
  alt(): string {
    const name = accessibleName(this.ownerName || this._ownerId() || 'Participant', this.ownerScreenReaderName);
    return `${name} character, ${this._expression()}`;
  }

  /** Resolve the owner's sticker pack (fail-soft), then pick the current frame. */
  private async resolve(): Promise<void> {
    const owner = this._ownerId();
    if (!owner) {
      this.pack.set(null);
      await this.pickFrame();
      return;
    }
    const resolved = await this.packs.resolveCharacterPack(owner);
    this.pack.set(resolved);
    await this.pickFrame();
  }

  /**
   * Pick the `<img src>` for the current expression. Priority of SOURCE:
   * sticker-pack frame (when a pack resolved) → composed drawable SVG (when a
   * drawable character+pack was supplied) → hide. The EXPRESSION priority
   * (`vn.expression` > sentiment > neutral) is applied by the caller before it
   * sets {@link expression}.
   */
  private async pickFrame(): Promise<void> {
    const pack = this.pack();
    const image = this.packs.imageFor(pack, this._expression());
    if (image) {
      await this.renderMxc(image.url);
      return;
    }
    if (this._character && this.characterPack) {
      await this.renderDrawable(this._character, this.characterPack);
      return;
    }
    // Nothing to show — hide cleanly (and release any held blob URL).
    this.revoke();
    this.src.set('');
    this.shown.set(false);
    this.mode.set('none');
    // A character swap to nothing must also silence any in-progress voice.
    this.stopSpeaking();
  }

  /** Fetch an authenticated sticker mxc as a blob object URL for the `<img>`. */
  private async renderMxc(mxc: string): Promise<void> {
    try {
      const url = await this.matrix.fetchMediaObjectUrl(mxc, { thumbnail: true, w: 160, h: 160, method: 'scale' });
      this.revoke();
      if (!url) {
        this.src.set('');
        this.shown.set(false);
        this.mode.set('none');
        return;
      }
      this.objectUrl = url;
      this.src.set(url);
      this.shown.set(true);
      // Sticker-pack character = full-face mxc → STATIC mouth, NO overlay.
      this.mode.set('sticker');
    } catch {
      // Fail-soft: a media error shows nothing rather than a broken character.
      this.revoke();
      this.src.set('');
      this.shown.set(false);
      this.mode.set('none');
    }
  }

  /** Compose + CLIENT-SANITIZE the drawable character into a data: SVG URL. */
  private async renderDrawable(def: VnCharacter, pack: PartManifest): Promise<void> {
    try {
      // Re-sync fix: pass the live expression's slot overrides so the DRAWABLE
      // swaps its mouth/eyes per expression (the stale 2-arg compositor ignored
      // the expression entirely — the drawable was inert). Empty for a pack with
      // no expressions, so that drawable renders the neutral base unchanged.
      const slots = this.expressionSlotsFor(pack, this._expression());
      const dataUrl = await this.rig.composeSanitizedDataUrl(def, pack, slots);
      // A composed data: URL is not an object URL — release any prior blob first.
      this.revoke();
      this.src.set(dataUrl);
      this.shown.set(true);
      // DRAWABLE = our own composed SVG portrait → the amplitude mouth OVERLAY
      // (a separate sibling DOM element) is allowed here.
      this.mode.set('drawable');
    } catch {
      this.revoke();
      this.src.set('');
      this.shown.set(false);
      this.mode.set('none');
    }
  }

  /**
   * Resolve the drawable slot→partId overrides for `expression` from the pack's
   * {@link PartManifest.expressions} presets (id IS the canonical expression
   * label). Returns `{}` — the neutral base — when the pack ships no expressions
   * or the label has no preset (so the drawable degrades gracefully, never throws).
   */
  private expressionSlotsFor(pack: PartManifest, expression: Expression): Record<string, string> {
    const preset = pack.expressions?.find((e) => e.id === expression);
    return preset?.slots ?? {};
  }

  /** Revoke the blob object URL we own (no-op for data:/empty). */
  private revoke(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
