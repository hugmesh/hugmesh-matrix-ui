// Step definitions for the VN scene & prop sweep (vn-scene-sweep.feature).
// All OFFLINE: the scene manifest is a static app asset, and every picker edit
// applies to the stage OPTIMISTICALLY (onSceneEdited) before the fail-soft
// room-state PUT — so the sweeps prove the real render path with no backend.
// The cross-user round-trip of the same state event stays @cluster in
// vn-voice-call.feature.

import { expect } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { valueRegistry } from './_registry';

/** The 8 pack-authored scene ids in assets/vn/scenes/scenes.json. */
const MANIFEST_SCENES = 8;

When('{string} opens the scene tools', async ({ page }, _username: string) => {
  await page.getByTestId('scene-tools').locator('summary').click();
  await expect(page.getByTestId('scene-picker')).toBeVisible({ timeout: 15_000 });
});

Then('the scene picker offers the {int} manifest scenes plus "No scene"', async ({ page }, count: number) => {
  // The tiles render once the (static-asset) manifest fetch resolves.
  await expect(page.getByTestId('scene-tile')).toHaveCount(count, { timeout: 15_000 });
  await expect(page.getByTestId('scene-none')).toBeVisible();
  expect(count).toBe(MANIFEST_SCENES);
});

Then('selecting each scene in turn swaps the stage background to that scene', async ({ page }) => {
  // SINGLE-AXIS SWEEP: every option of the scene axis exercised end-to-end —
  // tile click → optimistic shared-state update → stage <img src> swap.
  const tiles = page.getByTestId('scene-tile');
  const count = await tiles.count();
  expect(count).toBe(MANIFEST_SCENES);
  for (let i = 0; i < count; i++) {
    const tile = tiles.nth(i);
    const sceneId = (await tile.getAttribute('data-scene-id'))!;
    await tile.click();
    await expect(tile, `${sceneId} checked`).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('scene-bg'), `${sceneId} on stage`).toHaveAttribute(
      'src',
      new RegExp(sceneId),
    );
  }
});

Then('selecting "No scene" leaves the stage with no background image', async ({ page }) => {
  await page.getByTestId('scene-none').click();
  // Fail-soft null scene = the frame's own dark backdrop, no <img> at all.
  await expect(page.getByTestId('scene-bg')).toHaveCount(0);
  await expect(page.getByTestId('scene-none')).toHaveAttribute('aria-checked', 'true');
});

// ───────────────────────── radiogroup keyboard (APG) ─────────────────────────

Then('exactly one scene tile is in the tab order', async ({ page }) => {
  await expect(page.getByTestId('scene-tile')).toHaveCount(MANIFEST_SCENES, { timeout: 15_000 });
  await expect(page.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('[role="radio"][tabindex="-1"]')).toHaveCount(MANIFEST_SCENES);
});

Then('pressing ArrowRight on the checked tile selects and focuses the next scene', async ({ page }) => {
  // Fresh view: "No scene" is checked; the next option is the first manifest scene.
  const none = page.getByTestId('scene-none');
  await none.focus();
  await page.keyboard.press('ArrowRight');
  const first = page.getByTestId('scene-tile').first();
  await expect(first).toHaveAttribute('aria-checked', 'true');
  await expect(first).toBeFocused();
  const sceneId = (await first.getAttribute('data-scene-id'))!;
  await expect(page.getByTestId('scene-bg')).toHaveAttribute('src', new RegExp(sceneId));
});

Then('pressing ArrowLeft wraps the selection back', async ({ page }) => {
  // From the first scene: ArrowLeft → "No scene", ArrowLeft again → WRAPS to
  // the LAST manifest scene.
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('scene-none')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowLeft');
  const lastTile = page.getByTestId('scene-tile').last();
  await expect(lastTile).toHaveAttribute('aria-checked', 'true');
  await expect(lastTile).toBeFocused();
});

// ───────────────────────── props: add / move / remove / cap ─────────────────────────

When('{string} adds the prop {string}', async ({ page }, _username: string, propId: string) => {
  await page.locator(`[data-testid="prop-add"][data-prop-id="${propId}"]`).click();
});

Then(/^the stage shows (\d+) placed props?$/, async ({ page }, count: string) => {
  await expect(page.getByTestId('stage-prop')).toHaveCount(Number(count));
});

When('{string} nudges the placed prop right with the keyboard', async ({ page }, _username: string) => {
  // Remember where the prop sat so the Then can prove REAL movement.
  const before = await page.getByTestId('stage-prop').first().evaluate((el) => (el as HTMLElement).style.left);
  valueRegistry.set('prop:left-before', before);
  const move = page.getByTestId('prop-move').first();
  await move.focus();
  await page.keyboard.press('ArrowRight');
});

Then('the placed prop moved right on the stage', async ({ page }) => {
  const before = parseFloat(valueRegistry.get('prop:left-before') ?? '');
  const after = parseFloat(
    await page.getByTestId('stage-prop').first().evaluate((el) => (el as HTMLElement).style.left),
  );
  expect(after, `moved right of ${before}%`).toBeGreaterThan(before);
});

When('{string} removes the placed prop', async ({ page }, _username: string) => {
  await page.getByTestId('prop-remove').first().click();
});

When('{string} adds {int} props', async ({ page }, _username: string, count: number) => {
  // Programmatic loop over the SAME palette tile — the cap is about COUNT,
  // not variety (the picker happily places duplicates).
  const tile = page.getByTestId('prop-add').first();
  for (let i = 0; i < count; i++) {
    await tile.click();
  }
});

Then('the prop palette is disabled with the announced cap notice', async ({ page }) => {
  // LIMIT MAX_PROPS=32: every Add tile disables and the polite live-region
  // notice names the cap.
  const tiles = page.getByTestId('prop-add');
  const count = await tiles.count();
  for (let i = 0; i < count; i++) {
    await expect(tiles.nth(i)).toBeDisabled();
  }
  const note = page.getByTestId('prop-cap-note');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('aria-live', 'polite');
  await expect(note).toContainText('32');
});

Then('the prop palette is enabled again', async ({ page }) => {
  await expect(page.getByTestId('prop-add').first()).toBeEnabled();
  await expect(page.getByTestId('prop-cap-note')).toHaveCount(0);
});
