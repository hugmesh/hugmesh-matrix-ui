// Step definitions for room-level features not covered by messaging-steps.ts:
// room settings (a REAL power-level ALLOW/DENY gate) and room creation (the
// client-side required-name validation + the "Public" preset's no-invite
// join). Reuses the shared-public-room convention and the invite-only room
// creation flow from messaging-steps.ts (same env knob, same valueRegistry
// key `room:id`), so scenarios freely compose steps from either file.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { pageFor, valueRegistry } from './_registry';

const PUBLIC_ROOM = process.env.E2E_PUBLIC_ROOM ?? '!e2e-public:tenant-a.test';

/** Unique per-send suffix so a captured value can only come from THIS run. */
function runId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The REAL room id captured by messaging-steps.ts's "creates an invite-only
 *  room in their context" step (shared valueRegistry key `room:id`). */
function capturedRoomId(): string {
  const v = valueRegistry.get('room:id');
  if (!v) throw new Error('No captured room id — create the room first.');
  return v;
}

// ───────────────────────── room settings (power-level gate) ─────────────────────────

When('{string} updates the room name and topic in their context', async ({}, username: string) => {
  const page = pageFor(username);
  const roomId = capturedRoomId();
  const newName = `settings-name-${runId()}`;
  const newTopic = `settings-topic-${runId()}`;
  valueRegistry.set('room:new-name', newName);
  valueRegistry.set('room:new-topic', newTopic);
  await page.goto(`/rooms/${roomId}/settings`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-settings')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('input-room-name').fill(newName);
  await page.getByTestId('input-room-topic').fill(newTopic);
  await page.getByTestId('btn-save-room').click();
  await expect(page.getByTestId('room-settings-status')).toContainText(/saved/i, { timeout: 15_000 });
});

Then(
  '{string} sees the updated room name and topic within {int} seconds',
  async ({}, username: string, seconds: number) => {
    const page = pageFor(username);
    const roomId = capturedRoomId();
    const name = valueRegistry.get('room:new-name');
    const topic = valueRegistry.get('room:new-topic');
    if (!name || !topic) throw new Error('No captured room name/topic — save it first.');
    await expect
      .poll(
        async () => {
          await page.goto(`/rooms/${roomId}`, { waitUntil: 'domcontentloaded' });
          try {
            await page.getByTestId('room-name').waitFor({ state: 'visible', timeout: 5_000 });
          } catch {
            return '';
          }
          return page.getByTestId('room-name').innerText();
        },
        {
          timeout: seconds * 1000,
          message: `expected ${username} to see the updated room name within ${seconds}s`,
        },
      )
      .toBe(name);
    // The topic sits alongside the name on the same fetched room-view render.
    await expect(page.getByTestId('room-topic')).toHaveText(topic);
  },
);

When(
  '{string} attempts to rename the shared public room in their context',
  async ({}, username: string) => {
    const page = pageFor(username);
    const attempted = `deny-rename-${runId()}`;
    valueRegistry.set('room:deny-name', attempted);
    await page.goto(`/rooms/${PUBLIC_ROOM}/settings`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('room-settings')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('input-room-name').fill(attempted);
    await page.getByTestId('btn-save-room').click();
  },
);

Then('{string} sees an announced room-settings save failure', async ({}, username: string) => {
  const status = pageFor(username).getByTestId('room-settings-status');
  await expect(status).toBeVisible({ timeout: 15_000 });
  await expect(status).toContainText(/save failed/i);
});

Then('the attempted room rename never applies for {string}', async ({}, username: string) => {
  const page = pageFor(username);
  const attempted = valueRegistry.get('room:deny-name');
  if (!attempted) throw new Error('No attempted rename recorded — attempt it first.');
  // The failed PUT was already awaited by the time the save-failure step
  // resolved (room-settings.component.ts save() awaits it sequentially before
  // setting status), so a single fresh fetch here is deterministic, not a race.
  await page.goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-name')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('room-name')).not.toHaveText(attempted);
});

// ───────────────────────── room creation ─────────────────────────

When('{string} opens the create-room dialog', async ({ page }, _username: string) => {
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('btn-create-room').click();
  await expect(page.getByTestId('dialog-create-room')).toBeVisible();
});

When('{string} submits the create-room form without a name', async ({ page }, _username: string) => {
  await page.locator('[data-testid="dialog-create-room"] button[type="submit"]').click();
});

Then('a required-name validation error is shown', async ({ page }) => {
  const err = page.getByTestId('create-room-error');
  await expect(err).toBeVisible();
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toContainText(/room name is required/i);
  // The dialog stays open — the client-side guard short-circuits before any
  // createRoom call (room-list.component.ts create()), so there is no
  // navigation and no new room-item can have appeared.
  await expect(page.getByTestId('dialog-create-room')).toBeVisible();
});

Given('{string} creates a public room in their context', async ({}, username: string) => {
  const page = pageFor(username);
  const name = `public-room-${runId()}`;
  valueRegistry.set('pubroom:name', name);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('btn-create-room').click();
  await page.locator('#create-name').fill(name);
  await page.locator('#create-preset').selectOption('public_chat');
  await page.locator('[data-testid="dialog-create-room"] button[type="submit"]').click();
  // Capture the REAL room id off the creator's refreshed list (honest oracle).
  const item = page.locator('[data-testid^="room-item-"]').filter({ hasText: name }).first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  const testid = await item.getAttribute('data-testid');
  valueRegistry.set('pubroom:id', testid!.replace('room-item-', ''));
});

When('{string} joins the created public room by id in their context', async ({}, username: string) => {
  const page = pageFor(username);
  const roomId = valueRegistry.get('pubroom:id');
  if (!roomId) throw new Error('No captured public room id — create it first.');
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  // No invite involved — the "Public" preset lets ANY user join purely by id.
  await page.getByTestId('input-join-alias').fill(roomId);
  await page.getByTestId('btn-join-alias').click();
  await expect(page.locator(`[data-testid="room-item-${roomId}"]`)).toBeVisible({ timeout: 30_000 });
});

Then('the created public room is listed for {string}', async ({}, username: string) => {
  const page = pageFor(username);
  const roomId = valueRegistry.get('pubroom:id');
  if (!roomId) throw new Error('No captured public room id — create it first.');
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-testid="room-item-${roomId}"]`)).toBeVisible({ timeout: 15_000 });
});
