# MULTIUSER / CROSS-USER — room membership lifecycle: public join ALLOW,
# invite-only DENY→invited ALLOW, moderator kick revoking visibility, and the
# cross-tenant enumeration DENY with a REAL oracle (the room is proven to exist
# in tenant A by its member BEFORE the tenant-B absence is asserted — a 404 on
# a fabricated id proves nothing).
#
# The invite-only pair follows the honest-oracle rule end-to-end: the VICTIM
# (alice) creates the room through the real UI, its REAL id is captured from
# her rendered room list, she posts a secret message into it, and only then is
# the attacker's (bob's) DENY asserted — announced join rejection, room absent
# from his list, secret never rendered to him — followed by the invited ALLOW
# where the SAME secret becomes visible to him.
#
# Needs the live stack — @cluster keeps the feature dark by default.
@cluster
Feature: Room membership — join, invite, kick and cross-tenant enumeration
  As the Matrix remote
  I must grant room visibility exactly to current members
  So joining, inviting and kicking each change what a user can see

  Scenario: joining a public room grants timeline visibility (ALLOW)
    Given "user-bob" has a seeded session in their own context
    When "user-bob" has joined the shared public room in their context
    Then the shared public room is listed for "user-bob"
    And "user-bob" sees the shared public room timeline render in their context

  Scenario: an invite-only room denies an uninvited user, then admits them once invited
    Given "user-alice" has a seeded session in their own context
    And "user-alice" creates an invite-only room in their context
    And "user-alice" sends a unique message "secret" in their new room
    And "user-bob" has a seeded session in their own context
    When "user-bob" attempts to join the captured room by id in their context
    Then "user-bob" sees an announced join rejection
    And the captured room is not listed for "user-bob"
    And "user-bob" is denied the captured room history and the message "secret" is not shown
    When "user-alice" invites "user-bob" to their new room
    And "user-bob" joins the captured room by id in their context
    Then the message "secret" appears in "user-bob" timeline within 30 seconds

  # RACE-FREE ordering: the victim's OWN server-fetched room list drops the
  # room FIRST (his side of the revocation), THEN the post-kick message is
  # sent and proven to exist via the moderator's echo, and the final absence
  # is a FRESH server-answered history fetch — a kicked user can never receive
  # an in-room canary, so the oracle is the server's post-send response, not a
  # snapshot of a sync stream that may simply not have caught up yet.
  Scenario: a moderator kick revokes a member's room visibility
    Given "user-bob" has a seeded session in their own context
    And "user-bob" has joined the shared public room in their context
    And "mod-mallory" has a seeded session in their own context
    And "mod-mallory" has joined the shared public room in their context
    When "mod-mallory" kicks "user-bob" from the shared public room
    Then the shared public room drops from "user-bob" room list within 30 seconds
    When "mod-mallory" sends a unique message "after-kick" in the shared public room
    Then "mod-mallory" sees their message "after-kick" echoed in their own timeline within 30 seconds
    And a fresh history fetch never shows "user-bob" the message "after-kick"

  Scenario: a tenant-b user cannot enumerate a tenant-a room that provably exists
    Given "user-alice" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And the shared public room is listed for "user-alice"
    When "user-carol" has a seeded session in their own context
    And "user-carol" requests the joined rooms in their context
    Then the shared public room is not listed for "user-carol"
