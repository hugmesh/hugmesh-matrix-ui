// Step definitions for seeding HugSessions + navigating the role-gated
// surfaces. These wrap the helpers in tests/helpers/roles.ts so the BDD
// surface stays a thin presentation layer over the session-seeding mechanism.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import {
  seedSession,
  persistedRoles,
  newE2eContext,
  SESSION_KEY,
  SeedUser,
} from '../../tests/helpers/roles';
import { ctxRegistry, pageRegistry } from './_registry';

// ───────────────────────── single-context seeding ─────────────────────────

Given('{string} has a seeded session', async ({ page, user }, username: string) => {
  await seedSession(page, user(username));
});

When('{string} opens the moderation panel', async ({ page }, _username: string) => {
  // Standalone Matrix dev shell mounts MATRIX_ROUTES at the root, so the
  // dedicated moderation page is reachable at /moderation without the host.
  // (The username is presentation-only — single-context steps act on the
  // shared page whose session the Given seeded.)
  await page.goto('/moderation', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('moderation-panel')).toBeVisible({ timeout: 15_000 });
});

When('{string} opens the room list', async ({ page }, _username: string) => {
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
});

// ─────────────────────── persisted-role assertions ───────────────────────

Then('the persisted roles include {string}', async ({ page }, role: string) => {
  expect(await persistedRoles(page)).toContain(role);
});

Then('the persisted roles do not include {string}', async ({ page }, role: string) => {
  expect(await persistedRoles(page)).not.toContain(role);
});

// ─────────────────────────── per-context seeding ───────────────────────────
// The cross-user isolation scenarios run two identities in two separate
// contexts at once. Each gets its own context (trusting the self-signed cert)
// + page, tracked by username in the registry so later steps address them.

Given(
  '{string} has a seeded session in their own context',
  async ({ browser, user }, username: string) => {
    const u: SeedUser = user(username);
    const ctx = await newE2eContext(browser);
    const page = await ctx.newPage();
    await seedSession(page, u);
    ctxRegistry.set(u.username, ctx);
    pageRegistry.set(u.username, page);
  },
);

function pageFor(username: string) {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No seeded context for "${username}" — seed it first.`);
  return page;
}

When('{string} opens the moderation panel in their context', async ({}, username: string) => {
  const page = pageFor(username);
  await page.goto('/moderation', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('moderation-panel')).toBeVisible({ timeout: 15_000 });
});

Then(
  'the MOD moderation tier is not visible in {string} context',
  async ({}, username: string) => {
    await expect(pageFor(username).getByTestId('tier-mod')).toHaveCount(0);
  },
);

Then('the MOD moderation tier is visible in {string} context', async ({}, username: string) => {
  await expect(pageFor(username).getByTestId('tier-mod')).toBeVisible();
});

Then(
  '{string} matrix id is scoped to tenant {string}',
  async ({}, username: string, tenant: string) => {
    // Post-cutover the browser holds NO Matrix userId/token (the hsproxy injects
    // the server-held token). The principal's tenant scope rides on the
    // non-secret session identity (`label` / `id`, e.g. alice@tenant-a.test), so
    // the cross-tenant isolation invariant is asserted off that.
    const page = pageFor(username);
    const identity = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      try {
        const s = JSON.parse(raw) as { label?: string; id?: string };
        return s.label ?? s.id ?? null;
      } catch {
        return null;
      }
    }, SESSION_KEY);
    expect(identity, `expected a tenant-scoped identity for ${username}`).toBeTruthy();
    expect(identity!.endsWith(`@${tenant}`)).toBeTruthy();
  },
);

Then('the two contexts hold different sessions', async ({}) => {
  const ids = await Promise.all(
    [...pageRegistry.values()].map((p) =>
      p.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY),
    ),
  );
  const unique = new Set(ids.filter((v) => v !== null));
  expect(unique.size).toBe(ids.length);
});
