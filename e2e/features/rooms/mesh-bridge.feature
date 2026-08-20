Feature: The Meshtastic LoRa-mesh bridge is visible and honest about what it can prove
  As the Matrix remote
  I must mark every message that arrived over the radio with its provenance —
  and say plainly that a LoRa node id is not authenticated — while letting a
  member manage the radios claimed under their own name
  So a community can run a LoRa bridge without ever mistaking a radio's
  self-reported node id for an authenticated identity

  # OFFLINE (untagged): both surfaces are pure RENDER off server-held state, so
  # neither needs a live homeserver, BFF or bridge appservice — the
  # com.hugmesh.mesh content fragment on a timeline event and the
  # /bff/user/mesh-devices rows are SEEDED via route-fulfilment (the same
  # pattern read-receipts.feature's offline half uses).
  #
  # Two mesh surfaces stay UNCOVERED here, for different reasons (both listed in
  # e2e/README.md's Known e2e gaps):
  #   * a real radio round-trip — no bridge appservice is deployed anywhere yet,
  #     so "a packet leaves this room and comes back over LoRa" is unscriptable.
  #   * the room-settings bridge toggle — blocked on a CHANGE-DETECTION defect
  #     in room-settings.component, not on the test harness: the component
  #     renders `name`/`topic`/`meshEnabled`/`meshDevice`/`meshChannel` from
  #     PLAIN fields assigned after `await`ing MatrixService's raw `fetch`, and
  #     zone.js 0.16 does not patch `fetch`, so no change-detection tick follows
  #     the load. In a real browser the section stays at its defaults (and
  #     falsely power-LOCKED, since `summary` is still null) until some
  #     unrelated interaction ticks change detection. A scenario written against
  #     that page today could only assert the broken state, so it is deliberately
  #     absent rather than green.

  # ── The timeline provenance badge ──
  # A room whose history holds ONE radio-bridged message (an @mesh-* sender
  # carrying a com.hugmesh.mesh fragment) and ONE ordinary message. The badge
  # must land on the bridged one and NOWHERE else — the ordinary message is
  # proven rendered first, so its lack of a badge is never a vacuous absence.
  Scenario: a radio-bridged message is badged with its node id and the ordinary one is not
    Given "user-alice" has a seeded session
    When "user-alice" opens a seeded room holding one radio-bridged and one ordinary message
    Then the bridged message carries the "via LoRa mesh" badge naming node "!a1b2c3d4"
    And the badge's title reports the radio signal and the authentication caution
    And the ordinary message carries no mesh badge

  # ── User settings → My Mesh Devices ──
  # A REVOKED radio stays listed (flagged, with the server's reason) but its
  # visibility is frozen, while an ACTIVE one keeps a live visibility control —
  # both rows fed by the seeded GET /bff/user/mesh-devices.
  Scenario: my claimed radios list an active device and a flagged revoked one
    Given "user-alice" has a seeded session
    When "user-alice" opens user settings holding an active and a revoked mesh device
    Then the active device shows its radio-reported status line and a live visibility control
    And the revoked device is flagged with the server's reason and its visibility is frozen

  # The claim / visibility / release round trip. The malformed node id is
  # refused CLIENT-side (normalizeMeshNodeId) with an announced reason and no
  # request at all; the ordering oracle for that absence is the VALID claim
  # right after it, which does reach the BFF — so the route was demonstrably
  # live while the malformed one sent nothing.
  Scenario: claiming, re-scoping and releasing a radio reach the mesh-device BFF
    Given "user-alice" has a seeded session
    When "user-alice" opens user settings holding an active and a revoked mesh device
    And "user-alice" tries to register the node id "nothex!!"
    Then the mesh claim error names the 8-hex-digit rule
    And no mesh-device write has reached the BFF
    When "user-alice" registers the node id "!A1B2C3D4"
    Then the claim reached the BFF carrying the canonical node id "!a1b2c3d4"
    When "user-alice" sets the active device's visibility to "friends"
    Then the visibility change reached the BFF carrying "friends"
    When "user-alice" releases the active device
    Then the release reached the BFF naming the active device
