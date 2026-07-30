# MULTIUSER / CROSS-USER — redaction: a MOD removes a member's message for
# EVERYONE (author, another member and the mod all converge on the redacted
# placeholder), a plain member is never OFFERED redaction of someone else's
# message (ownership+role gate — timeline.component canRedact), and the author
# may always self-redact.
#
# The redact affordance is the timeline Delete button (btn-delete-<eventId>),
# gated by canRedact = author OR SessionService.isMod — the homeserver still
# enforces the redact power level server-side (defence-in-depth). Convergence
# is asserted with the reload-aware redaction poll helper: the homeserver
# strips a redacted event's content on the next /messages fetch
# (unsigned.redacted_because), so each observer's timeline must show the
# `redacted-marker` placeholder INSIDE the target event's own row (the REAL
# event id is captured off the clicked redact control — the persistent shared
# room accumulates other deleted-message markers, so a page-wide marker count
# would prove nothing) with the original body GONE.
#
# Needs the live stack — @cluster keeps the feature dark by default.
@cluster
Feature: Redaction — moderators and authors remove messages for everyone
  As the Matrix remote
  I must let moderators and authors redact messages, and only them
  So a removed message disappears for every member, and nobody else can remove one

  Scenario: a moderator redacts a member's message and every context converges on the placeholder
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "mod-mallory" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    And "mod-mallory" has joined the shared public room in their context
    When "user-alice" sends a unique message "to-redact" in the shared public room
    And the message "to-redact" appears in "mod-mallory" timeline within 30 seconds
    And "mod-mallory" deletes the message "to-redact" from their timeline
    Then the message "to-redact" shows as a redacted placeholder in "mod-mallory" timeline within 30 seconds
    And the message "to-redact" shows as a redacted placeholder in "user-alice" timeline within 30 seconds
    And the message "to-redact" shows as a redacted placeholder in "user-bob" timeline within 30 seconds

  Scenario: a plain member is offered redaction of their own message but never of another member's
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a unique message "not-yours" in the shared public room
    And "user-bob" sends a unique message "bobs-own" in the shared public room
    And the message "not-yours" appears in "user-bob" timeline within 30 seconds
    And the message "bobs-own" appears in "user-bob" timeline within 30 seconds
    Then "user-bob" is offered a delete control on the message "bobs-own"
    But "user-bob" is not offered a delete control on the message "not-yours"

  Scenario: the author self-redacts and another member sees the placeholder
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a unique message "self-gone" in the shared public room
    And the message "self-gone" appears in "user-bob" timeline within 30 seconds
    And "user-alice" deletes the message "self-gone" from their timeline
    Then the message "self-gone" shows as a redacted placeholder in "user-alice" timeline within 30 seconds
    And the message "self-gone" shows as a redacted placeholder in "user-bob" timeline within 30 seconds
