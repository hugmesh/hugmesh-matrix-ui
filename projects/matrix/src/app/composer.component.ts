import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges, ViewChild, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CloakCapability, CloakMode, CloakStatus, MatrixService, TimelineEvent } from './matrix.service';
import { SessionService } from './session.service';
import { HugStickerPickerComponent } from './vn/hug-sticker-picker.component';

type ComposerMode = 'send' | 'reply' | 'edit' | 'thread';

/**
 * A file uploaded-but-not-yet-sent. The Matrix composer DECOUPLES upload from
 * send (see {@link ComposerComponent.onFile}): the bytes are uploaded via the
 * AI-cloak BFF proxy and held here as a pending attachment so (a) the cloak runs
 * BEFORE the `m.image` event federates and (b) the per-attachment cloak badge has
 * a real surface to live on (the transient {@link ComposerComponent.status}
 * signal cannot host it once the event is sent).
 */
interface PendingAttachment {
  file: File;
  mxcUri: string;
  isImage: boolean;
  dims: { w?: number; h?: number };
  /** Per-attachment cloak state — the server decision drives the badge copy. */
  cloak: CloakStatus;
  /** Whether this attachment was uploaded through the cloak proxy at all. */
  cloaked: boolean;
}

/**
 * Element Web MessageComposer / SendMessageComposer. Sends m.text on Enter
 * (wraps sendMessage), supports reply/edit/thread modes, and attaches
 * files/images.
 *
 * AI-CLOAK (default-on, image-only): attachments are routed through the user-bff
 * media proxy ({@link MatrixService.uploadMediaProtected}) which poisons the
 * bytes BEFORE the homeserver ingests them, instead of POSTing straight to
 * `/_matrix/media/v3/upload`. The per-attachment shield toggle defaults ON
 * (`mode:'cloak'`); turning it off (`mode:'none'`) forwards the bytes unchanged.
 * Because cloaking is genuinely slow, upload is decoupled from send: the file is
 * uploaded and held as a pending attachment with an inline "Protecting your
 * image…" progress state + a "post now without protection" escape hatch, and the
 * `m.image` event is only emitted on explicit send. Carries the matrix-input /
 * matrix-send testids.
 */
@Component({
  selector: 'hug-composer',
  standalone: true,
  imports: [CommonModule, FormsModule, HugStickerPickerComponent],
  templateUrl: './composer.component.html',
  styleUrl: './composer.component.scss',
})
export class ComposerComponent implements OnInit, OnChanges, OnDestroy {
  private readonly matrix = inject(MatrixService);
  private readonly session = inject(SessionService);

  /** The sticker toggle button — focus returns here when the picker closes. */
  @ViewChild('stickerToggle') stickerToggle?: ElementRef<HTMLButtonElement>;

  @Input() roomId = '';
  /** When set, the composer enters reply/edit/thread mode for this event. */
  @Input() target: TimelineEvent | null = null;
  @Input() mode = signal<ComposerMode>('send');
  /** Thread root + latest event when in thread mode. */
  @Input() threadRootId: string | null = null;
  @Input() latestThreadEventId: string | null = null;

  @Output() sent = new EventEmitter<string>();
  @Output() modeReset = new EventEmitter<void>();

  draft = '';
  readonly busy = signal(false);
  readonly status = signal('');

  // ── VN sticker picker (MSC2545 send-half) ──
  /** Whether the own-pack sticker picker overlay is open for this room. */
  readonly stickerPickerOpen = signal(false);

  // ── AI-cloak (default-ON, per-attachment) ──
  /** Per-post AI-cloak toggle. DEFAULT ON → mode `cloak`; off → `none`.
   *  The opt-out is "Don't protect this image from AI" — flipping it OFF forwards
   *  the bytes unchanged (the server records an honest `skipped` decision). */
  readonly poisonImages = signal(true);

  // ── Local-only / domain-lock (SOCIAL LOCAL-ONLY enforcement) ──
  /**
   * Whether the caller is Matrix DOMAIN-LOCKED — the `matrix_domainlocked`
   * restriction marker the admin-bff (PR #26) folds into the session `roles[]`
   * off the validated JWT. When true, this composer's federation surface is
   * forced LOCAL-ONLY: the local-only state is pinned ON and explained, while
   * local sending stays fully usable (we never disable Send/attach — only
   * cross-domain targets). Defence-in-depth: the homeserver/BFF still enforces
   * force-local server-side.
   */
  readonly domainLocked = computed(() => this.session.isMatrixDomainLocked());

  /**
   * Per-post "local-only" intent / state.
   *
   * Post-level local-only is NOT a Matrix primitive — the only Matrix mechanism
   * is a local-only ROOM (`creation_content.m.federate=false` at ROOM CREATION,
   * immutable thereafter). So this control is never a freely-toggleable per-post
   * switch: it is DRIVEN by the account-level domain lock. When the caller is
   * domain-locked it reads ON (forced, non-interactive, with WHY-helptext); when
   * not locked it reads OFF and inert (room-level setting, nothing to wire here).
   * Either way the control is rendered disabled+helptext, never a bare disabled
   * control. */
  readonly localOnly = computed(() => this.domainLocked());
  /** Heavy-tier capability, queried on init so the shield is honest up front. */
  readonly capability = signal<CloakCapability>({ backend: 'none', available: false });
  /** The file uploaded-but-not-yet-sent (decoupled upload→send). */
  readonly pending = signal<PendingAttachment | null>(null);
  /** Whether a cloak is actively running on the pending attachment (progress). */
  readonly cloaking = signal(false);

  private typing = false;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private statusPoll: ReturnType<typeof setTimeout> | undefined;

  get placeholder(): string {
    switch (this.mode()) {
      case 'reply': return 'Write a reply…';
      case 'edit': return 'Edit message…';
      case 'thread': return 'Reply in thread…';
      default: return 'Send a message…';
    }
  }

  /** Toggle/mode label for the shield control (honest, never "protected"). */
  get cloakLabel(): string {
    if (!this.capability().available) return 'AI-cloak: Unavailable';
    return this.poisonImages() ? 'AI-cloak: on' : 'AI-cloak: off';
  }

  /** Helptext for the AI-cloak toggle: the OPT-OUT phrasing the task mandates
   *  when on, an honest "unavailable" note when the heavy tier is absent. */
  get cloakHelp(): string {
    if (!this.capability().available) return 'AI-cloak is unavailable on this server right now.';
    return this.poisonImages()
      ? "Images are protected from AI by default. Turn this off to NOT protect this image from AI."
      : "This image will NOT be protected from AI. Turn this back on to protect it.";
  }

  /** Accessible name for the (always-disabled) local-only control. When the
   *  caller is domain-locked it reads "on" + "enforced"; otherwise it reads the
   *  inert room-level state. Honest — never implies a togglable switch. */
  get localOnlyLabel(): string {
    return this.domainLocked() ? 'Local-only: on (enforced by domain lock)' : 'Local-only: unavailable';
  }

  /** Helptext for the (disabled) local-only control — explains WHY it is in its
   *  state. When the caller is DOMAIN-LOCKED: this account is restricted to its
   *  own domain, so messages stay local and cross-domain/federation targets are
   *  unavailable; local chat is unaffected. Otherwise: local-only is a room-level
   *  setting chosen at room creation and cannot be changed per post. */
  get localOnlyHelp(): string {
    return this.domainLocked()
      ? 'Your account is domain-locked: messages stay on your own domain, so cross-domain (federation) targets are unavailable. Local chat is unaffected.'
      : 'Local-only is a room-level setting chosen when the room is created (it cannot be changed per post), and account-level enforcement is not available yet.';
  }

  /** Expected per-image processing time copy for the progress state. */
  get cloakEta(): string {
    const s = this.capability().expectedSeconds;
    if (!s) return '';
    const mins = Math.max(1, Math.round(s / 60));
    return ` (~${mins} min)`;
  }

  /** Honest badge copy for a pending attachment's cloak status. */
  badgeText(s: CloakStatus): string {
    switch (s) {
      case 'cloaked': return 'AI-cloak applied';
      case 'degraded': return 'Protection degraded';
      case 'pending': return 'Protecting your image…';
      case 'failed': return 'Cloak failed — not cloaked';
      default: return 'Not cloaked';
    }
  }

  ngOnInit(): void {
    // Honest shield state up front: discover whether the optional heavy tier is
    // reachable so we render "Unavailable" before the user attaches, not after.
    // Guarded so the composer still mounts if it is embedded with a service that
    // doesn't expose the (optional) cloak probe — the shield simply stays
    // "Unavailable" rather than crashing the host view.
    try {
      void this.matrix.cloakCapability?.()
        .then((c) => this.capability.set(c))
        .catch(() => { /* leave default none */ });
    } catch { /* leave default none */ }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['target']) {
      if (this.mode() === 'edit' && this.target) {
        this.draft = (this.target.content?.['m.new_content']?.body ?? this.target.body ?? '').replace(/^\* /, '');
      }
    }
  }

  ngOnDestroy(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    if (this.statusPoll) clearTimeout(this.statusPoll);
    void this.stopTyping();
  }

  targetSummary(): string {
    return this.target ? (this.target.senderDisplayName || this.target.sender) : '';
  }

  appendEmoji(): void {
    this.draft += '🙂';
  }

  /** Flip the AI-cloak shield for subsequent attachments. */
  togglePoison(): void {
    this.poisonImages.update((v) => !v);
  }

  /** Open/close the VN sticker picker. Opening is allowed even when the user has
   *  no pack (the picker shows its own empty state) so the button never flickers
   *  on async pack state. Requires a room — a sticker is sent into the active one. */
  toggleStickerPicker(): void {
    if (!this.roomId) {
      return;
    }
    this.stickerPickerOpen.update((v) => !v);
  }

  /** The picker sent an m.sticker (or was dismissed): close it and return focus to
   *  the toggle button (APG "close returns focus to the trigger"). */
  closeStickerPicker(): void {
    if (!this.stickerPickerOpen()) {
      return;
    }
    this.stickerPickerOpen.set(false);
    // Restore focus to the toggle so a keyboard user isn't stranded.
    queueMicrotask(() => this.stickerToggle?.nativeElement?.focus());
  }

  /** A sticker was sent: surface the new event to the host (timeline refresh)
   *  exactly like text/attachment sends, then close the picker. */
  onStickerSent(eventId: string): void {
    this.sent.emit(eventId);
    this.closeStickerPicker();
  }

  onInput(): void {
    if (!this.roomId) return;
    if (!this.typing) {
      this.typing = true;
      void this.matrix.setTyping(this.roomId, true, 30000);
    }
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTyping(), 3000);
  }

  async stopTyping(): Promise<void> {
    if (this.typing && this.roomId) {
      this.typing = false;
      await this.matrix.setTyping(this.roomId, false);
    }
  }

  cancel(): void {
    this.mode.set('send');
    this.draft = '';
    this.modeReset.emit();
  }

  async send(): Promise<void> {
    const body = this.draft.trim();
    if (!body || !this.roomId) return;
    this.busy.set(true);
    await this.stopTyping();
    try {
      let eventId: string;
      switch (this.mode()) {
        case 'reply':
          eventId = await this.matrix.sendReply(this.roomId, body, this.target!.eventId);
          break;
        case 'edit':
          eventId = await this.matrix.editMessage(this.roomId, this.target!.eventId, body);
          break;
        case 'thread':
          eventId = await this.matrix.sendThreadMessage(
            this.roomId, body,
            this.threadRootId ?? this.target?.eventId ?? '',
            this.latestThreadEventId ?? this.threadRootId ?? this.target?.eventId ?? '');
          break;
        default:
          eventId = await this.matrix.sendMessage(this.roomId, { msgtype: 'm.text', body });
      }
      this.draft = '';
      if (this.mode() !== 'thread') this.mode.set('send');
      this.modeReset.emit();
      this.sent.emit(eventId);
      this.status.set('');
    } catch (e: any) {
      // ANNOUNCED failure (mirrors sendAttachment): a rejected send — banned /
      // signed-out / power-level-denied sender, homeserver 4xx/5xx — surfaces in
      // the aria-live composer-status region instead of dying as an unhandled
      // rejection. The draft is kept so the user can retry or copy it out.
      this.status.set(`Send failed: ${e?.message ?? e}`);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Pick a file and UPLOAD it (decoupled from send).
   *
   * IMAGES always go through the AI-cloak BFF proxy so the OPT-OUT DECISION IS
   * SERVER-OWNED (not a UI-only convention): `mode:'cloak'` when the shield is on
   * and the heavy tier is available (poison-before-ingest), `mode:'none'`
   * otherwise (the server records an honest "skipped" decision and forwards the
   * bytes unchanged). NON-IMAGE media has no cloak surface and is forwarded
   * straight to the homeserver content repo.
   *
   * The resulting mxc is held as a pending attachment with its cloak status; the
   * `m.image`/`m.file` event is NOT emitted until {@link sendAttachment}.
   */
  async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.roomId) return;
    const isImage = file.type.startsWith('image/');
    const cloakMode: CloakMode = this.poisonImages() && this.capability().available ? 'cloak' : 'none';
    const willCloak = isImage && cloakMode === 'cloak';

    this.busy.set(true);
    this.cloaking.set(willCloak);
    this.status.set(willCloak ? `Protecting ${file.name}…${this.cloakEta}` : `Uploading ${file.name}…`);
    try {
      const dims = isImage
        ? await this.imageDims(file).catch(() => ({ w: undefined, h: undefined }))
        : { w: undefined, h: undefined };

      let mxcUri: string;
      let cloak: CloakStatus;
      let cloaked: boolean;
      if (isImage) {
        // Route every image through the BFF media proxy (poison-before-ingest for
        // `cloak`; server-recorded opt-out for `none`).
        const up = await this.matrix.uploadMediaProtected(file, cloakMode, this.roomId);
        mxcUri = up.mxcUri;
        cloak = up.decision.status;
        cloaked = cloakMode === 'cloak';
      } else {
        // Non-image: nothing to cloak — forward straight through unchanged.
        const up = await this.matrix.uploadMedia(file, file.name);
        mxcUri = up.mxcUri;
        cloak = 'skipped';
        cloaked = false;
      }

      this.pending.set({ file, mxcUri, isImage, dims, cloak, cloaked });
      this.status.set('');
      if (cloaked && cloak === 'pending') this.pollCloak(mxcUri);
    } catch (e: unknown) {
      this.status.set(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy.set(false);
      this.cloaking.set(false);
    }
  }

  /** Poll the server-owned cloak decision until it resolves, then update the
   *  pending attachment's badge (round-trip survival gate ⇒ may end `degraded`). */
  private pollCloak(mxcUri: string, attempt = 0): void {
    if (this.statusPoll) clearTimeout(this.statusPoll);
    this.statusPoll = setTimeout(() => {
      void this.matrix.cloakStatus(mxcUri).then((d) => {
        const p = this.pending();
        if (!p || p.mxcUri !== mxcUri) return; // attachment replaced/sent
        this.pending.set({ ...p, cloak: d.status });
        if (d.status === 'pending' && attempt < 60) this.pollCloak(mxcUri, attempt + 1);
      }).catch(() => { /* leave last known status */ });
    }, 2000);
  }

  /** ESCAPE HATCH — post the pending image immediately without waiting for the
   *  cloak to finish. Honest: the badge will reflect whatever the server's final
   *  decision is (it may still resolve to degraded/cloaked after the fact). */
  postNow(): void {
    void this.sendAttachment();
  }

  /** Send the held pending attachment as an `m.image`/`m.file` event. Downstream
   *  {@link MatrixService.sendImage} is untouched — it just references the
   *  already-uploaded (and, when cloaked, poison-before-ingest) mxc. */
  async sendAttachment(): Promise<void> {
    const p = this.pending();
    if (!p || !this.roomId) return;
    this.busy.set(true);
    if (this.statusPoll) clearTimeout(this.statusPoll);
    try {
      let eventId: string;
      if (p.isImage) {
        eventId = await this.matrix.sendImage(this.roomId, p.mxcUri, p.file, {
          w: p.dims.w, h: p.dims.h, mimetype: p.file.type, size: p.file.size,
        });
      } else {
        eventId = await this.matrix.sendFile(this.roomId, p.mxcUri, p.file);
      }
      this.pending.set(null);
      this.status.set('');
      this.sent.emit(eventId);
    } catch (e: unknown) {
      this.status.set(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy.set(false);
    }
  }

  /** Discard the pending attachment without sending it. */
  discardAttachment(): void {
    if (this.statusPoll) clearTimeout(this.statusPoll);
    this.pending.set(null);
    this.status.set('');
  }

  private imageDims(file: File): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }
}
