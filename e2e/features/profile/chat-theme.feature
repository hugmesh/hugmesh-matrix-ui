Feature: Per-user chat theme — preset/knob sweeps, seeded combos, and scoping
  As the Matrix remote
  I must let a user restyle THEIR chat (presets, bubbles, font, density,
  background, colors) with every option applying as data-matrix-* attributes +
  --hugm-chat-* vars on the remote's OWN roots only
  So personal theming works across every knob combination without leaking

  # OFFLINE (untagged): ChatThemeService applies themes synchronously to its
  # registered roots and persists locally (localStorage) BEFORE the fail-soft
  # account-data PUT — so the full combination sweep is honestly provable with
  # no homeserver. The account-data round-trip is unit-tested against the
  # service; nothing here fabricates a backend oracle.

  Scenario: SINGLE-AXIS SWEEP — each of the 5 presets applies and is reflected in data-matrix-theme
    Given "user-alice" has a seeded session
    When "user-alice" opens the user settings
    Then applying each theme preset in turn stamps its data-matrix-theme on the settings root

  Scenario: SINGLE-AXIS SWEEP — every bubble shape, font, density and background value applies
    Given "user-alice" has a seeded session
    When "user-alice" opens the user settings
    Then choosing each bubble shape in turn stamps data-matrix-bubbles
    And choosing each chat font in turn stamps data-matrix-font
    And choosing each density in turn stamps data-matrix-density
    And choosing each chat background in turn stamps data-matrix-chatbg

  Scenario: SEEDED RANDOM SWEEP — 20 deterministic mixed theme configs all apply attrs + vars
    Given "user-alice" has a seeded session
    When "user-alice" opens the user settings
    Then applying 20 seeded random theme combinations stamps the matching attributes and custom properties each time

  Scenario: the saved theme boots onto the room view root (cross-surface scoping)
    Given "user-alice" has a seeded session
    When "user-alice" opens the user settings
    And "user-alice" applies the "midnight-vn" theme preset
    And "user-alice" opens the shared public room by route
    Then the room view root carries data-matrix-theme "midnight-vn"
    And the document body carries no data-matrix-theme

  Scenario: reset returns to the stock look
    Given "user-alice" has a seeded session
    When "user-alice" opens the user settings
    And "user-alice" applies the "neon" theme preset
    And "user-alice" resets the chat appearance
    Then the settings root carries no data-matrix-theme

  # MOBILE/TABLET: the theme editor page stays usable at phone/tablet widths —
  # no horizontal body scroll, and its controls meet the 44px touch minimum.
  Scenario: the theme editor is usable on a phone viewport
    Given "user-alice" has a seeded session
    And the viewport is a 360x740 phone
    When "user-alice" opens the user settings
    Then the page has no horizontal scrolling
    And the theme preset swatches meet the 44px touch target minimum

  Scenario: the theme editor is usable on a portrait tablet viewport
    Given "user-alice" has a seeded session
    And the viewport is a 768x1024 tablet
    When "user-alice" opens the user settings
    Then the page has no horizontal scrolling
    And the theme preset swatches meet the 44px touch target minimum
