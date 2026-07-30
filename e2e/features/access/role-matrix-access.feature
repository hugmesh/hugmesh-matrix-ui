# USER-SITUATIONAL — ROLE_MATRIX access gating + the moderation panel's
# signed-in vs signed-out surface.
#
# Grounded in the real surfaces:
#   * The host shell gates /social/matrix on registeredGuard (host
#     registration.guard.ts → SessionService.fullyRegistered), so a Matrix
#     identity that has NOT completed registration (our `banned` / role-absent
#     seed) is bounced to /login. That is the platform ROLE_MATRIX gate.
#   * The standalone Matrix moderation panel (moderation-panel.component.html)
#     renders the role-action tiers ONLY when SessionService.isUser() — i.e.
#     a seeded HugSession exists; otherwise it shows the
#     `mod-panel-signedout` prompt. Clearing the session models role-absence
#     WITHOUT needing the host guard or a live stack.
#
# Cluster-free: every scenario here only reads/writes localStorage and asserts
# rendered DOM. None talk to the homeserver or a BFF.
Feature: ROLE_MATRIX access gate — registered users in, role-absent denied
  As the Matrix remote
  I must only expose the chat + moderation surfaces to a registered platform
  identity, and show a sign-in prompt to a role-absent / banned visitor
  So a user without the ROLE_MATRIX platform role can never act

  Scenario: a registered USER reaches the moderation surface (ALLOW)
    Given "user-alice" has a seeded session
    When "user-alice" opens the moderation panel
    Then the moderation panel renders
    And the USER moderation tier is visible
    And the signed-out prompt is not shown

  Scenario: a role-absent / banned visitor is DENIED the moderation tiers
    Given "banned-eve" has a seeded session
    When "banned-eve" opens the moderation panel
    Then the moderation panel renders
    And the signed-out prompt is shown
    And no moderation action tier is visible

  Scenario: the seeded USER session carries the user role and no elevated role
    Given "user-alice" has a seeded session
    Then the persisted roles include "user"
    And the persisted roles do not include "mod"
    And the persisted roles do not include "admin"

  Scenario: the moderation surface exposes the accessible skip-link and main landmark
    Given "user-alice" has a seeded session
    When "user-alice" opens the moderation panel
    Then the page exposes a skip-to-main-content link
    And the moderation panel has an accessible heading
