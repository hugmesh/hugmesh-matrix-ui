import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

// The Matrix remote's standalone dev shell (`ng serve matrix`) mounts the
// exposed MATRIX_ROUTES at the root, so /moderation, /settings, /search are
// browsable without the host shell or a live homeserver. In CI the e2e:bdd job
// points E2E_BASE_URL at whatever serves the built `dist/matrix` (or the host
// shell at /social/matrix). The role-gated moderation surfaces read their tier
// purely from `localStorage['hug.session']`, so the USER/MOD/ADMIN/banned
// matrix runs WITHOUT a cluster — only the scenarios that talk to the live
// homeserver / BFF carry the `@cluster` tag (the platform-wide convention —
// mirrors admin/mod/mastodon/user/wiki/tube/owncast-ui) and are filtered out
// below.
const baseURL = process.env.E2E_BASE_URL ?? 'https://host.docker.internal:8080';

// playwright-bdd compiles every .feature under features/ into a generated
// .spec.js, picks them up via `testDir`, and wires the World fixture +
// hooks from features/support/fixtures.ts. Step definitions live under
// features/steps/.
const bddTestDir = defineBddConfig({
  features: 'features/**/*.feature',
  steps: [
    'features/steps/**/*.ts',
    'features/support/**/*.ts',
  ],
  // Cucumber tag-expression filter — the platform-majority `not @cluster`
  // convention (a plain filter tag, deliberately NOT playwright-bdd's reserved
  // `@skip`, which would remove scenarios from generation entirely). The
  // default `bddgen` + `playwright test --list` discovers the offline set with
  // NOTHING requiring a live stack; a no-filter config (tags: '') generates and
  // lists EVERY scenario, proving all the Gherkin compiles. Run the @cluster
  // set with that override plus a real E2E_BASE_URL.
  tags: 'not @cluster',
});

export default defineConfig({
  // Single-worker. The role/seed-user World writes the shared
  // `localStorage['hug.session']` key per scenario; serial execution keeps
  // role swaps deterministic and matches the proven games/login/admin e2e
  // matrices (per-role Casdoor login contends on a small dev stack).
  fullyParallel: false,
  workers: 1,
  // One retry catches a rare federation/init flake without papering over a
  // real regression — a deterministic bug fails twice in a row.
  retries: 1,
  timeout: 180_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: '/work/results/html', open: 'never' }],
  ],
  outputDir: '/work/results/artifacts',
  use: {
    baseURL,
    // Accept the e2e self-signed cert without rejecting.
    ignoreHTTPSErrors: true,
    // Trace + per-step PNG + video forced ON so the artefact harvest always
    // has a granular per-step shot plus a full webm to scrub.
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'on',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      // BDD project — generated specs from .feature files plus their step
      // definitions and the role/seed-user World.
      name: 'bdd',
      testDir: bddTestDir,
      use: {
        ...devices['Desktop Chrome'],
        // Synthetic camera/mic so the @cluster WebRTC call handshake's
        // getUserMedia resolves headlessly without a permission prompt. Inert
        // for every other scenario — nothing else touches getUserMedia — so it
        // is safe to set project-wide.
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
});
