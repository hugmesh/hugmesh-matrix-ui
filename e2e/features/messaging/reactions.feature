@cluster
Feature: Emoji reactions are delivered to every room member with an accurate aggregate count
  As the Matrix remote
  I must let a member react to a message and show the aggregated reactions —
  count and per-viewer ownership — to every other member of the room
  So a reaction is a real, server-persisted m.annotation round-trip, not a
  local-only echo

  # WHY @cluster: a reaction is a genuine CS-API round-trip — sendReaction
  # (m.reaction / m.annotation) to add and redactEvent of the caller's own
  # reaction to remove (reaction-picker.component.ts pick()), then getRelations
  # aggregation to render the pill + count (timeline.component.ts
  # aggregateReactions). There is no offline surface: the reaction pill only
  # exists on a REAL rendered message row, and the shared room's history fetch
  # is itself server-gated, so nothing renders without the homeserver. The
  # reaction picker's own client-side APG behaviour (aria-expanded toggle,
  # role=menu, roving tabindex, Escape restore-focus) is asserted INSIDE this
  # live flow because it can only be reached from a rendered message.

  # ALLOW + OWNERSHIP: a member reacts to a message and every member sees the
  # same pill with count 1; the reactor's own pill reads as theirs
  # (aria-pressed=true), another member's reads as not-theirs
  # (aria-pressed=false) — the per-viewer ownership the toggle-off relies on.
  Scenario: a member's reaction reaches every room member with correct per-viewer ownership
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a unique message "reaction-target" in the shared public room
    And the message "reaction-target" appears in "user-bob" timeline within 30 seconds
    And "user-alice" reacts to the message "reaction-target" with "👍"
    Then "user-alice" sees the "👍" reaction on the message "reaction-target" with count 1 within 30 seconds
    And "user-alice" sees the "👍" reaction on the message "reaction-target" marked as their own
    And "user-bob" sees the "👍" reaction on the message "reaction-target" with count 1 within 30 seconds
    And "user-bob" sees the "👍" reaction on the message "reaction-target" not marked as their own

  # AGGREGATION + REMOVE: two members react with the SAME key and the count
  # aggregates to 2 for a member's fetch; when one reactor removes theirs, the
  # count drops to exactly 1 for every member (the remaining reactor's stays) —
  # the redact half of the toggle, proven cross-user with a fresh server fetch.
  Scenario: reactions from two members aggregate, and removing one drops the count for everyone
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a unique message "reaction-tally" in the shared public room
    And the message "reaction-tally" appears in "user-bob" timeline within 30 seconds
    And "user-alice" reacts to the message "reaction-tally" with "👍"
    And "user-bob" reacts to the message "reaction-tally" with "👍"
    Then "user-alice" sees the "👍" reaction on the message "reaction-tally" with count 2 within 30 seconds
    When "user-alice" removes their "👍" reaction on the message "reaction-tally"
    Then "user-alice" sees the "👍" reaction on the message "reaction-tally" with count 1 within 30 seconds
    And "user-alice" sees the "👍" reaction on the message "reaction-tally" not marked as their own
    And "user-bob" sees the "👍" reaction on the message "reaction-tally" with count 1 within 30 seconds
