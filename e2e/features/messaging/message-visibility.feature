# MULTIUSER / CROSS-USER — the core Matrix message-visibility matrix: a room
# member's message is visible to other members (sync-aware), and NEVER visible
# to a non-member, a signed-out visitor, or delivered from a banned sender.
#
# Every persona runs in its OWN browser context (pageRegistry/ctxRegistry) with
# its own seeded session, and every cross-context wait is the expect.poll
# timeline helper (tests/helpers/timeline.ts) — never a bare waitForTimeout.
#
# HONEST oracles throughout:
#   * every message body is UNIQUE per scenario ("label-<runId>"), so a match
#     can only come from THIS scenario's send;
#   * absence is only asserted AFTER a later canary message has arrived in the
#     same observer's timeline (ordering oracle), never timeout-and-hope;
#   * the banned sender's DENY asserts the ANNOUNCED send failure — never a
#     fabricated success.
#
# Needs the live stack (homeserver + user-bff hsproxy + seeded shared public
# room E2E_PUBLIC_ROOM) — @cluster keeps the whole feature dark by default.
@cluster
Feature: Matrix message visibility across members, non-members and visitors
  As the Matrix remote
  I must show a room's messages to its members and to nobody else
  So room content never leaks past membership, sign-in or a ban

  Scenario: a member sees another member's message (sync-aware)
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a unique message "hello" in the shared public room
    Then "user-alice" sees their message "hello" echoed in their own timeline within 30 seconds
    And the message "hello" appears in "user-bob" timeline within 30 seconds

  Scenario: a non-member neither lists the room nor ever sees its message
    Given "user-alice" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-carol" has a seeded session in their own context
    When "user-alice" sends a unique message "members-only" in the shared public room
    Then "user-alice" sees their message "members-only" echoed in their own timeline within 30 seconds
    And the shared public room is listed for "user-alice"
    But the shared public room is not listed for "user-carol"
    When "user-carol" navigates directly to the shared public room in their context
    Then "user-carol" is denied the room history and the message "members-only" is not shown

  # This remote is guard-free BY DESIGN — the login redirect belongs to the
  # host shell that mounts it at /social/matrix, not to this standalone
  # surface. The honest signed-out DENY provable HERE is the server's: the
  # session-less history fetch is rejected and the explicit denied notice
  # renders, with a message that PROVABLY exists (a member sent and saw it
  # first) never shown.
  Scenario: a signed-out visitor is denied a room's history
    Given "user-alice" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-alice" sends a unique message "for-members" in the shared public room
    And "user-alice" sees their message "for-members" echoed in their own timeline within 30 seconds
    And a signed-out visitor has a fresh context
    When the signed-out visitor navigates directly to the shared public room
    Then the signed-out visitor is denied the room history and the message "for-members" is not shown

  Scenario: a banned sender's message is announced as rejected and never reaches a member
    Given "user-bob" has a seeded session in their own context
    And "user-bob" has joined the shared public room in their context
    And "banned-eve" has a seeded session in their own context
    When "banned-eve" attempts to send a unique message "from-banned" in the shared public room
    Then "banned-eve" sees an announced send failure
    When "user-alice" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-alice" sends a unique message "canary" in the shared public room
    Then the message "from-banned" never appears in "user-bob" timeline once the canary "canary" has arrived
