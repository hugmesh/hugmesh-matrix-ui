@cluster
Feature: Room settings are gated by the room's power levels
  As the Matrix remote
  I must let a sufficiently-powered member change a room's name/topic and
  refuse everyone else
  So room metadata can only be changed by whoever the room's power levels allow

  # ALLOW: the room CREATOR (Matrix always grants the creator power level 100)
  # renames their own room; a member she invited observes the SAME new
  # name/topic on a fresh server-answered fetch.
  Scenario: the room creator updates the room name and topic for every member
    Given "user-alice" has a seeded session in their own context
    And "user-alice" creates an invite-only room in their context
    And "user-bob" has a seeded session in their own context
    And "user-alice" invites "user-bob" to their new room
    And "user-bob" joins the captured room by id in their context
    When "user-alice" updates the room name and topic in their context
    Then "user-bob" sees the updated room name and topic within 30 seconds

  # DENY: a plain member of the shared public room (power level 0, below the
  # room's state_default of 50) attempts the SAME action. The settings form
  # offers Save to every member regardless of power (matching Element's own
  # RoomSettingsDialog — see room-settings.component.ts), so the real gate is
  # the homeserver's 403 on the underlying state-event PUT. The composer-
  # analogous room-settings-status announces "Save failed", and a fresh fetch
  # by another member proves the attempted name never applied.
  Scenario: a plain member cannot change the shared room's settings
    Given "user-bob" has a seeded session in their own context
    And "user-bob" has joined the shared public room in their context
    And "user-alice" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    When "user-bob" attempts to rename the shared public room in their context
    Then "user-bob" sees an announced room-settings save failure
    And the attempted room rename never applies for "user-alice"
