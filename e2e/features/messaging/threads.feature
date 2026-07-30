@cluster
Feature: Threaded replies are visible to every room member
  As the Matrix remote
  I must let a member start a thread on a message and show its replies to
  every other member of the room
  So a side conversation stays attached to its root and reaches the whole room

  # This feature is membership-gated exactly like the main timeline (same
  # room-scoped CS-API), and message-visibility.feature already proves that
  # DENY at the room-history level. A separate thread-specific DENY scenario
  # is intentionally NOT added here: matrix.service.ts's getRelations/
  # getThreads degrade a rejected/empty response to an EMPTY LIST rather than
  # a distinct denied signal (unlike messages(), which throws on 401/403 so
  # timeline.component can render the explicit timeline-denied notice), so a
  # non-member's thread view would be indistinguishable from "no thread yet
  # in this room" — asserting DENY against that would be a vacuous oracle.
  Scenario: a thread reply reaches every room member, and the room's thread list picks it up
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a unique message "thread-root" in the shared public room
    And "user-alice" starts a thread on the message "thread-root" with reply "thread-reply"
    Then the thread reply "thread-reply" appears in "user-bob" thread view within 30 seconds
    And the thread is listed for "user-bob" in the shared public room
