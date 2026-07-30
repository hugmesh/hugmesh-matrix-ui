@cluster
Feature: A user's own profile changes are visible to other room members
  As the Matrix remote
  I must let a user change their own display name and propagate it to every
  room they share with others
  So a profile update is not just a local echo but a real, server-persisted change

  # Self-service, no adversary: user-settings has no role/ownership gate to
  # pair an ALLOW with a DENY against (everyone may only ever edit their OWN
  # profile — there is no "edit someone else's name" control to deny in the
  # first place). The honest coverage here is CROSS-USER VISIBILITY of a real
  # profile write, using the same multi-context pageRegistry/ctxRegistry
  # pattern message-visibility.feature uses for messages.
  Scenario: a member's new display name is visible to another member of a shared room
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sets a unique display name in their context
    Then "user-bob" sees "user-alice"'s updated display name in the shared public room member list within 30 seconds
