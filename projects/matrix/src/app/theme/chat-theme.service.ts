import { Injectable, inject, signal } from '@angular/core';
import { MatrixService } from '../matrix.service';

/**
 * The account-data event type the per-user chat theme persists under —
 * fetched/stored through {@link MatrixService.getAccountData} /
 * {@link MatrixService.setAccountData} exactly like the MSC2545
 * `im.ponies.user_emotes` pack the VN character system reads (cookie-auth BFF
 * hsproxy; no client-side token). Account data is PER USER, so the theme
 * follows the account across devices without ever being visible to others.
 */
export const CHAT_THEME_ACCOUNT_DATA_TYPE = 'net.hugmesh.chat_theme';

/**
 * Pre-rebrand generations of {@link CHAT_THEME_ACCOUNT_DATA_TYPE};
 * read-fallback only — never written. An account whose theme was saved under
 * an older branding still carries it under that name, and BOTH old
 * generations are real data — `systems.hugmesh.*` (every post-squash build
 * before the .net domain move) and `systems.snapdragon.*` (pre-rebrand
 * accounts). Ordered newest first: {@link ChatThemeService} reads the
 * canonical type, then each generation in order (the newest generation that
 * has content wins — including a canonical `{}` reset marker); every write
 * goes to the canonical type only, so the first post-move save migrates the
 * account forward.
 */
export const LEGACY_CHAT_THEME_ACCOUNT_DATA_TYPES: readonly string[] = [
  'systems.hugmesh.chat_theme', 'systems.snapdragon.chat_theme',
];

/** Instant-boot cache: the last saved theme, applied synchronously on the first
 *  theme-root registration BEFORE the account-data fetch resolves (no flash of
 *  unthemed chat). The account-data copy remains the source of truth. */
export const CHAT_THEME_STORAGE_KEY = 'hug.matrix.chattheme.v1';

export type ChatThemePreset = 'element-dark' | 'pastel' | 'neon' | 'paper' | 'midnight-vn';
export type ChatBubbleShape = 'rounded' | 'square' | 'minimal';
export type ChatFont = 'system' | 'serif' | 'rounded' | 'mono';
export type ChatDensity = 'cozy' | 'compact';
export type ChatBackground = 'none' | 'dots' | 'grid' | 'stars';

/** The complete personally-customizable chat appearance for one user. */
export interface ChatThemeConfig {
  preset: ChatThemePreset;
  /** Accent (#rrggbb) — sender names + chat background pattern ink. */
  accent: string;
  bubbleShape: ChatBubbleShape;
  /** Bubble fill (#rrggbb) for MY messages. */
  bubbleMine: string;
  /** Bubble fill (#rrggbb) for OTHER senders' messages. */
  bubbleTheirs: string;
  font: ChatFont;
  density: ChatDensity;
  chatBackground: ChatBackground;
}

const PRESET_IDS: readonly ChatThemePreset[] = ['element-dark', 'pastel', 'neon', 'paper', 'midnight-vn'];
const BUBBLE_SHAPES: readonly ChatBubbleShape[] = ['rounded', 'square', 'minimal'];
const FONTS: readonly ChatFont[] = ['system', 'serif', 'rounded', 'mono'];
const DENSITIES: readonly ChatDensity[] = ['cozy', 'compact'];
const BACKGROUNDS: readonly ChatBackground[] = ['none', 'dots', 'grid', 'stars'];

/**
 * The 5 presets' swatch/default colors — the TS mirror of the SCSS maps in
 * styles/_chat-themes.scss (which own the FULL palette: surfaces, text colors,
 * borders). Only the three user-tweakable colors live here so the settings
 * pickers can seed from the chosen preset and stay in sync with the CSS.
 */
// CONTRAST CONTRACT: each preset's accent renders 13px sender-name TEXT on
// BOTH bubble fills and the chat bg, so it must hold WCAG AA 4.5:1 against
// all three (verified ratios: element-dark 5.03/7.54/8.75, pastel
// 4.79/5.02/6.49, neon 10.07/12.15/14.12, paper 5.07/6.79/6.29, midnight-vn
// 5.65/6.43/7.38). Keep in sync with the SCSS maps in styles/_chat-themes.scss.
export const CHAT_THEME_PRESETS: readonly { id: ChatThemePreset; label: string; accent: string; bubbleMine: string; bubbleTheirs: string }[] = [
  { id: 'element-dark', label: 'Element dark', accent: '#12cf99', bubbleMine: '#0f4a3f', bubbleTheirs: '#21262e' },
  { id: 'pastel', label: 'Pastel', accent: '#6a3fbb', bubbleMine: '#ffc8dd', bubbleTheirs: '#bde0fe' },
  { id: 'neon', label: 'Neon', accent: '#ffd700', bubbleMine: '#332b00', bubbleTheirs: '#1c1c1c' },
  { id: 'paper', label: 'Paper', accent: '#6f5629', bubbleMine: '#e7dcc0', bubbleTheirs: '#fffdf7' },
  { id: 'midnight-vn', label: 'Midnight VN', accent: '#b388ff', bubbleMine: '#2b1e4d', bubbleTheirs: '#191932' },
];

/** Strict #rrggbb — the ONLY color shape ever interpolated into inline styles.
 *  (No 3-digit, no alpha, no named colors: anything else is rejected so a
 *  crafted value like `red;background:url(...)` can never reach a style.) */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A full config seeded from a preset's canonical colors + the neutral knobs. */
export function defaultChatTheme(preset: ChatThemePreset = 'element-dark'): ChatThemeConfig {
  const p = CHAT_THEME_PRESETS.find((x) => x.id === preset) ?? CHAT_THEME_PRESETS[0];
  return {
    preset: p.id,
    accent: p.accent,
    bubbleShape: 'rounded',
    bubbleMine: p.bubbleMine,
    bubbleTheirs: p.bubbleTheirs,
    font: 'system',
    density: 'cozy',
    chatBackground: 'none',
  };
}

/**
 * Validate an untrusted config (account data / localStorage / caller input)
 * into a safe {@link ChatThemeConfig}, or `null` when it does not denote a
 * theme at all (absent/empty content = "no theme set" — the reset marker).
 * Field-wise tolerant: an unknown enum or a non-#rrggbb color falls back to
 * the preset's default rather than discarding the whole theme, so a config
 * written by a newer client version still mostly applies.
 */
export function sanitizeChatTheme(raw: unknown): ChatThemeConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['preset'] !== 'string' || !(PRESET_IDS as readonly string[]).includes(r['preset'])) return null;
  const base = defaultChatTheme(r['preset'] as ChatThemePreset);
  return {
    preset: base.preset,
    accent: isHexColor(r['accent']) ? (r['accent'] as string).toLowerCase() : base.accent,
    bubbleShape: oneOf(r['bubbleShape'], BUBBLE_SHAPES, base.bubbleShape),
    bubbleMine: isHexColor(r['bubbleMine']) ? (r['bubbleMine'] as string).toLowerCase() : base.bubbleMine,
    bubbleTheirs: isHexColor(r['bubbleTheirs']) ? (r['bubbleTheirs'] as string).toLowerCase() : base.bubbleTheirs,
    font: oneOf(r['font'], FONTS, base.font),
    density: oneOf(r['density'], DENSITIES, base.density),
    chatBackground: oneOf(r['chatBackground'], BACKGROUNDS, base.chatBackground),
  };
}

/** The data-* attributes this service owns on each registered theme root. */
const THEME_ATTRS = ['data-matrix-theme', 'data-matrix-bubbles', 'data-matrix-font', 'data-matrix-density', 'data-matrix-chatbg'] as const;
/** The inline custom properties this service owns (user color overrides — the
 *  preset's full palette comes from the scoped SCSS rules, not inline style). */
const THEME_VARS = ['--hugm-chat-accent', '--hugm-chat-bubble-mine', '--hugm-chat-bubble-theirs'] as const;

/**
 * Per-user chat theming. Owns the {@link ChatThemeConfig} model, persists it to
 * Matrix account data (`net.hugmesh.chat_theme`) with a localStorage
 * fast-boot fallback, and APPLIES it by stamping `data-matrix-*` attributes +
 * `--hugm-chat-*` custom properties onto the REMOTE'S OWN ROOT ELEMENTS only.
 *
 * Application scoping: this remote has no single persistent root when
 * federated (the host mounts MATRIX_ROUTES straight into its router outlet),
 * so the routed shell components (chat shell, room view, thread panel, user
 * settings) each register their host element via {@link ChatThemeRootDirective}.
 * Attributes/vars are ONLY ever set on those registered hosts — never on
 * `<body>`/`<html>` — so the theme can never leak into the host shell or the
 * other federated remotes. The matching CSS lives in styles/_chat-themes.scss,
 * included `:host(...)`-scoped by those same components; message bubbles and
 * the composer consume the inherited `--hugm-chat-*` vars with fallbacks that
 * exactly preserve the unthemed look.
 *
 * FAIL-SOFT like every fetch in this remote: a failed account-data read/write
 * never throws out of the service — the localStorage copy (or the default
 * look) simply remains in force.
 */
@Injectable({ providedIn: 'root' })
export class ChatThemeService {
  private readonly matrix = inject(MatrixService);

  /** The currently APPLIED theme; `null` = no theme set (stock look). */
  readonly theme = signal<ChatThemeConfig | null>(null);

  private readonly roots = new Set<HTMLElement>();
  private loadStarted = false;

  /**
   * Register a remote root element (a routed shell component's host). The
   * current theme is applied to it immediately; the FIRST registration also
   * boots persistence: the localStorage copy applies synchronously, then the
   * account-data copy is fetched and wins once it resolves.
   */
  registerRoot(el: HTMLElement): void {
    this.roots.add(el);
    if (!this.loadStarted) {
      this.loadStarted = true;
      this.theme.set(this.readLocal());
      void this.loadRemote();
    }
    this.applyTo(el, this.theme());
  }

  /** Forget a root (component destroyed). Its attributes are left as-is — the
   *  element is leaving the DOM. */
  unregisterRoot(el: HTMLElement): void {
    this.roots.delete(el);
  }

  /**
   * Apply a theme to all registered roots WITHOUT persisting — the live
   * feedback path while a color picker is still being dragged. Input is
   * sanitized; an invalid value falls back per-field, never into a style.
   */
  preview(cfg: ChatThemeConfig): void {
    const clean = sanitizeChatTheme(cfg);
    if (!clean) return;
    this.theme.set(clean);
    this.applyAll();
  }

  /** Apply + persist: localStorage synchronously, then account data
   *  (fail-soft — a rejected PUT leaves the local copy in force). */
  async setTheme(cfg: ChatThemeConfig): Promise<void> {
    const clean = sanitizeChatTheme(cfg);
    if (!clean) return;
    this.theme.set(clean);
    this.applyAll();
    this.writeLocal(clean);
    await this.persistRemote(clean);
  }

  /** Back to the stock look: clear attributes/vars from every root, drop the
   *  localStorage copy, and write the EMPTY object as the account-data reset
   *  marker (other devices read `{}` as "no theme"). */
  async reset(): Promise<void> {
    this.theme.set(null);
    this.applyAll();
    try {
      localStorage.removeItem(CHAT_THEME_STORAGE_KEY);
    } catch { /* storage unavailable — ignore */ }
    await this.persistRemote(null);
  }

  // ── Application ──────────────────────────────────────────────────────────

  private applyAll(): void {
    const cfg = this.theme();
    for (const el of this.roots) this.applyTo(el, cfg);
  }

  private applyTo(el: HTMLElement, cfg: ChatThemeConfig | null): void {
    if (!cfg) {
      for (const attr of THEME_ATTRS) el.removeAttribute(attr);
      for (const v of THEME_VARS) el.style.removeProperty(v);
      return;
    }
    // Attribute values are enum members validated by sanitizeChatTheme — never
    // free-form strings.
    el.setAttribute('data-matrix-theme', cfg.preset);
    el.setAttribute('data-matrix-bubbles', cfg.bubbleShape);
    el.setAttribute('data-matrix-font', cfg.font);
    el.setAttribute('data-matrix-density', cfg.density);
    el.setAttribute('data-matrix-chatbg', cfg.chatBackground);
    // Inline vars: user color overrides only, re-validated at the style
    // boundary (defence in depth — nothing but #rrggbb ever reaches a style).
    this.setVar(el, '--hugm-chat-accent', cfg.accent);
    if (cfg.bubbleShape === 'minimal') {
      // Minimal = no bubble chrome: drop the inline fills so the SCSS
      // `transparent` override wins.
      el.style.removeProperty('--hugm-chat-bubble-mine');
      el.style.removeProperty('--hugm-chat-bubble-theirs');
    } else {
      this.setVar(el, '--hugm-chat-bubble-mine', cfg.bubbleMine);
      this.setVar(el, '--hugm-chat-bubble-theirs', cfg.bubbleTheirs);
    }
  }

  private setVar(el: HTMLElement, name: string, hex: string): void {
    if (isHexColor(hex)) el.style.setProperty(name, hex);
    else el.style.removeProperty(name);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private readLocal(): ChatThemeConfig | null {
    try {
      const raw = localStorage.getItem(CHAT_THEME_STORAGE_KEY);
      return raw ? sanitizeChatTheme(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  private writeLocal(cfg: ChatThemeConfig): void {
    try {
      localStorage.setItem(CHAT_THEME_STORAGE_KEY, JSON.stringify(cfg));
    } catch { /* storage unavailable — account data still persists */ }
  }

  private async persistRemote(cfg: ChatThemeConfig | null): Promise<void> {
    try {
      const me = await this.matrix.whoami();
      if (!me) return;
      await this.matrix.setAccountData(me, CHAT_THEME_ACCOUNT_DATA_TYPE, cfg ?? {});
    } catch { /* fail-soft: local copy remains in force */ }
  }

  /** Fetch the account-data copy; when it resolves it WINS over the
   *  localStorage boot copy (and refreshes it). `null` (never set / fetch
   *  failed) keeps whatever is already applied; an explicit `{}` is the reset
   *  marker written by {@link reset} on another device. */
  private async loadRemote(): Promise<void> {
    try {
      const me = await this.matrix.whoami();
      if (!me) return;
      // Generation chain: canonical first, then each pre-rebrand name. The
      // NEWEST generation with any content wins — an explicit `{}` reset saved
      // canonically must keep suppressing an older generation's theme.
      let raw: Record<string, unknown> | null = null;
      for (const type of [CHAT_THEME_ACCOUNT_DATA_TYPE, ...LEGACY_CHAT_THEME_ACCOUNT_DATA_TYPES]) {
        raw = await this.matrix.getAccountData<Record<string, unknown>>(me, type);
        if (raw !== null && raw !== undefined) break;
      }
      if (raw === null || raw === undefined) return;
      const cfg = sanitizeChatTheme(raw);
      if (cfg) {
        this.theme.set(cfg);
        this.applyAll();
        this.writeLocal(cfg);
      } else {
        // Explicit empty/invalid content ⇒ the account says "no theme".
        this.theme.set(null);
        this.applyAll();
        try { localStorage.removeItem(CHAT_THEME_STORAGE_KEY); } catch { /* ignore */ }
      }
    } catch { /* fail-soft: keep the boot copy */ }
  }
}
