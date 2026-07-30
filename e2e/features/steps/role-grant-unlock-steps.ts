// Step definitions backing features/access/role-grant-unlock-loop.feature —
// the MATRIX-side leg of the cross-service "grant ROLE_MATRIX -> Matrix
// surface unlocks" loop (see hugmesh-admin-ui's
// e2e/features/admin/role-grant.feature, PR #67, for the ADMIN-side leg that
// exercises the SAME endpoint).
//
// Two REAL levers are exercised here:
//   1. The WRITE: admin-bff AdminController#grantRole / #revokeRole
//      (POST/DELETE /bff/admin/roles/{roleName}/{user}) — asserted against the
//      server's OWN response body, never a local echo (mirrors
//      role-grant-steps.ts's evidence standard in admin-ui).
//   2. The EFFECT: hugmesh-gateway's GatewayRouteAccessFilter, which gates
//      `/social/matrix/**` (and `/_matrix/**`) on the caller's ROLE_MATRIX
//      authority — DENY is a real 403 + `X-Route-Denied: <gateway>:<path>`
//      header (never a redirect, never a fabricated-id 404), ALLOW is a real
//      200. See the feature file's header comment for the full citation of
//      why this — and NOT the client-side registeredGuard/fullyRegistered gate
//      — is the accurate "matrix-ui becomes reachable" mechanism.
//
// AUTH PREMISE (live runs): matrix-ui's e2e has no real Casdoor login of its
// own (every other scenario in this suite authenticates by seeding
// localStorage, which carries no cookie). So, matching
// domainlock-enforcement.feature's already-established convention, every call
// below rides an out-of-band bearer read from an env var; absent that env var
// the request carries no Authorization header, and the assertion fails LOUDLY
// (an unexpected status) rather than green-washing.
//
// IDENTITY DISCIPLINE — FIXED, never uniquified: the target string passed
// into every step below (e.g. "e2e-matrix-unlock-victim") is used VERBATIM
// as the literal Casdoor username, by BOTH the write leg (grant/revoke) AND
// the read-probe leg (env-var bearers). A prior revision of this file
// generated a fresh `${base}-${uid()}` username per run and used that random
// name for the grant/revoke calls while the probes still read static,
// pre-minted env-var tokens — that broke the loop into two causally
// disconnected principals (review-caught: the write leg touched a name that
// didn't exist until the test ran; the read leg could only ever probe
// whatever fixed identity its env vars were minted for ahead of time, since
// env vars are supplied before the test process starts and cannot be
// generated on the fly for a not-yet-chosen random name). The fix — and the
// only construction that can work given static env-var bearers — is to pin
// one fixed literal identity that both legs share, mirroring admin-ui#67's
// own precedent (its role-grant.feature uses the literal
// "e2e-role-grant-victim", not a randomized one). Operators preparing
// E2E_ROLE_GRANT_TARGET_{BEFORE,AFTER,REVOKED}_TOKEN must mint all three for
// exactly the literal username this feature declares.

import { Browser, expect } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { newE2eContext } from '../../tests/helpers/roles';
import { pageFor, roleGrantState } from './_registry';

function bearerHeaders(envVar: string): Record<string, string> {
  const token = process.env[envVar];
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─────────────────────────── the real write leg ───────────────────────────

When(
  '{string} grants the {string} role to {string} via the admin BFF',
  async ({}, admin: string, role: string, target: string) => {
    const page = pageFor(admin);
    const res = await page.request.post(`/bff/admin/roles/${role}/${encodeURIComponent(target)}`, {
      headers: bearerHeaders('E2E_ROLE_GRANT_ADMIN_TOKEN'),
    });
    // Honest ALLOW: the grant must really succeed (200, AdminController#grantRole)
    // — this is the oracle the response-body assertion below is measured against.
    expect(res.status(), 'the role grant must succeed (200)').toBe(200);
    roleGrantState.lastBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  },
);

When(
  '{string} revokes the {string} role from {string} via the admin BFF',
  async ({}, admin: string, role: string, target: string) => {
    const page = pageFor(admin);
    const res = await page.request.delete(`/bff/admin/roles/${role}/${encodeURIComponent(target)}`, {
      headers: bearerHeaders('E2E_ROLE_GRANT_ADMIN_TOKEN'),
    });
    expect(res.status(), 'the role revoke must succeed (200)').toBe(200);
    roleGrantState.lastBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  },
);

Then(
  'the role response reports {string} role {string} for {string}',
  async ({}, verb: string, role: string, target: string) => {
    const body = roleGrantState.lastBody;
    // Honest oracle: reads the LAST grant/revoke call's own JSON body
    // (Map.of("granted"|"revoked", roleName, "user", user)) — never a
    // locally-fabricated echo.
    expect(body, 'expected a JSON body from the grant/revoke response').toBeTruthy();
    expect(body![verb.toLowerCase()]).toBe(role);
    expect(body!['user']).toBe(target);
  },
);

// ────────────────────────── the real effect leg ───────────────────────────
// Probes hugmesh-gateway's ROLE_MATRIX-gated FE route directly (a
// stateless HTTP check — no seeded session is involved, since the gate being
// tested lives entirely at the gateway, off the caller's own JWT authorities).

const GATEWAY_MATRIX_PATH = '/social/matrix/';

/** Probe the real ROLE_MATRIX-gated gateway route as the target, using a
 *  bearer minted at one specific moment in the loop (env-var name identifies
 *  which moment — before the grant / after the grant / after the revoke).
 *  Stateless HTTP check in a throwaway context: the gate under test lives
 *  entirely at the gateway, off the caller's own JWT authorities, so no
 *  seeded session/UI is involved. */
async function probeGatedMatrixSurface(
  browser: Browser,
  envVar: string,
): Promise<{ status: number; routeDenied: string | undefined }> {
  const ctx = await newE2eContext(browser);
  try {
    const res = await ctx.request.get(GATEWAY_MATRIX_PATH, {
      headers: bearerHeaders(envVar),
      maxRedirects: 0,
    });
    return { status: res.status(), routeDenied: res.headers()['x-route-denied'] };
  } finally {
    await ctx.close();
  }
}

Then(
  '{string} is denied the gated Matrix surface before any grant',
  async ({ browser }, target: string) => {
    const probe = await probeGatedMatrixSurface(browser, 'E2E_ROLE_GRANT_TARGET_BEFORE_TOKEN');
    // Real, bean-valid-path DENY oracle: GatewayRouteAccessFilter's own 403 +
    // X-Route-Denied header — never inferred from a fabricated-id 404.
    expect(probe.status, `${target} (pre-grant) must be denied the ROLE_MATRIX-gated route (403)`).toBe(403);
    expect(
      probe.routeDenied,
      'the gateway must name this as a real route-access denial, not an unrelated failure',
    ).toBeTruthy();
  },
);

Then(
  '{string} is allowed the gated Matrix surface after the grant',
  async ({ browser }, target: string) => {
    const probe = await probeGatedMatrixSurface(browser, 'E2E_ROLE_GRANT_TARGET_AFTER_TOKEN');
    expect(probe.status, `${target} (post-grant) must be allowed the ROLE_MATRIX-gated route (200)`).toBe(200);
    expect(probe.routeDenied, 'a genuinely-allowed request must carry no route-denied marker').toBeFalsy();
  },
);

Then(
  '{string} is denied the gated Matrix surface after the revoke',
  async ({ browser }, target: string) => {
    const probe = await probeGatedMatrixSurface(browser, 'E2E_ROLE_GRANT_TARGET_REVOKED_TOKEN');
    expect(probe.status, `${target} (post-revoke) must be denied the ROLE_MATRIX-gated route again (403)`).toBe(403);
    expect(
      probe.routeDenied,
      'the gateway must name this as a real route-access denial, not an unrelated failure',
    ).toBeTruthy();
  },
);
