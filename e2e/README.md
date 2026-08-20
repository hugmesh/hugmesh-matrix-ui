# hugmesh-matrix-ui — e2e (Playwright + playwright-bdd)

See the [repo README](../README.md) for what this remote is/does; this page
covers only the e2e harness.

Gherkin-readable e2e harness for the **Matrix chat remote** (the Element-like
CS-API client). Copied from the proven `hugmesh.games/e2e` pattern and
aligned with the platform-wide harness conventions (`admin-ui`, `mod-ui`,
`mastodon-ui`, `login-ui`). Pure test code in this `e2e/` directory — the only
app-side additions are minimal `data-testid` surfaces the scenarios assert
(the mod-gated timeline redact control, the explicit `timeline-denied` state,
the announced `composer-status` / `rl-join-error` / `rl-dm-error` failures and
the `rl-*-lock-note` domain-lock helptext), each unit-tested next to its
component.

## The `@cluster` tag (ships dark)

Every scenario that needs a live stack (homeserver + user-bff hsproxy +
mod-bff + seeded rooms/personas) is tagged **`@cluster`** at the feature or
scenario level — the platform-majority convention (this repo previously used
`@skip-cluster`; the tag was renamed, semantics unchanged). The default
Playwright config filters them out (`tags: 'not @cluster'`), so the **default
run requires no cluster** and CI's `e2e:bdd` job proves the whole suite
compiles + discovers offline (`bddgen` + `playwright test --list`).

`@cluster` is a plain filter tag, deliberately NOT playwright-bdd's reserved
`@skip` (which removes a scenario from generation entirely, so it could never
be discovered). Run the dark set against a real deployment by overriding the
filter (set `tags: ''`) plus `E2E_BASE_URL`.

Scenarios that only need a seeded `localStorage['hug.session']` (role tiers,
domain-lock helptext, access gating, a11y) are NOT tagged and run offline.

## What it covers

- **`features/access/role-matrix-access.feature`** — the ROLE_MATRIX access
  gate: registered USER ALLOW, role-absent/banned DENY (signed-out prompt),
  skip-link + landmark a11y.
- **`features/access/role-grant-unlock-loop.feature`** (@cluster) — the
  MATRIX-side leg of the cross-service "grant ROLE_MATRIX → Matrix surface
  unlocks" loop: the same fixed target identity is denied the gated Matrix
  surface, granted ROLE_MATRIX via the admin BFF and allowed, then revoked and
  denied again — proving the gateway's `gateway_route_access` gate (not the
  client-side `registeredGuard`) is the real reachability boundary. See the
  feature file's header comment for the full three-pre-minted-token design
  rationale (why a randomized target would silently test two disconnected
  identities).
- **`features/moderation/role-tiers.feature`** — the additive USER/MOD/ADMIN
  tier matrix (ALLOW + DENY per role), the admin Approve/Deny decide tier
  (real verbs since role-actions #36; its help note documents the
  kill-switch-override + audit-trail semantics), and
  the **SUPERADMIN fold-in** row: SessionService has no distinct superadmin
  tier, so a `superadmin`+`admin` session must render exactly the admin tier
  (asserted by enumerating every rendered `tier-*` testid).
- **`features/moderation/domainlock.feature`** +
  **`domainlock-enforcement.feature`** — the `matrix_domainlocked` SOCIAL
  LOCAL-ONLY marker: helptext steering (offline), LOCAL actions fully usable
  (locked dana sends, bob receives — @cluster), federated join / cross-domain
  DM **explicitly rejected** (announced `role=alert` notice naming the lock,
  target never listed), and the unlock round-trip (the mod-ui verb `DELETE
  /bff/mod/domain-lock/ROLE_MATRIX_DOMAINLOCKED/{user}`, honest **202
  pending-reconcile envelope** — never a fake synchronous OK — then a fresh
  marker-less session joins a federated room).
- **`features/messaging/message-visibility.feature`** (@cluster) — the core
  visibility matrix across per-persona contexts: member→member delivery
  (sync-aware `expect.poll`), non-member DENY (room unlisted + explicit
  `timeline-denied` on deep link, message never rendered), signed-out DENY
  (this remote is guard-free by design — the login redirect lives in the host
  shell, so the DENY provable here is the server-rejected session-less history
  fetch rendering `timeline-denied`), banned sender's **announced** send
  failure + absence-after-canary in a member's timeline.
- **`features/messaging/rooms-membership.feature`** (@cluster) — public join
  ALLOW, invite-only DENY→invited ALLOW with a REAL captured room id + secret
  message oracle, moderator kick revoking visibility (the victim's own
  server-fetched list drops the room first; the post-kick absence is a fresh
  server-answered history fetch made after the message provably exists — a
  kicked user can never receive an in-room canary), and cross-tenant
  enumeration DENY against a room **proven to exist** to its member first.
- **`features/messaging/redaction.feature`** (@cluster) — mod redacts a
  member's message and author/member/mod all converge on the redacted
  placeholder; plain member is never OFFERED redaction of another's message
  (but is of their own); author self-redact propagates.
- **`features/isolation/`** — cross-context tier + tenant isolation.
- **`features/rooms/room-settings.feature`** (@cluster) — the room settings
  power-level gate: the room CREATOR (Matrix power level 100) renames their
  room and a member observes the update; a plain member (power level 0, below
  `state_default`) attempts the same state-event PUT, sees the announced
  `room-settings-status` failure, and the attempted rename never applies for
  another observer. The settings form itself offers Save to every member
  (matching Element's own dialog) — the real gate is the homeserver's 403.
- **`features/rooms/membership-power-deny.feature`** (@cluster) — announced-
  failure honesty on a power-denied kick. Victim-creates-first: alice (creator,
  power level 100) provisions the room and invites bob (power level 0) through
  the real UI; bob's Kick on alice must surface the homeserver's 403 in the
  `member-list-status` aria-live region (never the silent no-op the swallowed
  response used to produce), and alice is still a member on her OWN fresh fetch.
- **`features/rooms/invite-experience.feature`** (@cluster) — the invitee's side
  of an invite. alice creates an invite-only room, posts a unique secret, and
  invites bob; bob's room list must show the pending invite for the real
  captured room id with an actionable Accept, and accepting makes the secret
  visible to him. Pins the `rooms.invite` surface that replaced joining by an
  out-of-band room id.
- **`features/messaging/stickers.feature`** — MSC2545 `m.sticker` rendering.
  OFFLINE (route-fulfilled CS-API): a seeded sticker event renders as an image
  with an accessible label and NO duplicate text row — reverting the `rows()`
  widening fails it — plus the picker's empty state and Escape focus-return.
  (@cluster): alice sends a sticker from her own pack and bob sees THAT sticker
  (matched on the real event id captured off alice's own echo) in his timeline.
  Live premise: alice must carry a registered `im.ponies.user_emotes` pack on
  the seed homeserver, or the step fails loudly with no tile to click.
- **`features/rooms/room-create.feature`** — the required-name client-side
  validation (offline — the `matrix.createRoom` call sits behind an early
  guard, so no request is ever sent for an empty name) and (@cluster) the
  "Public" preset's no-invite join, distinct from the invite-only DENY→ALLOW
  pair in `rooms-membership.feature`.
- **`features/messaging/threads.feature`** (@cluster) — a threaded reply
  reaches every room member and the room's "All threads" list picks it up.
  Deliberately has no separate thread-specific DENY scenario: `getRelations`/
  `getThreads` degrade a rejected fetch to an empty list (unlike `messages()`,
  which throws so `timeline-denied` can render), so a non-member's thread view
  would be indistinguishable from "no thread yet" — the real membership DENY
  is already proven at the room-history level in `message-visibility.feature`.
- **`features/messaging/message-edits.feature`** (@cluster) — the author edits
  their own message and every member sees the new content + `edited-marker`;
  the Edit control (`isMine`-only) is only ever offered to the author, never
  to another member, mirroring the redact ownership gate. NOTE: this client
  does not fold an edit back onto its original bubble (unlike Element) — the
  edit renders as its OWN new timeline row; the scenarios assert exactly that
  real behaviour, not a claim that the pre-edit text disappears.
- **`features/messaging/typing-indicator.feature`** (@cluster) — the live
  typing indicator (`room-view.component.ts` `typingUsers`, fed by the
  `/sync` long-poll) is visible to another member in real time. Best-effort:
  the composer auto-clears `typing:true` 3s after the last keystroke, so the
  typer step re-triggers keystrokes to hold it active while the watcher's
  `expect.poll` observes.
- **`features/profile/user-settings.feature`** (@cluster) — cross-user
  visibility of a saved profile change: no ALLOW/DENY pair (self-service, no
  adversary — there is no "edit someone else's name" control to deny), so the
  honest coverage is that a member's new display name is a real,
  server-persisted write visible to another member's member-list fetch.
- **`features/profile/chat-theme.feature`** — per-user chat theming
  (`ChatThemeService`): OFFLINE (untagged) single-axis sweeps over every
  preset/bubble-shape/font/density/background value, a seeded 20-combo random
  sweep, cross-surface scoping (a saved theme boots onto the room-view root but
  never `<body>`), reset-to-stock, and phone/tablet touch-target checks. Themes
  persist to Matrix account data (fail-soft locally first), so the whole
  combination sweep is honestly provable with no homeserver.
- **`features/messaging/read-receipts.feature`** — the "seen by" indicator
  (`timeline.component.ts`): OFFLINE (untagged) proves the exact
  "shows on the read event, not the next one" render mapping via seeded
  ephemeral receipts; `@cluster` proves a real cross-user delivery (bob's
  genuine `m.read` receipt, sent by viewing the room, reaches alice's
  timeline through a live `/sync` round-trip).
- **`features/search/message-search.feature`** (@cluster) — full-text search
  is membership-scoped: a member finds their own room's message (ALLOW), and
  the SAME provably-existing message is never surfaced to an outsider who was
  never invited (DENY) — the homeserver only indexes rooms the caller joined.
- **`features/messaging/reactions.feature`** (@cluster) — an emoji reaction is
  a real `m.annotation` round-trip: a member opens the React picker (its
  client-side APG state — `aria-expanded` toggle, `role=menu` — asserted inline,
  reachable only from a rendered message), reacts, and every member sees the
  same pill with an accurate aggregate count (`timeline.component.ts`
  `aggregateReactions` over `getRelations`), the reactor's own pill reading
  `aria-pressed=true` and another member's `false`. A second scenario proves two
  members' reactions aggregate to a count of 2 and that removing one (redact of
  the caller's own reaction) drops it back to exactly 1 for every member. No
  offline surface — the pill only exists on a real, server-gated message row.
- **`features/calls/video-call.feature`** — the WebRTC video call
  (`matrix-call.component.ts`). OFFLINE (untagged): the call view renders its
  idle-state controls with the honest host/LAN-only capability note (the
  `state()`/`turnAvailable()` pre-await signal defaults render before any
  homeserver fetch resolves, so they hold with no backend). @cluster: the real
  1:1 handshake — one member places a call and the RINGING transition on the
  other side is the honest cross-user oracle (the callee's `pump()` read the
  caller's `m.call.invite` back out of the live homeserver), then both connect
  over host/LAN ICE candidates. Needs a live homeserver AND the config's
  `--use-fake-device-for-media-stream` (synthetic camera/mic for `getUserMedia`).
- **`features/calls/vn-voice-call.feature`** — the VN voice-chat call mode
  (`?mode=vn-voice`): OFFLINE (untagged) the VN stage renders instead of video
  tiles with no backend, and the room header offers both call-mode entries;
  `@cluster` a full 1:1 VN call connects, both members' sprites appear on the
  shared stage, a scene pick by one member round-trips the room STATE event to
  the other, and a room message typewriter-projects into both stage dialogue
  boxes.
- **`features/calls/vn-scene-sweep.feature`** — every manifest scene + prop
  add/move/resize/remove, the keyboard radiogroup (roving tabindex + arrows),
  and the 32-prop cap (disables + announces, re-enables on removal). OFFLINE
  (untagged): the picker applies to the stage optimistically regardless of the
  room-state PUT's outcome, so this is honestly provable with no homeserver;
  the cross-user round-trip of the same state event is the `@cluster` scenario
  in `vn-voice-call.feature`.
- **`features/calls/vn-scene-moderation.feature`** — the shared scene's TRUST
  BOUNDARY (`vn/scenes/vn-scene-moderation.ts`, applied on the receive path by
  `getModeratedSceneState`): a below-power-level sender's scene event is
  ignored and the last GOOD scene kept, and an authorized-but-seizing driver's
  per-poll flip burst is coalesced to `SceneRateLimiter`'s 3-changes-per-5s
  budget. OFFLINE (untagged) by necessity, not convenience — a homeserver that
  ENFORCES the power level would refuse the hostile write, so route-fulfilling
  the room state is the only way to stage the case the client must survive (a
  mis-configured `state_default`, an older room preset, a compromised server).
  Neither scenario sleeps: the seeded route COUNTS the state reads, so every
  assertion waits on proven re-reads, the "ignored" half is followed by a
  LEGITIMATE scene that does land (proving the poll path was live), and the
  coalesce half records every background the stage ever showed with a
  MutationObserver rather than sampling for them.
- **`features/calls/vn-viewport.feature`** — the VN call screen and room view
  stay usable on phone/tablet viewports: no forced horizontal scroll, the
  16:9 stage letterboxes, and controls meet the 44px touch-target minimum.
- **`features/rooms/mesh-bridge.feature`** — the Meshtastic LoRa-mesh bridge's
  two client-provable surfaces, OFFLINE off seeded fixtures: the timeline's
  "via LoRa mesh" provenance chip (present on an `@mesh-*` sender's event
  carrying a `com.hugmesh.mesh` fragment, naming its node id, with the
  node-ids-are-not-authenticated caution in its title — and absent from an
  ordinary message proven rendered first), and user-settings' My Mesh Devices
  (an active radio's telemetry line + live visibility control, a revoked one
  still listed/flagged with the server's reason and frozen, and the
  claim/visibility/release verbs asserted on the REQUESTS they send to
  `/bff/user/mesh-devices` — a malformed node id is refused client-side and
  sends nothing, with the valid claim right after it as the ordering oracle).

## Sibling harness: face-track e2e (`npm run e2e:face`)

The chat3d **camera face-tracking pipeline** has its own karma- and
Playwright-independent runner under [`face-track/`](./face-track/README.md):
headless Chrome plays the committed synthetic-face `face-clip.y4m` through
`--use-fake-device-for-media-stream` into the REAL `FaceTrackService` → REAL
worker → REAL self-hosted MediaPipe wasm/model, asserting calibrated
`jawOpen`/`eyeBlink*`/`eyeLook*` ranges on the emitted 52-float vector stream
across GPU / pinned-CPU / no-WebGL(honest-teardown) scenarios. It lives
outside the Playwright config because it drives a raw fake-camera Chrome
session against a loopback asset server, not the app UI.

## Known e2e gaps

- **Meshtastic LoRa-mesh bridge — the ROOM-SETTINGS toggle** (see the main
  [README](../README.md#meshtastic-lora-mesh-bridge-rooms-timeline-my-devices)).
  The other two surfaces now have offline coverage in
  `features/rooms/mesh-bridge.feature`; the room-settings bridge section does
  not, and the blocker is the APP, not the harness. `room-settings.component`
  renders `name`, `topic`, `meshEnabled`, `meshDevice` and `meshChannel` from
  PLAIN fields assigned after `await`ing `MatrixService`'s raw `fetch`. zone.js
  0.16 does not patch `fetch` (only `Promise`), so those continuations run
  outside the Angular zone and NO change-detection tick follows the load: on a
  real page load the section sits at its defaults and — because `summary` is
  still `null` when `canEditMeshBridge()` is evaluated — renders as
  power-LOCKED with the WHY-helptext even for a room moderator, until some
  unrelated interaction ticks change detection. (The surfaces that do work
  read through signals or Angular's `HttpClient`, which re-enters the zone.)
  A scenario written against that page today could only assert the broken
  state, so it is deliberately absent rather than green; worth fixing the
  component first, then adding the ALLOW/DENY power-level pair.
- **Meshtastic LoRa-mesh bridge — a real radio round-trip.** No bridge
  appservice is deployed anywhere yet, so "a message leaves this room and comes
  back over LoRa" stays unscriptable. The seeded fixtures prove the client's
  rendering of that provenance, never the radio path itself.
- **Character voice (Piper TTS synth + recorded voice-clip capture)** ships
  **dark** (`VOICE_TTS_ENABLED` default `false` — no backend deployed
  anywhere on the platform yet, see the main README's Known Gaps & Roadmap).
  `VoiceSynthService`/`VoicePlaybackService`/`CharacterCaptureService` are
  fully unit-tested against mocks, but there is no e2e coverage — correctly
  so, since there is no real backend to round-trip against and the flag-off
  behaviour (no-op, no HTTP call) isn't a meaningful UI flow to script. Add
  scenarios once the seam is enabled somewhere runnable.

## Honest-test rules this suite follows

1. Message bodies are unique per scenario; a timeline match can only come from
   this scenario's send.
2. Absence is asserted only after an ordering oracle (a later canary arrived,
   or the membership revocation is itself visible) — never timeout-and-hope,
   and never a bare `waitForTimeout` (see `tests/helpers/timeline.ts`).
3. DENY always asserts the announced rejection surface (role=alert notice,
   `timeline-denied`, `composer-status`), paired with the resource's proven
   existence for its rightful owner. No fabricated ids, no `A OR B` oracles.
4. Desired-state writes (domain-unlock) assert the honest 202
   pending-reconcile envelope, never a synchronous success.

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

Listing only proves the Gherkin compiles and every step resolves. To *run* the
offline scenarios, serve the built remote and point `E2E_BASE_URL` at it — the
seeded route-fulfilment halves need no homeserver, but they do need the real
bundle:

```bash
npm run build:matrix                      # repo root
# serve dist/matrix/browser with an SPA fallback (deep routes like /settings,
# /rooms must return index.html, not 404) on e.g. :8099
E2E_BASE_URL=http://127.0.0.1:8099 npx bddgen && npx playwright test
```

Two container-isms bite outside CI: the config's `html` reporter and
`outputDir` are hardcoded to `/work/results/*`, so a local run needs
`--reporter=list` and `--output=<writable dir>`; and there is no bundled
Chromium in every dev image — `channel: 'chrome'` on the `bdd` project reuses
an installed Google Chrome.

## Seed users

See `tests/helpers/roles.ts` — sessions are seeded straight into the
`hug.session` localStorage key (the exact shape `SessionService.set()`
writes): alice/bob (tenant-a users), carol (tenant-b), mod-mallory,
admin-adam, superadmin-sam, domain-locked dana, banned/role-absent eve.
Cluster scenarios resolve personas' Matrix ids via `matrixIdFor()`
(`@<username>:<tenant>`, overridable per persona with
`E2E_MATRIX_ID_<USERNAME>`), and use the seeded rooms `E2E_PUBLIC_ROOM`,
`E2E_FEDERATED_ROOM_ALIAS` and `E2E_CROSS_DOMAIN_USER` (defaults in
`features/steps/messaging-steps.ts`). Live runs against a REAL mod-bff must
also export `E2E_MOD_BFF_TOKEN` (a genuine moderator `bff_` session bearer)
for the domain-unlock verb — the seeded placeholder token is only honoured by
a stack running mod-bff in its e2e test-auth mode.
