@cluster
Feature: A member's typing state is visible to other room members in real time
  As the Matrix remote
  I must show a member's live typing state to other members of the same room
  So the room feels synchronous even before a message is sent

  # BEST-EFFORT ORACLE: the composer auto-clears typing:true 3s after the last
  # keystroke (composer.component.ts onInput/stopTyping), so the typer step
  # keeps re-triggering keystrokes for several seconds to hold the ephemeral
  # state active across a real network round-trip to the watcher's own live
  # /sync loop. The watcher assertion itself is a real expect.poll against the
  # rendered DOM (room-view.component.ts typingUsers, fed by
  # matrix-chat.component.ts's syncLoop) — never a fixed sleep; only the
  # typer's own local pacing between keystrokes uses a short wait, which is
  # not the cross-user oracle.
  Scenario: another member sees a live typing indicator while a member is actively typing
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" keeps typing in the shared public room for a few seconds
    Then "user-bob" sees "user-alice" listed as typing in the shared public room within 15 seconds
