Feature: VN call & room view on phone/tablet viewports
  As the Matrix remote
  I must keep the VN call screen and the room view usable on phones and
  tablets — the 16:9 stage letterboxes instead of overflowing, nothing forces
  horizontal body scroll, and the touch controls meet the 44px minimum
  So the co-directed voice chat works on the devices people actually call from

  # OFFLINE (untagged): all of this is client-side layout — the VN template
  # branch renders with no backend (same basis as the vn-voice-call offline
  # scenarios), and the room header renders offline with the room id fallback.

  Scenario: the VN call screen letterboxes and stays touch-usable on a phone
    Given "user-alice" has a seeded session
    And the viewport is a 360x740 phone
    When "user-alice" opens the VN voice call view
    Then the page has no horizontal scrolling
    And the VN stage letterboxes inside the viewport
    And the call controls meet the 44px touch target minimum
    When "user-alice" opens the scene tools
    Then the page has no horizontal scrolling
    And the scene tools panel scrolls internally

  Scenario: the VN call screen letterboxes on a portrait tablet
    Given "user-alice" has a seeded session
    And the viewport is a 768x1024 tablet
    When "user-alice" opens the VN voice call view
    Then the page has no horizontal scrolling
    And the VN stage letterboxes inside the viewport

  Scenario: the VN call screen letterboxes on a landscape tablet
    Given "user-alice" has a seeded session
    And the viewport is a 1024x768 tablet
    When "user-alice" opens the VN voice call view
    Then the page has no horizontal scrolling
    And the VN stage letterboxes inside the viewport

  Scenario: the room view header (call entries included) stays touch-usable on a phone
    Given "user-alice" has a seeded session
    And the viewport is a 360x740 phone
    When "user-alice" opens the shared public room by route
    Then the page has no horizontal scrolling
    And the room header call entries meet the 44px touch target minimum
