# USER-SITUATIONAL (ALLOW + DENY/disabled) and MULTIUSER-SITUATIONAL coverage
# of the additive moderation tiers in role-actions.component.{ts,html}.
#
# The component CONDITIONALLY RENDERS three additive tiers off the JWT role
# tier (SessionService.isUser / isMod / isAdmin) — and the invariant is that
# because isMod ⊇ isAdmin and the tiers are additive, a MOD never sees the
# ADMIN tier and a USER never sees MOD/ADMIN. These scenarios assert exactly
# that matrix: which tier each role DOES see (ALLOW) and which it must NOT
# (DENY). The ADMIN approve/deny control is REAL, not stubbed — Approve/Deny
# call AdminBffService.decide() against admin-bff-api (role-actions #36). The
# `admin-stub-note` testid name is a pre-#36 leftover; its rendered copy now
# honestly documents the kill-switch-override + audit-trail semantics of those
# real verbs, which is what the scenarios below assert.
#
# Cluster-free: the moderation panel renders the tiers from the seeded session
# alone; the queue/blocks lists start empty (no BFF), which is exactly the
# `No queued requests loaded.` empty state we assert.
Feature: Additive moderation tiers gate by platform role (mod/admin)
  As the Matrix moderation surface
  I must show each role only the actions its tier allows
  So defence-in-depth UI gating never offers a tier the role cannot use

  Scenario: USER sees only the self-actions tier (ALLOW user, DENY mod/admin)
    Given "user-alice" has a seeded session
    When "user-alice" opens the moderation panel
    Then the USER moderation tier is visible
    And the MOD moderation tier is not visible
    And the ADMIN moderation tier is not visible
    And the block-or-mute control is available

  Scenario: MOD sees the user + mod tiers but NOT the admin tier (ALLOW mod, DENY admin)
    Given "mod-mallory" has a seeded session
    When "mod-mallory" opens the moderation panel
    Then the USER moderation tier is visible
    And the MOD moderation tier is visible
    And the ADMIN moderation tier is not visible
    And the server-wide block control is available
    And the moderation queue shows the empty-state message

  Scenario: ADMIN sees all three tiers, and the admin decide tier documents its real semantics
    Given "admin-adam" has a seeded session
    When "admin-adam" opens the moderation panel
    Then the USER moderation tier is visible
    And the MOD moderation tier is visible
    And the admin decide help note explains the kill-switch override and audit trail

  # SUPERADMIN — the platform's top tier (roles carry `superadmin` AND `admin`,
  # RBAC SUPERADMIN > ADMIN). VERIFIED against src/app/session.service.ts: this
  # UI exposes NO distinct superadmin tier (isUser/isMod/isAdmin only — no
  # isSuperadmin accessor and no superadmin-only surface), so a superadmin must
  # FOLD INTO the admin tier: identical rendering to admin-adam, nothing more.
  Scenario: SUPERADMIN folds into the ADMIN tier (no distinct superadmin surface)
    Given "superadmin-sam" has a seeded session
    Then the persisted roles include "superadmin"
    And the persisted roles include "admin"
    When "superadmin-sam" opens the moderation panel
    Then the USER moderation tier is visible
    And the MOD moderation tier is visible
    And the admin decide help note explains the kill-switch override and audit trail
    And no moderation surface beyond the admin tier is rendered

  # MULTIUSER-SITUATIONAL — two distinct roles, swapped within one scenario,
  # must each resolve their own tier from their own seeded session.
  Scenario: a USER then a MOD each resolve their own tier on the same surface
    Given "user-alice" has a seeded session
    When "user-alice" opens the moderation panel
    Then the MOD moderation tier is not visible
    When "mod-mallory" has a seeded session
    And "mod-mallory" opens the moderation panel
    Then the MOD moderation tier is visible

  # The role-actions disclosure menu (non-inline) is the keyboard a11y surface:
  # Escape closes it and restores focus to the trigger. Asserted via the
  # member-list usage where role-actions renders its trigger button.
  @cluster
  Scenario: role-actions disclosure restores focus to its trigger on Escape (a11y)
    Given "mod-mallory" has a seeded session
    When "mod-mallory" opens a room member list
    And "mod-mallory" opens a member's moderation menu
    And "mod-mallory" presses Escape
    Then focus returns to the moderation menu trigger
