# USER-SITUATIONAL (disabled + helptext) coverage of the additive Matrix
# domain-lock restriction marker (SessionService.isMatrixDomainLocked,
# role `matrix_domainlocked`).
#
# Per the SessionService contract: when the marker is present the Matrix
# compose / room / federation surface must force LOCAL-ONLY — any cross-domain
# / federation target is greyed-out WITH why-helptext, while local interaction
# stays fully usable. The UI gate is defence-in-depth (the homeserver/BFF still
# force-local server-side) so it must never grey out a LOCAL action, only
# federation targets.
#
# The room-list join-by-alias + start-DM inputs accept `@user:server` /
# `#room:server` cross-domain targets — the natural place a domain-locked user
# would be steered toward local-only. These scenarios are tagged @cluster
# where they need the live room-list/composer wiring beyond the seeded session;
# the pure session-marker assertion runs cluster-free.
Feature: Matrix domain-lock greys out federation targets, keeps local usable
  As a domain-locked Matrix user
  I must be steered to local-only interaction with a clear why-helptext
  So I cannot reach a cross-domain / federation target the homeserver forbids

  Scenario: a domain-locked session carries the matrix_domainlocked marker
    Given "user-dana-locked" has a seeded session
    Then the persisted roles include "matrix_domainlocked"
    And the persisted roles include "user"

  Scenario: a non-locked user does NOT carry the domain-lock marker
    Given "user-alice" has a seeded session
    Then the persisted roles do not include "matrix_domainlocked"

  @cluster
  Scenario: domain-locked user's cross-domain join is explicitly rejected with why-helptext
    Given "user-dana-locked" has a seeded session
    When "user-dana-locked" opens the room list
    Then the join-by-alias help text explains local-only restriction
    And entering a cross-domain alias is rejected as a federation target
