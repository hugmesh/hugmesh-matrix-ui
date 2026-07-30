# CROSS-USER isolation (ALLOW own-tenant + DENY other-tenant) for the Matrix
# remote. Two identities live in two SEPARATE browser contexts at once, each
# with its own seeded HugSession, so neither can observe or inherit the
# other's tier — the same cross-context pattern the games/admin isolation
# specs use.
#
# The isolation invariant here is twofold:
#   1. tier isolation — a USER context never gains the MOD/ADMIN tier just
#      because a MOD context is open alongside it (the tier is read from each
#      context's own localStorage session, not a shared global).
#   2. tenant isolation — each identity's Matrix userId is scoped to its own
#      homeserver domain (@user:tenant-a.test vs @carol:tenant-b.test); a
#      cross-tenant identity is a distinct principal whose session never leaks
#      into the other context.
#
# Cluster-free: assertions read each context's own localStorage + rendered
# moderation tier. The live cross-tenant room-membership probe (which needs two
# real homeservers federating) is tagged @cluster.
Feature: Cross-user + cross-tenant isolation of Matrix sessions and tiers
  As the Matrix remote
  I must keep each identity's role tier and tenant scope isolated per context
  So one user's elevated tier or other tenant's data never bleeds across

  Scenario: a MOD context open beside a USER context does not elevate the USER
    Given "user-alice" has a seeded session in their own context
    And "mod-mallory" has a seeded session in their own context
    When "user-alice" opens the moderation panel in their context
    Then the MOD moderation tier is not visible in "user-alice" context
    When "mod-mallory" opens the moderation panel in their context
    Then the MOD moderation tier is visible in "mod-mallory" context

  Scenario: two tenants resolve to distinct homeserver-scoped Matrix ids
    Given "user-alice" has a seeded session in their own context
    And "user-carol" has a seeded session in their own context
    Then "user-alice" matrix id is scoped to tenant "tenant-a.test"
    And "user-carol" matrix id is scoped to tenant "tenant-b.test"
    And the two contexts hold different sessions

  @cluster
  Scenario: a tenant-b user cannot enumerate tenant-a's rooms
    Given "user-carol" has a seeded session in their own context
    When "user-carol" requests the joined rooms in their context
    Then no tenant-a room is listed for "user-carol"
