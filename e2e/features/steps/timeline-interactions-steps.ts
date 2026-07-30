// Step definitions for timeline-row interactions not covered by
// messaging-steps.ts: threaded replies, ownership-gated message edits, and
// the live typing indicator. Shares the shared-public-room convention and the
// `msg:<label>` valueRegistry keys messaging-steps.ts's send steps populate,
// so scenarios freely mix steps from both files.

import { expect } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { SeedUser, matrixIdFor } from '../../tests/helpers/roles';
import { expectMessageInTimeline } from '../../tests/helpers/timeline';
import { pageFor, valueRegistry } from './_registry';

const PUBLIC_ROOM = process.env.E2E_PUBLIC_ROOM ?? '!e2e-public:tenant-a.test';

/** Unique per-send suffix so a captured value can only come from THIS run. */
function runId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The remembered unique body for a scenario message label (written by
 *  messaging-steps.ts's send steps, or by the edit/thread steps below). */
function msgFor(label: string): string {
  const v = valueRegistry.get(`msg:${label}`);
  if (!v) throw new Error(`No unique message recorded for label "${label}" — send it first.`);
  return v;
}

/** Open the sync-driven chat shell on a room (the '' route runs the /sync
 *  long-poll loop that feeds the live timeline — deep room routes do not). */
async function openChatShell(page: import('@playwright/test').Page, roomId: string): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(roomId)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('matrix-log')).toBeVisible({ timeout: 15_000 });
}

// ───────────────────────── threads ─────────────────────────

When(
  '{string} starts a thread on the message {string} with reply {string}',
  async ({}, username: string, rootLabel: string, replyLabel: string) => {
    const page = pageFor(username);
    const rootBody = msgFor(rootLabel);
    const row = page.locator('[data-testid="matrix-log"] li.event').filter({ hasText: rootBody }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Capture the REAL root event id off the rendered row (honest oracle) —
    // never a fabricated id.
    const testid = await row.getAttribute('data-testid');
    const rootEventId = testid!.replace('event-', '');
    valueRegistry.set('thread:root-event-id', rootEventId);
    const unique = `${replyLabel}-${runId()}`;
    valueRegistry.set(`msg:${replyLabel}`, unique);
    await row.locator('[data-testid^="btn-thread-"]').click();
    // Composer entered thread mode — the placeholder swap is a real UI-state
    // oracle (composer.component.ts placeholder getter), not a fixed sleep.
    await expect(page.getByTestId('matrix-input')).toHaveAttribute('placeholder', 'Reply in thread…', {
      timeout: 5_000,
    });
    await page.getByTestId('matrix-input').fill(unique);
    await page.getByTestId('matrix-send').click();
    // The sender's own echo proves the reply was actually sent before any
    // cross-user assertion runs against it. Thread replies also fall back
    // into the main timeline (is_falling_back) per this client's
    // sendThreadMessage, so the shared matrix-log echo helper applies as-is.
    await expectMessageInTimeline(page, unique, 30);
  },
);

Then(
  'the thread reply {string} appears in {string} thread view within {int} seconds',
  async ({}, replyLabel: string, username: string, seconds: number) => {
    const page = pageFor(username);
    const rootEventId = valueRegistry.get('thread:root-event-id');
    if (!rootEventId) throw new Error('No captured thread root event id — start the thread first.');
    const body = msgFor(replyLabel);
    await expect
      .poll(
        async () => {
          await page.goto(`/rooms/${PUBLIC_ROOM}/thread/${rootEventId}`, { waitUntil: 'domcontentloaded' });
          try {
            await page.getByTestId('thread-panel').waitFor({ state: 'visible', timeout: 5_000 });
          } catch {
            return false;
          }
          return (await page.getByTestId('thread-panel').innerText()).includes(body);
        },
        {
          timeout: seconds * 1000,
          message: `expected "${body}" to appear in ${username}'s thread view within ${seconds}s`,
        },
      )
      .toBe(true);
  },
);

Then('the thread is listed for {string} in the shared public room', async ({}, username: string) => {
  const page = pageFor(username);
  const rootEventId = valueRegistry.get('thread:root-event-id');
  if (!rootEventId) throw new Error('No captured thread root event id — start the thread first.');
  // Still on the thread route from the previous step (getThreads renders the
  // "All threads" list alongside the open thread).
  await expect(page.getByTestId(`thread-list-item-${rootEventId}`)).toBeVisible({ timeout: 15_000 });
});

// ───────────────────────── edits (ownership gate) ─────────────────────────

When(
  '{string} edits the message {string} to a new message {string}',
  async ({}, username: string, fromLabel: string, toLabel: string) => {
    const page = pageFor(username);
    const fromBody = msgFor(fromLabel);
    const row = page.locator('[data-testid="matrix-log"] li.event').filter({ hasText: fromBody }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('[data-testid^="btn-edit-"]').click();
    await expect(page.getByTestId('edit-banner')).toBeVisible({ timeout: 5_000 });
    const unique = `${toLabel}-${runId()}`;
    valueRegistry.set(`msg:${toLabel}`, unique);
    await page.getByTestId('matrix-input').fill(unique);
    await page.getByTestId('matrix-send').click();
  },
);

Then(
  'the edited message {string} shows an edited marker in {string} timeline within {int} seconds',
  async ({}, label: string, username: string, seconds: number) => {
    const page = pageFor(username);
    const body = msgFor(label);
    await expect
      .poll(
        async () => {
          const row = page.locator('[data-testid="matrix-log"] li.event').filter({ hasText: body }).first();
          if ((await row.count()) === 0) return false;
          return (await row.locator('[data-testid="edited-marker"]').count()) > 0;
        },
        {
          timeout: seconds * 1000,
          message: `expected "${body}" to show an edited marker in ${username}'s timeline within ${seconds}s`,
        },
      )
      .toBe(true);
  },
);

Then('{string} is offered an edit control on the message {string}', async ({}, username: string, label: string) => {
  const row = pageFor(username)
    .locator('[data-testid="matrix-log"] li.event')
    .filter({ hasText: msgFor(label) })
    .first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.locator('[data-testid^="btn-edit-"]')).toBeVisible();
});

Then(
  '{string} is not offered an edit control on the message {string}',
  async ({}, username: string, label: string) => {
    const row = pageFor(username)
      .locator('[data-testid="matrix-log"] li.event')
      .filter({ hasText: msgFor(label) })
      .first();
    // The row itself must be rendered (otherwise "no control" proves nothing)…
    await expect(row).toBeVisible({ timeout: 15_000 });
    // …and the Edit affordance must be wholly absent (timeline.component's
    // isMine-only *ngIf) for a non-author.
    await expect(row.locator('[data-testid^="btn-edit-"]')).toHaveCount(0);
  },
);

// ───────────────────────── typing indicator (cross-user, live sync) ─────────────────────────

When('{string} keeps typing in the shared public room for a few seconds', async ({}, username: string) => {
  const page = pageFor(username);
  await openChatShell(page, PUBLIC_ROOM);
  const input = page.getByTestId('matrix-input');
  await input.click();
  // Local pacing ONLY — NOT the cross-user oracle (that is the watcher's
  // expect.poll in the Then step below). The composer auto-clears its
  // typing:true ephemeral state 3s after the last keystroke
  // (composer.component.ts onInput/stopTyping), so this keeps re-triggering
  // it to hold "typing" active across a real round-trip to the watcher's own
  // live /sync loop.
  for (let i = 0; i < 6; i++) {
    await input.fill(`typing-probe-${runId()}-${i}`);
    await page.waitForTimeout(700);
  }
});

Then(
  '{string} sees {string} listed as typing in the shared public room within {int} seconds',
  async ({ user }, watcherName: string, typerName: string, seconds: number) => {
    const watcher = pageFor(watcherName);
    const typerId = matrixIdFor(user(typerName) as SeedUser);
    await expect
      .poll(
        async () => {
          const el = watcher.getByTestId('typing-indicator');
          if ((await el.count()) === 0) return '';
          return el.innerText();
        },
        {
          timeout: seconds * 1000,
          message: `expected ${watcherName} to see ${typerName} (${typerId}) listed as typing within ${seconds}s`,
        },
      )
      .toContain(typerId);
  },
);
