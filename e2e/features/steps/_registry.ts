// Shared per-scenario state. playwright-bdd recreates the test instance for
// each scenario; the Before/After hooks in features/support/fixtures.ts reset
// these maps. Keys are usernames so a step can reference a seeded identity by
// name without threading a page/context through every step signature.

import { BrowserContext, Page } from '@playwright/test';

/** Per-username Page — the page the named identity's session was seeded into.
 *  Used by the cross-user isolation scenarios that run two identities in two
 *  separate contexts at once. */
export const pageRegistry = new Map<string, Page>();

/** Per-username BrowserContext — closed on teardown so a leaked tab does not
 *  carry a stale seeded session into the next scenario. */
export const ctxRegistry = new Map<string, BrowserContext>();

/** Per-scenario named values: unique message bodies, CAPTURED REAL room ids
 *  and CAPTURED REAL event ids (the honest-oracle rule — assert against ids
 *  the victim actually created / messages actually sent, never fabricated
 *  ones). Keyed by a scenario-chosen label such as `msg:hello`,
 *  `room:invite-only` or `event:to-redact`. */
export const valueRegistry = new Map<string, string>();

/** Last JSON body captured from a role-grant/revoke admin-bff call
 *  (role-grant-unlock-loop.feature's "the role response reports ..." assertion
 *  reads this). Module-global for the same reason as the maps above — cleared
 *  on scenario teardown. Mirrors admin-ui's own role-grant.feature convention
 *  (roleGrantState) so the two cross-referenced features stay recognisably
 *  parallel. */
export const roleGrantState = { lastBody: null as Record<string, unknown> | null };

/** The page a named persona's session was seeded into. Throws on a miss so a
 *  typo in a feature file fails loudly instead of acting as the wrong user. */
export function pageFor(username: string): Page {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No seeded context for "${username}" — seed it first.`);
  return page;
}

export function resetRegistry(): void {
  // Best-effort close of any extra contexts opened by multi-user scenarios.
  for (const ctx of ctxRegistry.values()) {
    void ctx.close().catch(() => {
      /* already closed */
    });
  }
  pageRegistry.clear();
  ctxRegistry.clear();
  valueRegistry.clear();
  roleGrantState.lastBody = null;
}
