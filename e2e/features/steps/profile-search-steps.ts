// Step definitions for the user-settings profile surface (self-service, no
// adversary — coverage is CROSS-USER VISIBILITY of a saved profile change,
// not an ALLOW/DENY privilege gate) and full-text message search
// (membership-gated: only rooms you belong to are searchable).

import { expect } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { SeedUser, matrixIdFor } from '../../tests/helpers/roles';
import { pageFor, valueRegistry } from './_registry';

const PUBLIC_ROOM = process.env.E2E_PUBLIC_ROOM ?? '!e2e-public:tenant-a.test';

/** Unique per-run suffix so a captured value can only come from THIS run. */
function runId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The remembered unique message body for a scenario label (written by
 *  messaging-steps.ts's send steps). */
function msgFor(label: string): string {
  const v = valueRegistry.get(`msg:${label}`);
  if (!v) throw new Error(`No unique message recorded for label "${label}" — send it first.`);
  return v;
}

// ───────────────────────── user settings (profile) ─────────────────────────

When('{string} sets a unique display name in their context', async ({}, username: string) => {
  const page = pageFor(username);
  const unique = `e2e-name-${runId()}`;
  valueRegistry.set(`displayname:${username}`, unique);
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('user-settings')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('input-display-name').fill(unique);
  await page.getByTestId('btn-save-profile').click();
  await expect(page.getByTestId('user-settings-status')).toContainText(/profile saved/i, { timeout: 15_000 });
});

Then(
  "{string} sees {string}'s updated display name in the shared public room member list within {int} seconds",
  async ({ user }, observerName: string, subjectName: string, seconds: number) => {
    const page = pageFor(observerName);
    const targetId = matrixIdFor(user(subjectName) as SeedUser);
    const expected = valueRegistry.get(`displayname:${subjectName}`);
    if (!expected) throw new Error(`No display name recorded for "${subjectName}" — set it first.`);
    await expect
      .poll(
        async () => {
          await page.goto(`/rooms/${PUBLIC_ROOM}/members`, { waitUntil: 'domcontentloaded' });
          try {
            await page.getByTestId('member-list').waitFor({ state: 'visible', timeout: 5_000 });
          } catch {
            return '';
          }
          const row = page.locator(`[data-testid="member-${targetId}"]`);
          if ((await row.count()) === 0) return '';
          return row.innerText();
        },
        {
          timeout: seconds * 1000,
          message: `expected ${observerName} to see ${subjectName}'s updated display name within ${seconds}s`,
        },
      )
      .toContain(expected);
  },
);

// ───────────────────────── full-text search (membership-gated) ─────────────────────────

When('{string} searches for {string} in their context', async ({}, username: string, label: string) => {
  const page = pageFor(username);
  await page.goto('/search', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('search-view')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('input-search').fill(msgFor(label));
  await page.getByTestId('btn-search').click();
});

Then(
  '{string} finds a search result for {string} within {int} seconds',
  async ({}, username: string, label: string, seconds: number) => {
    const page = pageFor(username);
    const term = msgFor(label);
    // Poll: full-text indexing can lag the send by a moment, so re-issue the
    // search each iteration rather than trusting a single snapshot.
    await expect
      .poll(
        async () => {
          await page.getByTestId('input-search').fill(term);
          await page.getByTestId('btn-search').click();
          return page.locator('[data-testid^="search-result-"]').filter({ hasText: term }).count();
        },
        {
          timeout: seconds * 1000,
          message: `expected ${username} to find a search result for "${term}" within ${seconds}s`,
        },
      )
      .toBeGreaterThan(0);
  },
);

Then('{string} finds no search results for {string}', async ({}, username: string, label: string) => {
  const page = pageFor(username);
  const term = msgFor(label);
  // A non-member's search is deterministically denied by the homeserver (it
  // only indexes rooms the caller has joined) — not a timing race, so a
  // single fresh search suffices, exactly like the room-list DENY assertions
  // in messaging-steps.ts.
  await expect(page.getByTestId('search-result-count')).toHaveText('0 results', { timeout: 15_000 });
  await expect(page.locator('[data-testid^="search-result-"]').filter({ hasText: term })).toHaveCount(0);
});
