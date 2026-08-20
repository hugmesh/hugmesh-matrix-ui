// Step definitions for the shared VN scene's trust boundary
// (vn-scene-moderation.feature). OFFLINE: the guard lives on the RECEIVE path
// (vn/scenes/vn-scene-moderation.ts, applied by
// VnSceneStateService.getModeratedSceneState), so the room's
// `m.room.power_levels` and `net.hugmesh.vn.scene` state events are seeded via
// route-fulfilment and swapped mid-scenario — the call view's 1Hz pump re-reads
// them exactly as it would against a homeserver.
//
// Seeding is not a shortcut here, it is the only honest way to reach the case:
// a homeserver that ENFORCES the power level would refuse the hostile write, so
// the state under test is precisely the one a live server cannot be asked to
// produce. What the client must survive is a room where the write DID land
// (a mis-configured `state_default`, an older room preset, a compromised
// server) — and that is what these fixtures stage.
//
// Both scenarios avoid timeout-and-hope: the seeded route COUNTS the state
// reads, so every assertion waits on proven re-reads rather than a sleep.

import { expect, Page, Route } from '@playwright/test';
import { When, Then } from '../support/fixtures';

const SEEDED_ROOM = '!vn-moderated:tenant-a.test';
const SEEDED_ME = '@user-alice:tenant-a.test';
/** A room MODERATOR — power level 50, the guard's floor. */
const MODERATOR = '@mod-mallory:tenant-a.test';
/** A plain member — power level 0 via `users_default`, below the floor. */
const HOSTILE = '@user-eve:tenant-a.test';

/** SceneRateLimiter's defaults (vn/scenes/vn-scene-moderation.ts) — the burst
 *  budget this feature asserts the stage holds to: at most 3 applied scene
 *  changes per sliding 5-second window. */
const SCENE_BURST_MAX_PER_WINDOW = 3;
const SCENE_BURST_WINDOW_MS = 5_000;

/** Scenes served in the rate-limit burst (manifest ids, so each resolves to a
 *  real background <img src> the stage can actually swap to). */
const BURST_SCENES = [
  'vn_scene_bedroom',
  'vn_scene_classroom',
  'vn_scene_cafe',
  'vn_scene_forest_park',
  'vn_scene_beach_sunset',
  'vn_scene_night_city',
  'vn_scene_castle_hall',
  'vn_scene_starship',
];

/** The scene state event the seeded room currently holds; swapped by the steps. */
let currentScene: { sender: string; sceneId: string } = { sender: MODERATOR, sceneId: '' };
/** How many times the app has re-read `/rooms/{id}/state` (the poll oracle). */
let stateReads = 0;
/** Whether the room serves a NEW scene on every state read (the burst fixture). */
let flipEveryRead = false;
/** Every scene the burst fixture has served, one per state read (the list
 *  CYCLES through BURST_SCENES, so these are flips served, not distinct ids). */
let servedScenes: string[] = [];

async function fulfillJson(route: Route, obj: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
}

/** The room's full state: power levels (moderator 50, everyone else 0) plus the
 *  current `net.hugmesh.vn.scene` event with whatever SENDER the scenario set. */
function roomStateEvents(): Record<string, unknown>[] {
  return [
    {
      event_id: '$vn-mod-powers',
      room_id: SEEDED_ROOM,
      type: 'm.room.power_levels',
      state_key: '',
      sender: MODERATOR,
      content: { users: { [MODERATOR]: 50 }, users_default: 0, events: {}, state_default: 50 },
    },
    {
      event_id: '$vn-mod-scene',
      room_id: SEEDED_ROOM,
      type: 'net.hugmesh.vn.scene',
      state_key: '',
      sender: currentScene.sender,
      content: { sceneId: currentScene.sceneId, props: [] },
    },
  ];
}

/**
 * Seed every CS-API endpoint the VN call view touches so it runs OFFLINE: the
 * identity, the room list, an empty TURN/message feed, the roster — and the
 * room STATE, which is the fixture under test. Each state read is counted (and,
 * for the burst scenario, answers with the NEXT scene) so the steps can wait on
 * proven re-reads instead of sleeping.
 */
async function seedModeratedRoom(page: Page): Promise<void> {
  stateReads = 0;
  servedScenes = [];
  await page.route('**/_matrix/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/account/whoami')) return fulfillJson(route, { user_id: SEEDED_ME });
    if (url.includes('/joined_rooms')) return fulfillJson(route, { joined_rooms: [SEEDED_ROOM] });
    if (url.includes('/turnServer')) return fulfillJson(route, { uris: [] });
    if (url.includes('/messages')) return fulfillJson(route, { chunk: [], start: 's', end: '' });
    if (url.includes('/joined_members')) {
      return fulfillJson(route, { joined: { [SEEDED_ME]: { display_name: 'Alice' } } });
    }
    // getStateEvent (…/state/<type>/<key>) → a content object; roomState
    // (…/state) → the state-events array. The specific check runs first.
    if (url.includes('/state/')) return fulfillJson(route, {});
    if (/\/rooms\/[^/]+\/state(\?|$)/.test(url)) {
      if (flipEveryRead) {
        // A seizing (but AUTHORIZED) driver: a different scene every single poll.
        currentScene = { sender: MODERATOR, sceneId: BURST_SCENES[servedScenes.length % BURST_SCENES.length] };
        servedScenes.push(currentScene.sceneId);
      }
      stateReads += 1;
      return fulfillJson(route, roomStateEvents());
    }
    if (url.includes('/sync')) {
      await new Promise((r) => setTimeout(r, 1200));
      return fulfillJson(route, { next_batch: 's2', rooms: { join: {} } });
    }
    return fulfillJson(route, {});
  });
}

/** One background the stage actually showed, and when. */
interface AppliedScene {
  src: string;
  t: number;
}

/**
 * Record EVERY background the stage ever shows, with its timestamp, so the
 * coalesce assertions count applied scenes exactly instead of sampling for
 * them. Installed before navigation; the observer watches both the scene-bg
 * <img> appearing and its src changing.
 *
 * The observation target is `document`, NOT `document.documentElement` — an
 * init script runs before the document element exists, so observing the latter
 * throws and silently loses the whole recording.
 */
async function recordAppliedScenes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const applied: { src: string; t: number }[] = [];
    (window as unknown as { __appliedScenes: typeof applied }).__appliedScenes = applied;
    const note = () => {
      const src = document.querySelector('[data-testid="scene-bg"]')?.getAttribute('src') ?? '';
      if (src && applied[applied.length - 1]?.src !== src) {
        applied.push({ src, t: Date.now() });
      }
    };
    new MutationObserver(note).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    note();
  });
}

/** The backgrounds the stage has shown so far, in order. */
async function appliedScenes(page: Page): Promise<AppliedScene[]> {
  return page.evaluate(
    () => (window as unknown as { __appliedScenes: AppliedScene[] }).__appliedScenes ?? [],
  );
}

async function openVnCall(page: Page): Promise<void> {
  await page.goto(`/call?room=${encodeURIComponent(SEEDED_ROOM)}&mode=vn-voice`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByTestId('call-view')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('vn-stage')).toBeVisible({ timeout: 15_000 });
}

// ───────────────────────── power-level guard ─────────────────────────

When('{string} opens the VN call view on a room staged by a moderator', async ({ page }, _username: string) => {
  currentScene = { sender: MODERATOR, sceneId: 'vn_scene_cafe' };
  flipEveryRead = false;
  await recordAppliedScenes(page);
  await seedModeratedRoom(page);
  await openVnCall(page);
});

Then('the stage shows the moderator\'s scene {string}', async ({ page }, sceneId: string) => {
  await expect(page.getByTestId('scene-bg')).toHaveAttribute('src', new RegExp(sceneId), { timeout: 20_000 });
});

When(
  'a below-power-level member overwrites the room\'s scene with {string}',
  async ({}, sceneId: string) => {
    // The write a hostile member lands when the room's own levels let them:
    // a DIFFERENT scene, from a sender at users_default 0.
    currentScene = { sender: HOSTILE, sceneId };
  },
);

When('the moderator stages {string} instead', async ({}, sceneId: string) => {
  currentScene = { sender: MODERATOR, sceneId };
});

When('the call view has re-read the room state {int} more times', async ({}, times: number) => {
  // ORDERING ORACLE: wait until the app has genuinely re-fetched the room state
  // this many times since now — never a bare sleep. The count is incremented by
  // the seeded route itself, so it can only advance on a REAL poll.
  const target = stateReads + times;
  await expect
    .poll(() => stateReads, {
      timeout: 30_000,
      message: `expected ${times} further room-state polls (at ${stateReads}, want ${target})`,
    })
    .toBeGreaterThanOrEqual(target);
});

Then('the stage still shows the moderator\'s scene {string}', async ({ page }, sceneId: string) => {
  // The hostile scene was served on every poll counted above and never applied:
  // the stage is STILL the moderator's, and the "last good scene kept" contract
  // means no intermediate hostile frame was rendered either.
  await expect(page.getByTestId('scene-bg')).toHaveAttribute('src', new RegExp(sceneId));
  const applied = await appliedScenes(page);
  expect(
    applied.filter((a) => a.src.includes('vn_scene_starship')).map((a) => a.src),
    'a below-power-level sender\'s scene must never reach the stage',
  ).toEqual([]);
});

// ───────────────────────── rate limit / coalesce ─────────────────────────

When(
  '{string} opens the VN call view on a room whose moderator flips the scene every poll',
  async ({ page }, _username: string) => {
    currentScene = { sender: MODERATOR, sceneId: BURST_SCENES[0] };
    flipEveryRead = true;
    await recordAppliedScenes(page);
    await seedModeratedRoom(page);
    await openVnCall(page);
  },
);

Then('the stage applied strictly fewer scenes than the room served', async ({ page }) => {
  const applied = await appliedScenes(page);
  const served = servedScenes.length;
  expect(served, 'the burst fixture must have served several flips').toBeGreaterThan(4);
  // The sender clears the power-level guard, so ONLY the burst coalescer can be
  // holding changes back. Without SceneRateLimiter every served flip would land.
  expect(
    applied.length,
    `expected the coalescer to drop flips: ${applied.length} applied of ${served} served`,
  ).toBeLessThan(served);
  // Non-vacuous the other way too: the stage is live, not simply dead.
  expect(applied.length, 'the stage must still be applying SOME scenes').toBeGreaterThan(0);
  // And the CONTRACT itself (SceneRateLimiter's default 3 changes per 5s
  // window), asserted on the recorded timestamps rather than inferred from the
  // totals: no 5-second span may hold more than 3 applied changes.
  for (const start of applied) {
    const inWindow = applied.filter((a) => a.t >= start.t && a.t < start.t + SCENE_BURST_WINDOW_MS);
    expect(
      inWindow.length,
      `${inWindow.length} scenes applied within ${SCENE_BURST_WINDOW_MS}ms of ${start.src}`,
    ).toBeLessThanOrEqual(SCENE_BURST_MAX_PER_WINDOW);
  }
});

Then('the stage is still showing one of the served scenes', async ({ page }) => {
  const src = (await page.getByTestId('scene-bg').getAttribute('src')) ?? '';
  expect(
    BURST_SCENES.some((id) => src.includes(id)),
    `stage background "${src}" should be one of the served scenes`,
  ).toBeTruthy();
});
