# MULTIUSER / CROSS-USER — MSC2545 m.sticker render (the send-half had NO
# render-half). hug-sticker-picker sends a real `m.sticker` event, but the
# timeline previously filtered rows() to `m.room.message` only, so a sent
# sticker rendered NOWHERE — for the sender OR any member ("I clicked a sticker
# and nothing happened"). The fix widened rows() to include m.sticker and
# hydrates its content.url as an authenticated thumbnail.
#
# SPLIT (mirrors read-receipts.feature): the RENDER MAPPING (an m.sticker event
# renders as an image with an accessible label and NO duplicate text row) is a
# pure client render needing no live homeserver, so it runs OFFLINE with the
# CS-API seeded via route-fulfilment. The picker's own empty-state + Escape
# focus-return is likewise offline. The live CROSS-USER DELIVERY half — alice's
# genuine picker send reaching bob's timeline through a real /sync round-trip —
# stays @cluster.

Feature: Stickers render in the timeline (MSC2545 m.sticker)
  As the Matrix remote
  I must render a sent m.sticker as its image with an accessible label
  So a sticker the picker sends is actually visible to the sender and every member

  # OFFLINE (render mapping): a room is seeded whose history carries one
  # m.sticker event. It MUST render as an <img> (data-testid sticker-<eventId>)
  # hydrated from the authenticated media thumbnail, its accessible name must
  # carry the sticker body + sender, and it MUST NOT also render a duplicate
  # plain-text row (the body is the image's accessible name). Reverting the
  # rows() widening makes this scenario fail — it pins the exact defect.
  Scenario: a seeded m.sticker event renders as an image, not a missing row
    Given "user-alice" has a seeded session
    When "user-alice" opens a seeded room whose history contains a sticker
    Then the sticker image renders in the timeline with an accessible label
    And no duplicate plain-text row is shown for the sticker

  # OFFLINE (picker a11y): opening the picker with no registered pack shows the
  # friendly empty state; Escape closes the picker and returns focus to the
  # sticker toggle (APG "close returns focus to the trigger") so a keyboard user
  # is never stranded.
  Scenario: the sticker picker shows an empty state and Escape restores focus
    Given "user-alice" has a seeded session
    When "user-alice" opens the sticker picker in a seeded room with no pack
    Then the sticker picker shows its empty state
    And pressing Escape closes the picker and returns focus to the sticker button

  # @cluster (live cross-user delivery): alice sends a sticker from her own pack
  # into the shared room; its REAL event id is captured off alice's own timeline
  # echo (honest oracle), and bob — a member — sees THAT sticker image render in
  # his timeline through a real /sync round-trip.
  #
  # LIVE SEED PREMISE: alice must have a registered VN sticker pack
  # (im.ponies.user_emotes account-data with at least one image) on the seed
  # homeserver, or the picker shows its empty state and the send never happens —
  # the step fails loudly (no tile to click) rather than green-washing.
  @cluster
  Scenario: a sticker sent from the picker is delivered to another member's timeline
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a sticker from her pack in the shared public room
    Then the sticker appears in "user-bob" timeline within 30 seconds
