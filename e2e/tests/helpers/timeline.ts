import { Page, expect } from '@playwright/test';

/**
 * Sync-aware timeline waits for the CROSS-USER scenarios (one persona acts,
 * another persona's context must observe it). The chat shell ('' route,
 * `/?room=<id>`) drives its timeline off the /sync long-poll loop
 * (matrix-chat.component.ts syncLoop), so a message another member sent
 * arrives ASYNCHRONOUSLY — these helpers poll the rendered `matrix-log`
 * instead of ever sleeping a fixed interval (the platform standard bans bare
 * waitForTimeout for cross-user waits).
 */

/** The rendered text of the page's message timeline ('' when not mounted). */
async function timelineText(page: Page): Promise<string> {
  const log = page.getByTestId('matrix-log');
  if ((await log.count()) === 0) return '';
  try {
    return await log.innerText();
  } catch {
    return '';
  }
}

/**
 * Poll until `text` is rendered in the page's message timeline — "X appears in
 * <ctx>'s timeline within N seconds". Sync-aware: no reload, the assertion
 * rides the page's own /sync loop.
 */
export async function expectMessageInTimeline(page: Page, text: string, withinSeconds = 30): Promise<void> {
  await expect
    .poll(() => timelineText(page), {
      timeout: withinSeconds * 1000,
      message: `expected "${text}" to appear in the timeline within ${withinSeconds}s`,
    })
    .toContain(text);
}

/**
 * HONEST absence: proving a message NEVER arrives needs an ordering oracle, so
 * the caller first sends a later CANARY message that IS expected to arrive.
 * Once the canary is rendered (the sync stream has progressed past the point
 * the forbidden message would have appeared), the forbidden text must be
 * absent. Never a bare timeout-and-hope.
 */
export async function expectMessageAbsentAfterCanary(
  page: Page,
  absentText: string,
  canaryText: string,
  withinSeconds = 30,
): Promise<void> {
  await expectMessageInTimeline(page, canaryText, withinSeconds);
  expect(await timelineText(page), `"${absentText}" must never appear (canary "${canaryText}" already arrived)`).not.toContain(absentText);
}

/**
 * Poll (RELOAD-based) until the event `eventId` (the REAL id captured when the
 * redact control was clicked) shows as REDACTED in this page's timeline: the
 * original body text is gone AND the redacted placeholder is rendered INSIDE
 * that event's own row. Scoping the marker to the target row matters — the
 * persistent shared room accumulates "(message deleted)" markers across runs
 * and scenarios, so a page-wide marker count would be vacuously satisfied.
 * Reload-based because a redaction of an ALREADY-RENDERED event is applied by
 * the homeserver stripping the content on the next /messages fetch
 * (unsigned.redacted_because → TimelineEvent.redacted), not by the live
 * append-only sync feed.
 */
export async function expectRedactedInTimeline(page: Page, text: string, eventId: string, withinSeconds = 30): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const log = page.getByTestId('matrix-log');
        try {
          await log.waitFor({ state: 'visible', timeout: 5_000 });
        } catch {
          return 'timeline-not-mounted';
        }
        const body = await timelineText(page);
        if (body.includes(text)) return 'original-body-still-visible';
        const row = page.locator(`[data-testid="event-${eventId}"]`);
        if ((await row.count()) === 0) return 'target-event-row-missing';
        const placeholders = await row.locator('[data-testid="redacted-marker"]').count();
        return placeholders > 0 ? 'redacted' : 'no-redacted-placeholder-on-target-row';
      },
      {
        timeout: withinSeconds * 1000,
        message: `expected event ${eventId} ("${text}") to show as a redacted placeholder in its own row within ${withinSeconds}s`,
      },
    )
    .toBe('redacted');
}
