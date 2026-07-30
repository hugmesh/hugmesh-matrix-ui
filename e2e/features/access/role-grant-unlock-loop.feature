# THE MATRIX-SIDE LEG of the cross-service "grant ROLE_MATRIX -> Matrix surface
# unlocks" loop. See hugmesh-admin-ui's e2e/features/admin/role-grant.feature
# (PR #67) for the ADMIN-side leg — the real lever both legs share is the SAME
# endpoint: AdminController#grantRole / #revokeRole,
# POST/DELETE /bff/admin/roles/{roleName}/{user} (admin-bff-api).
#
# INVESTIGATION FINDING — what "matrix-ui becomes reachable" actually means:
#   admin-ui#67 assumed this repo's OWN role-matrix-access.feature already
#   proves the causal effect ("the platform ROLE_MATRIX gate ... registeredGuard
#   -> SessionService.fullyRegistered"). Reading the actual source shows that
#   claim is IMPRECISE: `fullyRegistered` / `registrationComplete`
#   (projects/host/src/app/session.service.ts, projects/host/src/app/
#   registration.guard.ts) is a TWO-STAGE-REGISTRATION flag, flipped by
#   AuthController#complete -> AccountStore#markComplete
#   (hugmesh-admin-bff-api / hugmesh-auth-core Account.java) — a value
#   completely INDEPENDENT of the Casdoor ROLE_MATRIX authority
#   AdminController#grantRole actually manages. Granting/revoking ROLE_MATRIX
#   does NOT touch `registrationComplete`, so asserting causality through that
#   client-side gate would be a FABRICATED link, not a real one.
#
#   The REAL, source-grounded ROLE_MATRIX gate lives one layer further out, in
#   hugmesh-gateway's route-access rules (CanonicalSeed.java /
#   compose/route-access-seed.sql):
#     r(FE, "/social/matrix/**", "ROLE_MATRIX")
#     r(BE, "/_matrix/**",       "ROLE_MATRIX")
#   GatewayRouteAccessFilter enforces this per-request off the caller's
#   validated JWT authorities: DENY -> 403 + `X-Route-Denied: <gateway>:<path>`
#   (never a redirect, never a silent 404 — a real, bean-valid-path DENY
#   oracle); ALLOW/NO_RULE -> forward. THIS is "the app becomes reachable at
#   all" — matrix-ui, as a federated remote, is not even served to a principal
#   lacking ROLE_MATRIX. It is a genuinely different (and more fundamental)
#   mechanism than this repo's existing role-matrix-access.feature, which only
#   asserts the client-side registeredGuard/moderation-panel tier rendering —
#   this feature does not duplicate that file; it proves the network-level
#   gate the OTHER file's own header comment (inaccurately) attributes to
#   registeredGuard.
#
# AUTH PREMISE (live runs) — matrix-ui's own e2e has NO real Casdoor login of
# its own (unlike the admin/games remotes — see tests/helpers/roles.ts's own
# doc comment); every scenario in this suite authenticates by seeding
# `localStorage['hug.session']`, which carries NO cookie and cannot pass a
# server-side gate. So, matching the SAME honest convention already
# established by this repo's domainlock-enforcement.feature
# ("unlock restores federation" — a real mod-bff DELETE + a modelled re-login),
# every write/probe below rides an OUT-OF-BAND bearer exported as an env var;
# with none set, the request carries no Authorization header and the
# assertion fails LOUDLY (401/an unexpected status) rather than green-washing:
#   E2E_ROLE_GRANT_ADMIN_TOKEN          — real ADMIN bff_ bearer (the grant/
#                                         revoke calls)
#   E2E_ROLE_GRANT_TARGET_BEFORE_TOKEN  — the target's REAL bearer minted
#                                         BEFORE the grant (no ROLE_MATRIX)
#   E2E_ROLE_GRANT_TARGET_AFTER_TOKEN   — the SAME target's REAL bearer minted
#                                         AFTER the grant (WITH ROLE_MATRIX)
#   E2E_ROLE_GRANT_TARGET_REVOKED_TOKEN — the SAME target's REAL bearer minted
#                                         AFTER the revoke (ROLE_MATRIX removed
#                                         again)
# THREE DISTINCT target tokens are required, never one reused across stages: a
# JWT is immutable once minted, and grantRole/revokeRole each best-effort
# invalidate the grantee's LIVE custody JWT (GatewayRevocationClient
# .revokeSubject) precisely so a stale token can never coast across a role
# change — the new state is only visible on a freshly re-minted token, and a
# token invalidated by the grant step's revocation could 403 the post-revoke
# probe for the WRONG reason (a revoked-token rejection, not a route-access
# ROLE_MATRIX decision) if reused. Three fresh mints keep each probe an honest,
# unambiguous read of ONE specific moment in this identity's real role state.
#
# Same-identity discipline — FIXED, not uniquified: the target is the single
# literal username "e2e-matrix-unlock-victim", used verbatim by the write leg
# (grant/revoke) AND by all three probes. An earlier draft of this file
# uniquified the target at runtime (`${base}-${uid()}`) to dodge cross-run
# Casdoor role-membership collisions — that was WRONG and was caught in
# review: the three probe bearer tokens are read from static env vars, which
# by construction must be minted BEFORE this test process even starts, so
# they can only ever belong to some fixed, pre-existing identity. A
# runtime-random target can never match a pre-minted token's subject, which
# severs the write leg (operates on the random name) from the read-probe leg
# (reads a fixed identity's pre-existing access state) — two causally
# disconnected principals dressed up as a before/after. The fix is to match
# admin-ui#67's own precedent (its role-grant.feature uses the literal
# "e2e-role-grant-victim", not a randomized one): pin the target to one fixed
# literal name here too, so the SAME identity is what gets granted/revoked
# AND what the pre-minted tokens actually probe. Operators preparing
# E2E_ROLE_GRANT_TARGET_{BEFORE,AFTER,REVOKED}_TOKEN MUST mint all three for
# exactly this literal username, in the three grant-state moments the env-var
# names describe (cross-run staleness is an accepted tradeoff of this design,
# same as admin-ui's own fixed-victim convention).
#
# @cluster — ships dark; the default `not @cluster` filter excludes this from
# every offline run, matching the platform convention. bddgen compile-proof is
# the validation gate for this file, not a live cluster run.
@cluster @access @mutation
Feature: Granting ROLE_MATRIX unlocks the Matrix surface; revoking it locks it again
  As the platform
  I must gate reachability of the Matrix remote (/social/matrix, /_matrix) on the
  Casdoor ROLE_MATRIX authority the admin-bff role-grant lever manages
  So the cross-service loop (grant ROLE_MATRIX -> Matrix reachable -> revoke ->
  Matrix denied again) is a real, causal, single-identity chain — not a coincidence
  of two different users

  Scenario: the same target user is denied, then allowed, then denied again as ROLE_MATRIX is granted and revoked
    Given "admin-adam" has a seeded session in their own context
    Then "e2e-matrix-unlock-victim" is denied the gated Matrix surface before any grant
    When "admin-adam" grants the "ROLE_MATRIX" role to "e2e-matrix-unlock-victim" via the admin BFF
    Then the role response reports "granted" role "ROLE_MATRIX" for "e2e-matrix-unlock-victim"
    And "e2e-matrix-unlock-victim" is allowed the gated Matrix surface after the grant
    When "admin-adam" revokes the "ROLE_MATRIX" role from "e2e-matrix-unlock-victim" via the admin BFF
    Then the role response reports "revoked" role "ROLE_MATRIX" for "e2e-matrix-unlock-victim"
    And "e2e-matrix-unlock-victim" is denied the gated Matrix surface after the revoke
