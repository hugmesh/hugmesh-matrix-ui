Feature: Room creation — required-name validation and public-preset semantics
  As the Matrix remote
  I must validate a new room's name before creating it, and let a public room
  be joined without an invite
  So a malformed create never reaches the homeserver, and a public room behaves
  like Element's "Public" preset

  # Pure client-side validation (room-list.component.ts create() — the
  # matrix.createRoom call sits behind an early `if (!this.newName.trim())
  # return;`). No homeserver call happens before the name is checked, so this
  # scenario runs OFFLINE (no @cluster) exactly like role-tiers/domainlock.
  Scenario: submitting the create-room form with no name is rejected before any request is sent
    Given "user-alice" has a seeded session
    When "user-alice" opens the create-room dialog
    And "user-alice" submits the create-room form without a name
    Then a required-name validation error is shown

  # ALLOW: a room created with the "Public" preset can be joined by a DIFFERENT
  # user purely by id — no invite involved (the invite-only DENY→ALLOW pair for
  # the OTHER preset already lives in messaging/rooms-membership.feature).
  @cluster
  Scenario: a public room is joinable by another user without an invite
    Given "user-alice" has a seeded session in their own context
    And "user-alice" creates a public room in their context
    And "user-bob" has a seeded session in their own context
    When "user-bob" joins the created public room by id in their context
    Then the created public room is listed for "user-bob"
