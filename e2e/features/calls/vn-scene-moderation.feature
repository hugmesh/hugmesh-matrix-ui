Feature: The shared VN scene defends itself against a hostile or seizing driver
  As the Matrix remote
  I must ignore a scene event whose sender sits below the room's required power
  level, and coalesce a burst of rapid flips, keeping the last GOOD scene either
  way
  So one member cannot flip or seizure the stage everyone else is looking at

  # OFFLINE (untagged): the guard is a CLIENT-SIDE RECEIVE-PATH defence
  # (vn-scene-moderation.ts, applied by getModeratedSceneState), so the honest
  # end-to-end proof is a seeded room whose `m.room.power_levels` and
  # `net.hugmesh.vn.scene` events are route-fulfilled — exactly the write a
  # hostile member would land on a real homeserver that DID allow it, which is
  # the case the client must still survive. No homeserver can produce this
  # state on demand anyway: a server that enforces the level would reject the
  # hostile write, so seeding it is the only way to test the client's own
  # defence. (The cross-user round-trip of a LEGITIMATE scene stays @cluster in
  # vn-voice-call.feature.)

  # The call view re-reads the room's scene on its 1Hz pump. The room is first
  # staged by a MODERATOR, then a plain member (power level 0, below the guard's
  # moderator floor) overwrites the state event with a different scene. The
  # stage must keep the moderator's scene — and the ordering oracle that makes
  # this a real assertion rather than timeout-and-hope is twofold: the seeded
  # route COUNTS the state reads, so the hostile scene is proven to have been
  # fetched several times, and a LEGITIMATE scene served afterwards does land,
  # proving the poll path was live the whole time.
  Scenario: a below-power-level member's scene is ignored and the last good scene is kept
    Given "user-alice" has a seeded session
    When "user-alice" opens the VN call view on a room staged by a moderator
    Then the stage shows the moderator's scene "vn_scene_cafe"
    When a below-power-level member overwrites the room's scene with "vn_scene_starship"
    And the call view has re-read the room state 3 more times
    Then the stage still shows the moderator's scene "vn_scene_cafe"
    When the moderator stages "vn_scene_night_city" instead
    Then the stage shows the moderator's scene "vn_scene_night_city"

  # RATE LIMIT: an AUTHORIZED but seizing driver flips the scene on every single
  # poll. SceneRateLimiter coalesces (3 applied changes per 5s window), so the
  # stage must swap its background strictly FEWER times than the number of flips
  # the room served — and no 5-second span may hold more than 3 of those swaps,
  # which is the limiter's contract stated directly. Every background the stage
  # ever showed is recorded (with its timestamp) by a MutationObserver installed
  # before navigation, so the counts are exact rather than sampled; without the
  # limiter they would equal the number served, which is what a mutation run of
  # this scenario confirms.
  Scenario: a seizing driver's rapid flips are coalesced by the stage
    Given "user-alice" has a seeded session
    When "user-alice" opens the VN call view on a room whose moderator flips the scene every poll
    And the call view has re-read the room state 10 more times
    Then the stage applied strictly fewer scenes than the room served
    And the stage is still showing one of the served scenes
