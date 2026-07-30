// Step definitions for the @cluster messaging wave: cross-user message
// visibility, room membership (join / invite / kick), redaction and the
// domain-lock enforcement scenarios. Every persona lives in its OWN browser
// context (pageRegistry/ctxRegistry) and every cross-context wait goes through
// the sync-aware expect.poll helpers in tests/helpers/timeline.ts — never a
// bare waitForTimeout.
//
// HONEST-ORACLE conventions:
//  * message bodies are UNIQUE per scenario (`label-<runId>`) and remembered in
//    the per-scenario valueRegistry, so a timeline match can only come from
//    THIS scenario's send;
//  * created rooms have their REAL id captured off the creator's rendered room
//    list (never a fabricated id);
//  * "never appears" steps only run AFTER an ordering oracle in the same
//    scenario (a later canary arrived / the membership revocation is visible);
//  * DENY steps assert the ANNOUNCED rejection (rl-join-error / rl-dm-error /
//    composer-status / timeline-denied), never a silent no-op.
//
// Seeded-environment knobs (generator seed-job conventions, overridable):
//  * E2E_PUBLIC_ROOM            — a public room on tenant-a every member can
//                                 join by id/alias   (default !e2e-public:tenant-a.test)
//  * E2E_FEDERATED_ROOM_ALIAS   — a joinable room on ANOTHER homeserver
//                                 (default #e2e-federated:tenant-b.test)
//  * E2E_CROSS_DOMAIN_USER      — a real user on another homeserver
//                                 (default @user-carol:tenant-b.test)
//  * E2E_MATRIX_ID_<USERNAME>   — per-persona Matrix id override (roles.ts)
//  * E2E_MOD_BFF_TOKEN          — REAL moderator bff_ bearer for the live
//                                 mod-bff verbs (domain-unlock); without it the
//                                 seeded placeholder token is sent, which only
//                                 a stack running mod-bff in its e2e test-auth
//                                 mode will accept

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import {
  SESSION_KEY,
  SeedUser,
  matrixIdFor,
  newE2eContext,
  persistedRoles,
  seedSession,
} from '../../tests/helpers/roles';
import {
  expectMessageAbsentAfterCanary,
  expectMessageInTimeline,
  expectRedactedInTimeline,
} from '../../tests/helpers/timeline';
import { ctxRegistry, pageFor, pageRegistry, valueRegistry } from './_registry';

const PUBLIC_ROOM = process.env.E2E_PUBLIC_ROOM ?? '!e2e-public:tenant-a.test';
const FEDERATED_ROOM_ALIAS = process.env.E2E_FEDERATED_ROOM_ALIAS ?? '#e2e-federated:tenant-b.test';
const CROSS_DOMAIN_USER = process.env.E2E_CROSS_DOMAIN_USER ?? '@user-carol:tenant-b.test';

/** Unique per-send suffix so a timeline match can only come from THIS run. */
function runId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The remembered unique body for a scenario message label. Throws on a miss
 *  so an out-of-order feature fails loudly. */
function msgFor(label: string): string {
  const v = valueRegistry.get(`msg:${label}`);
  if (!v) throw new Error(`No unique message recorded for label "${label}" — send it first.`);
  return v;
}

/** The REAL room id captured when the scenario's victim created their room. */
function capturedRoomId(): string {
  const v = valueRegistry.get('room:id');
  if (!v) throw new Error('No captured room id — create the room first.');
  return v;
}

/** Open the sync-driven chat shell on a room (the '' route runs the /sync
 *  long-poll loop that feeds the live timeline — deep room routes do not). */
async function openChatShell(page: import('@playwright/test').Page, roomId: string): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(roomId)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('matrix-log')).toBeVisible({ timeout: 15_000 });
}

/** The explicit DENIED-history oracle: the timeline.component loadDenied
 *  notice is rendered (matrix.service throws on the 401/403 the homeserver
 *  answers a non-member / signed-out history fetch with — never an ambiguous
 *  empty log), no event row rendered, forbidden body absent. */
async function expectDeniedHistory(page: import('@playwright/test').Page, forbiddenBody: string): Promise<void> {
  await expect(page.getByTestId('timeline-denied')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid^="event-"]')).toHaveCount(0);
  await expect(page.getByTestId('matrix-log')).not.toContainText(forbiddenBody);
}

/** Join a room by id/alias through the room-list UI and PROVE membership by
 *  the room landing in the joined list (server-acknowledged). */
async function joinViaUi(page: import('@playwright/test').Page, target: string): Promise<void> {
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('input-join-alias').fill(target);
  await page.getByTestId('btn-join-alias').click();
}

// ───────────────────────── membership (shared public room) ─────────────────────────

Given('{string} has joined the shared public room in their context', async ({}, username: string) => {
  const page = pageFor(username);
  await joinViaUi(page, PUBLIC_ROOM);
  // Membership oracle: the joined list must now show the room.
  await expect(page.locator(`[data-testid="room-item-${PUBLIC_ROOM}"]`)).toBeVisible({ timeout: 30_000 });
  // Park the persona on the sync-driven chat shell so later cross-user waits
  // observe the LIVE timeline.
  await openChatShell(page, PUBLIC_ROOM);
});

Then('{string} sees the shared public room timeline render in their context', async ({}, username: string) => {
  const page = pageFor(username);
  await openChatShell(page, PUBLIC_ROOM);
  await expect(page.getByTestId('timeline-denied')).toHaveCount(0);
});

Then('the shared public room is listed for {string}', async ({}, username: string) => {
  const page = pageFor(username);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-testid="room-item-${PUBLIC_ROOM}"]`)).toBeVisible({ timeout: 15_000 });
});

Then('the shared public room is not listed for {string}', async ({}, username: string) => {
  const page = pageFor(username);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-testid="room-item-${PUBLIC_ROOM}"]`)).toHaveCount(0);
});

// ───────────────────────── sending + cross-context visibility ─────────────────────────

When(
  '{string} sends a unique message {string} in the shared public room',
  async ({}, username: string, label: string) => {
    const page = pageFor(username);
    const unique = `${label}-${runId()}`;
    valueRegistry.set(`msg:${label}`, unique);
    await openChatShell(page, PUBLIC_ROOM);
    await page.getByTestId('matrix-input').fill(unique);
    await page.getByTestId('matrix-send').click();
  },
);

Then(
  '{string} sees their message {string} echoed in their own timeline within {int} seconds',
  async ({}, username: string, label: string, seconds: number) => {
    await expectMessageInTimeline(pageFor(username), msgFor(label), seconds);
  },
);

Then(
  'the message {string} appears in {string} timeline within {int} seconds',
  async ({}, label: string, username: string, seconds: number) => {
    await expectMessageInTimeline(pageFor(username), msgFor(label), seconds);
  },
);

Then(
  'the message {string} never appears in {string} timeline once the canary {string} has arrived',
  async ({}, label: string, username: string, canaryLabel: string) => {
    // HONEST absence via the shared canary helper: the observer's own sync
    // stream must first deliver the LATER canary message (ordering oracle —
    // the stream provably progressed past the point the forbidden message
    // would have appeared), and only then is the forbidden body asserted
    // absent. Never timeout-and-hope.
    await expectMessageAbsentAfterCanary(pageFor(username), msgFor(label), msgFor(canaryLabel), 30);
  },
);

// ───────────────────────── non-member / signed-out DENY ─────────────────────────

When(
  '{string} navigates directly to the shared public room in their context',
  async ({}, username: string) => {
    await pageFor(username).goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
  },
);

Then(
  '{string} is denied the room history and the message {string} is not shown',
  async ({}, username: string, label: string) => {
    await expectDeniedHistory(pageFor(username), msgFor(label));
  },
);

Given('a signed-out visitor has a fresh context', async ({ browser }) => {
  const ctx = await newE2eContext(browser);
  const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((key) => window.localStorage.removeItem(key), SESSION_KEY);
  ctxRegistry.set('signed-out-visitor', ctx);
  pageRegistry.set('signed-out-visitor', page);
});

When('the signed-out visitor navigates directly to the shared public room', async ({}) => {
  await pageFor('signed-out-visitor').goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
});

Then(
  'the signed-out visitor is denied the room history and the message {string} is not shown',
  async ({}, label: string) => {
    // This remote is guard-free BY DESIGN (the login redirect lives in the
    // host shell that mounts it at /social/matrix) — so the honest signed-out
    // DENY this standalone surface CAN prove is the server one: the
    // session-less history fetch is rejected (401) and the timeline renders
    // its explicit denied notice, with the provably-existing member message
    // never shown.
    await expectDeniedHistory(pageFor('signed-out-visitor'), msgFor(label));
  },
);

// ───────────────────────── banned sender DENY ─────────────────────────

When(
  '{string} attempts to send a unique message {string} in the shared public room',
  async ({}, username: string, label: string) => {
    const page = pageFor(username);
    const unique = `${label}-${runId()}`;
    valueRegistry.set(`msg:${label}`, unique);
    // The deep room route mounts the composer regardless of membership; the
    // send is what the server must reject for a banned / session-less sender.
    await page.goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('composer')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('matrix-input').fill(unique);
    await page.getByTestId('matrix-send').click();
  },
);

Then('{string} sees an announced send failure', async ({}, username: string) => {
  const status = pageFor(username).getByTestId('composer-status');
  await expect(status).toBeVisible({ timeout: 15_000 });
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toContainText(/send failed/i);
});

// ───────────────────────── invite-only room (real-oracle DENY→ALLOW) ─────────────────────────

Given('{string} creates an invite-only room in their context', async ({}, username: string) => {
  const page = pageFor(username);
  const name = `invite-only-${runId()}`;
  valueRegistry.set('room:name', name);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('btn-create-room').click();
  await page.locator('#create-name').fill(name);
  // The create dialog defaults to the Private (invite-only) preset.
  await page.locator('#create-preset').selectOption('private_chat');
  await page.locator('[data-testid="dialog-create-room"] button[type="submit"]').click();
  // Capture the REAL room id off the creator's refreshed list (honest oracle).
  const item = page.locator('[data-testid^="room-item-"]').filter({ hasText: name }).first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  const testid = await item.getAttribute('data-testid');
  valueRegistry.set('room:id', testid!.replace('room-item-', ''));
});

Given(
  '{string} sends a unique message {string} in their new room',
  async ({}, username: string, label: string) => {
    const page = pageFor(username);
    const roomId = capturedRoomId();
    const unique = `${label}-${runId()}`;
    valueRegistry.set(`msg:${label}`, unique);
    await openChatShell(page, roomId);
    await page.getByTestId('matrix-input').fill(unique);
    await page.getByTestId('matrix-send').click();
    // The creator's own echo proves the message exists BEFORE any DENY is
    // asserted against it.
    await expectMessageInTimeline(page, unique, 30);
  },
);

When(
  '{string} attempts to join the captured room by id in their context',
  async ({}, username: string) => {
    await joinViaUi(pageFor(username), capturedRoomId());
  },
);

Then('{string} sees an announced join rejection', async ({}, username: string) => {
  const err = pageFor(username).getByTestId('rl-join-error');
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toContainText(/could not join/i);
});

Then('the captured room is not listed for {string}', async ({}, username: string) => {
  const page = pageFor(username);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-testid="room-item-${capturedRoomId()}"]`)).toHaveCount(0);
});

Then(
  '{string} is denied the captured room history and the message {string} is not shown',
  async ({}, username: string, label: string) => {
    const page = pageFor(username);
    await page.goto(`/rooms/${capturedRoomId()}`, { waitUntil: 'domcontentloaded' });
    await expectDeniedHistory(page, msgFor(label));
  },
);

When('{string} invites {string} to their new room', async ({ user }, inviter: string, invitee: string) => {
  const page = pageFor(inviter);
  const target = matrixIdFor(user(invitee) as SeedUser);
  const roomId = capturedRoomId();
  await page.goto(`/rooms/${roomId}/members`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('member-list')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('input-invite-user').fill(target);
  await page.getByTestId('btn-invite').click();
  // doInvite clears the input only after the server accepted the invite.
  await expect(page.getByTestId('input-invite-user')).toHaveValue('', { timeout: 15_000 });
});

When('{string} joins the captured room by id in their context', async ({}, username: string) => {
  const page = pageFor(username);
  const roomId = capturedRoomId();
  await joinViaUi(page, roomId);
  // Membership oracle, then park on the sync-driven shell for the timeline wait.
  await expect(page.locator(`[data-testid="room-item-${roomId}"]`)).toBeVisible({ timeout: 30_000 });
  await openChatShell(page, roomId);
});

// ───────────────────────── kick revokes visibility ─────────────────────────

When('{string} kicks {string} from the shared public room', async ({ user }, modName: string, targetName: string) => {
  const page = pageFor(modName);
  const target = matrixIdFor(user(targetName) as SeedUser);
  await page.goto(`/rooms/${PUBLIC_ROOM}/members`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('member-list')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`btn-kick-${target}`).click();
  // Revocation oracle: doKick reloads joinedMembers — the row must be GONE
  // (the server acknowledged the kick) before any later-message assertion.
  await expect(page.getByTestId(`member-${target}`)).toHaveCount(0, { timeout: 30_000 });
});

Then(
  'the shared public room drops from {string} room list within {int} seconds',
  async ({}, username: string, seconds: number) => {
    // The KICKED user's OWN observation of the revocation, asserted BEFORE any
    // post-kick message exists: each poll iteration reloads /rooms, which
    // re-fetches joined_rooms from the server, so the absence is
    // server-acknowledged from the victim's side — not inferred from the
    // moderator's view.
    const page = pageFor(username);
    await expect
      .poll(
        async () => {
          await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
          try {
            await page.getByTestId('room-list').waitFor({ state: 'visible', timeout: 10_000 });
          } catch {
            return -1; // list not rendered yet — keep polling
          }
          return page.locator(`[data-testid="room-item-${PUBLIC_ROOM}"]`).count();
        },
        {
          timeout: seconds * 1000,
          message: `expected the shared public room to drop from ${username}'s server-fetched room list within ${seconds}s`,
        },
      )
      .toBe(0);
  },
);

Then(
  'a fresh history fetch never shows {string} the message {string}',
  async ({}, username: string, label: string) => {
    // RACE-FREE absence: the kicked user cannot receive a post-kick canary in
    // this room (their sync stream for it ended at the leave), so instead of
    // racing their sync we issue a FRESH server-answered /messages request —
    // strictly AFTER the moderator's own echo proved the message exists on the
    // server — and assert the server's response never carries the body. The
    // response reflects post-send server state, so a leak cannot hide behind
    // "the client just hasn't synced it yet".
    const page = pageFor(username);
    const unique = msgFor(label);
    const historyResponse = page.waitForResponse(
      (r) => r.url().includes('/_matrix/client/v3/rooms/') && r.url().includes('/messages'),
      { timeout: 30_000 },
    );
    await page.goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
    const res = await historyResponse;
    const raw = await res.text().catch(() => '');
    expect(raw, `the server's fresh post-kick /messages response must never carry "${unique}"`).not.toContain(unique);
    // And the rendered surface agrees (whether the server answered with the
    // pre-kick history or a denial, the forbidden body is never shown).
    await expect(page.getByTestId('matrix-log')).not.toContainText(unique);
  },
);

// ───────────────────────── redaction ─────────────────────────

When('{string} deletes the message {string} from their timeline', async ({}, username: string, label: string) => {
  const page = pageFor(username);
  const unique = msgFor(label);
  const row = page.locator('[data-testid="matrix-log"] li.event').filter({ hasText: unique }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  // The ownership/role-gated redact affordance (timeline canRedact). Capture
  // the REAL event id off the control's testid (btn-delete-<eventId>) so the
  // placeholder assertions can scope to THIS event's row — the persistent
  // shared room accumulates other "(message deleted)" markers.
  const btn = row.locator('[data-testid^="btn-delete-"]');
  const testid = await btn.getAttribute('data-testid');
  valueRegistry.set(`event:${label}`, testid!.replace('btn-delete-', ''));
  await btn.click();
});

Then(
  'the message {string} shows as a redacted placeholder in {string} timeline within {int} seconds',
  async ({}, label: string, username: string, seconds: number) => {
    const eventId = valueRegistry.get(`event:${label}`);
    if (!eventId) throw new Error(`No captured event id for "${label}" — delete it through the UI first.`);
    await expectRedactedInTimeline(pageFor(username), msgFor(label), eventId, seconds);
  },
);

Then('{string} is offered a delete control on the message {string}', async ({}, username: string, label: string) => {
  const row = pageFor(username)
    .locator('[data-testid="matrix-log"] li.event')
    .filter({ hasText: msgFor(label) })
    .first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.locator('[data-testid^="btn-delete-"]')).toBeVisible();
});

Then(
  '{string} is not offered a delete control on the message {string}',
  async ({}, username: string, label: string) => {
    const row = pageFor(username)
      .locator('[data-testid="matrix-log"] li.event')
      .filter({ hasText: msgFor(label) })
      .first();
    // The row itself must be rendered (otherwise "no control" proves nothing)…
    await expect(row).toBeVisible({ timeout: 15_000 });
    // …and the redact affordance must be wholly absent for a non-owner non-mod.
    await expect(row.locator('[data-testid^="btn-delete-"]')).toHaveCount(0);
  },
);

// ───────────────────────── domain-lock enforcement ─────────────────────────

Then('the join help includes the domain-lock local-only note', async ({ page }) => {
  await expect(page.getByTestId('rl-join-help')).toBeVisible();
  await expect(page.getByTestId('rl-join-lock-note')).toContainText(/domain-locked/i);
});

Then('the start-DM help includes the domain-lock local-only note', async ({ page }) => {
  await expect(page.getByTestId('rl-dm-help')).toBeVisible();
  await expect(page.getByTestId('rl-dm-lock-note')).toContainText(/domain-locked/i);
});

Then('no domain-lock restriction note is shown', async ({ page }) => {
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('rl-join-lock-note')).toHaveCount(0);
  await expect(page.getByTestId('rl-dm-lock-note')).toHaveCount(0);
});

Then('no domain-lock restriction note is shown in {string} context', async ({}, username: string) => {
  const page = pageFor(username);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('rl-join-lock-note')).toHaveCount(0);
  await expect(page.getByTestId('rl-dm-lock-note')).toHaveCount(0);
});

When(
  '{string} attempts to join the federated room alias in their context',
  async ({}, username: string) => {
    await joinViaUi(pageFor(username), FEDERATED_ROOM_ALIAS);
  },
);

Then('{string} sees an explicit domain-lock join rejection', async ({}, username: string) => {
  const err = pageFor(username).getByTestId('rl-join-error');
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toContainText(/domain-locked/i);
});

Then('the federated room is not listed for {string}', async ({}, username: string) => {
  const page = pageFor(username);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  // No joined room resolves to the federated homeserver.
  const server = FEDERATED_ROOM_ALIAS.split(':').slice(1).join(':');
  await expect(page.locator(`[data-testid^="room-item-"][data-testid*="${server}"]`)).toHaveCount(0);
});

Then('the federated room is listed for {string}', async ({}, username: string) => {
  const page = pageFor(username);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  const server = FEDERATED_ROOM_ALIAS.split(':').slice(1).join(':');
  await expect(page.locator(`[data-testid^="room-item-"][data-testid*="${server}"]`).first()).toBeVisible({
    timeout: 30_000,
  });
});

When(
  '{string} attempts to start a DM with a cross-domain user in their context',
  async ({}, username: string) => {
    const page = pageFor(username);
    await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('btn-start-dm').click();
    await page.locator('#dm-user').fill(CROSS_DOMAIN_USER);
    await page.locator('form[aria-label="Start direct message"] button[type="submit"]').click();
  },
);

Then('{string} sees an explicit domain-lock DM rejection', async ({}, username: string) => {
  const err = pageFor(username).getByTestId('rl-dm-error');
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toContainText(/domain-locked/i);
});

Then('no room with the cross-domain user is listed for {string}', async ({}, username: string) => {
  const page = pageFor(username);
  await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-list')).toBeVisible({ timeout: 15_000 });
  // The DM never became a joined room (People section stays free of the target).
  await expect(page.getByTestId('room-list')).not.toContainText(CROSS_DOMAIN_USER);
});

// ───────────────────────── unlock restores federation ─────────────────────────

Given(
  'the moderator has lifted the Matrix domain lock on {string}',
  async ({ user }, username: string) => {
    // The mod-ui verb: DELETE /bff/mod/domain-lock/ROLE_MATRIX_DOMAINLOCKED/{user}
    // issued AS the moderator. Auth is the HttpOnly `bff_` session cookie —
    // `page.request` shares the page's browser-context cookie jar, so it rides
    // along automatically when mod-mallory's context holds a real cookie (a
    // live `login()` round trip). The endpoint returns the HONEST 202
    // pending-reconcile envelope (state, never a fake sync OK).
    const modPage = pageFor('mod-mallory');
    const locked = user(username) as SeedUser;
    // AUTH PREMISE (live runs): the seed helper only writes non-secret
    // metadata (roles.ts sessionFor) — it carries NO cookie. A cluster run
    // against a real mod-bff therefore needs either a genuine live login (the
    // `bff_` cookie rides via the shared context automatically) or an
    // out-of-band moderator bearer exported as E2E_MOD_BFF_TOKEN. The 202
    // assertion below fails loudly (401) rather than green-washing if neither
    // holds.
    const bffToken = process.env.E2E_MOD_BFF_TOKEN ?? null;
    const target = process.env.E2E_DOMAINLOCK_TARGET ?? locked.label;
    const res = await modPage.request.delete(
      `/bff/mod/domain-lock/ROLE_MATRIX_DOMAINLOCKED/${encodeURIComponent(target)}`,
      { headers: bffToken ? { Authorization: `Bearer ${bffToken}` } : {} },
    );
    // HONEST envelope: a 202 (pending-reconcile) — the effect applies
    // asynchronously via the reconcile loop; NEVER assert a synchronous OK.
    expect(res.status(), 'domain-unlock must be accepted (202 pending-reconcile)').toBe(202);
    const body = (await res.json()) as { state?: string };
    expect(body.state, 'the 202 envelope carries the desired-state field').toBeTruthy();
  },
);

Given(
  '{string} signs in again without the domain-lock marker in their own context',
  async ({ browser, user }, username: string) => {
    // Models the re-login AFTER the reconcile applied: the admin-bff no longer
    // folds ROLE_MATRIX_DOMAINLOCKED into roles[], so the fresh session drops
    // the `matrix_domainlocked` marker. Same identity, marker removed.
    const locked = user(username) as SeedUser;
    const unlocked: SeedUser = {
      ...locked,
      roles: locked.roles.filter((r) => r !== 'matrix_domainlocked'),
      domainLocked: false,
    };
    const ctx = await newE2eContext(browser);
    const page = await ctx.newPage();
    await seedSession(page, unlocked);
    // Sanity: the PERSISTED session (what SessionService actually reads back)
    // really lost the marker.
    expect(await persistedRoles(page)).not.toContain('matrix_domainlocked');
    ctxRegistry.set(locked.username, ctx);
    pageRegistry.set(locked.username, page);
  },
);
