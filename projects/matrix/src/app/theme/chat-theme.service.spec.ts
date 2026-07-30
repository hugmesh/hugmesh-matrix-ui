import { TestBed } from '@angular/core/testing';
import { MatrixService } from '../matrix.service';
import {
  CHAT_THEME_ACCOUNT_DATA_TYPE,
  CHAT_THEME_PRESETS,
  CHAT_THEME_STORAGE_KEY,
  ChatThemeConfig,
  ChatThemeService,
  defaultChatTheme,
  isHexColor,
  sanitizeChatTheme,
} from './chat-theme.service';

class MatrixServiceStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  getAccountData = jasmine.createSpy('getAccountData').and.resolveTo(null);
  setAccountData = jasmine.createSpy('setAccountData').and.resolveTo(undefined);
}

/** Let the fire-and-forget account-data load settle (whoami + getAccountData). */
const settle = () => new Promise((res) => setTimeout(res));

describe('ChatThemeService', () => {
  let service: ChatThemeService;
  let matrix: MatrixServiceStub;
  let root: HTMLElement;

  const pastel = (): ChatThemeConfig => defaultChatTheme('pastel');

  beforeEach(() => {
    localStorage.clear();
    matrix = new MatrixServiceStub();
    TestBed.configureTestingModule({
      providers: [{ provide: MatrixService, useValue: matrix }],
    });
    service = TestBed.inject(ChatThemeService);
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    localStorage.clear();
  });

  // ───────── Validation ─────────

  it('isHexColor accepts only strict #rrggbb', () => {
    expect(isHexColor('#a1B2c3')).toBeTrue();
    expect(isHexColor('#abc')).toBeFalse(); // no 3-digit shorthand
    expect(isHexColor('#aabbccdd')).toBeFalse(); // no alpha
    expect(isHexColor('red')).toBeFalse();
    expect(isHexColor('#ggg000')).toBeFalse();
    expect(isHexColor('#aabbcc;background:url(x)')).toBeFalse();
    expect(isHexColor(112233)).toBeFalse();
    expect(isHexColor(null)).toBeFalse();
  });

  it('sanitizeChatTheme returns null for non-themes (absent preset = reset marker)', () => {
    expect(sanitizeChatTheme(null)).toBeNull();
    expect(sanitizeChatTheme({})).toBeNull();
    expect(sanitizeChatTheme([])).toBeNull();
    expect(sanitizeChatTheme('pastel')).toBeNull();
    expect(sanitizeChatTheme({ preset: 'not-a-preset' })).toBeNull();
  });

  it('sanitizeChatTheme falls back field-wise to the preset defaults on bad values', () => {
    const cfg = sanitizeChatTheme({
      preset: 'neon',
      accent: 'javascript:alert(1)',
      bubbleShape: 'blob',
      bubbleMine: '#12345', // invalid length
      bubbleTheirs: '#AABBCC',
      font: 'wingdings',
      density: 'ultra',
      chatBackground: 'lava',
    })!;
    const neon = CHAT_THEME_PRESETS.find((p) => p.id === 'neon')!;
    expect(cfg.preset).toBe('neon');
    expect(cfg.accent).toBe(neon.accent);
    expect(cfg.bubbleShape).toBe('rounded');
    expect(cfg.bubbleMine).toBe(neon.bubbleMine);
    expect(cfg.bubbleTheirs).toBe('#aabbcc'); // valid hex normalised to lowercase
    expect(cfg.font).toBe('system');
    expect(cfg.density).toBe('cozy');
    expect(cfg.chatBackground).toBe('none');
  });

  // ───────── Apply mechanism ─────────

  it('setTheme stamps the data-matrix-* attributes and inline --hugm-chat-* vars on registered roots', async () => {
    service.registerRoot(root);
    await service.setTheme({ ...pastel(), accent: '#112233', bubbleShape: 'square', font: 'mono', density: 'compact', chatBackground: 'dots' });
    expect(root.getAttribute('data-matrix-theme')).toBe('pastel');
    expect(root.getAttribute('data-matrix-bubbles')).toBe('square');
    expect(root.getAttribute('data-matrix-font')).toBe('mono');
    expect(root.getAttribute('data-matrix-density')).toBe('compact');
    expect(root.getAttribute('data-matrix-chatbg')).toBe('dots');
    expect(root.style.getPropertyValue('--hugm-chat-accent')).toBe('#112233');
    expect(root.style.getPropertyValue('--hugm-chat-bubble-mine')).toBe(pastel().bubbleMine);
    expect(root.style.getPropertyValue('--hugm-chat-bubble-theirs')).toBe(pastel().bubbleTheirs);
  });

  it('LEAK TEST: attributes land on the registered remote root, never on <body> or <html>', async () => {
    service.registerRoot(root);
    await service.setTheme(pastel());
    expect(root.hasAttribute('data-matrix-theme')).toBeTrue();
    for (const el of [document.body, document.documentElement]) {
      expect(el.hasAttribute('data-matrix-theme')).withContext(el.tagName).toBeFalse();
      expect(el.hasAttribute('data-matrix-bubbles')).withContext(el.tagName).toBeFalse();
      expect(el.hasAttribute('data-matrix-font')).withContext(el.tagName).toBeFalse();
      expect(el.hasAttribute('data-matrix-density')).withContext(el.tagName).toBeFalse();
      expect(el.hasAttribute('data-matrix-chatbg')).withContext(el.tagName).toBeFalse();
      expect(el.style.getPropertyValue('--hugm-chat-accent')).withContext(el.tagName).toBe('');
    }
  });

  it('never lets an unvalidated string reach an inline style (defence in depth)', async () => {
    service.registerRoot(root);
    const evil = { ...pastel(), accent: '#fff;background:url(https://evil.example/x)' };
    await service.setTheme(evil as ChatThemeConfig);
    const styleAttr = root.getAttribute('style') ?? '';
    expect(styleAttr).not.toContain('url(');
    expect(styleAttr).not.toContain('evil.example');
    // The invalid accent fell back to the preset default.
    expect(root.style.getPropertyValue('--hugm-chat-accent')).toBe(pastel().accent);
  });

  it('minimal bubble shape drops the inline fill overrides so the SCSS transparent rule wins', async () => {
    service.registerRoot(root);
    await service.setTheme(pastel());
    expect(root.style.getPropertyValue('--hugm-chat-bubble-mine')).not.toBe('');
    await service.setTheme({ ...pastel(), bubbleShape: 'minimal' });
    expect(root.getAttribute('data-matrix-bubbles')).toBe('minimal');
    expect(root.style.getPropertyValue('--hugm-chat-bubble-mine')).toBe('');
    expect(root.style.getPropertyValue('--hugm-chat-bubble-theirs')).toBe('');
  });

  it('applies the current theme to roots registered AFTER it was set', async () => {
    service.registerRoot(root);
    await service.setTheme(pastel());
    const late = document.createElement('div');
    service.registerRoot(late);
    expect(late.getAttribute('data-matrix-theme')).toBe('pastel');
  });

  // ───────── Persistence ─────────

  it('setTheme persists to localStorage AND the systems.hugmesh.chat_theme account data', async () => {
    service.registerRoot(root);
    const cfg = pastel();
    await service.setTheme(cfg);
    expect(JSON.parse(localStorage.getItem(CHAT_THEME_STORAGE_KEY)!)).toEqual(cfg);
    expect(matrix.setAccountData).toHaveBeenCalledWith('@me:test', CHAT_THEME_ACCOUNT_DATA_TYPE, cfg);
  });

  it('boot: the localStorage copy applies SYNCHRONOUSLY on first root registration', () => {
    localStorage.setItem(CHAT_THEME_STORAGE_KEY, JSON.stringify(pastel()));
    service.registerRoot(root);
    // No awaits: the theme must be visible before any fetch resolves.
    expect(root.getAttribute('data-matrix-theme')).toBe('pastel');
    expect(service.theme()?.preset).toBe('pastel');
  });

  it('the account-data copy wins over the localStorage boot copy once it resolves', async () => {
    localStorage.setItem(CHAT_THEME_STORAGE_KEY, JSON.stringify(pastel()));
    matrix.getAccountData.and.resolveTo(defaultChatTheme('neon'));
    service.registerRoot(root);
    expect(root.getAttribute('data-matrix-theme')).toBe('pastel'); // instant boot copy
    await settle();
    expect(root.getAttribute('data-matrix-theme')).toBe('neon');
    expect(matrix.getAccountData).toHaveBeenCalledWith('@me:test', CHAT_THEME_ACCOUNT_DATA_TYPE);
    // localStorage refreshed to the authoritative copy.
    expect(JSON.parse(localStorage.getItem(CHAT_THEME_STORAGE_KEY)!).preset).toBe('neon');
  });

  it('an EMPTY account-data object (reset on another device) clears the boot copy', async () => {
    localStorage.setItem(CHAT_THEME_STORAGE_KEY, JSON.stringify(pastel()));
    matrix.getAccountData.and.resolveTo({});
    service.registerRoot(root);
    await settle();
    expect(root.hasAttribute('data-matrix-theme')).toBeFalse();
    expect(service.theme()).toBeNull();
    expect(localStorage.getItem(CHAT_THEME_STORAGE_KEY)).toBeNull();
  });

  it('a failed account-data fetch keeps the localStorage theme (fail-soft)', async () => {
    localStorage.setItem(CHAT_THEME_STORAGE_KEY, JSON.stringify(pastel()));
    matrix.getAccountData.and.rejectWith(new Error('boom'));
    service.registerRoot(root);
    await settle();
    expect(root.getAttribute('data-matrix-theme')).toBe('pastel');
  });

  it('a failed account-data WRITE still applies + saves locally (fail-soft)', async () => {
    matrix.setAccountData.and.rejectWith(new Error('boom'));
    service.registerRoot(root);
    await expectAsync(service.setTheme(pastel())).toBeResolved();
    expect(root.getAttribute('data-matrix-theme')).toBe('pastel');
    expect(localStorage.getItem(CHAT_THEME_STORAGE_KEY)).not.toBeNull();
  });

  it('reset clears attributes + vars, drops localStorage, and writes the {} reset marker', async () => {
    service.registerRoot(root);
    await service.setTheme(pastel());
    await service.reset();
    expect(service.theme()).toBeNull();
    expect(root.hasAttribute('data-matrix-theme')).toBeFalse();
    expect(root.hasAttribute('data-matrix-bubbles')).toBeFalse();
    expect(root.style.getPropertyValue('--hugm-chat-accent')).toBe('');
    expect(localStorage.getItem(CHAT_THEME_STORAGE_KEY)).toBeNull();
    expect(matrix.setAccountData).toHaveBeenCalledWith('@me:test', CHAT_THEME_ACCOUNT_DATA_TYPE, {});
  });

  // ───────── Preview / unregister ─────────

  it('preview applies without persisting anywhere', () => {
    service.registerRoot(root);
    service.preview({ ...pastel(), accent: '#445566' });
    expect(root.style.getPropertyValue('--hugm-chat-accent')).toBe('#445566');
    expect(localStorage.getItem(CHAT_THEME_STORAGE_KEY)).toBeNull();
    expect(matrix.setAccountData).not.toHaveBeenCalled();
  });

  it('unregisterRoot stops future applications to that element', async () => {
    service.registerRoot(root);
    await service.setTheme(pastel());
    service.unregisterRoot(root);
    await service.setTheme(defaultChatTheme('neon'));
    expect(root.getAttribute('data-matrix-theme')).toBe('pastel'); // untouched since unregister
  });

  // ───────── Combination coverage ─────────
  // "All combinations" made tractable: exhaustive SINGLE-AXIS sweeps (every
  // option of every knob applied at least once), then a SEEDED pseudo-random
  // multi-axis sweep (fixed seed ⇒ the same 24 mixed configs every run) whose
  // oracle is the full attrs+vars application contract per config.

  describe('combination coverage', () => {
    const PRESETS = ['element-dark', 'pastel', 'neon', 'paper', 'midnight-vn'] as const;
    const SHAPES = ['rounded', 'square', 'minimal'] as const;
    const FONTS = ['system', 'serif', 'rounded', 'mono'] as const;
    const DENSITIES = ['cozy', 'compact'] as const;
    const BACKGROUNDS = ['none', 'dots', 'grid', 'stars'] as const;

    /** Assert the FULL application contract for one config on the root. */
    const expectApplied = (cfg: ChatThemeConfig, label: string): void => {
      expect(root.getAttribute('data-matrix-theme')).withContext(label).toBe(cfg.preset);
      expect(root.getAttribute('data-matrix-bubbles')).withContext(label).toBe(cfg.bubbleShape);
      expect(root.getAttribute('data-matrix-font')).withContext(label).toBe(cfg.font);
      expect(root.getAttribute('data-matrix-density')).withContext(label).toBe(cfg.density);
      expect(root.getAttribute('data-matrix-chatbg')).withContext(label).toBe(cfg.chatBackground);
      expect(root.style.getPropertyValue('--hugm-chat-accent')).withContext(label).toBe(cfg.accent);
      if (cfg.bubbleShape === 'minimal') {
        // Minimal drops the inline fills so the SCSS transparent override wins.
        expect(root.style.getPropertyValue('--hugm-chat-bubble-mine')).withContext(label).toBe('');
        expect(root.style.getPropertyValue('--hugm-chat-bubble-theirs')).withContext(label).toBe('');
      } else {
        expect(root.style.getPropertyValue('--hugm-chat-bubble-mine')).withContext(label).toBe(cfg.bubbleMine);
        expect(root.style.getPropertyValue('--hugm-chat-bubble-theirs')).withContext(label).toBe(cfg.bubbleTheirs);
      }
    };

    it('SINGLE-AXIS: every preset applies (and seeds its own canonical colors)', () => {
      service.registerRoot(root);
      for (const preset of PRESETS) {
        const cfg = defaultChatTheme(preset);
        service.preview(cfg);
        expectApplied(cfg, `preset=${preset}`);
        const canon = CHAT_THEME_PRESETS.find((p) => p.id === preset)!;
        expect(cfg.accent).withContext(preset).toBe(canon.accent);
      }
    });

    it('SINGLE-AXIS: every bubbleShape / font / density / chatBackground value applies', () => {
      service.registerRoot(root);
      for (const bubbleShape of SHAPES) {
        service.preview({ ...defaultChatTheme(), bubbleShape });
        expect(root.getAttribute('data-matrix-bubbles')).toBe(bubbleShape);
      }
      for (const font of FONTS) {
        service.preview({ ...defaultChatTheme(), font });
        expect(root.getAttribute('data-matrix-font')).toBe(font);
      }
      for (const density of DENSITIES) {
        service.preview({ ...defaultChatTheme(), density });
        expect(root.getAttribute('data-matrix-density')).toBe(density);
      }
      for (const chatBackground of BACKGROUNDS) {
        service.preview({ ...defaultChatTheme(), chatBackground });
        expect(root.getAttribute('data-matrix-chatbg')).toBe(chatBackground);
      }
    });

    it('BOUNDARY COMBOS: first/first/…, last/last/…, and minimal-with-colors all hold the contract', () => {
      service.registerRoot(root);
      const first: ChatThemeConfig = { ...defaultChatTheme(PRESETS[0]), bubbleShape: SHAPES[0], font: FONTS[0], density: DENSITIES[0], chatBackground: BACKGROUNDS[0] };
      const last: ChatThemeConfig = { ...defaultChatTheme(PRESETS[PRESETS.length - 1]), bubbleShape: SHAPES[SHAPES.length - 1], font: FONTS[FONTS.length - 1], density: DENSITIES[DENSITIES.length - 1], chatBackground: BACKGROUNDS[BACKGROUNDS.length - 1] };
      for (const [cfg, label] of [[first, 'first-of-each'], [last, 'last-of-each']] as const) {
        service.preview(cfg);
        expectApplied(cfg, label);
      }
    });

    it('SEEDED RANDOM SWEEP: 24 deterministic mixed configs apply + round-trip sanitize losslessly', () => {
      service.registerRoot(root);
      // mulberry32, fixed seed — deterministic across runs by construction.
      let s = 0xC0FFEE;
      const rnd = (): number => {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
      const hex = (): string => `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}`;

      for (let i = 0; i < 24; i++) {
        const cfg: ChatThemeConfig = {
          preset: pick(PRESETS),
          accent: hex(),
          bubbleShape: pick(SHAPES),
          bubbleMine: hex(),
          bubbleTheirs: hex(),
          font: pick(FONTS),
          density: pick(DENSITIES),
          chatBackground: pick(BACKGROUNDS),
        };
        // Random-but-valid configs must survive sanitize verbatim…
        expect(sanitizeChatTheme(cfg)).withContext(`combo ${i}`).toEqual(cfg);
        // …and apply their exact attrs + vars.
        service.preview(cfg);
        expectApplied(cfg, `combo ${i}: ${JSON.stringify(cfg)}`);
      }
    });
  });
});
