// Step definitions for the per-user chat theme sweeps (chat-theme.feature).
// All OFFLINE: ChatThemeService applies a theme synchronously to its
// registered roots (data-matrix-* attributes + --hugm-chat-* inline vars) and
// persists to localStorage BEFORE the fail-soft account-data PUT — the
// application contract is fully provable with no homeserver. The oracle is
// always the REAL stamped attribute/var, never a client echo of the click.

import { Locator, Page, expect } from '@playwright/test';
import { When, Then } from '../support/fixtures';

const PRESETS = ['element-dark', 'pastel', 'neon', 'paper', 'midnight-vn'] as const;
const SHAPES = ['rounded', 'square', 'minimal'] as const;
const FONTS = ['system', 'serif', 'rounded', 'mono'] as const;
const DENSITIES = ['cozy', 'compact'] as const;
const BACKGROUNDS = ['none', 'dots', 'grid', 'stars'] as const;

/** The settings page host element — itself a registered chat-theme root. */
const settingsRoot = (page: Page): Locator => page.locator('hug-user-settings');

/** Read the full stamped theme surface off a root element. */
const readTheme = (root: Locator) =>
  root.evaluate((el) => ({
    theme: el.getAttribute('data-matrix-theme'),
    bubbles: el.getAttribute('data-matrix-bubbles'),
    font: el.getAttribute('data-matrix-font'),
    density: el.getAttribute('data-matrix-density'),
    chatbg: el.getAttribute('data-matrix-chatbg'),
    accent: (el as HTMLElement).style.getPropertyValue('--hugm-chat-accent'),
    bubbleMine: (el as HTMLElement).style.getPropertyValue('--hugm-chat-bubble-mine'),
    bubbleTheirs: (el as HTMLElement).style.getPropertyValue('--hugm-chat-bubble-theirs'),
  }));

/** Drive a color <input> the way a picker does: input (preview) + change (commit). */
const setColor = async (input: Locator, hex: string): Promise<void> => {
  await input.evaluate((el, v) => {
    const i = el as HTMLInputElement;
    i.value = v;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, hex);
};

When('{string} opens the user settings', async ({ page }, _username: string) => {
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('user-settings')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-appearance')).toBeVisible();
});

// ───────────────────────── single-axis sweeps ─────────────────────────

Then(
  'applying each theme preset in turn stamps its data-matrix-theme on the settings root',
  async ({ page }) => {
    const root = settingsRoot(page);
    for (const preset of PRESETS) {
      const swatch = page.getByTestId(`theme-preset-${preset}`);
      await swatch.click();
      await expect(root, preset).toHaveAttribute('data-matrix-theme', preset);
      // The pressed state follows the applied preset (a11y toggle contract).
      await expect(swatch, `${preset} pressed`).toHaveAttribute('aria-pressed', 'true');
    }
  },
);

Then('choosing each bubble shape in turn stamps data-matrix-bubbles', async ({ page }) => {
  const root = settingsRoot(page);
  for (const shape of SHAPES) {
    await page.getByTestId('select-theme-shape').selectOption(shape);
    await expect(root, shape).toHaveAttribute('data-matrix-bubbles', shape);
  }
});

Then('choosing each chat font in turn stamps data-matrix-font', async ({ page }) => {
  const root = settingsRoot(page);
  for (const font of FONTS) {
    await page.getByTestId('select-theme-font').selectOption(font);
    await expect(root, font).toHaveAttribute('data-matrix-font', font);
  }
});

Then('choosing each density in turn stamps data-matrix-density', async ({ page }) => {
  const root = settingsRoot(page);
  for (const density of DENSITIES) {
    await page.getByTestId('select-theme-density').selectOption(density);
    await expect(root, density).toHaveAttribute('data-matrix-density', density);
  }
});

Then('choosing each chat background in turn stamps data-matrix-chatbg', async ({ page }) => {
  const root = settingsRoot(page);
  for (const bg of BACKGROUNDS) {
    await page.getByTestId('select-theme-chatbg').selectOption(bg);
    await expect(root, bg).toHaveAttribute('data-matrix-chatbg', bg);
  }
});

// ───────────────────────── seeded random multi-axis sweep ─────────────────────────

Then(
  'applying {int} seeded random theme combinations stamps the matching attributes and custom properties each time',
  async ({ page }, combos: number) => {
    // mulberry32 with a FIXED seed: the same {combos} mixed configs every run,
    // so a failure is reproducible, never a flake.
    let s = 0x5EED;
    const rnd = (): number => {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
    const hex = (): string => `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}`;

    const root = settingsRoot(page);
    for (let i = 0; i < combos; i++) {
      const cfg = {
        preset: pick(PRESETS),
        bubbleShape: pick(SHAPES),
        font: pick(FONTS),
        density: pick(DENSITIES),
        chatBackground: pick(BACKGROUNDS),
        accent: hex(),
        bubbleMine: hex(),
        bubbleTheirs: hex(),
      };
      const label = `combo ${i}: ${JSON.stringify(cfg)}`;

      // Preset first (it re-seeds the colors), then the knobs, colors LAST.
      await page.getByTestId(`theme-preset-${cfg.preset}`).click();
      await page.getByTestId('select-theme-shape').selectOption(cfg.bubbleShape);
      await page.getByTestId('select-theme-font').selectOption(cfg.font);
      await page.getByTestId('select-theme-density').selectOption(cfg.density);
      await page.getByTestId('select-theme-chatbg').selectOption(cfg.chatBackground);
      await setColor(page.getByTestId('input-theme-accent'), cfg.accent);
      await setColor(page.getByTestId('input-theme-bubble-mine'), cfg.bubbleMine);
      await setColor(page.getByTestId('input-theme-bubble-theirs'), cfg.bubbleTheirs);

      await expect
        .poll(() => readTheme(root), { message: label, timeout: 5_000 })
        .toEqual({
          theme: cfg.preset,
          bubbles: cfg.bubbleShape,
          font: cfg.font,
          density: cfg.density,
          chatbg: cfg.chatBackground,
          accent: cfg.accent,
          // 'minimal' drops the inline fills so the SCSS transparent rule wins.
          bubbleMine: cfg.bubbleShape === 'minimal' ? '' : cfg.bubbleMine,
          bubbleTheirs: cfg.bubbleShape === 'minimal' ? '' : cfg.bubbleTheirs,
        });
    }
  },
);

// ───────────────────────── cross-surface scoping + reset ─────────────────────────

When('{string} applies the {string} theme preset', async ({ page }, _username: string, preset: string) => {
  await page.getByTestId(`theme-preset-${preset}`).click();
  await expect(settingsRoot(page)).toHaveAttribute('data-matrix-theme', preset);
});

Then('the room view root carries data-matrix-theme {string}', async ({ page }, preset: string) => {
  // hug-room-view is itself a registered theme root: the localStorage boot
  // copy applies on registration, so the theme saved in /settings must be
  // stamped here too (and ONLY on remote roots — see the body assertion).
  await expect(page.locator('hug-room-view')).toHaveAttribute('data-matrix-theme', preset, {
    timeout: 15_000,
  });
});

Then('the document body carries no data-matrix-theme', async ({ page }) => {
  await expect(page.locator('body')).not.toHaveAttribute('data-matrix-theme');
  await expect(page.locator('html')).not.toHaveAttribute('data-matrix-theme');
});

When('{string} resets the chat appearance', async ({ page }, _username: string) => {
  await page.getByTestId('btn-theme-reset').click();
});

Then('the settings root carries no data-matrix-theme', async ({ page }) => {
  await expect(settingsRoot(page)).not.toHaveAttribute('data-matrix-theme');
});
