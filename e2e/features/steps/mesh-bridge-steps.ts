// Step definitions for the Meshtastic LoRa-mesh bridge (mesh-bridge.feature).
// All OFFLINE — both surfaces are pure renders off server-held state, so every
// source is seeded via route-fulfilment (the read-receipts-steps.ts pattern)
// and nothing here needs a homeserver, a BFF or a bridge appservice:
//
//  * TIMELINE — the "via LoRa mesh" chip is derived purely from the event
//    (an `@mesh-*` sender and/or a `com.hugmesh.mesh` fragment), so a seeded
//    /messages page proves the whole badge path through the rendered DOM.
//  * USER SETTINGS — My Mesh Devices renders the `/bff/user/mesh-devices` rows;
//    the claim/visibility/release verbs are asserted on the REQUESTS they send
//    (captured by the same fulfilment), never on a fabricated echo.
//
// The third mesh surface — the room-settings bridge toggle — is deliberately
// NOT covered here; see mesh-bridge.feature's header for the change-detection
// defect that blocks it.
//
// The node id in every fixture is a radio's SELF-REPORTED identity — that is
// the point of the caution copy these steps assert.

import { expect, Page, Route } from '@playwright/test';
import { When, Then } from '../support/fixtures';

// ───────────────────────── shared fixtures ─────────────────────────

const SEEDED_ROOM = '!mesh-bridged:tenant-a.test';
const SEEDED_ALICE = '@user-alice:tenant-a.test';

/** The bridge radio the fixtures relay through (the room's configured device). */
const BRIDGE_DEVICE = 'basecamp';
/** Meshtastic channel slot the fixtures' packets arrive on. */
const BRIDGE_CHANNEL = 5;

/** Timeline fixture: one radio-bridged message, one ordinary one. */
const MESH_EVENT = '$mesh-bridged-message';
const PLAIN_EVENT = '$mesh-ordinary-message';
const MESH_NODE = '!a1b2c3d4';
const MESH_SENDER = '@mesh-a1b2c3d4:tenant-a.test';

/** My Mesh Devices fixture: one active radio and one revoked one. */
const ACTIVE_DEVICE_ID = 'dev-active-1';
const REVOKED_DEVICE_ID = 'dev-revoked-1';
const REVOKE_REASON = 'reported spoofing another node';

/** Mesh-device WRITES captured off the seeded BFF route (method + path + body),
 *  so the claim/visibility/release assertions read what the app actually sent. */
interface MeshWrite {
  method: string;
  path: string;
  body: unknown;
}
let meshWrites: MeshWrite[] = [];

async function fulfillJson(route: Route, obj: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
}

// ───────────────────────── the timeline provenance badge ─────────────────────────

function meshMessageEvent(): Record<string, unknown> {
  return {
    event_id: MESH_EVENT,
    room_id: SEEDED_ROOM,
    type: 'm.room.message',
    sender: MESH_SENDER,
    origin_server_ts: 1000,
    content: {
      msgtype: 'm.text',
      body: 'mesh-bridge radio hello',
      // The provenance fragment the bridge appservice attaches. Node ids are
      // NOT authenticated — the badge title says so, and this test asserts it.
      'com.hugmesh.mesh': {
        node: MESH_NODE,
        device: BRIDGE_DEVICE,
        channel: BRIDGE_CHANNEL,
        registered: true,
        rssi: -95,
        snr: 5.5,
      },
    },
  };
}

function plainMessageEvent(): Record<string, unknown> {
  return {
    event_id: PLAIN_EVENT,
    room_id: SEEDED_ROOM,
    type: 'm.room.message',
    sender: SEEDED_ALICE,
    origin_server_ts: 2000,
    content: { msgtype: 'm.text', body: 'mesh-bridge ordinary hello' },
  };
}

When(
  '{string} opens a seeded room holding one radio-bridged and one ordinary message',
  async ({ page }, _username: string) => {
    await page.route('**/_matrix/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/account/whoami')) return fulfillJson(route, { user_id: SEEDED_ALICE });
      if (url.includes('/joined_rooms')) return fulfillJson(route, { joined_rooms: [SEEDED_ROOM] });
      if (url.includes('/messages')) {
        // dir=b returns newest-first; the timeline re-sorts by origin_server_ts.
        return fulfillJson(route, { chunk: [plainMessageEvent(), meshMessageEvent()], start: 's', end: '' });
      }
      if (url.includes('/joined_members')) {
        return fulfillJson(route, {
          joined: { [SEEDED_ALICE]: { display_name: 'Alice' }, [MESH_SENDER]: { display_name: 'mesh a1b2c3d4' } },
        });
      }
      if (url.includes('/relations')) return fulfillJson(route, { chunk: [] });
      if (url.includes('/sync')) {
        await new Promise((r) => setTimeout(r, 1200));
        return fulfillJson(route, { next_batch: 's2', rooms: { join: {} } });
      }
      if (url.includes('/state/')) return fulfillJson(route, {});
      if (/\/rooms\/[^/]+\/state(\?|$)/.test(url)) return fulfillJson(route, []);
      return fulfillJson(route, {});
    });
    // The '' chat shell renders the timeline for the seeded room.
    await page.goto(`/?room=${encodeURIComponent(SEEDED_ROOM)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('matrix-log')).toBeVisible({ timeout: 15_000 });
    // BOTH rows must be rendered before the badge's presence/absence is judged,
    // otherwise "no badge on the ordinary one" would be vacuously true.
    await expect(page.locator(`[data-testid="event-${MESH_EVENT}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`[data-testid="event-${PLAIN_EVENT}"]`)).toBeVisible({ timeout: 15_000 });
  },
);

Then(
  'the bridged message carries the "via LoRa mesh" badge naming node {string}',
  async ({ page }, node: string) => {
    const badge = page.locator(`[data-testid="event-${MESH_EVENT}"] [data-testid="mesh-badge-${MESH_EVENT}"]`);
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toContainText('via LoRa mesh');
    await expect(badge).toContainText(node);
  },
);

Then("the badge's title reports the radio signal and the authentication caution", async ({ page }) => {
  const title =
    (await page.locator(`[data-testid="mesh-badge-${MESH_EVENT}"]`).getAttribute('title')) ?? '';
  expect(title).toContain(`node ${MESH_NODE}`);
  expect(title).toContain('registered');
  expect(title).toContain('RSSI -95 dBm');
  expect(title).toContain('SNR 5.5 dB');
  expect(title).toContain('not cryptographically authenticated');
});

Then('the ordinary message carries no mesh badge', async ({ page }) => {
  // The row is proven rendered above; a badge would have to be inside it.
  await expect(
    page.locator(`[data-testid="event-${PLAIN_EVENT}"] [data-testid="mesh-badge-${PLAIN_EVENT}"]`),
  ).toHaveCount(0);
});

// ───────────────────────── user settings → My Mesh Devices ─────────────────────────

/** The seeded `/bff/user/mesh-devices` rows: one active radio carrying the full
 *  (radio-reported, unauthenticated) telemetry set, one revoked with a reason. */
function meshDeviceRows(): Record<string, unknown>[] {
  return [
    {
      id: ACTIVE_DEVICE_ID,
      nodeId: MESH_NODE,
      label: 'backpack radio',
      createdAt: '2026-01-01T00:00:00Z',
      visibility: 'private',
      state: 'active',
      revokeReason: null,
      lastSeenAt: new Date().toISOString(),
      batteryPct: 87,
      snr: 6.5,
      hopsAway: 2,
      viaDevice: BRIDGE_DEVICE,
    },
    {
      id: REVOKED_DEVICE_ID,
      nodeId: '!b2c3d4e5',
      label: 'old handheld',
      createdAt: '2025-06-01T00:00:00Z',
      visibility: 'channels',
      state: 'revoked',
      revokeReason: REVOKE_REASON,
      lastSeenAt: null,
      batteryPct: null,
      snr: null,
      hopsAway: null,
      viaDevice: null,
    },
  ];
}

When(
  '{string} opens user settings holding an active and a revoked mesh device',
  async ({ page }, _username: string) => {
    meshWrites = [];
    // The Matrix half of user-settings (profile + presence) is inert here —
    // answer it emptily so a dead fetch never sinks the mesh section.
    await page.route('**/_matrix/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/account/whoami')) return fulfillJson(route, { user_id: SEEDED_ALICE });
      return fulfillJson(route, {});
    });
    // A RegExp, not a glob: Playwright only lets `**` span `/` when it sits
    // next to one, so `**/bff/user/mesh-devices**` would match the list GET and
    // the claim POST but NOT the deeper `/{id}/visibility` PUT or `/{id}` DELETE.
    await page.route(/\/bff\/user\/mesh-devices/, async (route) => {
      const req = route.request();
      const method = req.method();
      if (method === 'GET') return fulfillJson(route, meshDeviceRows());
      // Capture the write verbatim — the claim/visibility/release assertions
      // read what the app SENT, never a fabricated echo.
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      meshWrites.push({ method, path: new URL(req.url()).pathname, body });
      if (method === 'POST') {
        return fulfillJson(route, { ...meshDeviceRows()[0], id: 'dev-claimed', nodeId: '!a1b2c3d4' }, 201);
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mesh-devices')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`[data-testid="mesh-device-${ACTIVE_DEVICE_ID}"]`)).toBeVisible({ timeout: 15_000 });
  },
);

Then(
  'the active device shows its radio-reported status line and a live visibility control',
  async ({ page }) => {
    const status = page.locator(`[data-testid="mesh-status-${ACTIVE_DEVICE_ID}"]`);
    await expect(status).toBeVisible();
    await expect(status).toContainText('battery 87%');
    await expect(status).toContainText('SNR 6.5 dB');
    await expect(status).toContainText(`via ${BRIDGE_DEVICE}`);
    const select = page.locator(`[data-testid="select-mesh-visibility-${ACTIVE_DEVICE_ID}"]`);
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('private');
    await expect(page.locator(`[data-testid="mesh-revoked-${ACTIVE_DEVICE_ID}"]`)).toHaveCount(0);
  },
);

Then(
  "the revoked device is flagged with the server's reason and its visibility is frozen",
  async ({ page }) => {
    const flag = page.locator(`[data-testid="mesh-revoked-${REVOKED_DEVICE_ID}"]`);
    await expect(flag).toBeVisible();
    await expect(flag).toContainText(REVOKE_REASON);
    // Still LISTED (revocation is not deletion), but no longer re-scopable.
    await expect(page.locator(`[data-testid="mesh-device-${REVOKED_DEVICE_ID}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="select-mesh-visibility-${REVOKED_DEVICE_ID}"]`)).toBeDisabled();
  },
);

When('{string} tries to register the node id {string}', async ({ page }, _username: string, nodeId: string) => {
  await page.getByTestId('input-mesh-node').fill(nodeId);
  await page.getByTestId('btn-mesh-claim').click();
});

Then('the mesh claim error names the 8-hex-digit rule', async ({ page }) => {
  const err = page.getByTestId('mesh-error');
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toHaveAttribute('aria-live', 'polite');
  await expect(err).toContainText('8 hex digits');
});

Then('no mesh-device write has reached the BFF', async ({}) => {
  // Refused client-side by normalizeMeshNodeId — nothing was sent. The VALID
  // claim in the next step is the ordering oracle that proves the captured
  // route was live while this absence held.
  expect(meshWrites, 'a malformed node id must never be sent').toEqual([]);
});

When('{string} registers the node id {string}', async ({ page }, _username: string, nodeId: string) => {
  await page.getByTestId('input-mesh-node').fill(nodeId);
  await page.getByTestId('btn-mesh-claim').click();
  await expect(page.getByTestId('user-settings-status')).toContainText('Mesh device registered', {
    timeout: 15_000,
  });
});

Then('the claim reached the BFF carrying the canonical node id {string}', async ({}, canonical: string) => {
  const post = meshWrites.find((w) => w.method === 'POST');
  expect(post, 'a POST to /bff/user/mesh-devices').toBeTruthy();
  // The typed "!A1B2C3D4" is normalized to "!"+8 lowercase hex before it flies.
  expect(post!.body).toMatchObject({ nodeId: canonical });
  expect(post!.path.endsWith('/bff/user/mesh-devices')).toBeTruthy();
});

When(
  "{string} sets the active device's visibility to {string}",
  async ({ page }, _username: string, visibility: string) => {
    await page
      .locator(`[data-testid="select-mesh-visibility-${ACTIVE_DEVICE_ID}"]`)
      .selectOption(visibility);
    await expect(page.getByTestId('user-settings-status')).toContainText('visibility updated', {
      timeout: 15_000,
    });
  },
);

Then('the visibility change reached the BFF carrying {string}', async ({}, visibility: string) => {
  const put = meshWrites.find((w) => w.method === 'PUT');
  expect(put, 'a PUT to /bff/user/mesh-devices/{id}/visibility').toBeTruthy();
  expect(put!.body).toMatchObject({ visibility });
  expect(put!.path).toContain(`/mesh-devices/${ACTIVE_DEVICE_ID}/visibility`);
});

When('{string} releases the active device', async ({ page }, _username: string) => {
  await page.locator(`[data-testid="btn-mesh-release-${ACTIVE_DEVICE_ID}"]`).click();
  await expect(page.getByTestId('user-settings-status')).toContainText('Mesh device released', {
    timeout: 15_000,
  });
});

Then('the release reached the BFF naming the active device', async ({}) => {
  const del = meshWrites.find((w) => w.method === 'DELETE');
  expect(del, 'a DELETE to /bff/user/mesh-devices/{id}').toBeTruthy();
  expect(del!.path.endsWith(`/mesh-devices/${ACTIVE_DEVICE_ID}`)).toBeTruthy();
});
