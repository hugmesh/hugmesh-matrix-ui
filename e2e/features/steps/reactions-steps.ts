// Step definitions for emoji reactions (@cluster). A reaction is a real
// m.annotation round-trip — sendReaction to add, redactEvent of the caller's
// own reaction to remove (reaction-picker.component.ts pick()), surfaced by
// getRelations aggregation into the pill + count
// (timeline.component.ts aggregateReactions). Reuses the shared-public-room
// convention and the `msg:<label>` valueRegistry keys messaging-steps.ts's
// send steps populate, so scenarios freely mix steps from both files.
//
// HONEST-ORACLE notes:
//  * the reactor's OWN pill assertions run after her awaited send/redact, so
//    her page reflects the completed write; the CROSS-USER pill assertions
//    re-fetch fresh from the server each poll iteration (a reload-based poll,
//    never a fixed sleep), reading the aggregated getRelations state — so a
//    match can only come from a real server-persisted annotation;
//  * removal (redact) is proven cross-user only AFTER the reactor's redact was
//    server-acknowledged (awaited), and the remaining reactor's contribution
//    keeps the count at exactly 1 — never a bare timeout-and-hope.

import { expect, Locator, Page } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { pageFor, valueRegistry } from './_registry';

const PUBLIC_ROOM = process.env.E2E_PUBLIC_ROOM ?? '!e2e-public:tenant-a.test';

/** The remembered unique body for a scenario message label (written by
 *  messaging-steps.ts's send steps). Throws on a miss so an out-of-order
 *  feature fails loudly. */
function msgFor(label: string): string {
  const v = valueRegistry.get(`msg:${label}`);
  if (!v) throw new Error(`No unique message recorded for label "${label}" — send it first.`);
  return v;
}

/** Open the deep room route (RoomViewComponent → TimelineComponent) so a fresh
 *  history fetch runs aggregateReactions and renders the reaction pills off the
 *  server's current getRelations state. Returns the target message's row. */
async function rowForMessage(page: Page, body: string): Promise<Locator> {
  const row = page.locator('[data-testid="matrix-log"] li.event').filter({ hasText: body }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

/** Parse the trailing count off a reaction pill's rendered text ("👍 2"). */
function pillCount(text: string): number {
  const m = text.trim().match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

// ───────────────────────── react (open picker → pick) ─────────────────────────

When(
  '{string} reacts to the message {string} with {string}',
  async ({}, username: string, label: string, emoji: string) => {
    const page = pageFor(username);
    await page.goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
    const row = await rowForMessage(page, msgFor(label));
    // The per-message action group is hover-revealed (timeline.component.scss
    // `.event:hover .actions`), so hover the row before reaching for React.
    await row.hover();
    const react = row.locator('[data-testid^="btn-react-"]');
    await expect(react).toBeVisible({ timeout: 15_000 });
    // Client-side APG oracle: opening flips the trigger's aria-expanded and
    // mounts the role=menu reaction picker (reaction-picker.component.ts).
    await expect(react).toHaveAttribute('aria-expanded', 'false');
    await react.click();
    await expect(react).toHaveAttribute('aria-expanded', 'true');
    const picker = row.locator('[data-testid="reaction-picker"]');
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute('role', 'menu');
    await picker.locator(`[data-testid="emoji-${emoji}"]`).click();
    // The picker closing (onReacted sets pickerFor null) is a real UI-state
    // oracle that the sendReaction round-trip resolved — not a fixed sleep.
    await expect(react).toHaveAttribute('aria-expanded', 'false', { timeout: 15_000 });
  },
);

When(
  '{string} removes their {string} reaction on the message {string}',
  async ({}, username: string, emoji: string, label: string) => {
    const page = pageFor(username);
    await page.goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
    const row = await rowForMessage(page, msgFor(label));
    const pill = row.locator(`[data-testid="reaction-pill-${emoji}"]`);
    // Precondition oracle: the pill must currently read as THIS viewer's own
    // reaction, so the click provably redacts her annotation (not a no-op).
    await expect(pill).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    await pill.click();
    // toggleReaction awaits redactEvent then re-aggregates — the pill drops to
    // not-mine (the remaining reactor keeps it rendered).
    await expect(pill).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
  },
);

// ───────────────────────── pill count + ownership (cross-user, fresh fetch) ─────────────────────────

Then(
  '{string} sees the {string} reaction on the message {string} with count {int} within {int} seconds',
  async ({}, username: string, emoji: string, label: string, count: number, seconds: number) => {
    const page = pageFor(username);
    const body = msgFor(label);
    await expect
      .poll(
        async () => {
          await page.goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
          try {
            await page.getByTestId('matrix-log').waitFor({ state: 'visible', timeout: 5_000 });
          } catch {
            return -1;
          }
          const row = page.locator('[data-testid="matrix-log"] li.event').filter({ hasText: body }).first();
          if ((await row.count()) === 0) return -1;
          const pill = row.locator(`[data-testid="reaction-pill-${emoji}"]`);
          if ((await pill.count()) === 0) return 0;
          return pillCount(await pill.innerText());
        },
        {
          timeout: seconds * 1000,
          message: `expected ${username} to see the "${emoji}" reaction on "${label}" with count ${count} within ${seconds}s`,
        },
      )
      .toBe(count);
  },
);

Then(
  '{string} sees the {string} reaction on the message {string} marked as their own',
  async ({}, username: string, emoji: string, label: string) => {
    const page = pageFor(username);
    await page.goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
    const row = await rowForMessage(page, msgFor(label));
    const pill = row.locator(`[data-testid="reaction-pill-${emoji}"]`);
    await expect(pill).toBeVisible({ timeout: 15_000 });
    // aria-pressed is derived per-viewer from rx.myEventId (the caller's own
    // annotation), re-resolved on this fresh fetch — proves server-side that
    // THIS identity owns a reaction with this key.
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  },
);

Then(
  '{string} sees the {string} reaction on the message {string} not marked as their own',
  async ({}, username: string, emoji: string, label: string) => {
    const page = pageFor(username);
    await page.goto(`/rooms/${PUBLIC_ROOM}`, { waitUntil: 'domcontentloaded' });
    const row = await rowForMessage(page, msgFor(label));
    const pill = row.locator(`[data-testid="reaction-pill-${emoji}"]`);
    // The pill must be rendered (otherwise "not mine" proves nothing) AND read
    // as not this viewer's own reaction.
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
  },
);
