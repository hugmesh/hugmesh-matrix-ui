// Step definitions for read receipts — the "seen by" indicator
// (timeline.component.ts readByEvent, fed by the /sync ephemeral m.receipt the
// chat shell folds via mergeReadReceipts). Two halves:
//
//  * OFFLINE render mapping — the CS-API is SEEDED via route-fulfilment so the
//    chat shell renders two real message rows plus a folded read receipt that
//    anchors on the EARLIER one. Pure client render (no homeserver): the oracle
//    is that the indicator lands on the exact event its author read and NOWHERE
//    else. This mirrors the mergeReadReceipts / readByEvent unit tests, proven
//    end-to-end through the built app's rendered DOM.
//  * @cluster live delivery — a REAL cross-user m.read round-trip: the reader's
//    own send-on-view receipt reaches the message author's live timeline. That
//    Then lives here too so both halves share one testid vocabulary.
//
// The author's OWN receipt is never rendered (Element convention), so any chip
// the author sees can only be another member's — the cross-user assertion is
// non-vacuous by construction.

import { expect, Page, Route } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { matrixIdFor, SeedUser } from '../../tests/helpers/roles';
import { pageFor, valueRegistry } from './_registry';

const PUBLIC_ROOM = process.env.E2E_PUBLIC_ROOM ?? '!e2e-public:tenant-a.test';

// ───────────────────────── OFFLINE render mapping (seeded CS-API) ─────────────────────────

const SEEDED_ROOM = '!seen-receipts:tenant-a.test';
const SEEDED_ME = '@user-alice:tenant-a.test';
const SEEDED_BOB = '@user-bob:tenant-a.test';
const EARLY_EVENT = '$seen-receipts-early';
const LATE_EVENT = '$seen-receipts-late';
const EARLY_BODY = 'seen-receipts earlier message';
const LATE_BODY = 'seen-receipts later message';

async function fulfillJson(route: Route, obj: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
}

function messageEvent(eventId: string, body: string, ts: number): Record<string, unknown> {
  return {
    event_id: eventId,
    room_id: SEEDED_ROOM,
    type: 'm.room.message',
    sender: SEEDED_ME,
    origin_server_ts: ts,
    content: { msgtype: 'm.text', body },
  };
}

/** A /sync body whose room carries an ephemeral m.receipt: Bob has read the
 *  EARLIER event. The chat shell folds this into the latest-read-per-user map
 *  the timeline's "seen by" indicator renders from. */
function syncWithBobReceipt(): Record<string, unknown> {
  return {
    next_batch: 's2',
    rooms: {
      join: {
        [SEEDED_ROOM]: {
          timeline: { events: [], limited: false },
          state: { events: [] },
          ephemeral: {
            events: [{ type: 'm.receipt', content: { [EARLY_EVENT]: { 'm.read': { [SEEDED_BOB]: { ts: 1500 } } } } }],
          },
          unread_notifications: { notification_count: 0, highlight_count: 0 },
        },
      },
    },
  };
}

/**
 * Seed every CS-API endpoint the chat shell touches so the room renders OFFLINE:
 * two message rows from /messages, the roster (Alice + Bob) from /joined_members,
 * and — the point of the test — a folded read receipt from /sync anchoring Bob
 * on the earlier event.
 *
 * The receipt is served on EVERY /sync, not just the first. A read receipt is
 * server-held STATE: a real homeserver replays it in the ephemeral block of any
 * initial sync, so answering it once only was modelling the server wrongly and
 * made the scenario depend on the chat shell's sync loop happening to issue the
 * page's very first /sync. It no longer does — the room list mounted inside the
 * shell issues its own zero-timeout invites sync (MatrixService.pendingInvites)
 * — and a one-shot seed silently handed the receipt to that caller instead.
 * Later calls still hold before answering so the long-poll loop parks rather
 * than busy-spinning.
 */
async function seedReceiptRoom(page: Page): Promise<void> {
  let syncCall = 0;
  await page.route('**/_matrix/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/account/whoami')) return fulfillJson(route, { user_id: SEEDED_ME });
    if (url.includes('/joined_rooms')) return fulfillJson(route, { joined_rooms: [SEEDED_ROOM] });
    if (url.includes('/messages')) {
      // dir=b returns newest-first; the timeline re-sorts by origin_server_ts.
      return fulfillJson(route, { chunk: [messageEvent(LATE_EVENT, LATE_BODY, 2000), messageEvent(EARLY_EVENT, EARLY_BODY, 1000)], start: 's', end: '' });
    }
    if (url.includes('/joined_members')) {
      return fulfillJson(route, { joined: { [SEEDED_ME]: { display_name: 'Alice' }, [SEEDED_BOB]: { display_name: 'Bob' } } });
    }
    if (url.includes('/relations')) return fulfillJson(route, { chunk: [] });
    if (url.includes('/sync')) {
      syncCall += 1;
      if (syncCall === 1) return fulfillJson(route, syncWithBobReceipt());
      // Subsequent long-polls: hold briefly (so the loop parks instead of
      // busy-spinning), then replay the same server-held receipt.
      await new Promise((r) => setTimeout(r, 1200));
      return fulfillJson(route, syncWithBobReceipt());
    }
    // getStateEvent (…/state/<type>/<key>) → a content object; roomState
    // (…/state) → the state-events array. Order matters: the more specific
    // `/state/` check must run first.
    if (url.includes('/state/')) return fulfillJson(route, {});
    if (/\/rooms\/[^/]+\/state(\?|$)/.test(url)) return fulfillJson(route, []);
    // Everything else the bootstrap probes (account_data m.direct, etc.).
    return fulfillJson(route, {});
  });
}

When(
  '{string} opens a seeded room where {string} has read the earlier of two messages',
  async ({ page }, _username: string, _reader: string) => {
    await seedReceiptRoom(page);
    // The '' route runs the /sync loop that folds the seeded receipt; deep room
    // routes do not. Park on the chat shell for the seeded room.
    await page.goto(`/?room=${encodeURIComponent(SEEDED_ROOM)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('matrix-log')).toBeVisible({ timeout: 15_000 });
    // Both seeded messages must be rendered before the indicator is asserted —
    // otherwise "absent on the later one" would be vacuously true.
    await expect(page.locator(`[data-testid="event-${LATE_EVENT}"]`)).toBeVisible({ timeout: 15_000 });
  },
);

Then(
  'the read receipt for {string} appears on the earlier message labelled {string}',
  async ({ page }, _reader: string, label: string) => {
    const chip = page.locator(`[data-testid="event-${EARLY_EVENT}"] [data-testid="read-receipt-${SEEDED_BOB}"]`);
    // The folded /sync receipt arrives just after the initial render, so poll
    // the indicator into existence rather than assuming a fixed order.
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toHaveAttribute('role', 'img');
    await expect(chip).toHaveAttribute('aria-label', label);
  },
);

Then('the read receipt for {string} does not appear on the later message', async ({ page }, _reader: string) => {
  const lateRow = page.locator(`[data-testid="event-${LATE_EVENT}"]`);
  // The later row must be rendered (proven above) AND carry no chip for Bob —
  // he read the earlier event, so his avatar anchors there, never on N+1.
  await expect(lateRow.locator(`[data-testid="read-receipt-${SEEDED_BOB}"]`)).toHaveCount(0);
});

// ───────────────────────── @cluster live cross-user delivery ─────────────────────────

Then(
  '{string} sees a read receipt from {string} on the message {string} within {int} seconds',
  async ({ user }, viewer: string, reader: string, label: string, seconds: number) => {
    const page = pageFor(viewer);
    const readerId = matrixIdFor(user(reader) as SeedUser);
    const body = valueRegistry.get(`msg:${label}`);
    if (!body) throw new Error(`No unique message recorded for label "${label}" — send it first.`);
    await expect
      .poll(
        async () => {
          // Re-open the sync-driven chat shell so a fresh initial /sync pulls the
          // room's CURRENT ephemeral receipts (a real server round-trip each
          // iteration — never a fixed sleep).
          await page.goto(`/?room=${encodeURIComponent(PUBLIC_ROOM)}`, { waitUntil: 'domcontentloaded' });
          try {
            await page.getByTestId('matrix-log').waitFor({ state: 'visible', timeout: 5_000 });
          } catch {
            return 'timeline-not-mounted';
          }
          const row = page.locator('[data-testid="matrix-log"] li.event').filter({ hasText: body }).first();
          if ((await row.count()) === 0) return 'target-message-not-rendered';
          const chip = row.locator(`[data-testid="read-receipt-${readerId}"]`);
          return (await chip.count()) > 0 ? 'receipt-visible' : 'no-receipt-yet';
        },
        {
          timeout: seconds * 1000,
          message: `expected ${viewer} to see a read receipt from ${reader} (${readerId}) on "${label}" within ${seconds}s`,
        },
      )
      .toBe('receipt-visible');
  },
);
