# MULTIUSER / CROSS-USER — the invitee's side of an invite (rooms.invite).
# sync() used to parse only rooms.join, so a pending invite surfaced NOWHERE in
# the UI — the old invite-only scenario had bob join by an out-of-band room id.
# The fix parses rooms.invite (pendingInvites()) and the room list renders an
# Invites section with Accept/Decline. This pins the new surface: alice invites
# bob, bob's room list shows the pending invite, bob Accepts, and the room's
# secret message becomes visible to him.
#
# victim-creates-first + honest oracle: alice creates the invite-only room, its
# REAL id is captured off her list, she posts a unique secret; only then is
# bob's invitee experience exercised. Needs the live stack — @cluster keeps it
# dark by default.
@cluster
Feature: Pending invites surface to the invitee with Accept/Decline
  As the Matrix remote
  I must show an invited user their pending invite and let them accept it
  So an invite is a visible, actionable affordance — not an out-of-band room id

  Scenario: an invited member sees the pending invite and accepts it into visibility
    Given "user-alice" has a seeded session in their own context
    And "user-alice" creates an invite-only room in their context
    And "user-alice" sends a unique message "secret" in their new room
    And "user-bob" has a seeded session in their own context
    And "user-alice" invites "user-bob" to their new room
    Then the pending invite to the captured room is shown for "user-bob"
    When "user-bob" accepts the pending invite to the captured room
    Then the message "secret" appears in "user-bob" timeline within 30 seconds
