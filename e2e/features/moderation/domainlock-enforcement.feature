# DOMAIN-LOCK ENFORCEMENT (matrix_domainlocked SOCIAL LOCAL-ONLY) — the full
# ALLOW/DENY pair the marker demands:
#   * LOCAL actions ALLOW — a locked user's local-room interaction stays fully
#     usable (dana sends, bob receives) — the lock must NEVER grey out a local
#     action;
#   * federation DENY — a cross-domain join / DM is EXPLICITLY rejected with an
#     announced why-notice (rl-join-error / rl-dm-error role=alert +
#     rl-*-lock-note helptext), never silently swallowed and never fake-OK;
#   * unlock restores — after the moderator's DELETE
#     /bff/mod/domain-lock/ROLE_MATRIX_DOMAINLOCKED/{user} (the mod-ui verb,
#     honest 202 pending-reconcile envelope) a re-login drops the marker and a
#     federated join succeeds.
#
# The helptext scenarios run OFFLINE (the lock note renders purely off the
# seeded session marker); everything touching the homeserver / mod-bff is
# @cluster. The homeserver MRF stays the source of truth — the UI gate is
# defence-in-depth only.
Feature: Matrix domain-lock enforcement — local allowed, federation denied, unlock restores
  As a domain-locked Matrix user
  I must keep full local interaction while every federation target is explicitly denied
  So the lock constrains WHERE I can act, never WHETHER I can act locally

  Scenario: the locked user's join and DM helptext explain the local-only restriction
    Given "user-dana-locked" has a seeded session
    When "user-dana-locked" opens the room list
    Then the join help includes the domain-lock local-only note
    And the start-DM help includes the domain-lock local-only note

  Scenario: a non-locked user sees no domain-lock steering
    Given "user-alice" has a seeded session
    When "user-alice" opens the room list
    Then no domain-lock restriction note is shown

  @cluster
  Scenario: a locked user's LOCAL actions stay fully usable (ALLOW)
    Given "user-dana-locked" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-dana-locked" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-dana-locked" sends a unique message "local-ok" in the shared public room
    Then "user-dana-locked" sees their message "local-ok" echoed in their own timeline within 30 seconds
    And the message "local-ok" appears in "user-bob" timeline within 30 seconds

  @cluster
  Scenario: a locked user's federated join is explicitly rejected (DENY)
    Given "user-dana-locked" has a seeded session in their own context
    When "user-dana-locked" attempts to join the federated room alias in their context
    Then "user-dana-locked" sees an explicit domain-lock join rejection
    And the federated room is not listed for "user-dana-locked"

  @cluster
  Scenario: a locked user cannot start a cross-domain direct message (DENY)
    Given "user-dana-locked" has a seeded session in their own context
    When "user-dana-locked" attempts to start a DM with a cross-domain user in their context
    Then "user-dana-locked" sees an explicit domain-lock DM rejection
    And no room with the cross-domain user is listed for "user-dana-locked"

  @cluster
  Scenario: lifting the domain lock restores federation
    Given "mod-mallory" has a seeded session in their own context
    And the moderator has lifted the Matrix domain lock on "user-dana-locked"
    And "user-dana-locked" signs in again without the domain-lock marker in their own context
    Then no domain-lock restriction note is shown in "user-dana-locked" context
    When "user-dana-locked" attempts to join the federated room alias in their context
    Then the federated room is listed for "user-dana-locked"
