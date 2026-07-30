// Step definitions for the moderation panel + role-actions tier matrix
// (moderation-panel.component.html, role-actions.component.html). Assertions
// key off the real data-testid contract: moderation-panel, mod-panel-signedout,
// tier-user, tier-mod, tier-admin, ra-block-user, ra-mod-block, admin-stub-note.

import { expect } from '@playwright/test';
import { Then } from '../support/fixtures';

// ─────────────────────────── panel-level ───────────────────────────

Then('the moderation panel renders', async ({ page }) => {
  await expect(page.getByTestId('moderation-panel')).toBeVisible();
});

Then('the signed-out prompt is shown', async ({ page }) => {
  await expect(page.getByTestId('mod-panel-signedout')).toBeVisible();
});

Then('the signed-out prompt is not shown', async ({ page }) => {
  await expect(page.getByTestId('mod-panel-signedout')).toHaveCount(0);
});

Then('no moderation action tier is visible', async ({ page }) => {
  // Role-absent session → moderation-panel hides the embedded role-actions
  // entirely (the *ngIf="session.isUser()" gate), so NO tier renders.
  await expect(page.getByTestId('tier-user')).toHaveCount(0);
  await expect(page.getByTestId('tier-mod')).toHaveCount(0);
  await expect(page.getByTestId('tier-admin')).toHaveCount(0);
});

// ─────────────────────────── tier visibility ───────────────────────────

Then('the USER moderation tier is visible', async ({ page }) => {
  await expect(page.getByTestId('tier-user')).toBeVisible();
});

Then('the MOD moderation tier is visible', async ({ page }) => {
  await expect(page.getByTestId('tier-mod')).toBeVisible();
});

Then('the MOD moderation tier is not visible', async ({ page }) => {
  await expect(page.getByTestId('tier-mod')).toHaveCount(0);
});

Then('the ADMIN moderation tier is not visible', async ({ page }) => {
  // tier-admin only renders inside a queue row that is admin-gated; with an
  // empty queue + non-admin role it must be wholly absent.
  await expect(page.getByTestId('tier-admin')).toHaveCount(0);
});

// ─────────────────────────── per-tier controls (ALLOW) ───────────────────────────

Then('the block-or-mute control is available', async ({ page }) => {
  const btn = page.getByTestId('ra-block-user');
  await expect(btn).toBeVisible();
  await expect(btn).toBeEnabled();
});

Then('the server-wide block control is available', async ({ page }) => {
  const btn = page.getByTestId('ra-mod-block');
  await expect(btn).toBeVisible();
  await expect(btn).toBeEnabled();
});

Then('the moderation queue shows the empty-state message', async ({ page }) => {
  // No BFF in the cluster-free run → the queue loads empty and the role-actions
  // template renders the `No queued requests loaded.` status line.
  await expect(page.getByTestId('tier-mod').getByText('No queued requests loaded.')).toBeVisible();
});

// ─────────────────── ADMIN decide tier (real approve/deny) ───────────────────

Then(
  'the admin decide help note explains the kill-switch override and audit trail',
  async ({ page }) => {
    // The admin tier stopped being a stub when Approve/Deny were wired to
    // admin-bff-api (role-actions #36); the note's copy now honestly describes
    // the kill-switch-override + audit-trail semantics of those real verbs.
    // (The old oracle asserted the pre-#36 "decisions happen in
    // hugmesh-admin-ui" stub text and had drifted from the app.)
    const note = page.getByTestId('admin-stub-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('kill-switch override');
    await expect(note).toContainText('audit trail');
  },
);

// ─────────────────── SUPERADMIN folds into the ADMIN tier ───────────────────

Then('no moderation surface beyond the admin tier is rendered', async ({ page }) => {
  // VERIFIED against SessionService: there is NO isSuperadmin accessor and no
  // superadmin-only surface in this UI — a superadmin session must render
  // EXACTLY the admin tier set. Enumerate every rendered tier testid and
  // assert nothing outside {tier-user, tier-mod, tier-admin} exists (so a
  // future tier-superadmin regression fails loudly here).
  const tiers = await page.locator('[data-testid^="tier-"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-testid')),
  );
  const allowed = new Set(['tier-user', 'tier-mod', 'tier-admin']);
  for (const t of tiers) {
    expect(allowed.has(t ?? ''), `unexpected moderation tier surface: ${t}`).toBeTruthy();
  }
});
