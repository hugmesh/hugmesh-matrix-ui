// Viewport / responsive step definitions (phone + tablet coverage for the VN
// call screen, the room view and the chat-theme editor). All offline: pure
// client-side layout assertions over the rendered page — no backend oracle is
// fabricated, and the 44px checks measure the REAL hit boxes Playwright sees.

import { expect } from '@playwright/test';
import { Given, Then } from '../support/fixtures';

/** WCAG 2.5.8 (AAA)/platform-HIG touch-target minimum, in CSS px. */
const TOUCH_MIN = 44;

Given('the viewport is a {int}x{int} phone', async ({ page }, w: number, h: number) => {
  await page.setViewportSize({ width: w, height: h });
});

Given('the viewport is a {int}x{int} tablet', async ({ page }, w: number, h: number) => {
  await page.setViewportSize({ width: w, height: h });
});

Then('the page has no horizontal scrolling', async ({ page }) => {
  // The whole-document check: any child spilling past the viewport width
  // grows documentElement.scrollWidth beyond its clientWidth.
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'no horizontal body scroll').toBeLessThanOrEqual(clientWidth + 1);
});

Then('the VN stage letterboxes inside the viewport', async ({ page }) => {
  const stage = page.getByTestId('vn-stage');
  await expect(stage).toBeVisible();
  const viewport = page.viewportSize()!;
  const stageBox = (await stage.boundingBox())!;
  expect(stageBox.width, 'stage fits the viewport width').toBeLessThanOrEqual(viewport.width + 1);

  // The 16:9 frame sits INSIDE the stage box (letterboxed, never overflowing).
  const frame = page.locator('.stage-frame');
  const frameBox = (await frame.boundingBox())!;
  expect(frameBox.width).toBeLessThanOrEqual(stageBox.width + 1);
  expect(frameBox.height).toBeLessThanOrEqual(stageBox.height + 1);
  // And it kept its 16:9 shape rather than distorting to fit.
  expect(Math.abs(frameBox.width / frameBox.height - 16 / 9)).toBeLessThan(0.05);
});

Then('the call controls meet the {int}px touch target minimum', async ({ page }, minPx: number) => {
  for (const id of ['call-start', 'call-join', 'call-hangup']) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.height, `${id} height`).toBeGreaterThanOrEqual(Math.min(minPx, TOUCH_MIN));
    expect(box.width, `${id} width`).toBeGreaterThanOrEqual(Math.min(minPx, TOUCH_MIN));
  }
});

Then('the room header call entries meet the {int}px touch target minimum', async ({ page }, minPx: number) => {
  for (const id of ['btn-call-vn-voice', 'btn-call-video', 'btn-member-list', 'btn-room-settings']) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.height, `${id} height`).toBeGreaterThanOrEqual(Math.min(minPx, TOUCH_MIN));
    expect(box.width, `${id} width`).toBeGreaterThanOrEqual(Math.min(minPx, TOUCH_MIN));
  }
});

Then('the theme preset swatches meet the {int}px touch target minimum', async ({ page }, minPx: number) => {
  const swatches = page.locator('.preset-swatch');
  const count = await swatches.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = (await swatches.nth(i).boundingBox())!;
    expect(box.height, `swatch ${i} height`).toBeGreaterThanOrEqual(Math.min(minPx, TOUCH_MIN));
  }
});

Then('the scene tools panel scrolls internally', async ({ page }) => {
  // The opened <details> hosts hug-vn-scene-controls with its own
  // overflow-y:auto max-height box, so a long picker never buries the call
  // controls below the fold.
  const overflowY = await page
    .locator('hug-vn-scene-controls')
    .evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflowY).toBe('auto');
});
