// Step definitions for the two membership seams the WIP fixes closed:
//
//  * POWER-DENIED KICK announced honesty (membership-power-deny.feature) —
//    matrix.service.kick() now THROWS on a non-OK response and member-list
//    announces it, so a plain member's kick of a higher-PL member surfaces the
//    homeserver 403 in the aria-live status region instead of a silent no-op.
//  * INVITE EXPERIENCE from the invitee's side (invite-experience.feature) —
//    sync() now parses rooms.invite (pendingInvites()) and the room list renders
//    an Invites section with Accept/Decline, so a pending invite is a visible,
//    actionable affordance.
//
// Both reuse the invite-only room the messaging-steps "creates an invite-only
// room" / "invites … to their new room" / "joins the captured room by id" steps
// provision and capture (valueRegistry `room:id`), keeping the honest-oracle
// rule end-to-end. Every cross-context wait is a bounded expect.poll — never a
// bare waitForTimeout.

import { expect, Page } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { matrixIdFor, SeedUser } from '../../tests/helpers/roles';
import { pageFor, valueRegistry } from './_registry';

/** The REAL room id captured when the scenario's creator made their room. */
function capturedRoomId(): string {
  const v = valueRegistry.get('room:id');
  if (!v) throw new Error('No captured room id — create the room first.');
  return v;
}

async function openChatShell(page: Page, roomId: string): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(roomId)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('matrix-log')).toBeVisible({ timeout: 15_000 });
}

// ───────────────────────── power-denied kick (announced honesty) ─────────────────────────

When(
  '{string} attempts to kick {string} from the captured room',
  async ({ user }, kickerName: string, targetName: string) => {
    const page = pageFor(kickerName);
    const targetId = matrixIdFor(user(targetName) as SeedUser);
    const roomId = capturedRoomId();
    await page.goto(`/rooms/${roomId}/members`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('member-list')).toBeVisible({ timeout: 15_000 });
    // The Kick button renders for every member (no client-side power gate) — the
    // homeserver is the authority, so the click is what the server must reject.
    const kickBtn = page.getByTestId(`btn-kick-${targetId}`);
    await expect(kickBtn, `expected a Kick control for ${targetName} (${targetId})`).toBeVisible({ timeout: 15_000 });
    await kickBtn.click();
  },
);

Then('{string} sees an announced kick failure', async ({}, username: string) => {
  const status = pageFor(username).getByTestId('member-list-status');
  await expect(status).toBeVisible({ timeout: 15_000 });
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toContainText(/kick failed/i);
});

Then(
  '{string} is still listed as a member of the captured room',
  async ({ user }, username: string) => {
    // Server-truth convergence from the VICTIM's own fresh fetch: alice reopens
    // her member list and is still present — the denied kick never applied.
    const page = pageFor(username);
    const selfId = matrixIdFor(user(username) as SeedUser);
    await page.goto(`/rooms/${capturedRoomId()}/members`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('member-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`member-${selfId}`)).toBeVisible({ timeout: 15_000 });
  },
);

// ───────────────────────── invite experience (invitee side) ─────────────────────────

Then('the pending invite to the captured room is shown for {string}', async ({}, username: string) => {
  const page = pageFor(username);
  const roomId = capturedRoomId();
  // The room list loads pending invites on init; the invite may take a sync
  // round-trip to reach the invitee, so poll the /rooms view into showing it.
  await expect
    .poll(
      async () => {
        await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
        try {
          await page.getByTestId('room-list').waitFor({ state: 'visible', timeout: 5_000 });
        } catch {
          return false;
        }
        return (await page.locator(`[data-testid="invite-item-${roomId}"]`).count()) > 0;
      },
      {
        timeout: 30_000,
        message: `expected a pending invite affordance for the captured room to surface for ${username}`,
      },
    )
    .toBe(true);
  // The invite row carries an actionable Accept control (not just a label).
  await expect(page.getByTestId(`btn-accept-invite-${roomId}`)).toBeVisible({ timeout: 15_000 });
});

When('{string} accepts the pending invite to the captured room', async ({}, username: string) => {
  const page = pageFor(username);
  const roomId = capturedRoomId();
  await page.getByTestId(`btn-accept-invite-${roomId}`).click();
  // Accept joins the room and drops the invite row (server-acknowledged join).
  await expect(page.locator(`[data-testid="invite-item-${roomId}"]`)).toHaveCount(0, { timeout: 30_000 });
  // Park on the sync-driven chat shell so the reused timeline oracle observes
  // the now-visible room history.
  await openChatShell(page, roomId);
});
