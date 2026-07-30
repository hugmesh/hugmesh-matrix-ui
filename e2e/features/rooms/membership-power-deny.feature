# MULTIUSER / CROSS-USER — announced-failure honesty on a power-denied kick.
# matrix.service.kick() used to swallow a non-OK response, so a plain member
# (PL0) clicking Kick on a higher-PL member silently no-op'd — no feedback, the
# target still there, indistinguishable from a lag. The fix makes kick() THROW
# on a non-OK response and member-list announce it. This proves the seam
# end-to-end: the homeserver's 403 (insufficient power level) surfaces in the
# aria-live status region, and the target remains a member on a fresh fetch.
#
# victim-creates-first: alice (the room creator, PL100) provisions the room and
# invites bob (PL0) through the real UI; only then is bob's power-denied kick
# asserted. Needs the live stack — @cluster keeps it dark by default.
@cluster
Feature: Power-denied kick announces the failure instead of a silent no-op
  As the Matrix remote
  I must announce a homeserver-rejected kick, never swallow it
  So a member without the power to kick sees the refusal rather than a silent no-op

  Scenario: a plain member's kick of the room creator is announced as a failure
    Given "user-alice" has a seeded session in their own context
    And "user-alice" creates an invite-only room in their context
    And "user-bob" has a seeded session in their own context
    And "user-alice" invites "user-bob" to their new room
    And "user-bob" joins the captured room by id in their context
    When "user-bob" attempts to kick "user-alice" from the captured room
    Then "user-bob" sees an announced kick failure
    And "user-alice" is still listed as a member of the captured room
