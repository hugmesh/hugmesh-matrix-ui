// Step definitions for MSC2545 m.sticker rendering — the render-half the send
// half (hug-sticker-picker) shipped without. Two halves:
//
//  * OFFLINE render mapping — the CS-API is SEEDED via route-fulfilment so the
//    chat shell renders a real m.sticker row hydrated from an authenticated
//    media thumbnail. Pure client render (no homeserver): the oracle is that
//    the sticker becomes an <img> with an accessible label and NO duplicate
//    plain-text row. This is the browser-integration companion to the
//    timeline.component m.sticker unit specs, proven through the built app's DOM.
//  * OFFLINE picker a11y — opening the picker with no pack shows the empty state
//    and Escape returns focus to the toggle.
//  * @cluster live delivery — a REAL cross-user round-trip: alice's picker send
//    reaches bob's live timeline. The sent sticker's REAL event id is captured
//    off alice's own echo (honest oracle) so bob's match can only be THIS send.
//
// Every cross-context wait is a bounded expect.poll re-opening the sync-driven
// chat shell — never a bare waitForTimeout.

import { expect, Page, Route } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { pageFor, valueRegistry } from './_registry';

const PUBLIC_ROOM = process.env.E2E_PUBLIC_ROOM ?? '!e2e-public:tenant-a.test';

// ───────────────────────── OFFLINE render mapping (seeded CS-API) ─────────────────────────

const SEEDED_ROOM = '!sticker-render:tenant-a.test';
const SEEDED_ME = '@user-alice:tenant-a.test';
const STICKER_EVENT = '$sticker-render-1';
const STICKER_BODY = 'smug expression';
const STICKER_MXC = 'mxc://tenant-a.test/sticker-render-media';

// A 1×1 transparent PNG — the seeded authenticated media thumbnail. The DOM
// oracle only needs the <img src> to become a real blob: object URL; the pixel
// content is irrelevant.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function fulfillJson(route: Route, obj: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
}

function stickerEvent(): Record<string, unknown> {
  return {
    event_id: STICKER_EVENT,
    room_id: SEEDED_ROOM,
    // MSC2545: a sticker is its OWN top-level event type, not an m.room.message.
    type: 'm.sticker',
    sender: SEEDED_ME,
    origin_server_ts: 1000,
    content: {
      body: STICKER_BODY,
      url: STICKER_MXC,
      info: { mimetype: 'image/png', w: 256, h: 256 },
    },
  };
}

/**
 * Seed every CS-API endpoint the chat shell touches so the room renders OFFLINE.
 * `withSticker` decides whether /messages carries the seeded m.sticker (render
 * scenario) or is empty (empty-picker scenario). Account-data is answered empty
 * so the sticker picker resolves NO pack → its empty state. Media requests
 * return a real PNG so fetchMediaObjectUrl yields a blob: object URL. /sync
 * answers empty and long-polls so the loop parks instead of busy-spinning.
 */
async function seedStickerRoom(page: Page, withSticker: boolean): Promise<void> {
  await page.route('**/_matrix/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/account/whoami')) return fulfillJson(route, { user_id: SEEDED_ME });
    if (url.includes('/joined_rooms')) return fulfillJson(route, { joined_rooms: [SEEDED_ROOM] });
    if (url.includes('/media/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX });
    }
    if (url.includes('/messages')) {
      return fulfillJson(route, { chunk: withSticker ? [stickerEvent()] : [], start: 's', end: '' });
    }
    if (url.includes('/joined_members')) {
      return fulfillJson(route, { joined: { [SEEDED_ME]: { display_name: 'Alice' } } });
    }
    if (url.includes('/relations')) return fulfillJson(route, { chunk: [] });
    if (url.includes('/sync')) {
      // No live delta needed — the render comes from /messages; long-poll parks.
      await new Promise((r) => setTimeout(r, 500));
      return fulfillJson(route, { next_batch: 's2', rooms: { join: {} } });
    }
    // getStateEvent (…/state/<type>/<key>) → a content object; roomState
    // (…/state) → the state-events array. The specific check runs first.
    if (url.includes('/state/')) return fulfillJson(route, {});
    if (/\/rooms\/[^/]+\/state(\?|$)/.test(url)) return fulfillJson(route, []);
    // Account-data (im.ponies.user_emotes → no pack), m.direct, everything else.
    return fulfillJson(route, {});
  });
}

When('{string} opens a seeded room whose history contains a sticker', async ({ page }, _username: string) => {
  await seedStickerRoom(page, true);
  // The '' route runs the /sync loop + loadInitial that hydrates media; deep
  // room routes do not. Park on the chat shell for the seeded room.
  await page.goto(`/?room=${encodeURIComponent(SEEDED_ROOM)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('matrix-log')).toBeVisible({ timeout: 15_000 });
  // The event row itself must render before the image oracle is asserted.
  await expect(page.locator(`[data-testid="event-${STICKER_EVENT}"]`)).toBeVisible({ timeout: 15_000 });
});

Then('the sticker image renders in the timeline with an accessible label', async ({ page }) => {
  const img = page.locator(`[data-testid="event-${STICKER_EVENT}"] [data-testid="sticker-${STICKER_EVENT}"]`);
  // hydrateMedia fetches the sticker mxc and sets a blob: object URL — poll it
  // into existence (the fetch resolves just after the initial render).
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect(img).toHaveJSProperty('tagName', 'IMG');
  await expect(img).toHaveAttribute('src', /^blob:/);
  // The accessible name carries the body AND the sender (stickerAlt()).
  const alt = (await img.getAttribute('alt')) ?? '';
  expect(alt).toContain(STICKER_BODY);
  expect(alt).toContain(SEEDED_ME);
});

Then('no duplicate plain-text row is shown for the sticker', async ({ page }) => {
  const row = page.locator(`[data-testid="event-${STICKER_EVENT}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  // The sticker body is the image's accessible name — the timeline must NOT
  // also render it as a .text span (which would double the sticker as text).
  await expect(row.locator('.text')).toHaveCount(0);
});

// ───────────────────────── OFFLINE picker empty state + Escape ─────────────────────────

When('{string} opens the sticker picker in a seeded room with no pack', async ({ page }, _username: string) => {
  await seedStickerRoom(page, false);
  await page.goto(`/?room=${encodeURIComponent(SEEDED_ROOM)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('composer')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('btn-sticker').click();
  await expect(page.getByTestId('composer-sticker-picker')).toBeVisible({ timeout: 15_000 });
});

Then('the sticker picker shows its empty state', async ({ page }) => {
  await expect(page.getByTestId('sticker-empty')).toBeVisible({ timeout: 15_000 });
  // The grid never rendered a tile (no pack) — an honest empty state, not a
  // hidden-but-present grid.
  await expect(page.locator('[data-testid="composer-sticker-picker"] button.sticker-btn')).toHaveCount(0);
});

Then('pressing Escape closes the picker and returns focus to the sticker button', async ({ page }) => {
  // Focus the empty-state note (tabindex=0) so its Escape handler fires — the
  // keyboard path a user who opened an empty picker actually takes.
  await page.getByTestId('sticker-empty').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('composer-sticker-picker')).toHaveCount(0);
  // APG close-returns-focus-to-trigger: the toggle is focused and collapsed.
  await expect(page.getByTestId('btn-sticker')).toBeFocused();
  await expect(page.getByTestId('btn-sticker')).toHaveAttribute('aria-expanded', 'false');
});

// ───────────────────────── @cluster live cross-user delivery ─────────────────────────

/** The set of sticker-<eventId> render testids currently in a page's timeline
 *  log (NOT the picker tiles, which live outside matrix-log). */
async function timelineStickerIds(page: Page): Promise<string[]> {
  const ids = await page.locator('[data-testid="matrix-log"] [data-testid^="sticker-"]').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).getAttribute('data-testid') ?? ''),
  );
  return ids.filter((id) => id.startsWith('sticker-'));
}

async function openChatShell(page: Page, roomId: string): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(roomId)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('matrix-log')).toBeVisible({ timeout: 15_000 });
}

When('{string} sends a sticker from her pack in the shared public room', async ({}, username: string) => {
  const page = pageFor(username);
  await openChatShell(page, PUBLIC_ROOM);
  const before = await timelineStickerIds(page);
  await page.getByTestId('btn-sticker').click();
  await expect(page.getByTestId('composer-sticker-picker')).toBeVisible({ timeout: 15_000 });
  // LIVE SEED PREMISE: alice's own VN pack must carry at least one sticker, or
  // the picker shows its empty state and there is no tile to click — this fails
  // loudly rather than green-washing.
  const firstTile = page.locator('[data-testid="composer-sticker-picker"] button.sticker-btn').first();
  await expect(firstTile, 'alice must have a registered VN sticker pack on the seed homeserver').toBeVisible({
    timeout: 15_000,
  });
  await firstTile.click();
  // The sender's OWN echo proves the sticker was actually sent: capture the NEW
  // sticker event id that appears in alice's timeline (honest oracle — a real
  // id she created, never a fabricated one).
  let newId = '';
  await expect
    .poll(
      async () => {
        const fresh = (await timelineStickerIds(page)).filter((id) => !before.includes(id));
        if (fresh.length) {
          newId = fresh[0];
          return true;
        }
        return false;
      },
      { timeout: 30_000, message: 'expected alice to see her own sent sticker echo in the timeline' },
    )
    .toBe(true);
  valueRegistry.set('sticker:event-id', newId.replace('sticker-', ''));
});

Then('the sticker appears in {string} timeline within {int} seconds', async ({}, username: string, seconds: number) => {
  const page = pageFor(username);
  const eventId = valueRegistry.get('sticker:event-id');
  if (!eventId) throw new Error('No captured sticker event id — send the sticker first.');
  await expect
    .poll(
      async () => {
        // Re-open the sync-driven shell each iteration so a fresh initial fetch
        // pulls the room's CURRENT history (a real server round-trip, never a
        // fixed sleep).
        await page.goto(`/?room=${encodeURIComponent(PUBLIC_ROOM)}`, { waitUntil: 'domcontentloaded' });
        try {
          await page.getByTestId('matrix-log').waitFor({ state: 'visible', timeout: 5_000 });
        } catch {
          return false;
        }
        return (await page.locator(`[data-testid="matrix-log"] [data-testid="sticker-${eventId}"]`).count()) > 0;
      },
      {
        timeout: seconds * 1000,
        message: `expected the sticker (event ${eventId}) to appear in ${username}'s timeline within ${seconds}s`,
      },
    )
    .toBe(true);
});
