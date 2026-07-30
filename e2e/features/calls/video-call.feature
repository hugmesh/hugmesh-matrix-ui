Feature: Matrix WebRTC video call — idle-state controls and the ringing handshake
  As the Matrix remote
  I must present the call controls in an honest, capability-gated idle state,
  and let one member place a call that rings the other member and connects
  So the video-call surface is usable offline for its client-side state and
  proven end-to-end against a live homeserver

  # OFFLINE (untagged): the call view (matrix-call.component) renders its
  # initial signal state with NO backend — state()='idle' and turnAvailable()
  # =false are the pre-await defaults set at construction, so the template
  # renders them before ngOnInit's homeserver fetches ever resolve. This asserts
  # the client-side gating + the honest "host/LAN-only until a TURN relay" note
  # (callHelp getter), all of which are pure client state.
  Scenario: the call view renders its idle state with gated controls and the LAN-only capability note
    Given "user-alice" has a seeded session
    When "user-alice" opens the call view
    Then the call view shows the idle state
    And the hang-up control is disabled while no call is in progress
    And the call help surfaces the LAN-only capability note

  # @cluster: the real 1:1 call handshake needs a live homeserver (the
  # m.call.invite / m.call.answer / m.call.candidate signalling rides the room
  # via /messages) AND a synthetic camera/mic (getUserMedia — the config's
  # --use-fake-device-for-media-stream). The RINGING transition is the honest
  # cross-user oracle: it can only happen because the callee's pump() read the
  # caller's m.call.invite back out of the homeserver. Connection completes over
  # host/LAN ICE candidates.
  @cluster
  Scenario: a placed call rings the other member and both sides connect
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" opens the call view on the shared public room in their context
    And "user-alice" starts a call in their context
    And "user-bob" opens the call view on the shared public room in their context
    Then "user-bob" sees the call ringing in their context within 30 seconds
    When "user-bob" joins the ringing call in their context
    Then "user-alice" and "user-bob" both reach the connected call state within 60 seconds
