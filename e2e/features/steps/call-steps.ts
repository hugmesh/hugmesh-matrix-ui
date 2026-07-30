// Step definitions for the Matrix WebRTC video call (matrix-call.component).
// Split by dependency, exactly like room-create:
//  * the OFFLINE scenario asserts the call view's client-side idle state — the
//    pre-await signal defaults (state='idle', turnAvailable=false) render before
//    ngOnInit's homeserver fetches resolve, so they hold with NO backend. Uses
//    the shared single-context `page` the "has a seeded session" Given seeds.
//  * the @cluster scenario drives the real 1:1 signalling handshake across two
//    seeded contexts (pageRegistry), where the RINGING transition is the honest
//    cross-user oracle (the callee's pump() read the caller's m.call.invite back
//    out of the live homeserver).

import { expect } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { ctxRegistry, pageFor, valueRegistry } from './_registry';

const PUBLIC_ROOM = process.env.E2E_PUBLIC_ROOM ?? '!e2e-public:tenant-a.test';

// ───────────────────────── offline: idle-state render ─────────────────────────

When('{string} opens the call view', async ({ page }, _username: string) => {
  // The standalone Matrix dev shell mounts MATRIX_ROUTES at the root, so /call
  // is browsable without the host shell or a homeserver.
  await page.goto('/call', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('call-view')).toBeVisible({ timeout: 15_000 });
});

Then('the call view shows the idle state', async ({ page }) => {
  // state() defaults to 'idle' and is rendered synchronously at construction,
  // before ngOnInit's whoami/joinedRooms fetches resolve — so this holds offline.
  await expect(page.getByTestId('call-state')).toHaveText('idle');
});

Then('the hang-up control is disabled while no call is in progress', async ({ page }) => {
  // [disabled]="state() === 'idle'" — with no call started, Hang up is always
  // gated. A pure client-state assertion independent of any backend response.
  await expect(page.getByTestId('call-hangup')).toBeDisabled();
});

Then('the call help surfaces the LAN-only capability note', async ({ page }) => {
  // callHelp appends the honest capability note whenever turnAvailable() is
  // false (no TURN relay advertised — the default, and unchangeable offline
  // since turnServer() degrades to []). Names the missing relay so a failed
  // WAN/NAT call is understood as a capability gap, not a bug.
  const help = page.getByTestId('call-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText(/TURN relay/i);
  await expect(help).toContainText(/host\/LAN-only/i);
});

// ───────────────────────── @cluster: the ringing handshake ─────────────────────────

When(
  '{string} opens the call view on the shared public room in their context',
  async ({}, username: string) => {
    const page = pageFor(username);
    // ?room= selects the room the call is placed into (matrix-call.component
    // reads it off the query param); both members joined it in earlier steps.
    await page.goto(`/call?room=${encodeURIComponent(PUBLIC_ROOM)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('call-view')).toBeVisible({ timeout: 15_000 });
    // The resolved room is reflected in the header — proves ?room= took effect
    // before any call action.
    await expect(page.getByTestId('call-room')).toContainText(PUBLIC_ROOM, { timeout: 15_000 });
  },
);

When('{string} starts a call in their context', async ({}, username: string) => {
  const page = pageFor(username);
  await page.getByTestId('call-start').click();
  // start() flips state to 'calling' before the async offer; it may progress
  // straight to 'connected' once the peer answers, so accept either.
  await expect(page.getByTestId('call-state')).toHaveText(/^(calling|connected)$/, { timeout: 15_000 });
});

Then(
  '{string} sees the call ringing in their context within {int} seconds',
  async ({}, username: string, seconds: number) => {
    // THE cross-user live oracle: this member's pump() read the OTHER member's
    // m.call.invite back out of the homeserver's /messages and flipped state to
    // 'ringing'. Cannot happen without the invite event round-tripping through
    // the live homeserver — a real backend observation, not a client echo.
    await expect(pageFor(username).getByTestId('call-state')).toHaveText('ringing', {
      timeout: seconds * 1000,
    });
  },
);

When('{string} joins the ringing call in their context', async ({}, username: string) => {
  const page = pageFor(username);
  // call-join is enabled only in the 'ringing' state — clicking it answers with
  // the callee's camera/mic and sends m.call.answer.
  await expect(page.getByTestId('call-join')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('call-join').click();
  await expect(page.getByTestId('call-state')).toHaveText(/^(calling|connected)$/, { timeout: 15_000 });
});

Then(
  '{string} and {string} both reach the connected call state within {int} seconds',
  async ({}, callerName: string, calleeName: string, seconds: number) => {
    // WebRTC completes over host/LAN ICE candidates (no TURN needed on the same
    // machine): both peer connections reach connectionState 'connected', which
    // matrix-call.component maps to state()='connected'.
    await expect(pageFor(callerName).getByTestId('call-state')).toHaveText('connected', {
      timeout: seconds * 1000,
    });
    await expect(pageFor(calleeName).getByTestId('call-state')).toHaveText('connected', {
      timeout: seconds * 1000,
    });
  },
);

// ───────────────────────── VN voice mode (vn-voice-call.feature) ─────────────────────────
// The offline steps mirror the video call's: ?mode=vn-voice is parsed
// synchronously, so the VN template branch (stage instead of tiles, scene
// tools, hidden audio sink) renders with NO backend.

When('{string} opens the VN voice call view', async ({ page }, _username: string) => {
  await page.goto('/call?mode=vn-voice', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('call-view')).toBeVisible({ timeout: 15_000 });
});

Then('the VN stage renders instead of the video tiles', async ({ page }) => {
  // The VN branch swaps the media surface: hug-vn-stage in, <video> tiles out.
  await expect(page.getByTestId('vn-stage')).toBeVisible();
  await expect(page.getByTestId('local-video')).toHaveCount(0);
  await expect(page.getByTestId('remote-video')).toHaveCount(0);
});

Then('the scene tools are available in the call view', async ({ page }) => {
  // The <details> host of hug-vn-scene-controls — collapsed by default, but
  // present so either member can redecorate mid-call.
  await expect(page.getByTestId('scene-tools')).toBeVisible();
});

When('{string} opens the shared public room by route', async ({ page }, _username: string) => {
  // rooms/:roomId renders its header offline (summary fetch fails soft; the
  // name falls back to the room id) — enough to assert the call entries.
  await page.goto(`/rooms/${encodeURIComponent(PUBLIC_ROOM)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('room-header')).toBeVisible({ timeout: 15_000 });
});

Then('the room header shows the VN voice chat and video call entries', async ({ page }) => {
  const vn = page.getByTestId('btn-call-vn-voice');
  const video = page.getByTestId('btn-call-video');
  await expect(vn).toBeVisible();
  await expect(video).toBeVisible();
  // Both land on the existing /call route carrying the room + render mode.
  await expect(vn).toHaveAttribute('href', /mode=vn-voice/);
  await expect(video).toHaveAttribute('href', /mode=video/);
});

// ───────── @cluster: the VN call handshake + shared-scene oracles ─────────

When(
  '{string} opens the VN voice call view on the shared public room in their context',
  async ({}, username: string) => {
    const page = pageFor(username);
    // Same entry as the video call's cluster step, plus mode=vn-voice.
    await page.goto(
      `/call?room=${encodeURIComponent(PUBLIC_ROOM)}&mode=vn-voice`,
      { waitUntil: 'domcontentloaded' },
    );
    await expect(page.getByTestId('call-view')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('call-room')).toContainText(PUBLIC_ROOM, { timeout: 15_000 });
    await expect(page.getByTestId('vn-stage')).toBeVisible();
  },
);

Then(
  '{string} sees {int} characters on the VN stage in their context within {int} seconds',
  async ({}, username: string, count: number, seconds: number) => {
    // Sprites appear once the call identifies both members (local user +
    // invite/answer sender) — sticker pack, avatar, or the neutral silhouette,
    // so the count holds whatever imagery each member has.
    await expect(pageFor(username).getByTestId('stage-sprite')).toHaveCount(count, {
      timeout: seconds * 1000,
    });
  },
);

When('{string} selects the scene {string} in their context', async ({}, username: string, sceneId: string) => {
  const page = pageFor(username);
  // Open the collapsed scene tools, then pick the scene tile — this PUTs the
  // systems.hugmesh.vn.scene room state through the BFF hsproxy.
  await page.getByTestId('scene-tools').locator('summary').click();
  await page.locator(`[data-testid="scene-tile"][data-scene-id="${sceneId}"]`).click();
});

Then(
  '{string} sees the scene {string} on the stage in their context within {int} seconds',
  async ({}, username: string, sceneId: string, seconds: number) => {
    // THE cross-user scene oracle: this member's 1Hz poll read the OTHER
    // member's systems.hugmesh.vn.scene state event back out of the live
    // homeserver and swapped the stage background to the manifest scene SVG.
    await expect(pageFor(username).getByTestId('scene-bg')).toHaveAttribute(
      'src', new RegExp(sceneId),
      { timeout: seconds * 1000 },
    );
  },
);

// ───────── @cluster: the dialogue-box oracle (message → stage caption) ─────────

When(
  '{string} sends the unique dialogue message {string} to the shared public room from a second tab',
  async ({}, username: string, label: string) => {
    // A SECOND TAB in the sender's own seeded context (same session/cookies):
    // the call view has no composer, so the in-call message rides the normal
    // chat shell. Unique body per run — a dialogue match can only come from
    // THIS scenario's send (the suite-wide honest-oracle rule).
    const ctx = ctxRegistry.get(username);
    if (!ctx) throw new Error(`No seeded context for "${username}" — seed it first.`);
    const unique = `${label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    valueRegistry.set(`msg:${label}`, unique);
    const tab = await ctx.newPage();
    try {
      await tab.goto(`/?room=${encodeURIComponent(PUBLIC_ROOM)}`, { waitUntil: 'domcontentloaded' });
      await expect(tab.getByTestId('matrix-log')).toBeVisible({ timeout: 15_000 });
      await tab.getByTestId('matrix-input').fill(unique);
      await tab.getByTestId('matrix-send').click();
      // Send-completion oracle before closing the tab: the sender's own live
      // timeline echoes the unique body back from the homeserver.
      await expect(tab.getByTestId('matrix-log')).toContainText(unique, { timeout: 30_000 });
    } finally {
      await tab.close();
    }
  },
);

Then(
  '{string} sees the dialogue message {string} in the stage dialogue box in their context within {int} seconds',
  async ({}, username: string, label: string, seconds: number) => {
    // THE dialogue oracle: this member's 1Hz poll pulled the OTHER tab's
    // m.room.message back out of the live homeserver and projected it into
    // the stage's VN caption bar.
    const unique = valueRegistry.get(`msg:${label}`);
    if (!unique) throw new Error(`No unique dialogue message recorded for "${label}" — send it first.`);
    await expect(pageFor(username).getByTestId('dialogue-text')).toContainText(unique, {
      timeout: seconds * 1000,
    });
  },
);

Then('the stage dialogue box is announced politely in {string} context', async ({}, username: string) => {
  // The projected wrapper (which only exists once a line rendered — asserted
  // by the previous step) is a polite live region, so SR users hear captions.
  const live = pageFor(username).locator('.dialogue-live');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveAttribute('aria-live', 'polite');
});
