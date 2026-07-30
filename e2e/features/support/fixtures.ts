// playwright-bdd extends Playwright's `test` with a BDD World. We publish
// `test`/`expect` from here so every step file imports through one channel.
// The custom fixture surface stays small — the World is the page + a way to
// look up seed users by their CLI-friendly username (mirroring the proven
// hugmesh.games / admin-ui / login-ui e2e Worlds).
//
// Hook registration (Before/After/AfterStep) is also inlined here.
// playwright-bdd's createBdd(test) returns hook factories that MUST be called
// against the very same test instance the generated specs use. Splitting hook
// calls across multiple files (especially when each loads independently via
// the steps[] glob) can race — the symptom is hooks that never fire even
// though they're registered.

import { test as base, createBdd } from 'playwright-bdd';
import { SEED_USERS, SeedUser } from '../../tests/helpers/roles';
import { resetRegistry } from '../steps/_registry';

interface UserLookup {
  /** Resolve a seed user by username. Throws on miss so a typo in a feature
   *  file fails loudly instead of silently acting as whoever the previous
   *  step happened to leave us as. */
  user(username: string): SeedUser;
}

export const test = base.extend<UserLookup>({
  user: async ({}, use) => {
    await use((username: string) => {
      const found = SEED_USERS.find((u) => u.username === username);
      if (!found) {
        throw new Error(
          `Unknown seed user: "${username}". Known: ${SEED_USERS.map((u) => u.username).join(', ')}`,
        );
      }
      return found;
    });
  },
});

export const { Given, When, Then, Step, Before, After, BeforeStep, AfterStep, BeforeAll, AfterAll } =
  createBdd(test);

// ─── Step-level screenshot capture ─────────────────────────────────
// Every step gets a PNG attached to the HTML report, so a reviewer can see the
// UI state at every transition without re-running.

let stepCounter = 0;

Before(async () => {
  stepCounter = 0;
  resetRegistry();
});

AfterStep(async ({ page, $step, $testInfo }) => {
  stepCounter += 1;
  // Path-based attach. Body-based attachments (in-memory Buffer) succeed at
  // attach time but Playwright's HTML reporter only persists path-based ones
  // into html/data — body attachments never become viewable assets in the
  // final report. Write the screenshot under testInfo.outputDir so the runner
  // tracks it as a real file, then attach by path.
  try {
    const stepTitle = ($step as { title?: string })?.title ?? `step-${stepCounter}`;
    const safeName = `${String(stepCounter).padStart(2, '0')}-${stepTitle}`
      .replace(/[^a-z0-9_-]+/gi, '-')
      .slice(0, 80);
    const filePath = $testInfo.outputPath(`${safeName}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    await $testInfo.attach(`step ${safeName}`, { path: filePath, contentType: 'image/png' });
  } catch {
    // Page closed mid-step (e.g. context torn down) — drop silently.
  }
});

After(async () => {
  // Reset the per-scenario role/page registry so a seeded session does not
  // bleed into the next scenario's role matrix.
  resetRegistry();
  stepCounter = 0;
});
