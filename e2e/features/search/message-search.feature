@cluster
Feature: Full-text message search is scoped to the searcher's own rooms
  As the Matrix remote
  I must return search results only from rooms the searcher can see
  So a private room's content is never discoverable through search by a non-member

  Scenario: a member finds their own message through search (ALLOW)
    Given "user-alice" has a seeded session in their own context
    And "user-alice" creates an invite-only room in their context
    And "user-alice" sends a unique message "findable" in their new room
    When "user-alice" searches for "findable" in their context
    Then "user-alice" finds a search result for "findable" within 30 seconds

  # DENY: the SAME message, provably searchable by its own room's member
  # (asserted first, in this scenario, so the term's existence is beyond
  # doubt), is never surfaced to an outsider who was never invited — the
  # homeserver's /search only indexes rooms the caller has joined.
  Scenario: a non-member's search never surfaces a private room's provably-existing message (DENY)
    Given "user-alice" has a seeded session in their own context
    And "user-alice" creates an invite-only room in their context
    And "user-alice" sends a unique message "hidden" in their new room
    And "user-carol" has a seeded session in their own context
    When "user-alice" searches for "hidden" in their context
    Then "user-alice" finds a search result for "hidden" within 30 seconds
    When "user-carol" searches for "hidden" in their context
    Then "user-carol" finds no search results for "hidden"
