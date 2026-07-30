Feature: VN scene & prop combination sweep — every scene, prop add/move/remove, and the caps
  As the Matrix remote
  I must let a call member pick ANY manifest scene and dress it with props,
  with the shared-state limits (32 props, clamped coords) enforced in the UI
  So the co-directed stage stays usable and bounded whatever gets clicked

  # OFFLINE (untagged): the scene manifest is a static app asset
  # (assets/vn/scenes/scenes.json), and every picker edit applies to the stage
  # OPTIMISTICALLY before (and regardless of) the room-state PUT — offline the
  # PUT fail-softs to the polite "shown locally only" notice while the local
  # stage still updates. That makes the WHOLE single-axis scene sweep and the
  # prop add/move/remove/cap loops honestly provable with no homeserver; the
  # cross-user round-trip of the same state event is the @cluster scenario in
  # vn-voice-call.feature.

  Scenario: SINGLE-AXIS SWEEP — every manifest scene is selectable and lands on the stage
    Given "user-alice" has a seeded session
    When "user-alice" opens the VN voice call view
    And "user-alice" opens the scene tools
    Then the scene picker offers the 8 manifest scenes plus "No scene"
    And selecting each scene in turn swaps the stage background to that scene
    And selecting "No scene" leaves the stage with no background image

  Scenario: the scene radiogroup is a keyboard radio group (roving tabindex + arrow keys)
    Given "user-alice" has a seeded session
    When "user-alice" opens the VN voice call view
    And "user-alice" opens the scene tools
    Then exactly one scene tile is in the tab order
    And pressing ArrowRight on the checked tile selects and focuses the next scene
    And pressing ArrowLeft wraps the selection back

  Scenario: props can be added, keyboard-moved, resized and removed
    Given "user-alice" has a seeded session
    When "user-alice" opens the VN voice call view
    And "user-alice" opens the scene tools
    And "user-alice" adds the prop "vn_prop_lamp"
    Then the stage shows 1 placed prop
    When "user-alice" nudges the placed prop right with the keyboard
    Then the placed prop moved right on the stage
    When "user-alice" removes the placed prop
    Then the stage shows 0 placed props

  Scenario: LIMIT — the prop palette disables at the 32-prop cap and announces why
    Given "user-alice" has a seeded session
    When "user-alice" opens the VN voice call view
    And "user-alice" opens the scene tools
    And "user-alice" adds 32 props
    Then the stage shows 32 placed props
    And the prop palette is disabled with the announced cap notice
    When "user-alice" removes the placed prop
    Then the prop palette is enabled again
