// Step definitions for the @cluster scenarios — the ones that need a live
// homeserver / BFF / federated host wiring beyond a seeded localStorage
// session. They are FILTERED OUT of the offline `bddgen` + `--list` run by the
// `not @cluster` tag expression in playwright.config.ts, but the step
// definitions are still authored so the suite is complete and ready to enable
// against a real E2E_BASE_URL.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { seedSession } from '../../tests/helpers/roles';
import { pageRegistry } from './_registry';

// ─────────────── role-actions disclosure a11y (member list) ───────────────

When('{string} opens a room member list', async ({ page, user }, username: string) => {
  await seedSession(page, user(username));
  // A member list needs a real room + joined members from the homeserver.
  await page.goto('/rooms/!e2e-room:tenant-a.test/members', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('member-list')).toBeVisible({ timeout: 15_000 });
});

When("{string} opens a member's moderation menu", async ({ page }, _username: string) => {
  // The first member row's role-actions trigger (data-testid role-actions-trigger).
  await page.getByTestId('role-actions-trigger').first().click();
  await expect(page.getByTestId('role-actions-menu').first()).toBeVisible();
});

When('{string} presses Escape', async ({ page }, _username: string) => {
  await page.keyboard.press('Escape');
});

Then('focus returns to the moderation menu trigger', async ({ page }) => {
  // role-actions.component.ts focusTrigger() restores focus to the trigger on
  // Escape (the disclosure-pattern contract).
  const trigger = page.getByTestId('role-actions-trigger').first();
  await expect(trigger).toBeFocused();
});

// ─────────────── domain-lock federation greying (room list) ───────────────

Then('the join-by-alias help text explains local-only restriction', async ({ page }) => {
  // The room-list join help (data-testid rl-join-help) is augmented for a
  // domain-locked user with an explicit local-only WHY-note
  // (rl-join-lock-note) — visible AND naming the domain lock, not just any
  // help copy.
  await expect(page.getByTestId('rl-join-help')).toBeVisible();
  const note = page.getByTestId('rl-join-lock-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText(/domain-locked/i);
});

Then('entering a cross-domain alias is rejected as a federation target', async ({ page }) => {
  await page.getByTestId('input-join-alias').fill('#room:evil.test');
  await page.getByTestId('btn-join-alias').click();
  // STRENGTHENED: the rejection must be EXPLICIT — an announced role=alert
  // notice naming the domain lock (rl-join-error), and the federation target
  // must never land in the joined room list. Merely "the input is still
  // visible" proves nothing.
  const err = page.getByTestId('rl-join-error');
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toContainText(/domain-locked/i);
  await expect(page.locator('[data-testid^="room-item-"][data-testid*="evil.test"]')).toHaveCount(0);
});

// ─────────────── cross-tenant room enumeration ───────────────

When('{string} requests the joined rooms in their context', async ({}, username: string) => {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No seeded context for "${username}".`);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
});

Then('no tenant-a room is listed for {string}', async ({}, username: string) => {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No seeded context for "${username}".`);
  // A tenant-b identity's joined-rooms must contain no room whose id is scoped
  // to tenant-a's homeserver.
  await expect(page.locator('[data-testid^="room-item-"][data-testid*="tenant-a.test"]')).toHaveCount(0);
});
