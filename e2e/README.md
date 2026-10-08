# hugmesh-matrix-ui — e2e (Playwright + playwright-bdd)

See the [repo README](../README.md) for what this remote does. This page covers
only the e2e harness.

A Gherkin-readable e2e harness for the **Matrix chat remote** (the Element-like
CS-API client). It is copied from the `hugmesh.games/e2e` pattern and follows the
platform-wide harness conventions (`admin-ui`, `mod-ui`, `mastodon-ui`,
`login-ui`). It is pure test code in this `e2e/` directory. The only app-side
additions are small `data-testid` surfaces the scenarios assert, each unit-tested
next to its component: the mod-gated timeline redact control, the explicit
`timeline-denied` state, the announced `composer-status`, `rl-join-error` and
`rl-dm-error` failures, and the `rl-*-lock-note` domain-lock helptext.

## The `@cluster` tag (ships dark)

Every scenario that needs a live stack (homeserver, user-bff hsproxy, mod-bff,
seeded rooms and personas) carries **`@cluster`**, on the feature or the scenario.
This is the platform-majority convention; this repo used `@skip-cluster` before,
and the tag was renamed with the same meaning. The default Playwright config
filters them out (`tags: 'not @cluster'`), so the **default run needs no
cluster**. CI's `e2e:bdd` job proves the whole suite compiles and discovers
offline (`bddgen` + `playwright test --list`). That job runs in GitLab CI
(`.gitlab-ci.yml`) and is `allow_failure: true`.

`@cluster` is a plain filter tag. It is deliberately NOT playwright-bdd's reserved
`@skip`, which removes a scenario from generation, so it could never be
discovered. To run the dark set against a real deployment, override the filter
(set `tags: ''`) and set `E2E_BASE_URL`.

Scenarios that need only a seeded `localStorage['hug.session']` (role tiers,
domain-lock helptext, access gating, a11y) are not tagged and run offline.

## What it covers

- **`features/access/role-matrix-access.feature`** — the ROLE_MATRIX access gate:
  a registered USER is allowed; a role-absent or banned visitor is denied (the
  signed-out prompt); skip-link and landmark a11y.
- **`features/access/role-grant-unlock-loop.feature`** (@cluster) — the Matrix-side
  leg of the cross-service loop "grant ROLE_MATRIX, the Matrix surface unlocks". The
  same fixed identity is denied the gated surface, granted ROLE_MATRIX through the
  admin BFF and allowed, then revoked and denied again. This shows that the
  gateway's `gateway_route_access` gate, not the client-side `registeredGuard`, is
  the real reachability boundary. The feature file's header explains why it uses
  three pre-minted tokens (a randomized target would test two unrelated identities).
- **`features/moderation/role-tiers.feature`** — the additive USER/MOD/ADMIN tier
  matrix (allow and deny per role); the admin Approve/Deny decide tier (real verbs
  since role-actions #36; its help note documents the kill-switch-override and
  audit-trail semantics); and the **SUPERADMIN fold-in** row. SessionService has no
  distinct superadmin tier, so a `superadmin`+`admin` session must render exactly the
  admin tier (asserted by enumerating every rendered `tier-*` testid). One @cluster
  scenario checks that the role-actions disclosure returns focus to its trigger on
  Escape.
- **`features/moderation/domainlock.feature`** and **`domainlock-enforcement.feature`**
  — the `matrix_domainlocked` SOCIAL LOCAL-ONLY marker. Helptext steering is
  offline. @cluster: LOCAL actions stay usable (locked dana sends, bob receives); a
  federated join and a cross-domain DM are **explicitly rejected** (an announced
  `role=alert` notice naming the lock; the target is never listed); and the unlock
  round-trip works. The unlock uses the mod-ui verb
  `DELETE /bff/mod/domain-lock/ROLE_MATRIX_DOMAINLOCKED/{user}` and expects the
  honest **202 pending-reconcile envelope**, never a fake synchronous OK. A fresh,
  marker-less session then joins a federated room.
- **`features/messaging/message-visibility.feature`** (@cluster) — the core
  visibility matrix across per-persona contexts.
  - A member receives a member's message (sync-aware `expect.poll`).
  - A non-member is denied: the room is unlisted, a deep link shows the explicit
    `timeline-denied`, and the message is never rendered.
  - A signed-out visitor is denied. This remote has no guard by design (the login
    redirect lives in the host shell), so the deny provable here is the
    server-rejected, session-less history fetch rendering `timeline-denied`.
  - A banned sender gets an **announced** send failure, and the message is absent
    after a canary in a member's timeline.
- **`features/messaging/rooms-membership.feature`** (@cluster):
  - A public join is allowed.
  - An invite-only room denies, then allows once invited, using a REAL captured room
    id and a secret-message oracle.
  - A moderator kick revokes visibility. The victim's own server-fetched list drops
    the room first. The post-kick absence is a fresh history fetch made after the
    message provably exists (a kicked user can never receive an in-room canary).
  - Cross-tenant enumeration is denied for a room **proven to exist** to its member
    first.
- **`features/messaging/redaction.feature`** (@cluster) — a mod redacts a member's
  message and author, member and mod all converge on the redacted placeholder. A
  plain member is never OFFERED redaction of another's message (but is of their
  own). Author self-redact propagates.
- **`features/isolation/cross-tenant.feature`** — cross-context tier and tenant
  isolation. A MOD context open beside a USER context does not elevate the USER, and
  two tenants resolve to distinct Matrix ids (both offline). The @cluster scenario
  is a tenant-b user failing to enumerate tenant-a's rooms.
- **`features/rooms/room-settings.feature`** (@cluster) — the room-settings
  power-level gate. The room CREATOR (Matrix power level 100) renames the room and a
  member sees the update. A plain member (power level 0, below `state_default`)
  attempts the same state-event PUT and sees the announced `room-settings-status`
  failure, and the rename never applies for another observer. The form itself offers
  Save to every member (as Element's dialog does); the real gate is the homeserver's
  403.
- **`features/rooms/membership-power-deny.feature`** (@cluster) — announced failure
  for a power-denied kick. Victim creates first: alice (creator, power level 100)
  provisions the room and invites bob (power level 0) through the real UI. Bob's
  Kick on alice must surface the homeserver's 403 in the `member-list-status`
  aria-live region (never the silent no-op the swallowed response used to produce),
  and alice is still a member on her OWN fresh fetch.
- **`features/rooms/invite-experience.feature`** (@cluster) — the invitee's side.
  alice creates an invite-only room, posts a unique secret and invites bob. Bob's
  room list must show the pending invite for the real captured room id with an
  actionable Accept, and accepting makes the secret visible to him. This pins the
  `rooms.invite` surface that replaced joining by an out-of-band room id.
- **`features/messaging/stickers.feature`** — MSC2545 `m.sticker` rendering. OFFLINE
  (route-fulfilled CS-API): a seeded sticker event renders as an image with an
  accessible label and NO duplicate text row (reverting the `rows()` widening fails
  it), plus the picker's empty state and Escape focus-return. @cluster: alice sends a
  sticker from her own pack and bob sees THAT sticker, matched on the real event id
  captured off alice's echo. Live premise: alice needs a registered
  `im.ponies.user_emotes` pack on the seed homeserver, or the step fails loudly with
  no tile to click.
- **`features/rooms/room-create.feature`** — required-name validation, offline (the
  `matrix.createRoom` call sits behind an early guard, so an empty name sends no
  request). @cluster: the "Public" preset's no-invite join, distinct from the
  invite-only deny-then-allow pair in `rooms-membership.feature`.
- **`features/messaging/threads.feature`** (@cluster) — a threaded reply reaches
  every room member and the room's "All threads" list picks it up. It has no thread
  deny scenario on purpose: `getRelations`/`getThreads` turn a rejected fetch into an
  empty list (unlike `messages()`, which throws so `timeline-denied` can render), so a
  non-member's thread view looks the same as "no thread yet". The membership deny is
  proven at room-history level in `message-visibility.feature`.
- **`features/messaging/message-edits.feature`** (@cluster) — the author edits their
  own message and every member sees the new content and `edited-marker`. The Edit
  control (`isMine` only) is offered to the author, never to another member, like the
  redact ownership gate. NOTE: unlike Element, this client does not fold an edit back
  onto its original bubble. The edit renders as its OWN new timeline row, and the
  scenarios assert exactly that.
- **`features/messaging/typing-indicator.feature`** (@cluster) — the live typing
  indicator (`room-view.component.ts` `typingUsers`, fed by the `/sync` long-poll) is
  visible to another member in real time. Best effort: the composer auto-clears
  `typing:true` 3s after the last keystroke, so the typer step repeats keystrokes to
  hold it while the watcher's `expect.poll` observes.
- **`features/profile/user-settings.feature`** (@cluster) — cross-user visibility of
  a saved profile change. It has no allow/deny pair (self-service, no adversary, no
  "edit someone else's name" control to deny). It shows that a member's new display
  name is a real, server-persisted write visible in another member's member-list
  fetch.
- **`features/profile/chat-theme.feature`** — per-user chat theming
  (`ChatThemeService`), OFFLINE (untagged): single-axis sweeps over every
  preset/bubble-shape/font/density/background value, a seeded 20-combo random sweep,
  cross-surface scoping (a saved theme boots onto the room-view root but never
  `<body>`), reset-to-stock, and phone and tablet touch-target checks. Themes persist
  to Matrix account data (fail-soft locally first), so the whole sweep is provable
  with no homeserver.
- **`features/messaging/read-receipts.feature`** — the "seen by" indicator
  (`timeline.component.ts`). OFFLINE (untagged): the exact "shows on the read event,
  not the next one" render mapping, via seeded ephemeral receipts. `@cluster`: real
  cross-user delivery — bob's genuine `m.read` receipt, sent by viewing the room,
  reaches alice's timeline through a live `/sync` round-trip.
- **`features/search/message-search.feature`** (@cluster) — full-text search is
  membership-scoped. A member finds their own room's message (allow). The SAME
  provably-existing message is never surfaced to an outsider who was never invited
  (deny), because the homeserver indexes only rooms the caller joined.
- **`features/messaging/reactions.feature`** (@cluster) — an emoji reaction is a real
  `m.annotation` round-trip. A member opens the React picker (its client-side APG
  state, `aria-expanded` toggle and `role=menu`, is asserted inline), reacts, and
  every member sees the same pill with an accurate count (`timeline.component.ts`
  `aggregateReactions` over `getRelations`). The reactor's pill reads
  `aria-pressed=true`; another member's reads `false`. A second scenario shows two
  members' reactions aggregating to 2, and removing one (a redact of the caller's own
  reaction) dropping it to 1 for every member. There is no offline surface: the pill
  exists only on a real, server-gated message row.
- **`features/calls/video-call.feature`** — the WebRTC video call
  (`matrix-call.component.ts`). OFFLINE (untagged): the idle-state controls and the
  honest host/LAN-only capability note (the `state()`/`turnAvailable()` defaults
  render before any homeserver fetch resolves). @cluster: the real 1:1 handshake. One
  member places a call; the RINGING transition on the other side is the honest
  cross-user oracle (the callee's `pump()` read the caller's `m.call.invite` back out
  of the live homeserver). Then both connect over host/LAN ICE candidates. It needs a
  live homeserver AND the config's `--use-fake-device-for-media-stream` (synthetic
  camera and mic for `getUserMedia`).
- **`features/calls/vn-voice-call.feature`** — the VN voice-chat call mode
  (`?mode=vn-voice`). OFFLINE (untagged): the VN stage renders instead of video tiles
  with no backend, and the room header offers both call-mode entries. @cluster: a
  full 1:1 VN call connects; both members' sprites appear on the shared stage; a
  scene pick by one member round-trips the room STATE event to the other; and a room
  message typewriter-projects into both stage dialogue boxes.
- **`features/calls/vn-scene-sweep.feature`** — every manifest scene, prop
  add/move/resize/remove, the keyboard radiogroup (roving tabindex + arrows), and the
  32-prop cap (disables and announces, re-enables on removal). OFFLINE (untagged): the
  picker applies to the stage optimistically whatever the room-state PUT does, so it
  is provable with no homeserver. The cross-user round-trip of the same state event is
  the @cluster scenario in `vn-voice-call.feature`.
- **`features/calls/vn-scene-moderation.feature`** — the shared scene's TRUST
  BOUNDARY (`vn/scenes/vn-scene-moderation.ts`, applied on the receive path by
  `getModeratedSceneState`). A below-power-level sender's scene event is ignored and
  the last GOOD scene kept. An authorized but seizing driver's per-poll flip burst is
  coalesced to `SceneRateLimiter`'s 3-changes-per-5s budget. Both are OFFLINE
  (untagged) by necessity: a homeserver that ENFORCES the power level would refuse the
  hostile write, so route-fulfilling the room state is the only way to stage what the
  client must survive (a mis-configured `state_default`, an older room preset, a
  compromised server). Neither scenario sleeps: the seeded route COUNTS state reads,
  and every assertion waits on proven re-reads. The "ignored" half is followed by a
  LEGITIMATE scene that does land, which proves the poll path was live. The coalesce
  half records every background the stage showed with a MutationObserver.
- **`features/calls/vn-viewport.feature`** — the VN call screen and room view stay
  usable on phone and tablet viewports: no forced horizontal scroll, the 16:9 stage
  letterboxes, and controls meet the 44px touch-target minimum.
- **`features/rooms/mesh-bridge.feature`** — the Meshtastic LoRa-mesh bridge's two
  client-provable surfaces, OFFLINE off seeded fixtures.
  - The timeline's "via LoRa mesh" chip: present on an `@mesh-*` sender's event
    carrying a `com.hugmesh.mesh` fragment, naming its node id, with the
    node-ids-are-not-authenticated caution in its title; absent from an ordinary
    message proven rendered first.
  - User settings' My Mesh Devices: an active radio's telemetry line and live
    visibility control; a revoked radio still listed, flagged with the server's
    reason, and frozen; and the claim, visibility and release verbs asserted on the
    REQUESTS they send to `/bff/user/mesh-devices`. A malformed node id is refused
    client-side and sends nothing, with the valid claim right after it as the
    ordering oracle.
## Sibling harness: face-track e2e (`npm run e2e:face`)

The chat3d **camera face-tracking pipeline** has its own runner under
[`face-track/`](./face-track/README.md), independent of karma and Playwright.
Headless Chrome plays the committed synthetic-face `face-clip.y4m` through
`--use-fake-device-for-media-stream` into the REAL `FaceTrackService`, the REAL
worker and the REAL self-hosted MediaPipe wasm and model. It asserts calibrated
`jawOpen`, `eyeBlink*` and `eyeLook*` ranges on the emitted 52-float vector stream,
across GPU, pinned-CPU and no-WebGL (honest teardown) scenarios. It sits outside the
Playwright config because it drives a raw fake-camera Chrome session against a
loopback asset server, not the app UI.

## Known e2e gaps

- **Meshtastic LoRa-mesh bridge — the ROOM-SETTINGS toggle** (see the main
  [README](../README.md#meshtastic-lora-mesh-bridge-rooms-timeline-my-devices)). The
  other two surfaces have offline coverage in `features/rooms/mesh-bridge.feature`;
  the room-settings bridge section does not. The blocker is the app, not the
  harness. `room-settings.component` renders `name`, `topic`, `meshEnabled`,
  `meshDevice` and `meshChannel` from PLAIN fields assigned after `await`ing
  `MatrixService`'s raw `fetch`. zone.js 0.16 does not patch `fetch` (only
  `Promise`), so those continuations run outside the Angular zone and NO
  change-detection tick follows the load. On a real page load the section sits at
  its defaults, and — because `summary` is still `null` when `canEditMeshBridge()`
  is evaluated — renders as power-LOCKED with the WHY-helptext even for a room
  moderator, until some unrelated interaction ticks change detection. (Surfaces that
  work read through signals or Angular's `HttpClient`, which re-enters the zone.) A
  scenario written against that page today could only assert the broken state, so it
  is absent rather than green. Fix the component first, then add the allow/deny
  power-level pair.
- **Meshtastic LoRa-mesh bridge — a real radio round-trip.** No bridge appservice is
  deployed anywhere, so "a message leaves this room and comes back over LoRa" cannot
  be scripted. The seeded fixtures prove how the client renders that provenance, never
  the radio path.
- **Character voice (Piper TTS synth and recorded voice-clip capture)** ships
  **dark** (`VOICE_TTS_ENABLED` defaults to `false`; no backend is deployed anywhere
  on the platform yet — see the main README's Known Gaps & Roadmap).
  `VoiceSynthService`, `VoicePlaybackService` and `CharacterCaptureService` are
  unit-tested against mocks, but have no e2e coverage. There is no real backend to
  round-trip against, and the flag-off behaviour (a no-op, no HTTP call) is not a UI
  flow worth scripting. Add scenarios once the seam is enabled somewhere runnable.

## Honest-test rules this suite follows

1. Message bodies are unique per scenario, so a timeline match can only come from
   this scenario's send.
2. Absence is asserted only after an ordering oracle (a later canary arrived, or the
   membership revocation is itself visible). Never timeout-and-hope, and never a bare
   `waitForTimeout` (see `tests/helpers/timeline.ts`).
3. A deny always asserts the announced rejection surface (`role=alert` notice,
   `timeline-denied`, `composer-status`), paired with the resource's proven existence
   for its rightful owner. No fabricated ids, no `A OR B` oracles.
4. Desired-state writes (domain-unlock) assert the honest 202 pending-reconcile
   envelope, never a synchronous success.

## Run

```bash
npm install
npm run bdd          # bddgen + playwright test (offline set; @cluster needs a live stack)
```

## Validate OFFLINE (no cluster)

```bash
npm install
npx bddgen                     # compile every .feature → .features-gen/*.spec.js
npx playwright test --list     # default config (not @cluster) — the dark run discovers 0 cluster scenarios
```

### Actually EXECUTING the offline set locally

Listing proves only that the Gherkin compiles and every step resolves. To *run* the
offline scenarios, serve the built remote and point `E2E_BASE_URL` at it. The seeded
route-fulfilment halves need no homeserver, but they do need the real bundle:

```bash
npm run build:matrix                      # repo root
# serve dist/matrix/browser with an SPA fallback (deep routes like /settings,
# /rooms must return index.html, not 404) on e.g. :8099
E2E_BASE_URL=http://127.0.0.1:8099 npx bddgen && npx playwright test
```

Two container-isms bite outside CI. The config's `html` reporter and `outputDir` are
hardcoded to `/work/results/*`, so a local run needs `--reporter=list` and
`--output=<writable dir>`. And not every dev image has a bundled Chromium: the `bdd`
project in `playwright.config.ts` uses `devices['Desktop Chrome']` and sets no
`channel`, so it launches Playwright's own Chromium build. To reuse an installed
Google Chrome, add `channel: 'chrome'` to that project locally.

## Seed users

See `tests/helpers/roles.ts`. Sessions are seeded straight into the `hug.session`
localStorage key (the exact shape `SessionService.set()` writes): `user-alice` and
`user-bob` (tenant-a users), `user-carol` (tenant-b), `mod-mallory`, `admin-adam`,
`superadmin-sam`, `user-dana-locked` (domain-locked), `banned-eve` (role-absent).
Cluster scenarios resolve personas' Matrix ids with `matrixIdFor()`
(`@<username>:<tenant>`, overridable per persona with `E2E_MATRIX_ID_<USERNAME>`,
hyphens becoming underscores and the name upper-cased, e.g.
`E2E_MATRIX_ID_USER_ALICE`). They use the seeded rooms `E2E_PUBLIC_ROOM`,
`E2E_FEDERATED_ROOM_ALIAS` and `E2E_CROSS_DOMAIN_USER` (defaults in the step files
under `features/steps/`). Live runs against a REAL mod-bff must also export
`E2E_MOD_BFF_TOKEN` (a genuine moderator `bff_` session bearer) for the domain-unlock
verb. The seeded placeholder token is honoured only by a stack running mod-bff in its
e2e test-auth mode.
