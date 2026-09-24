import { Injectable, inject, signal } from '@angular/core';
import { MatrixService } from '../matrix.service';
import { AmplitudeMouthService, MouthDrive } from '../vn/voice/amplitude-mouth.service';
import { SpeakingDetector } from '../vn/voice/speaking';
import { MatrixRtcService, RtcGroupSession } from '../rtc/matrix-rtc.service';
import { chooseGroupCallRoute } from '../rtc/matrix-rtc';
import {
  AV_CHANNEL_LABEL, BLENDSHAPES_BROADCAST_MS, JAW_OPEN_INDEX, POSE_BROADCAST_MS,
  decodeAvFrame, dequantizeBlendshape, encodeBlendshapesFrame, encodePoseFrame,
  encodeSpeakingFrame,
} from './av-channel';

/**
 * SMALL FULL-MESH voice + data for the 3D room (XR-chat DESIGN §6 Stage 2),
 * built on the LEGACY Matrix 1:1 call signalling (m.call.* v1 events with
 * `party_id` + `invitee`) — one RTCPeerConnection PER PAIR of participants, so
 * an N-person room runs N-1 connections per member. This deliberately stays on
 * the primitives the matrix-call precedent already proves against our
 * homeserver (no MSC3401/MatrixRTC, no SFU — LiveKit is the documented future
 * work); the practical ceiling is small (see {@link MESH_WARNING_SIZE}).
 *
 * PAIR RULES (deterministic — both sides derive them independently):
 *  - INITIATOR: the lexicographically LOWER mxid of the pair sends the offer;
 *    the higher side only ever answers. GLARE therefore cannot happen between
 *    honest clients, and a rule-violating invite (from a peer that should be
 *    answering) is dropped on receive — the designated initiator's offer is
 *    the one that wins, on both sides, with no tiebreak round-trip.
 *  - ADMISSION: when the roster exceeds the room cap, every client computes
 *    the SAME admitted set (lexicographically first `maxParticipants` mxids);
 *    pairs form only inside it. A non-admitted member connects to nobody and
 *    shows an honest room-full note.
 *  - CALL IDS: `c3d-…`-prefixed, chosen by the initiator. The prefix scopes
 *    the mesh's signalling so it never collides with the 1:1 call component
 *    sharing the same room timeline (whose events this service ignores).
 *  - FRESHNESS: an inbound `m.call.invite` is answered only while it is still
 *    inside its `lifetime` (clamped — the field is the peer's), measured
 *    against the event's `origin_server_ts`. The pump re-reads a 200-event
 *    BACK-PAGINATED window and `leave()` drops the dedupe set, so history is
 *    replayed at us on every join; without the age test one long-past invite
 *    is auto-answered with the live mic attached, forever, on the attacker's
 *    schedule.
 *
 * Per pair the initiator opens the {@link AV_CHANNEL_LABEL} RTCDataChannel
 * (unordered, no retransmits — motion data is better lost than late) carrying
 * the {@link decodeAvFrame} binary frames: pose @10Hz, quantized blendshapes
 * @15Hz, speaking on change. Audio is a single shared mic capture (audio-only;
 * the room renders avatars, not webcams) added to every pair; each REMOTE
 * stream gets its own hidden <audio> sink — a media element MUST be bound to a
 * remote WebRTC stream or Chrome's WebAudio analyser reads silence (the
 * audio-element workaround; ours doubles as the audible playback path) — plus
 * its own AmplitudeMouthService drive + SpeakingDetector, so every remote
 * mouth animates even when that peer broadcasts no blendshapes.
 *
 * CAPABILITY HONESTY: ICE comes from {@link MatrixService.turnServer} once per
 * join; when the relay is dark the voice mesh is host/LAN-only and
 * {@link turnAvailable} drives the note (turnAvailable precedent). A refused
 * mic keeps the member in the mesh listen-only, with the reason surfaced.
 *
 * ABOVE THE CAP — MatrixRTC (hugmesh-admin-bff-api#98, decision 102a = A):
 * when the dark {@link MatrixRtcService.enabled} flag is ON and the roster
 * grows past `maxParticipants`, the mesh asks the homeserver for a LiveKit
 * focus. With one advertised it joins the room's MatrixRTC call and moves
 * voice AND the av-channel frames onto that SFU session (one upstream instead
 * of N-1; everyone admitted); with none it keeps the peer-to-peer cap and
 * {@link routeNote} says why. The route is a pure function of the SHARED
 * roster (roster > cap ⇒ SFU), in BOTH directions, so every client — including
 * one that arrives after the room moved — converges on the same transport: a
 * "sticky for the join" rule stranded a newcomer who saw 8 of 8 on the p2p
 * mesh, inviting clients that had stopped answering. Leaving the SFU is
 * debounced ({@link SFU_FALLBACK_TICKS} consecutive at-or-under-cap rosters)
 * so a one-poll dip cannot flap the whole room between transports. With the
 * flag OFF (the default) none of this runs and the mesh is byte-for-byte the
 * p2p mesh above.
 */

/**
 * Consecutive roster ticks (the host's 1Hz poll) at or under the cap before
 * an SFU call falls back to the peer-to-peer mesh. Short enough that a
 * newcomer's invites are still fresh ({@link INVITE_LIFETIME_MS}) when the
 * returning clients' signalling pump restarts; long enough that one poll's
 * blip does not tear every connection down.
 */
export const SFU_FALLBACK_TICKS = 3;

/** Mesh size (roster incl. me) at which the full-mesh quality warning shows —
 *  N-1 upstreams per member makes ~8 the practical voice ceiling (DESIGN §6). */
export const MESH_WARNING_SIZE = 8;

/** Cadence of the m.call signalling poll (matrix-call precedent). */
export const MESH_SIGNAL_POLL_MS = 1_000;

/** Cadence of the per-remote openness/speaking sampler. ~30Hz keeps mouths
 *  smooth without a rAF loop the specs cannot drive deterministically. */
export const OPENNESS_SAMPLE_MS = 33;

/** LIMIT: most remote ICE candidates queued per pair before the remote
 *  description exists (matrix-call precedent — overflow drops oldest). */
export const MAX_QUEUED_CANDIDATES = 64;

/** LIMIT: most m.call event ids remembered for dedupe (precedent). */
const MAX_SEEN_EVENTS = 2000;

/** Cooldown after a peer hung up on us before we re-offer to them — without
 *  it, a still-in-roster peer that hung up gets re-invited every poll tick. */
export const REOFFER_COOLDOWN_MS = 10_000;

/** How long a received blendshapes vector outranks the amplitude drive as the
 *  peer's mouth source — after this it is stale and amplitude resumes. */
export const BLENDSHAPES_FRESH_MS = 700;

/** Marker prefix scoping mesh call ids away from the 1:1 call component. */
export const MESH_CALL_ID_PREFIX = 'c3d-';

/** Legacy VoIP v1 (the party_id/invitee revision of m.call.*). */
const CALL_VERSION = 1;
/** m.call.invite lifetime (ms) — the spec-recommended default. Advertised on
 *  our own offers AND assumed for a peer invite that carries no `lifetime`. */
export const INVITE_LIFETIME_MS = 60_000;

/**
 * LIMIT: the longest `lifetime` we HONOUR from a peer. The field is attacker-
 * controlled — an invite claiming `lifetime: 1e15` must not become eternally
 * answerable.
 */
export const MAX_INVITE_LIFETIME_MS = 120_000;

/**
 * Tolerance for homeserver/client clock disagreement when ageing an invite.
 * Applied in BOTH directions: a far-future `origin_server_ts` would otherwise
 * make an invite fresh forever, which is the same replay hole from the other
 * side.
 */
export const INVITE_CLOCK_SKEW_MS = 60_000;

/** Where one pair's connection stands (host UI surface). */
export type MeshPeerConnState = 'connecting' | 'connected' | 'failed' | 'ended';

/** The narrowed RTCPeerConnection surface the mesh drives (fakeable). */
export interface MeshPcLike {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  addTrack(track: MediaStreamTrack, stream: MediaStream): unknown;
  createDataChannel(label: string, opts?: RTCDataChannelInit): MeshChannelLike;
  close(): void;
  remoteDescription: unknown;
  connectionState: RTCPeerConnectionState | string;
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null;
  ontrack: ((ev: { streams: readonly MediaStream[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ondatachannel: ((ev: { channel: MeshChannelLike }) => void) | null;
}

/** The narrowed RTCDataChannel surface (fakeable). */
export interface MeshChannelLike {
  readonly label: string;
  readyState: RTCDataChannelState | string;
  binaryType?: string;
  send(data: ArrayBuffer): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
}

/** The hidden per-remote audio sink surface (fakeable). */
export interface AudioSinkLike {
  srcObject: MediaProvider | null;
  remove(): void;
}

/** One pair's live state. */
interface MeshPeer {
  userId: string;
  callId: string;
  /** The REMOTE side's party_id ('' until their invite/answer arrives). */
  remotePartyId: string;
  pc: MeshPcLike | null;
  channel: MeshChannelLike | null;
  state: MeshPeerConnState;
  queuedCandidates: RTCIceCandidateInit[];
  audioEl: AudioSinkLike | null;
  drive: MouthDrive | undefined;
  detector: SpeakingDetector;
  /** ms clock of the last blendshapes frame from this peer (-∞ = never). */
  lastBlendshapesMs: number;
  /** jawOpen (0..1) from that frame — outranks amplitude while fresh. */
  jawOpenness: number;
  /** The peer's channel-declared speaking flag (sender-authoritative). */
  channelSpeaking: boolean;
  /** Last openness/speaking values forwarded to the host (change-detection). */
  sentOpenness: number;
  sentSpeaking: boolean | null;
}

/** The host-facing snapshot of one pair. */
export interface MeshPeerState {
  userId: string;
  state: MeshPeerConnState;
}

/** A local pose sample (the game's localPose callback shape). */
export interface MeshPose { x: number; z: number; yaw: number; seat: number }

/** A timestamped quantized blendshape vector (FaceTrackService output). */
export interface QuantizedBlendshapes { values: Uint8Array; ts: number }

@Injectable({ providedIn: 'root' })
export class MeshCallService {
  private readonly matrix = inject(MatrixService);
  private readonly mouth = inject(AmplitudeMouthService);
  private readonly rtc = inject(MatrixRtcService);

  // ── Injection seams (specs assign fakes; defaults are the real APIs) ──

  /** Builds one RTCPeerConnection per pair. */
  pcFactory: (config: RTCConfiguration) => MeshPcLike =
    (config) => new RTCPeerConnection(config) as unknown as MeshPcLike;
  /** Captures the shared mic stream (audio only — avatars, not webcams). */
  mediaFactory: () => Promise<MediaStream> =
    () => navigator.mediaDevices.getUserMedia({ audio: true });
  /**
   * Builds the hidden per-remote audio sink. A media element MUST be attached
   * to a remote WebRTC stream or Chrome's analyser reads silence (the
   * audio-element workaround); this one doubles as the audible playback path,
   * so it is autoplaying and NOT muted.
   */
  audioSinkFactory: (stream: MediaStream) => AudioSinkLike = (stream) => {
    const el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.style.display = 'none';
    el.srcObject = stream;
    document.body.appendChild(el);
    void el.play().catch(() => undefined);
    return el;
  };
  /** Attaches an amplitude mouth drive to a stream (matrix-call precedent). */
  driveFactory: (stream: MediaStream) => MouthDrive | undefined = (stream) => {
    try {
      const ctx = (this.audioCtx ??= new AudioContext());
      void ctx.resume().catch(() => undefined);
      return this.mouth.drive(ctx.createMediaStreamSource(stream), ctx);
    } catch {
      return undefined;
    }
  };
  /** ms clock (fakeable for deterministic cooldown/freshness specs). */
  now: () => number = () => Date.now();

  // ── Host-set providers/callbacks ──

  /** Latest LOCAL pose (the game's localPose), broadcast @10Hz when set. */
  poseProvider: (() => MeshPose | null) | null = null;
  /** Latest LOCAL quantized blendshapes (FaceTrackService), @15Hz when new. */
  blendshapesProvider: (() => QuantizedBlendshapes | null) | null = null;
  /** A remote peer's pose arrived (already clamped by the wire decode). */
  onPeerPose: ((userId: string, pose: MeshPose) => void) | null = null;
  /** A remote peer's 52-byte blendshape vector arrived. */
  onPeerBlendshapes: ((userId: string, values: Uint8Array) => void) | null = null;
  /** A participant's speaking flag changed (includes ME — local mic). */
  onPeerSpeaking: ((userId: string, speaking: boolean) => void) | null = null;
  /** A participant's mouth openness changed (includes ME — local mic). */
  onPeerOpenness: ((userId: string, openness: number) => void) | null = null;

  // ── Honest state surface ──

  /** True once the homeserver returned a TURN/STUN relay (else LAN-only note). */
  readonly turnAvailable = signal(false);
  /** True while the mesh is joined (timers running). */
  readonly active = signal(false);
  /** True when the roster size makes full-mesh voice strain (≥8). */
  readonly meshWarning = signal(false);
  /** False when the roster exceeds the cap AND I fell outside the admitted
   *  set — I connect to nobody and the host shows the room-full note. */
  readonly admitted = signal(true);
  /** True while the local mic capture is live (false = listen-only). */
  readonly micLive = signal(false);
  /** WHY the mic is not live ('' when it is, or was never requested). */
  readonly micNote = signal('');
  /** WHY a voice invitation addressed to me was ignored — set only when an
   *  otherwise-acceptable invite failed the freshness test, so a member whose
   *  device clock is wrong learns why nobody ever connects instead of sitting
   *  in a silent room (turnAvailable-note precedent). */
  readonly staleInviteNote = signal('');
  /** Per-pair connection states for the host UI. */
  readonly peerStates = signal<Record<string, MeshPeerConnState>>({});
  /** Which transport voice + motion run on: the p2p mesh, or the MatrixRTC
   *  SFU session (only ever 'sfu' with the MatrixRTC flag on). */
  readonly transport = signal<'p2p' | 'sfu'>('p2p');
  /** WHY the call is (or is not) on the SFU above the cap ('' otherwise). */
  readonly routeNote = signal('');
  /** WHY other MatrixRTC clients will not list me in the call ('' when the
   *  membership event published, or no SFU call is joined). */
  readonly callMemberNote = signal('');

  // ── Internals ──

  private roomId = '';
  private myUserId = '';
  private myPartyId = '';
  private maxParticipants = 8;
  private micWanted = false;
  private participants: string[] = [];
  private peers = new Map<string, MeshPeer>();
  private localStream: MediaStream | null = null;
  private localDrive: MouthDrive | undefined;
  private readonly localDetector = new SpeakingDetector();
  private localSentSpeaking: boolean | null = null;
  private localSentOpenness = -1;
  private lastBlendshapesTsSent = -1;
  private iceServers: RTCIceServer[] = [];
  private seen = new Set<string>();
  /** True while {@link join} is still acquiring ICE + the microphone. Pairs
   *  must NOT form in that window — see join()'s doc. */
  private settingUp = false;
  /**
   * Bumped by every {@link join}. A join whose token is stale lost its room:
   * the moderator kill switch is `leave()` then `join()` on the NEXT 1Hz poll,
   * so a first-time mic prompt still open across a disable/re-enable leaves
   * TWO join() calls in flight. Without the token the older one would resume
   * into the newer one's room — clearing its `settingUp`, starting a second
   * full set of timers and adopting a stream the newer join never captured.
   */
  private joinToken = 0;
  private audioCtx: AudioContext | undefined;
  /** userId → ms clock of the hangup we received (re-offer cooldown). */
  private readonly hangupCooldown = new Map<string, number>();
  private signalTimer: ReturnType<typeof setInterval> | null = null;
  /** The joined MatrixRTC SFU session (null = p2p mesh). */
  private sfu: RtcGroupSession | null = null;
  /** A focus discovery / SFU join is in flight for this join. */
  private routeInFlight = false;
  /** This over-cap episode already ended in no-focus or a failed join; re-armed
   *  once the roster is back at or under the cap. */
  private routeSettled = false;
  /** Consecutive roster ticks at/under the cap while on the SFU. */
  private sfuUnderCapTicks = 0;
  private poseTimer: ReturnType<typeof setInterval> | null = null;
  private blendTimer: ReturnType<typeof setInterval> | null = null;
  private samplerTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Join the room's A/V mesh. Fetches ICE once, captures the mic when asked
   * (a refusal demotes to listen-only with an honest note — it never blocks
   * the mesh), and starts the signalling/broadcast/sampler timers. Peers
   * connect as {@link setParticipants} learns the roster.
   *
   * NO PAIR FORMS UNTIL THE SETUP FINISHES ({@link settingUp}). The host fires
   * `void mesh.join(...)` and its own 1Hz room-state poll concurrently, so the
   * roster routinely arrives while this method is still awaiting — and on a
   * FIRST-TIME microphone grant `mediaFactory()` stays pending for as long as
   * the user looks at the browser prompt. A pair negotiated inside that window
   * is built from `iceServers = []` and `localStream = null`, and
   * {@link addLocalTracks} silently no-ops; since nothing in this service ever
   * renegotiates, that pair is SILENT FOR ITS WHOLE LIFETIME while `micLive`
   * flips true a moment later and the UI reports voice as working.
   */
  async join(roomId: string, myUserId: string, opts: { micEnabled: boolean; maxParticipants?: number }): Promise<void> {
    if (this.active()) {
      return;
    }
    this.roomId = roomId;
    this.myUserId = myUserId;
    this.myPartyId = `p${Math.random().toString(36).slice(2, 10)}`;
    this.micWanted = opts.micEnabled;
    this.maxParticipants = opts.maxParticipants ?? 8;
    this.routeInFlight = false;
    this.routeSettled = false;
    this.sfuUnderCapTicks = 0;
    this.routeNote.set('');
    this.callMemberNote.set('');
    this.active.set(true);
    const token = ++this.joinToken;
    this.settingUp = true;
    let stream: MediaStream | null = null;
    try {
      // FAIL-SOFT, like every other capability probe here: a throwing ICE
      // lookup must degrade to "no relay" (which `turnAvailable` already has
      // an honest note for), NOT abort the join. Aborting would leave the mesh
      // `active` with no timers, no mic and no pump — a room that looks joined
      // and can never connect, with nothing on screen saying so.
      let ice: RTCIceServer[] = [];
      try {
        ice = await this.matrix.turnServer();
      } catch {
        ice = [];
      }
      this.iceServers = ice;
      this.turnAvailable.set(ice.length > 0);
      if (opts.micEnabled) {
        // Honest note WHILE we wait: an unanswered permission prompt otherwise
        // leaves the member in a room where nobody ever connects and nothing
        // says why (turnAvailable-note precedent).
        this.micNote.set(
          'Waiting for microphone permission — voice and live motion start once you answer your browser\'s prompt.');
        try {
          stream = await this.mediaFactory();
        } catch {
          stream = null;
        }
      }
    } finally {
      if (this.joinToken === token) {
        this.settingUp = false;
      }
    }
    if (!this.active() || this.joinToken !== token) {
      // Left (or re-joined) during the setup window: that teardown never saw
      // this capture, so stop it here rather than leak a live microphone.
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    if (opts.micEnabled) {
      if (stream) {
        this.localStream = stream;
        this.micLive.set(true);
        this.micNote.set('');
        this.localDrive = this.driveFactory(stream);
      } else {
        this.micLive.set(false);
        this.micNote.set('Microphone unavailable or refused — you are in the room listen-only.');
      }
    }
    this.signalTimer = setInterval(() => void this.pumpOnce(), MESH_SIGNAL_POLL_MS);
    this.poseTimer = setInterval(() => this.tickPose(), POSE_BROADCAST_MS);
    this.blendTimer = setInterval(() => this.tickBlendshapes(), BLENDSHAPES_BROADCAST_MS);
    this.samplerTimer = setInterval(() => this.tickOpenness(), OPENNESS_SAMPLE_MS);
    // Apply whatever roster arrived while we were acquiring ICE + the mic.
    this.applyRoster();
  }

  /** Update the room cap (the host re-reads it from room state each poll). */
  setMaxParticipants(cap: number): void {
    if (Number.isInteger(cap) && cap >= 2) {
      this.maxParticipants = cap;
      this.applyRoster();
    }
  }

  /**
   * The current roster (avatar-state publishers, my own id included or not —
   * it is folded in). Diffs pairs: new admitted remotes connect (offer or
   * await, per the initiator rule), departed remotes are hung up.
   */
  setParticipants(userIds: string[]): void {
    if (!this.active()) {
      return;
    }
    this.participants = [...new Set(userIds.filter((u) => typeof u === 'string' && u.startsWith('@')))];
    // Fall back from the SFU once the room has stayed at/under the cap for
    // SFU_FALLBACK_TICKS consecutive rosters (counted HERE, once per poll —
    // setMaxParticipants also re-applies the roster every poll).
    if (this.sfu && !this.settingUp) {
      if (this.rosterSize() <= this.maxParticipants) {
        if (++this.sfuUnderCapTicks >= SFU_FALLBACK_TICKS) {
          this.leaveSfu();
          return;
        }
      } else {
        this.sfuUnderCapTicks = 0;
      }
    }
    this.applyRoster();
  }

  /** Toggle the live mic without renegotiating (track.enabled). */
  setMicEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  /**
   * Leave the mesh: real m.call.hangup to every live pair (DESIGN §6 — no
   * ghost calls), close/stop/remove everything, stop the timers.
   */
  async leave(): Promise<void> {
    if (!this.active()) {
      return;
    }
    this.active.set(false);
    for (const timer of [this.signalTimer, this.poseTimer, this.blendTimer, this.samplerTimer]) {
      if (timer !== null) {
        clearInterval(timer);
      }
    }
    this.signalTimer = this.poseTimer = this.blendTimer = this.samplerTimer = null;
    const hangups: Promise<unknown>[] = [];
    // The SFU leg: disconnect AND clear my call-membership state event — the
    // kill switch reaches this through the same leave() as a normal exit.
    const sfu = this.sfu;
    this.sfu = null;
    if (sfu) {
      this.detachSfu(sfu);
      hangups.push(sfu.leave());
    }
    this.transport.set('p2p');
    this.routeNote.set('');
    this.callMemberNote.set('');
    this.routeInFlight = false;
    this.routeSettled = false;
    this.sfuUnderCapTicks = 0;
    for (const peer of this.peers.values()) {
      if (peer.callId && (peer.state === 'connecting' || peer.state === 'connected')) {
        hangups.push(this.sendSignal('m.call.hangup', {
          call_id: peer.callId, party_id: this.myPartyId, version: CALL_VERSION, reason: 'user_hangup',
        }));
      }
      this.closePeer(peer);
    }
    this.peers.clear();
    this.publishPeerStates();
    this.localDrive?.stop();
    this.localDrive = undefined;
    this.localDetector.reset();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.micLive.set(false);
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = undefined;
    }
    this.seen.clear();
    this.staleInviteNote.set('');
    // The mic note describes a capture that no longer exists. Left set, the
    // kill switch's leave/re-join cycle would re-show a stale "waiting for
    // permission"/"listen-only" line for a mic that is now live.
    this.micNote.set('');
    this.hangupCooldown.clear();
    await Promise.allSettled(hangups);
  }

  // ─────────────────────────── Roster / admission ───────────────────────────

  /**
   * The DETERMINISTIC admitted set: everyone sorts the same roster the same
   * way and takes the first `maxParticipants` — no coordinator, no race.
   */
  private admittedSet(): Set<string> {
    const all = [...new Set([...this.participants, this.myUserId])].sort();
    return new Set(all.slice(0, this.maxParticipants));
  }

  private applyRoster(): void {
    // `settingUp`: ICE and the mic are not there yet, so any pair opened now
    // would be negotiated with no relay and no audio track — permanently, as
    // nothing here renegotiates. join() re-runs this once setup completes.
    if (!this.active() || this.settingUp) {
      return;
    }
    if (this.sfu) {
      this.applySfuRoster();
      return;
    }
    const admitted = this.admittedSet();
    const rosterSize = new Set([...this.participants, this.myUserId]).size;
    if (this.rtc.enabled) {
      if (rosterSize > this.maxParticipants) {
        if (!this.routeInFlight && !this.routeSettled) {
          void this.routeAboveCap();
        }
      } else if (this.routeSettled) {
        // Back at/under the cap: the no-focus / failed-join note no longer
        // describes this room, and a later rise decides afresh.
        this.routeSettled = false;
        this.routeNote.set('');
      }
    }
    this.meshWarning.set(rosterSize >= MESH_WARNING_SIZE);
    const meAdmitted = admitted.has(this.myUserId);
    this.admitted.set(meAdmitted);
    const wanted = meAdmitted
      ? [...admitted].filter((u) => u !== this.myUserId)
      : [];
    // Departed (or no-longer-admitted) peers: hangup + close.
    for (const [userId, peer] of [...this.peers]) {
      if (!wanted.includes(userId)) {
        if (peer.callId && (peer.state === 'connecting' || peer.state === 'connected')) {
          void this.sendSignal('m.call.hangup', {
            call_id: peer.callId, party_id: this.myPartyId, version: CALL_VERSION, reason: 'user_hangup',
          });
        }
        this.closePeer(peer);
        this.peers.delete(userId);
      }
    }
    // New peers: the lexicographically lower mxid offers; the higher waits.
    for (const userId of wanted) {
      if (this.peers.has(userId)) {
        continue;
      }
      const cooldownAt = this.hangupCooldown.get(userId);
      if (cooldownAt !== undefined && this.now() - cooldownAt < REOFFER_COOLDOWN_MS) {
        continue;
      }
      if (this.iAmInitiatorFor(userId)) {
        void this.offerTo(userId);
      } else {
        this.peers.set(userId, this.newPeer(userId, '', 'connecting'));
      }
    }
    this.publishPeerStates();
  }

  // ─────────────────────────── Above the cap: MatrixRTC ───────────────────────────

  /** Roster size including me (the number the cap is compared against). */
  private rosterSize(): number {
    return new Set([...this.participants, this.myUserId]).size;
  }

  /**
   * The roster just exceeded the p2p cap with the MatrixRTC flag on: find a
   * focus and, if there is one, move this join onto the SFU. One attempt per
   * over-cap episode: no-focus and a failed join settle it until the roster is
   * back at/under the cap. Every await re-checks the join token — a
   * leave()/join() cycle mid-flight must not adopt (or leak) a session for the
   * room it already left.
   */
  private async routeAboveCap(): Promise<void> {
    const token = this.joinToken;
    this.routeInFlight = true;
    try {
      await this.routeAboveCapOnce(token);
    } finally {
      if (this.joinToken === token) {
        this.routeInFlight = false;
      }
    }
  }

  private async routeAboveCapOnce(token: number): Promise<void> {
    const focus = await this.rtc.discoverFocus();
    if (!this.active() || this.joinToken !== token) {
      return;
    }
    const cap = this.maxParticipants;
    const size = this.rosterSize();
    const route = chooseGroupCallRoute({ enabled: this.rtc.enabled, focus, rosterSize: size, p2pCap: cap });
    if (route.transport === 'p2p') {
      if (route.reason === 'no-focus') {
        this.routeSettled = true;
        this.routeNote.set(
          `This room has ${size} participants, more than the peer-to-peer voice cap of ${cap}. `
          + 'The homeserver advertises no group-call media server (MatrixRTC focus), so voice and '
          + `live motion stay peer-to-peer and only the first ${cap} participants get them.`);
      }
      // within-cap: back under the cap while we looked — the next over-cap
      // roster decides again (routeSettled stays false).
      return;
    }
    const res = await this.rtc.join(this.roomId, this.myUserId, route.focus);
    if (!this.active() || this.joinToken !== token) {
      if (res.ok) {
        void res.session.leave();
      }
      return;
    }
    if (!res.ok) {
      this.routeSettled = true;
      // NOT "only the first N get it": every other client of this deployment
      // made the same over-cap decision and is on the media server now, so
      // this client's peer-to-peer mesh most likely reaches nobody.
      this.routeNote.set(
        `This room has ${size} participants, more than the peer-to-peer voice cap of ${cap}, but joining `
        + `the group-call media server failed (${res.step === 'openid' ? 'the homeserver refused an identity token'
          : res.step === 'token' ? 'the media server refused a join token' : 'the media server connection failed'}). `
        + 'The others in this room have most likely moved to it, so you may hear no one and no one may hear you '
        + '— leave and re-enter the 3D room to try again.');
      return;
    }
    this.switchToSfu(res.session, res.membershipPublished, size, cap);
  }

  /** Tear the p2p pairs down (real hangups, like leave()) and run on `session`. */
  private switchToSfu(session: RtcGroupSession, membershipPublished: boolean, size: number, cap: number): void {
    if (this.signalTimer !== null) {
      clearInterval(this.signalTimer); // no more m.call.* answering on the SFU path
      this.signalTimer = null;
    }
    for (const peer of this.peers.values()) {
      if (peer.callId && (peer.state === 'connecting' || peer.state === 'connected')) {
        void this.sendSignal('m.call.hangup', {
          call_id: peer.callId, party_id: this.myPartyId, version: CALL_VERSION, reason: 'user_hangup',
        });
      }
      this.closePeer(peer);
    }
    this.peers.clear();
    this.sfu = session;
    this.sfuUnderCapTicks = 0;
    this.transport.set('sfu');
    // Every handler checks it still belongs to the CURRENT session: a late
    // event from a session we already left must not conjure a peer.
    session.onPeerAudio = (userId, stream) => {
      if (this.sfu !== session) {
        return;
      }
      const isNew = !this.peers.has(userId);
      const peer = this.sfuPeer(userId);
      // A NEW peer already got the session's retained stream (this one) from
      // sfuPeer — attaching again would build a second sink.
      if (peer && !(isNew && peer.audioEl)) {
        this.attachRemoteStream(peer, stream);
      }
    };
    session.onData = (userId, frame) => {
      if (this.sfu !== session) {
        return;
      }
      const peer = this.sfuPeer(userId);
      if (peer) {
        this.handleChannelFrame(peer, frame);
      }
    };
    session.onPeerLeft = (userId) => {
      if (this.sfu === session) {
        this.dropSfuPeer(userId);
      }
    };
    session.onDisconnected = () => {
      if (this.sfu === session) {
        this.routeNote.set(
          'The connection to the group-call media server dropped — leave and re-enter the 3D room to restore voice.');
      }
    };
    const micTrack = this.localStream?.getAudioTracks()[0];
    if (micTrack) {
      void session.publishMic(micTrack).catch(() => this.micNote.set(
        'Your microphone could not be published to the group-call media server — you are in the room listen-only.'));
    }
    this.routeNote.set(
      `This room has ${size} participants, more than the peer-to-peer voice cap of ${cap}, so voice and `
      + 'live motion now run through the group-call media server (MatrixRTC / LiveKit).');
    this.callMemberNote.set(membershipPublished ? '' : 'This room does not let members announce a call '
      + '(org.matrix.msc3401.call.member needs a lower power level), so other Matrix call apps will not list you in it.');
    this.applySfuRoster();
  }

  /**
   * The SFU peer entry for `userId`, created on first contact — or null for a
   * stranger. The SFU room admits anyone lk-jwt-service minted a token for,
   * which is NOT the same set as this room's 3D roster (membership-bound by
   * the host); a non-roster identity must not conjure an avatar in the game
   * or an audio sink on this page.
   */
  private sfuPeer(userId: string): MeshPeer | null {
    if (!this.sfu || userId === this.myUserId || !this.participants.includes(userId)) {
      return null;
    }
    let peer = this.peers.get(userId);
    if (!peer) {
      peer = this.newPeer(userId, '', 'connected');
      this.peers.set(userId, peer);
      // LiveKit delivers each remote track ONCE: audio that arrived while this
      // member was not (yet, or for one poll) on the roster was retained by
      // the session — attach it now, or they stay silent for the whole call.
      const retained = this.sfu.remoteAudio(userId);
      if (retained) {
        this.attachRemoteStream(peer, retained);
      }
      this.publishPeerStates();
    }
    return peer;
  }

  private dropSfuPeer(userId: string): void {
    const peer = this.peers.get(userId);
    if (peer) {
      this.closePeer(peer);
      this.peers.delete(userId);
      this.publishPeerStates();
    }
  }

  /**
   * On the SFU everyone is admitted and nothing strains; departed members'
   * sinks close, and a roster member whose audio the session already holds
   * (it arrived before they were on the roster) gets a peer + sink now.
   */
  private applySfuRoster(): void {
    this.admitted.set(true);
    this.meshWarning.set(false);
    for (const userId of [...this.peers.keys()]) {
      if (!this.participants.includes(userId)) {
        this.dropSfuPeer(userId);
      }
    }
    for (const userId of this.participants) {
      if (!this.peers.has(userId) && this.sfu?.remoteAudio(userId)) {
        this.sfuPeer(userId);
      }
    }
    this.publishPeerStates();
  }

  /** Stop routing a session's events here (it is being left). */
  private detachSfu(session: RtcGroupSession): void {
    session.onPeerAudio = null;
    session.onData = null;
    session.onPeerLeft = null;
    session.onDisconnected = null;
  }

  /**
   * Back to the peer-to-peer mesh: the room has stayed at/under the cap for
   * {@link SFU_FALLBACK_TICKS} rosters. Leaves the SFU (which clears the
   * call-membership event), closes the SFU sinks, restarts the m.call pump and
   * re-forms the pairs — exactly what a client that never left p2p is doing,
   * so both converge. The pre-SFU hangup cooldowns are dropped: those hangups
   * were transport moves, not members choosing to leave a pair.
   */
  private leaveSfu(): void {
    const sfu = this.sfu;
    this.sfu = null;
    if (sfu) {
      this.detachSfu(sfu);
      void sfu.leave();
    }
    for (const peer of this.peers.values()) {
      this.closePeer(peer);
    }
    this.peers.clear();
    this.hangupCooldown.clear();
    this.transport.set('p2p');
    this.routeNote.set('');
    this.callMemberNote.set('');
    this.routeSettled = false;
    this.sfuUnderCapTicks = 0;
    if (this.signalTimer === null) {
      this.signalTimer = setInterval(() => void this.pumpOnce(), MESH_SIGNAL_POLL_MS);
    }
    this.applyRoster();
  }

  /** The pair rule: the lexicographically LOWER mxid sends the offer. */
  iAmInitiatorFor(userId: string): boolean {
    return this.myUserId < userId;
  }

  // ─────────────────────────── Outbound signalling ───────────────────────────

  private async offerTo(userId: string): Promise<void> {
    const callId = `${MESH_CALL_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const peer = this.newPeer(userId, callId, 'connecting');
    this.peers.set(userId, peer);
    this.publishPeerStates();
    const pc = this.newPc(peer);
    peer.pc = pc;
    // The initiator opens the data channel BEFORE the offer so it rides the
    // initial SDP. Unordered + no retransmits: stale motion is dropped.
    this.wireChannel(peer, pc.createDataChannel(AV_CHANNEL_LABEL, { ordered: false, maxRetransmits: 0 }));
    this.addLocalTracks(pc);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendSignal('m.call.invite', {
        call_id: callId,
        party_id: this.myPartyId,
        version: CALL_VERSION,
        lifetime: INVITE_LIFETIME_MS,
        invitee: userId,
        offer,
      });
    } catch {
      peer.state = 'failed';
      this.publishPeerStates();
    }
  }

  private async answerInvite(userId: string, content: Record<string, unknown>): Promise<void> {
    const existing = this.peers.get(userId);
    if (existing?.pc) {
      // A repeat invite for a pair we already answered/connected — stale echo.
      if (existing.state === 'connected' || existing.callId === content['call_id']) {
        return;
      }
      this.closePeer(existing);
    }
    const peer = existing ?? this.newPeer(userId, '', 'connecting');
    peer.callId = String(content['call_id']);
    peer.remotePartyId = typeof content['party_id'] === 'string' ? content['party_id'] : '';
    peer.state = 'connecting';
    this.peers.set(userId, peer);
    const pc = this.newPc(peer);
    peer.pc = pc;
    this.addLocalTracks(pc);
    try {
      await pc.setRemoteDescription(content['offer'] as RTCSessionDescriptionInit);
      await this.flushCandidates(peer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.sendSignal('m.call.answer', {
        call_id: peer.callId, party_id: this.myPartyId, version: CALL_VERSION, answer,
      });
    } catch {
      peer.state = 'failed';
    }
    this.publishPeerStates();
  }

  private sendSignal(type: string, content: unknown): Promise<unknown> {
    return this.matrix.sendEvent(this.roomId, type, content).catch(() => '');
  }

  // ─────────────────────────── Inbound signalling ───────────────────────────

  /**
   * ONE signalling poll tick (public so specs drive it deterministically).
   * Fetches the newest timeline window, keeps only `c3d-`-scoped m.call.*
   * events from OTHER senders, dedupes by event id, and processes oldest-
   * first so an invite lands before its trailing candidates.
   */
  async pumpOnce(): Promise<void> {
    if (!this.active() || this.sfu) {
      return;
    }
    const all = await this.matrix.roomEvents(this.roomId).catch(() => []);
    const events = all
      .filter((e) => (e.type || '').startsWith('m.call.'))
      .filter((e) => typeof e.content?.call_id === 'string' && e.content.call_id.startsWith(MESH_CALL_ID_PREFIX))
      .reverse();
    if (this.seen.size > MAX_SEEN_EVENTS) {
      const window = new Set(events.map((e) => e.event_id));
      this.seen = new Set([...this.seen].filter((id) => window.has(id)));
    }
    for (const e of events) {
      if (this.seen.has(e.event_id) || e.sender === this.myUserId) {
        continue;
      }
      this.seen.add(e.event_id);
      await this.handleSignal(e.type, e.sender, e.content ?? {}, e.origin_server_ts);
    }
  }

  /**
   * Is this `m.call.invite` still LIVE, or is it history being replayed at me?
   *
   * `pumpOnce` re-reads a 200-event BACK-PAGINATED window and `leave()` clears
   * the dedupe set, so every join walks that whole window from scratch. Without
   * an age test, one invite a hostile peer posted hours ago is auto-answered —
   * with the live mic already attached (`answerInvite` → `addLocalTracks`) —
   * on every subsequent join, at a time of the attacker's choosing.
   *
   * FAIL-CLOSED on a missing/unparseable `origin_server_ts`: the homeserver
   * always stamps it on a /messages chunk, so its absence means we cannot age
   * the event and must not answer it.
   */
  private inviteIsFresh(originServerTs: number | undefined, content: Record<string, unknown>): boolean {
    if (typeof originServerTs !== 'number' || !Number.isFinite(originServerTs)) {
      return false;
    }
    const claimed = content['lifetime'];
    const lifetime = typeof claimed === 'number' && Number.isFinite(claimed) && claimed > 0
      ? Math.min(claimed, MAX_INVITE_LIFETIME_MS) // attacker-controlled — clamp
      : INVITE_LIFETIME_MS;
    const age = this.now() - originServerTs;
    return age <= lifetime + INVITE_CLOCK_SKEW_MS && age >= -INVITE_CLOCK_SKEW_MS;
  }

  private async handleSignal(
    type: string,
    sender: string,
    content: Record<string, unknown>,
    originServerTs?: number,
  ): Promise<void> {
    switch (type) {
      case 'm.call.invite': {
        // Only invites addressed to ME, from an admitted participant — and
        // only while I am admitted MYSELF: a non-admitted member connects to
        // nobody (applyRoster opens no pairs for them), and an admitted-but-
        // hostile peer must not be able to pull them into a live pair by
        // inviting them directly (the answer would leak mic audio until the
        // next roster tick tore the pair down — and the peer could re-invite
        // every tick).
        const admitted = this.admittedSet();
        if (content['invitee'] !== this.myUserId || !admitted.has(sender) || !admitted.has(this.myUserId)) {
          return;
        }
        // FRESHNESS: we advertise a `lifetime` on our own offers, so we must
        // honour one on receive — otherwise the pump's re-read of the history
        // window turns any old invite into a replayable mic tap.
        if (!this.inviteIsFresh(originServerTs, content)) {
          this.staleInviteNote.set(
            'A voice invitation was ignored because it was too old — it was replayed or badly delayed. '
            + 'If voice never connects, check that your device clock is correct.');
          return;
        }
        // GLARE RULE: if I am the designated initiator for this pair, a
        // peer-sent invite violates the deterministic rule — drop it; my own
        // offer (sent or about to be) is the one both sides converge on.
        if (this.iAmInitiatorFor(sender)) {
          return;
        }
        await this.answerInvite(sender, content);
        return;
      }
      case 'm.call.answer': {
        const peer = this.peers.get(sender);
        if (!peer || !peer.pc || peer.callId !== content['call_id']) {
          return;
        }
        // Only the initiator consumes answers; first answer wins the pair.
        if (!this.iAmInitiatorFor(sender) || peer.remotePartyId) {
          return;
        }
        peer.remotePartyId = typeof content['party_id'] === 'string' ? content['party_id'] : '';
        try {
          await peer.pc.setRemoteDescription(content['answer'] as RTCSessionDescriptionInit);
          await this.flushCandidates(peer);
        } catch {
          peer.state = 'failed';
          this.publishPeerStates();
        }
        return;
      }
      case 'm.call.candidates': {
        const peer = this.peers.get(sender);
        if (!peer || peer.callId !== content['call_id']) {
          return;
        }
        const cands = Array.isArray(content['candidates']) ? content['candidates'] : [];
        for (const c of cands) {
          if (c && typeof c === 'object') {
            peer.queuedCandidates.push(c as RTCIceCandidateInit);
          }
        }
        if (peer.queuedCandidates.length > MAX_QUEUED_CANDIDATES) {
          peer.queuedCandidates.splice(0, peer.queuedCandidates.length - MAX_QUEUED_CANDIDATES);
        }
        await this.flushCandidates(peer);
        return;
      }
      case 'm.call.hangup': {
        const peer = this.peers.get(sender);
        if (!peer || peer.callId !== content['call_id']) {
          return;
        }
        this.closePeer(peer);
        this.peers.delete(sender);
        // Don't re-offer immediately — they chose to leave the pair.
        this.hangupCooldown.set(sender, this.now());
        this.publishPeerStates();
        return;
      }
    }
  }

  /** Apply queued remote candidates once the remote description exists. */
  private async flushCandidates(peer: MeshPeer): Promise<void> {
    if (!peer.pc || !peer.pc.remoteDescription) {
      return;
    }
    for (const c of peer.queuedCandidates.splice(0)) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch { /* stale candidate — ignore */ }
    }
  }

  // ─────────────────────────── Peer plumbing ───────────────────────────

  private newPeer(userId: string, callId: string, state: MeshPeerConnState): MeshPeer {
    return {
      userId, callId, remotePartyId: '', pc: null, channel: null, state,
      queuedCandidates: [], audioEl: null, drive: undefined,
      detector: new SpeakingDetector(),
      lastBlendshapesMs: Number.NEGATIVE_INFINITY, jawOpenness: 0,
      channelSpeaking: false, sentOpenness: -1, sentSpeaking: null,
    };
  }

  private newPc(peer: MeshPeer): MeshPcLike {
    const pc = this.pcFactory({ iceServers: this.iceServers });
    pc.onicecandidate = (ev) => {
      if (ev.candidate && peer.callId) {
        void this.sendSignal('m.call.candidates', {
          call_id: peer.callId, party_id: this.myPartyId, version: CALL_VERSION,
          candidates: [ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate],
        });
      }
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream) {
        this.attachRemoteStream(peer, stream);
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected' && peer.state !== 'ended') {
        peer.state = 'connected';
      } else if (s === 'failed') {
        peer.state = 'failed';
      }
      this.publishPeerStates();
    };
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === AV_CHANNEL_LABEL) {
        this.wireChannel(peer, ev.channel);
      }
    };
    return pc;
  }

  private addLocalTracks(pc: MeshPcLike): void {
    if (!this.localStream) {
      return;
    }
    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }
  }

  /** Hidden audio sink + amplitude drive per REMOTE stream (see class doc). */
  private attachRemoteStream(peer: MeshPeer, stream: MediaStream): void {
    peer.audioEl?.remove();
    peer.audioEl = this.audioSinkFactory(stream);
    peer.drive?.stop();
    peer.detector.reset();
    peer.drive = this.driveFactory(stream);
  }

  private wireChannel(peer: MeshPeer, channel: MeshChannelLike): void {
    peer.channel = channel;
    if ('binaryType' in channel) {
      channel.binaryType = 'arraybuffer';
    }
    channel.onmessage = (ev) => this.handleChannelFrame(peer, ev.data);
  }

  /** Decode + dispatch one inbound data-channel frame (untrusted peer input —
   *  public-shaped via {@link decodeAvFrame}'s clamps; junk drops silently). */
  private handleChannelFrame(peer: MeshPeer, data: unknown): void {
    const frame = decodeAvFrame(data);
    if (!frame) {
      return;
    }
    switch (frame.t) {
      case 'pose':
        this.onPeerPose?.(peer.userId, { x: frame.x, z: frame.z, yaw: frame.yaw, seat: frame.seat });
        return;
      case 'blendshapes':
        peer.lastBlendshapesMs = this.now();
        peer.jawOpenness = dequantizeBlendshape(frame.values[JAW_OPEN_INDEX]);
        this.onPeerBlendshapes?.(peer.userId, frame.values);
        return;
      case 'speaking':
        peer.channelSpeaking = frame.speaking;
        return;
    }
  }

  private closePeer(peer: MeshPeer): void {
    peer.state = 'ended';
    try {
      peer.channel?.close();
    } catch { /* already closed */ }
    peer.channel = null;
    try {
      peer.pc?.close();
    } catch { /* already closed */ }
    peer.pc = null;
    peer.drive?.stop();
    peer.drive = undefined;
    peer.audioEl?.remove();
    peer.audioEl = null;
    peer.queuedCandidates = [];
  }

  private publishPeerStates(): void {
    const out: Record<string, MeshPeerConnState> = {};
    for (const [userId, peer] of this.peers) {
      out[userId] = peer.state;
    }
    this.peerStates.set(out);
  }

  // ─────────────────────────── Broadcast ticks ───────────────────────────
  // Public so specs can drive one tick deterministically (no fake clocks).

  /** @10Hz: the local pose to every open channel (fixed cadence — the frame
   *  is 17 bytes; resending an unchanged pose keeps late joiners honest). */
  tickPose(): void {
    const pose = this.poseProvider?.();
    if (!pose) {
      return;
    }
    this.broadcast(encodePoseFrame(pose.x, pose.z, pose.yaw, pose.seat));
  }

  /** @15Hz: the local quantized blendshapes — only when a NEW vector exists
   *  (camera off / face lost ⇒ nothing sent ⇒ peers fall back to amplitude). */
  tickBlendshapes(): void {
    const latest = this.blendshapesProvider?.();
    if (!latest || latest.ts === this.lastBlendshapesTsSent) {
      return;
    }
    this.lastBlendshapesTsSent = latest.ts;
    this.broadcast(encodeBlendshapesFrame(latest.values));
  }

  /**
   * The openness/speaking sampler (~30Hz): every participant's mouth signal to
   * the host, remote speaking-flag folding, local speaking broadcast ON CHANGE.
   * Openness source per peer: a FRESH blendshapes jawOpen outranks the
   * amplitude drive (camera-driven mouths are articulated, not just loud);
   * stale ⇒ amplitude resumes (fallback, DESIGN §6).
   */
  tickOpenness(): void {
    const now = this.now();
    // LOCAL: amplitude drive (or provider jaw when the local camera is fresh).
    const local = this.blendshapesProvider?.();
    const localFresh = !!local && now - local.ts <= BLENDSHAPES_FRESH_MS;
    const localOpenness = localFresh
      ? dequantizeBlendshape(local.values[JAW_OPEN_INDEX])
      : this.localDrive?.openness() ?? 0;
    if (Math.abs(localOpenness - this.localSentOpenness) > 0.01) {
      this.localSentOpenness = localOpenness;
      this.onPeerOpenness?.(this.myUserId, localOpenness);
    }
    const localSpeaking = this.localDetector.update(localOpenness, now);
    if (localSpeaking !== this.localSentSpeaking) {
      this.localSentSpeaking = localSpeaking;
      this.onPeerSpeaking?.(this.myUserId, localSpeaking);
      this.broadcast(encodeSpeakingFrame(localSpeaking));
    }
    // REMOTES.
    for (const peer of this.peers.values()) {
      const fresh = now - peer.lastBlendshapesMs <= BLENDSHAPES_FRESH_MS;
      const openness = fresh ? peer.jawOpenness : peer.drive?.openness() ?? 0;
      if (Math.abs(openness - peer.sentOpenness) > 0.01) {
        peer.sentOpenness = openness;
        this.onPeerOpenness?.(peer.userId, openness);
      }
      // The sender's own channel flag is authoritative (it works even when
      // our analyser can't run); amplitude detection is the fallback.
      const speaking = peer.channelSpeaking || peer.detector.update(openness, now);
      if (speaking !== peer.sentSpeaking) {
        peer.sentSpeaking = speaking;
        this.onPeerSpeaking?.(peer.userId, speaking);
      }
    }
  }

  private broadcast(frame: ArrayBuffer): void {
    if (this.sfu) {
      this.sfu.sendData(frame); // one publish reaches every SFU participant
      return;
    }
    for (const peer of this.peers.values()) {
      if (peer.channel && peer.channel.readyState === 'open') {
        try {
          peer.channel.send(frame);
        } catch { /* channel torn down mid-send — ignore */ }
      }
    }
  }
}
