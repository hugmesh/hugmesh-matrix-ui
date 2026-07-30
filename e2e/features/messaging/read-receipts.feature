Feature: Read receipts show which members have seen each message
  As the Matrix remote
  I must render, per room, which OTHER members have read up to which event —
  the "seen by" indicator anchored on the single event each reader's receipt
  points at — and advertise my OWN read position as I view the latest event
  So a member can tell, at a glance, who has caught up to a message

  # SPLIT: the receipt→render MAPPING (a seeded receipt lands its indicator on
  # the exact event its author read, and NOWHERE else) is deterministic and
  # needs no live homeserver, so the first scenario runs OFFLINE with the CS-API
  # seeded via route-fulfilment (the timeline + the folded /sync ephemeral
  # receipt render exactly as they would against a real server). The live
  # cross-user DELIVERY half — one member's genuine m.read receipt reaching the
  # message author's screen through a real /sync round-trip — is a homeserver
  # round-trip and stays @cluster.

  # OFFLINE (render mapping): a room is seeded so member "Bob" has read the
  # EARLIER of two messages. The indicator MUST appear on that earlier message
  # (labelled "Read by Bob") and MUST be absent from the later one — the exact
  # "shows on N, not N+1" invariant, proven end-to-end through the rendered DOM.
  Scenario: a seeded read receipt renders on the exact message its author has read
    Given "user-alice" has a seeded session
    When "user-alice" opens a seeded room where "Bob" has read the earlier of two messages
    Then the read receipt for "Bob" appears on the earlier message labelled "Read by Bob"
    And the read receipt for "Bob" does not appear on the later message

  # @cluster (live cross-user delivery): alice posts a message; bob opens the
  # shared room (his own /sync send-on-view advertises his read position up to
  # it); alice — parked on the live chat shell — sees bob's avatar as the
  # "seen by" indicator on HER message through a real receipt round-trip. The
  # author's-own receipt is never shown, so a match can only be bob's.
  @cluster
  Scenario: a member's read receipt is delivered to the message author's timeline
    Given "user-alice" has a seeded session in their own context
    And "user-bob" has a seeded session in their own context
    And "user-alice" has joined the shared public room in their context
    And "user-bob" has joined the shared public room in their context
    When "user-alice" sends a unique message "seen-target" in the shared public room
    And the message "seen-target" appears in "user-bob" timeline within 30 seconds
    Then "user-alice" sees a read receipt from "user-bob" on the message "seen-target" within 30 seconds
