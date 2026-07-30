@cluster
Feature: Editing a message is gated to its author
  As the Matrix remote
  I must let only a message's author edit it, and show the edited content to
  every room member
  So nobody can rewrite someone else's words, but an author's own correction
  reaches everyone

  # NOTE ON THIS CLIENT'S EDIT RENDERING (verified in timeline.component.ts):
  # unlike Element's superseding bubble, the timeline does not fold an
  # m.replace relation back onto its target row (aggregateReactions only pulls
  # m.annotation/m.thread relations) — an edit renders as its OWN new
  # timeline row carrying the "(edited)" marker and the new body, while the
  # pre-edit row is still rendered above it unchanged. That is genuinely what
  # ships today, so these scenarios assert exactly that (the new row +
  # marker), never a claim that the original text disappears.
  Scenario: the author edits their own message and every member sees the edited version
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a unique message "before-edit" in the shared public room
    And the message "before-edit" appears in "user-bob" timeline within 30 seconds
    And "user-alice" edits the message "before-edit" to a new message "after-edit"
    Then the edited message "after-edit" shows an edited marker in "user-alice" timeline within 30 seconds
    And the edited message "after-edit" shows an edited marker in "user-bob" timeline within 30 seconds

  # DENY: the Edit control (timeline.component canRedact's sibling ownership
  # gate, isMine(event)) is only ever OFFERED to the message's own author —
  # never rendered for anyone else's message, mirroring the redact ownership
  # gate already proven in redaction.feature.
  Scenario: a plain member is offered an edit control on their own message but never on another member's
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a unique message "not-bobs-to-edit" in the shared public room
    And "user-bob" sends a unique message "bobs-own-edit" in the shared public room
    And the message "not-bobs-to-edit" appears in "user-bob" timeline within 30 seconds
    And the message "bobs-own-edit" appears in "user-bob" timeline within 30 seconds
    Then "user-bob" is offered an edit control on the message "bobs-own-edit"
    But "user-bob" is not offered an edit control on the message "not-bobs-to-edit"
