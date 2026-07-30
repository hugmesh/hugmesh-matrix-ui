Feature: Visual-novel voice chat — the VN stage call mode
  As the Matrix remote
  I must offer the same 1:1 WebRTC call in an audio-only visual-novel mode,
  where the media surface is a VN stage (characters, shared scene, dialogue box)
  instead of camera tiles
  So a voice call is presentable as a scene both members co-direct, while the
  m.call.* signalling, controls, and capability gating stay identical

  # OFFLINE (untagged): ?mode=vn-voice is parsed synchronously in ngOnInit, so
  # the VN branch of the template (stage instead of tiles + the scene tools)
  # renders with NO backend, exactly like the video call's offline idle state.
  # The stage itself is fail-soft: no scene state resolves to a plain dark
  # stage; no participants until a call is in progress.
  Scenario: the VN voice call view renders the stage instead of the video tiles
    Given "user-alice" has a seeded session
    When "user-alice" opens the VN voice call view
    Then the call view shows the idle state
    And the VN stage renders instead of the video tiles
    And the scene tools are available in the call view

  # ROUTE ENTRY (untagged): the room header offers both call modes; the VN
  # entry lands on /call carrying the room AND mode query params. Uses the
  # seeded session's client-side room view (route param renders offline).
  Scenario: the room header offers the VN voice chat entry
    Given "user-alice" has a seeded session
    When "user-alice" opens the shared public room by route
    Then the room header shows the VN voice chat and video call entries

  # @cluster: the full VN voice call needs a live homeserver (m.call.* +
  # systems.hugmesh.vn.scene state + m.room.message all ride the room) AND
  # a synthetic mic (--use-fake-device-for-media-stream). The handshake steps
  # are the SAME ones video-call.feature proves — VN mode changes the media
  # surface, not the signalling — so the honest new oracles are: both members'
  # sprites on the stage, a scene edit by one member appearing on the other's
  # stage (round-trips the room STATE event), and the newest room message
  # appearing in the dialogue box.
  @cluster
  Scenario: a VN voice call connects and both members co-direct the shared scene
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" opens the VN voice call view on the shared public room in their context
    And "user-alice" starts a call in their context
    And "user-bob" opens the VN voice call view on the shared public room in their context
    Then "user-bob" sees the call ringing in their context within 30 seconds
    When "user-bob" joins the ringing call in their context
    Then "user-alice" and "user-bob" both reach the connected call state within 60 seconds
    And "user-alice" sees 2 characters on the VN stage in their context within 30 seconds
    And "user-bob" sees 2 characters on the VN stage in their context within 30 seconds
    When "user-alice" selects the scene "vn_scene_cafe" in their context
    Then "user-alice" sees the scene "vn_scene_cafe" on the stage in their context within 10 seconds
    And "user-bob" sees the scene "vn_scene_cafe" on the stage in their context within 30 seconds
    # Dialogue-box oracle: a room message sent DURING the call (from a second
    # tab in bob's own context) is typewriter-projected into BOTH members'
    # stage dialogue boxes by the same 1Hz poll that carries the signalling.
    When "user-bob" sends the unique dialogue message "vn-dialogue" to the shared public room from a second tab
    Then "user-alice" sees the dialogue message "vn-dialogue" in the stage dialogue box in their context within 30 seconds
    And "user-bob" sees the dialogue message "vn-dialogue" in the stage dialogue box in their context within 30 seconds
    And the stage dialogue box is announced politely in "user-alice" context
