import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MatrixService } from '../matrix.service';
import {
  INVITE_CLOCK_SKEW_MS, INVITE_LIFETIME_MS, MAX_INVITE_LIFETIME_MS,
  MAX_QUEUED_CANDIDATES, MESH_CALL_ID_PREFIX, MeshCallService, MeshChannelLike,
  MeshPcLike, REOFFER_COOLDOWN_MS, SFU_FALLBACK_TICKS,
} from './mesh-call.service';
import {
  BLENDSHAPE_COUNT, JAW_OPEN_INDEX, encodeBlendshapesFrame, encodePoseFrame,
  encodeSpeakingFrame, FRAME_SPEAKING,
} from './av-channel';
import { MatrixRtcService, RtcGroupSession, RtcJoinResult } from '../rtc/matrix-rtc.service';
import { LivekitFocus } from '../rtc/matrix-rtc';

class FakeChannel implements MeshChannelLike {
  readyState = 'open';
  binaryType = '';
  sent: ArrayBuffer[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(readonly label: string) {}
  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
}

class FakePc implements MeshPcLike {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState = 'new';
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((ev: { streams: readonly MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: MeshChannelLike }) => void) | null = null;
  channels: FakeChannel[] = [];
  addedCandidates: RTCIceCandidateInit[] = [];
  tracks: unknown[] = [];
  closed = false;
  constructor(readonly config: RTCConfiguration) {}
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = d;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = d;
  }
  async addIceCandidate(c: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(c);
  }
  addTrack(track: MediaStreamTrack, _stream: MediaStream): unknown {
    this.tracks.push(track);
    return undefined;
  }
  createDataChannel(label: string): MeshChannelLike {
    const c = new FakeChannel(label);
    this.channels.push(c);
    return c;
  }
  close(): void {
    this.closed = true;
  }
}

class MatrixStub {
  sendEvent = jasmine.createSpy('sendEvent').and.resolveTo('$sig1');
  roomEvents = jasmine.createSpy('roomEvents').and.resolveTo([]);
  turnServer = jasmine.createSpy('turnServer').and.resolveTo([]);
}

/**
 * m.call.* timeline row in the roomEvents() narrow shape. `origin_server_ts`
 * is part of that shape (the homeserver always stamps it on a /messages
 * chunk) and the invite freshness guard ages events against it, so the default
 * is "stamped right now" — {@link SERVER_NOW} tracks the specs' fake clock.
 */
let eventSeq = 0;
let SERVER_NOW = 100_000;
function callEvent(
  type: string,
  sender: string,
  content: Record<string, unknown>,
  originServerTs: number | undefined = SERVER_NOW,
) {
  return { event_id: `$sig${++eventSeq}`, type, sender, content, origin_server_ts: originServerTs };
}

const ME = '@aaa:test';
const HIGHER = '@zzz:test';

/** Flush the void-promise chains the service fires internally. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

describe('MeshCallService (full-mesh legacy m.call signalling + chat3d data channel)', () => {
  let svc: MeshCallService;
  let matrix: MatrixStub;
  let pcs: FakePc[];
  let fakeNow: number;
  let driveOpenness: ReturnType<typeof signal<number>>;
  const fakeTrack = () => ({ enabled: true, stop: jasmine.createSpy('stop') }) as unknown as MediaStreamTrack;
  let localTracks: MediaStreamTrack[];

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [{ provide: MatrixService, useValue: matrix }],
    });
    svc = TestBed.inject(MeshCallService);
    pcs = [];
    fakeNow = 100_000;
    SERVER_NOW = fakeNow;
    driveOpenness = signal(0);
    localTracks = [fakeTrack()];
    svc.now = () => fakeNow;
    svc.pcFactory = (config) => {
      const pc = new FakePc(config);
      pcs.push(pc);
      return pc;
    };
    svc.mediaFactory = async () => ({
      getTracks: () => localTracks,
      getAudioTracks: () => localTracks,
    }) as unknown as MediaStream;
    svc.audioSinkFactory = () => ({ srcObject: null, remove: jasmine.createSpy('remove') });
    svc.driveFactory = () => ({ openness: driveOpenness, stop: jasmine.createSpy('stop') });
  });

  afterEach(async () => {
    await svc.leave();
  });

  function sentSignals(type?: string): Record<string, unknown>[] {
    return matrix.sendEvent.calls.allArgs()
      .filter((args) => (type ? args[1] === type : String(args[1]).startsWith('m.call.')))
      .map((args) => args[2] as Record<string, unknown>);
  }

  async function join(me = ME, micEnabled = false, maxParticipants = 8): Promise<void> {
    await svc.join('!r:test', me, { micEnabled, maxParticipants });
  }

  it('DETERMINISTIC INITIATOR: the lexicographically lower mxid offers, with c3d call_id + party_id + invitee', async () => {
    await join(ME);
    svc.setParticipants([HIGHER]);
    await flush();
    const invites = sentSignals('m.call.invite');
    expect(invites.length).toBe(1);
    expect(String(invites[0]['call_id']).startsWith(MESH_CALL_ID_PREFIX)).toBeTrue();
    expect(invites[0]['invitee']).toBe(HIGHER);
    expect(invites[0]['version']).toBe(1);
    expect(typeof invites[0]['party_id']).toBe('string');
    expect(invites[0]['offer']).toEqual({ type: 'offer', sdp: 'offer-sdp' });
    // The initiator opened the chat3d data channel BEFORE the offer.
    expect(pcs.length).toBe(1);
    expect(pcs[0].channels.map((c) => c.label)).toEqual(['chat3d']);
  });

  it('the HIGHER mxid never offers — it waits for the designated initiator', async () => {
    await join(HIGHER);
    svc.setParticipants([ME]);
    await flush();
    expect(sentSignals('m.call.invite').length).toBe(0);
    expect(svc.peerStates()).toEqual({ [ME]: 'connecting' });
  });

  it('answers a designated initiator\'s invite with the SAME call_id', async () => {
    await join(HIGHER);
    svc.setParticipants([ME]);
    await flush();
    matrix.roomEvents.and.resolveTo([
      callEvent('m.call.invite', ME, {
        call_id: 'c3d-abc', party_id: 'pA', version: 1, invitee: HIGHER,
        offer: { type: 'offer', sdp: 'their-offer' },
      }),
    ]);
    await svc.pumpOnce();
    await flush();
    const answers = sentSignals('m.call.answer');
    expect(answers.length).toBe(1);
    expect(answers[0]['call_id']).toBe('c3d-abc');
    expect(answers[0]['answer']).toEqual({ type: 'answer', sdp: 'answer-sdp' });
    expect(pcs[0].remoteDescription).toEqual({ type: 'offer', sdp: 'their-offer' });
  });

  it('GLARE: a rule-violating invite (peer that should be answering) is dropped — my offer stands', async () => {
    await join(ME);
    svc.setParticipants([HIGHER]);
    await flush();
    const myPc = pcs[0];
    matrix.roomEvents.and.resolveTo([
      callEvent('m.call.invite', HIGHER, {
        call_id: 'c3d-glare', party_id: 'pZ', version: 1, invitee: ME,
        offer: { type: 'offer', sdp: 'glare-offer' },
      }),
    ]);
    await svc.pumpOnce();
    await flush();
    expect(sentSignals('m.call.answer').length).toBe(0); // never answered
    expect(pcs.length).toBe(1);                          // no second pc
    expect(myPc.closed).toBeFalse();                     // my offer untouched
    expect(myPc.remoteDescription).toBeNull();
  });

  it('ignores an invite not addressed to me and one from outside the admitted roster', async () => {
    await join(HIGHER);
    svc.setParticipants([ME]);
    await flush();
    matrix.roomEvents.and.resolveTo([
      callEvent('m.call.invite', ME, {
        call_id: 'c3d-a', party_id: 'pA', version: 1, invitee: '@else:test',
        offer: { type: 'offer', sdp: 'o' },
      }),
      callEvent('m.call.invite', '@stranger:test', {
        call_id: 'c3d-b', party_id: 'pS', version: 1, invitee: HIGHER,
        offer: { type: 'offer', sdp: 'o' },
      }),
    ]);
    await svc.pumpOnce();
    await flush();
    expect(sentSignals('m.call.answer').length).toBe(0);
  });

  it('ignores m.call events without the c3d- scope (the 1:1 call component\'s traffic)', async () => {
    await join(HIGHER);
    svc.setParticipants([ME]);
    await flush();
    matrix.roomEvents.and.resolveTo([
      callEvent('m.call.invite', ME, {
        call_id: 'c171234', version: 0, offer: { type: 'offer', sdp: 'legacy-1to1' },
      }),
    ]);
    await svc.pumpOnce();
    await flush();
    expect(sentSignals('m.call.answer').length).toBe(0);
  });

  it('QUEUES remote candidates until the answer lands, then flushes them (cap ' + MAX_QUEUED_CANDIDATES + ', oldest dropped)', async () => {
    await join(ME);
    svc.setParticipants([HIGHER]);
    await flush();
    const callId = String(sentSignals('m.call.invite')[0]['call_id']);
    const manyCands = Array.from({ length: MAX_QUEUED_CANDIDATES + 6 }, (_, i) => ({ candidate: `cand-${i}` }));
    matrix.roomEvents.and.resolveTo([
      callEvent('m.call.candidates', HIGHER, { call_id: callId, party_id: 'pZ', version: 1, candidates: manyCands }),
    ]);
    await svc.pumpOnce();
    await flush();
    expect(pcs[0].addedCandidates.length).toBe(0); // no remote description yet
    matrix.roomEvents.and.resolveTo([
      callEvent('m.call.answer', HIGHER, { call_id: callId, party_id: 'pZ', version: 1, answer: { type: 'answer', sdp: 'a' } }),
    ]);
    await svc.pumpOnce();
    await flush();
    expect(pcs[0].remoteDescription).toEqual({ type: 'answer', sdp: 'a' });
    expect(pcs[0].addedCandidates.length).toBe(MAX_QUEUED_CANDIDATES);
    // Overflow dropped the OLDEST candidates.
    expect(pcs[0].addedCandidates[0]).toEqual({ candidate: 'cand-6' });
  });

  it('a second answer for the same pair does not re-apply (first answer wins)', async () => {
    await join(ME);
    svc.setParticipants([HIGHER]);
    await flush();
    const callId = String(sentSignals('m.call.invite')[0]['call_id']);
    // roomEvents is newest-first (dir=b) and the pump reverses to process
    // oldest-first: 'older' (the array's LAST element) is processed first and
    // binds the pair's party; the later 'newer' answer must NOT re-apply.
    matrix.roomEvents.and.resolveTo([
      callEvent('m.call.answer', HIGHER, { call_id: callId, party_id: 'pZ2', version: 1, answer: { type: 'answer', sdp: 'newer' } }),
      callEvent('m.call.answer', HIGHER, { call_id: callId, party_id: 'pZ1', version: 1, answer: { type: 'answer', sdp: 'older' } }),
    ]);
    await svc.pumpOnce();
    await flush();
    expect(pcs[0].remoteDescription).toEqual({ type: 'answer', sdp: 'older' });
    expect(svc.peerStates()).toEqual({ [HIGHER]: 'connecting' });
  });

  it('HANGUP ends the pair, and the cooldown stops an immediate re-offer to a still-present peer', async () => {
    await join(ME);
    svc.setParticipants([HIGHER]);
    await flush();
    const pc = pcs[0];
    const callId = String(sentSignals('m.call.invite')[0]['call_id']);
    matrix.roomEvents.and.resolveTo([
      callEvent('m.call.hangup', HIGHER, { call_id: callId, party_id: 'pZ', version: 1, reason: 'user_hangup' }),
    ]);
    await svc.pumpOnce();
    expect(pc.closed).toBeTrue();
    expect(svc.peerStates()).toEqual({});
    // Still in the roster — but inside the cooldown no re-offer goes out.
    matrix.sendEvent.calls.reset();
    svc.setParticipants([HIGHER]);
    await flush();
    expect(sentSignals('m.call.invite').length).toBe(0);
    // After the cooldown a fresh roster tick re-offers.
    fakeNow += REOFFER_COOLDOWN_MS + 1;
    svc.setParticipants([HIGHER]);
    await flush();
    expect(sentSignals('m.call.invite').length).toBe(1);
  });

  it('a peer leaving the roster gets a real m.call.hangup and its pc closed', async () => {
    await join(ME);
    svc.setParticipants([HIGHER]);
    await flush();
    const callId = String(sentSignals('m.call.invite')[0]['call_id']);
    svc.setParticipants([]);
    await flush();
    const hangups = sentSignals('m.call.hangup');
    expect(hangups.length).toBe(1);
    expect(hangups[0]['call_id']).toBe(callId);
    expect(pcs[0].closed).toBeTrue();
    expect(svc.peerStates()).toEqual({});
  });

  it('ADMISSION: pairs form only inside the deterministic first-cap set; a non-admitted member connects to nobody', async () => {
    await join(ME, false, 4);
    // Sorted roster: [@aaa (me), @bbb, @ccc, @ddd, @eee, @fff] → admitted first 4.
    svc.setParticipants(['@fff:test', '@ccc:test', '@eee:test', '@bbb:test', '@ddd:test']);
    await flush();
    const invitees = sentSignals('m.call.invite').map((c) => c['invitee']).sort();
    expect(invitees).toEqual(['@bbb:test', '@ccc:test', '@ddd:test']);
    expect(svc.admitted()).toBeTrue();
    expect(svc.meshWarning()).toBeFalse();
  });

  it('a non-admitted member (outside the first-cap mxids) opens no pairs', async () => {
    await join('@zzz:test', false, 2);
    svc.setParticipants(['@aaa:test', '@bbb:test']);
    await flush();
    expect(sentSignals('m.call.invite').length).toBe(0);
    expect(svc.admitted()).toBeFalse();
    expect(svc.peerStates()).toEqual({});
  });

  describe('join() setup window (ICE + microphone still being acquired)', () => {
    /** A mediaFactory that hangs until the "user" answers the permission
     *  prompt — exactly what getUserMedia does on a first-time grant. */
    function deferredMic(): () => void {
      let release!: () => void;
      svc.mediaFactory = () => new Promise<MediaStream>((resolve) => {
        release = () => resolve({
          getTracks: () => localTracks,
          getAudioTracks: () => localTracks,
        } as unknown as MediaStream);
      });
      return () => release();
    }

    it('REGRESSION: a pair formed while the mic prompt is still open is NOT negotiated '
       + 'without the mic — the member would be silent to that peer forever', async () => {
      matrix.turnServer.and.resolveTo([{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }]);
      const grantMic = deferredMic();

      // The host fires `void mesh.join(...)` and its 1Hz room-state poll
      // concurrently, so the roster arrives while getUserMedia is still
      // pending — for as long as the user stares at the browser prompt.
      const joining = svc.join('!r:test', ME, { micEnabled: true, maxParticipants: 8 });
      await flush();
      svc.setParticipants([HIGHER]);
      await flush();

      // Nothing may be negotiated yet: addLocalTracks() no-ops while
      // localStream is null and there is no renegotiation anywhere in this
      // service, so an offer sent now is a PERMANENTLY silent pair — while
      // micLive goes true a moment later and the UI reports voice as working.
      expect(sentSignals('m.call.invite').length).toBe(0);
      expect(pcs.length).toBe(0);
      // …and the member is told why the room is still quiet.
      expect(svc.micNote()).toContain('permission');

      grantMic();
      await joining;
      await flush();

      // Once the grant lands the roster learned during the window is applied.
      const invites = sentSignals('m.call.invite');
      expect(invites.length).toBe(1);
      expect(invites[0]['invitee']).toBe(HIGHER);
      expect(pcs.length).toBe(1);
      // The offer carries the live mic track…
      expect(pcs[0].tracks.length).toBe(1);
      // …and the ICE servers turnServer() returned (a pair built before the
      // fetch resolved would have had NONE, silently host/LAN-only).
      expect((pcs[0].config.iceServers ?? []).length).toBe(1);
      expect(svc.micLive()).toBeTrue();
      expect(svc.micNote()).toBe('');
    });

    it('a THROWING ICE lookup degrades to no-relay instead of aborting the join', async () => {
      // Aborting mid-join would leave the mesh `active` with no timers, no
      // pump and no mic — joined-looking and permanently unable to connect.
      matrix.turnServer.and.throwError(new TypeError('turnServer is not a function'));
      await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
      expect(svc.active()).toBeTrue();
      expect(svc.turnAvailable()).toBeFalse();
      svc.setParticipants([HIGHER]);
      await flush();
      expect(sentSignals('m.call.invite').length).toBe(1);
      // The signalling pump really is running (the timers were reached).
      matrix.roomEvents.calls.reset();
      await svc.pumpOnce();
      expect(matrix.roomEvents).toHaveBeenCalled();
    });

    it('a REFUSED mic still opens the pair (listen-only) once the decision lands', async () => {
      svc.mediaFactory = () => Promise.reject(new Error('NotAllowedError'));
      await svc.join('!r:test', ME, { micEnabled: true, maxParticipants: 8 });
      svc.setParticipants([HIGHER]);
      await flush();
      expect(sentSignals('m.call.invite').length).toBe(1);
      expect(pcs[0].tracks.length).toBe(0);
      expect(svc.micLive()).toBeFalse();
      expect(svc.micNote()).toContain('listen-only');
    });

    it('leaving DURING the setup window starts no timers and forms no pairs', async () => {
      const grantMic = deferredMic();
      const joining = svc.join('!r:test', ME, { micEnabled: true, maxParticipants: 8 });
      await flush();
      svc.setParticipants([HIGHER]);
      await svc.leave();
      grantMic();
      await joining;
      await flush();
      expect(svc.active()).toBeFalse();
      expect(sentSignals('m.call.invite').length).toBe(0);
      expect(pcs.length).toBe(0);
      // The capture that completed after the leave must not be left running.
      expect(localTracks[0].stop).toHaveBeenCalled();
    });

    it('REGRESSION: a join ABANDONED by the kill switch does not resume into the re-joined room',
      async () => {
        // The moderator kill switch is leave() followed by join() on the NEXT
        // 1Hz poll. With a first-time mic prompt still open across the
        // disable/re-enable, TWO join() calls are in flight at once.
        const grantFirst = deferredMic();
        const first = svc.join('!r:test', ME, { micEnabled: true, maxParticipants: 8 });
        await flush();
        await svc.leave();

        // Re-enabled: a SECOND join, this one with a mic that resolves at once.
        const secondTracks = [fakeTrack()];
        svc.mediaFactory = async () => ({
          getTracks: () => secondTracks,
          getAudioTracks: () => secondTracks,
        } as unknown as MediaStream);
        await svc.join('!r:test', ME, { micEnabled: true, maxParticipants: 8 });

        // Only NOW does the user answer the first prompt.
        grantFirst();
        await first;
        await flush();

        // The abandoned join must not adopt the live room: its stream is
        // stopped, not installed, and it starts no second set of timers.
        expect(localTracks[0].stop).toHaveBeenCalled();
        expect(secondTracks[0].stop).not.toHaveBeenCalled();
        svc.setParticipants([HIGHER]);
        await flush();
        expect(pcs.length).toBe(1);
        // The pair carries the SECOND join's capture, the one that is live.
        expect(pcs[0].tracks).toEqual([secondTracks[0]]);
      });
  });

  it('REGRESSION: a non-admitted member does not ANSWER an inbound invite either — an admitted '
     + 'peer cannot pull them into a live mic pair by inviting them directly', async () => {
    // The mirror image of the test above, which only proves we open no pairs
    // OUTBOUND: it never pumps and never feeds an inbound invite, so the
    // self-admission half of the guard had zero coverage and could be deleted
    // with the whole suite still green.
    await join('@zzz:test', true, 2);
    svc.setParticipants(['@aaa:test', '@bbb:test']);
    await flush();
    expect(svc.admitted()).toBeFalse();

    // @aaa IS admitted and IS the designated initiator for the pair (lower
    // mxid), so every other guard on this path passes — only "am I admitted
    // myself?" stands between the hostile peer and my microphone.
    matrix.roomEvents.and.resolveTo([
      callEvent('m.call.invite', '@aaa:test', {
        call_id: 'c3d-pull', party_id: 'pA', version: 1, invitee: '@zzz:test',
        offer: { type: 'offer', sdp: 'pull-me-in' },
      }),
    ]);
    await svc.pumpOnce();
    await flush();

    expect(sentSignals('m.call.answer').length).toBe(0);
    expect(pcs.length).toBe(0);          // no PeerConnection, so no mic track
    expect(svc.peerStates()).toEqual({});
  });

  // ───────────────────── INVITE FRESHNESS (history replay) ─────────────────────

  describe('m.call.invite freshness', () => {
    /** The invite a hostile-but-admitted peer posts once and replays later. */
    const staleInvite = (ageMs: number) => [
      callEvent('m.call.invite', ME, {
        call_id: 'c3d-replay', party_id: 'pA', version: 1, invitee: HIGHER,
        offer: { type: 'offer', sdp: 'their-offer' }, lifetime: INVITE_LIFETIME_MS,
      }, SERVER_NOW - ageMs),
    ];

    async function joinedAsAnswerer(): Promise<void> {
      await join(HIGHER, true);
      svc.setParticipants([ME]);
      await flush();
    }

    it('REGRESSION: an invite older than its lifetime is NOT answered — the pump re-reads a '
       + '200-event history window from an empty dedupe set on every join', async () => {
      await joinedAsAnswerer();
      matrix.roomEvents.and.resolveTo(staleInvite(4 * 60 * 60 * 1000)); // 4h old
      await svc.pumpOnce();
      await flush();

      // Without the age test this hours-old event builds a PeerConnection,
      // attaches the live mic (answerInvite → addLocalTracks) and publishes an
      // answer — every time the victim opens the 3D room, on the attacker's
      // schedule (they re-post whenever it falls out of the window).
      expect(sentSignals('m.call.answer').length).toBe(0);
      expect(pcs.length).toBe(0);
      // …and it says WHY, so a member with a skewed clock is not left silent.
      expect(svc.staleInviteNote().toLowerCase()).toContain('too old');
    });

    it('a LIVE invite is still answered, and one just inside the skew tolerance too', async () => {
      await joinedAsAnswerer();
      matrix.roomEvents.and.resolveTo(staleInvite(0));
      await svc.pumpOnce();
      await flush();
      expect(sentSignals('m.call.answer').length).toBe(1);
      expect(svc.staleInviteNote()).toBe('');

      await svc.leave();
      await joinedAsAnswerer();
      matrix.sendEvent.calls.reset();
      matrix.roomEvents.and.resolveTo(staleInvite(INVITE_LIFETIME_MS + INVITE_CLOCK_SKEW_MS - 1_000));
      await svc.pumpOnce();
      await flush();
      expect(sentSignals('m.call.answer').length).toBe(1);
    });

    it('REGRESSION: a peer-claimed `lifetime` is CLAMPED — an invite cannot buy itself '
       + 'eternal answerability', async () => {
      await joinedAsAnswerer();
      matrix.roomEvents.and.resolveTo([
        callEvent('m.call.invite', ME, {
          call_id: 'c3d-forever', party_id: 'pA', version: 1, invitee: HIGHER,
          offer: { type: 'offer', sdp: 'o' },
          lifetime: 1e15, // "valid for 31 million years"
        }, SERVER_NOW - (MAX_INVITE_LIFETIME_MS + INVITE_CLOCK_SKEW_MS + 1_000)),
      ]);
      await svc.pumpOnce();
      await flush();
      expect(sentSignals('m.call.answer').length).toBe(0);
      expect(pcs.length).toBe(0);
    });

    it('REGRESSION: a FAR-FUTURE origin_server_ts is rejected too (the replay hole from the '
       + 'other side — it would stay "fresh" indefinitely)', async () => {
      await joinedAsAnswerer();
      matrix.roomEvents.and.resolveTo(staleInvite(-(24 * 60 * 60 * 1000))); // dated a day ahead
      await svc.pumpOnce();
      await flush();
      expect(sentSignals('m.call.answer').length).toBe(0);
      expect(pcs.length).toBe(0);
    });

    it('FAIL-CLOSED: an invite with no usable origin_server_ts is not answered', async () => {
      await joinedAsAnswerer();
      // NOTE: the ts is stamped by DELETING/overwriting the key, not by passing
      // `undefined` to callEvent — that would hit its default parameter and
      // silently produce a FRESH event, i.e. a vacuous test.
      for (const ts of [undefined, Number.NaN, Infinity, 'yesterday'] as unknown[]) {
        const row = callEvent('m.call.invite', ME, {
          call_id: `c3d-nots-${String(ts)}`, party_id: 'pA', version: 1, invitee: HIGHER,
          offer: { type: 'offer', sdp: 'o' },
        });
        (row as Record<string, unknown>)['origin_server_ts'] = ts;
        // The stamp really IS unusable (guards this test against going vacuous).
        expect(Number.isFinite(row.origin_server_ts as number)).toBeFalse();
        matrix.roomEvents.and.resolveTo([row]);
        await svc.pumpOnce();
        await flush();
      }
      expect(sentSignals('m.call.answer').length).toBe(0);
      expect(pcs.length).toBe(0);
    });

    it('an invite with NO lifetime field falls back to the spec default, not to "forever"', async () => {
      await joinedAsAnswerer();
      matrix.roomEvents.and.resolveTo([
        callEvent('m.call.invite', ME, {
          call_id: 'c3d-nolife', party_id: 'pA', version: 1, invitee: HIGHER,
          offer: { type: 'offer', sdp: 'o' },
        }, SERVER_NOW - (INVITE_LIFETIME_MS + INVITE_CLOCK_SKEW_MS + 1_000)),
      ]);
      await svc.pumpOnce();
      await flush();
      expect(sentSignals('m.call.answer').length).toBe(0);
    });

    it('freshness applies ONLY to invites — a hangup for a live pair still lands', async () => {
      await join(ME);
      svc.setParticipants([HIGHER]);
      await flush();
      const callId = String(sentSignals('m.call.invite')[0]['call_id']);
      const hangup = callEvent('m.call.hangup', HIGHER, { call_id: callId, party_id: 'pZ', version: 1 });
      delete (hangup as Partial<typeof hangup>).origin_server_ts;
      expect(hangup.origin_server_ts).toBeUndefined();
      matrix.roomEvents.and.resolveTo([hangup]);
      await svc.pumpOnce();
      // A hangup is only ever DESTRUCTIVE to a pair we already hold and is
      // bound to its call_id, so ageing it would only strand live connections.
      expect(pcs[0].closed).toBeTrue();
    });
  });

  it('warns about full-mesh strain from 8 participants up', async () => {
    await join(ME, false, 16);
    const seven = Array.from({ length: 7 }, (_, i) => `@u${i}:test`);
    svc.setParticipants(seven.slice(0, 6));
    expect(svc.meshWarning()).toBeFalse(); // 6 remotes + me = 7
    svc.setParticipants(seven);
    expect(svc.meshWarning()).toBeTrue(); // 7 remotes + me = 8
  });

  it('surfaces TURN darkness honestly and passes relays into the pc config when present', async () => {
    matrix.turnServer.and.resolveTo([{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }]);
    await join(ME);
    expect(svc.turnAvailable()).toBeTrue();
    svc.setParticipants([HIGHER]);
    await flush();
    expect(pcs[0].config.iceServers).toEqual([{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }]);
  });

  it('a refused mic demotes to listen-only with a WHY note instead of blocking the mesh', async () => {
    svc.mediaFactory = async () => {
      throw new DOMException('denied', 'NotAllowedError');
    };
    await join(ME, true);
    expect(svc.micLive()).toBeFalse();
    expect(svc.micNote().toLowerCase()).toContain('listen-only');
    svc.setParticipants([HIGHER]);
    await flush();
    expect(sentSignals('m.call.invite').length).toBe(1); // mesh still forms
    expect(pcs[0].tracks.length).toBe(0);                // just no local audio
  });

  it('adds the shared mic track to every pair when the mic is live, and setMicEnabled toggles it', async () => {
    await join(ME, true);
    svc.setParticipants([HIGHER]);
    await flush();
    expect(svc.micLive()).toBeTrue();
    expect(pcs[0].tracks.length).toBe(1);
    svc.setMicEnabled(false);
    expect((localTracks[0] as unknown as { enabled: boolean }).enabled).toBeFalse();
    svc.setMicEnabled(true);
    expect((localTracks[0] as unknown as { enabled: boolean }).enabled).toBeTrue();
  });

  describe('chat3d data channel traffic', () => {
    /** Join as initiator, connect the pair, return its channel. */
    async function connectedChannel(): Promise<FakeChannel> {
      await join(ME);
      svc.setParticipants([HIGHER]);
      await flush();
      return pcs[0].channels[0];
    }

    it('broadcasts the local pose @10Hz ticks to open channels only', async () => {
      const chan = await connectedChannel();
      svc.poseProvider = () => ({ x: 1, z: 2, yaw: 0.5, seat: 3 });
      svc.tickPose();
      expect(chan.sent.length).toBe(1);
      expect(new Uint8Array(chan.sent[0])[0]).toBe(0x01);
      chan.readyState = 'closed';
      svc.tickPose();
      expect(chan.sent.length).toBe(1); // closed channel skipped
      svc.poseProvider = () => null;
      chan.readyState = 'open';
      svc.tickPose();
      expect(chan.sent.length).toBe(1); // no pose yet ⇒ nothing sent
    });

    it('broadcasts blendshapes only when a NEW vector exists (ts-diffed)', async () => {
      const chan = await connectedChannel();
      const values = new Uint8Array(BLENDSHAPE_COUNT);
      values[JAW_OPEN_INDEX] = 128;
      svc.blendshapesProvider = () => ({ values, ts: 1 });
      svc.tickBlendshapes();
      svc.tickBlendshapes(); // same ts ⇒ no resend
      expect(chan.sent.length).toBe(1);
      svc.blendshapesProvider = () => ({ values, ts: 2 });
      svc.tickBlendshapes();
      expect(chan.sent.length).toBe(2);
    });

    it('dispatches inbound pose/blendshapes frames to the host callbacks and drops junk', async () => {
      const chan = await connectedChannel();
      const poses: unknown[] = [];
      const blends: Uint8Array[] = [];
      svc.onPeerPose = (userId, pose) => poses.push([userId, pose]);
      svc.onPeerBlendshapes = (userId, values) => blends.push(values);
      chan.onmessage!({ data: encodePoseFrame(1, 2, 0.25, 4) });
      expect(poses.length).toBe(1);
      expect(poses[0]).toEqual([HIGHER, jasmine.objectContaining({ x: 1, z: 2, seat: 4 })]);
      const vec = new Uint8Array(BLENDSHAPE_COUNT);
      vec[JAW_OPEN_INDEX] = 255;
      chan.onmessage!({ data: encodeBlendshapesFrame(vec) });
      expect(blends.length).toBe(1);
      expect(blends[0][JAW_OPEN_INDEX]).toBe(255);
      chan.onmessage!({ data: new Uint8Array([0x7f, 0, 1]).buffer }); // junk tag
      chan.onmessage!({ data: 'not-binary' });
      expect(poses.length).toBe(1);
      expect(blends.length).toBe(1);
    });

    it('OPENNESS: fresh blendshapes jawOpen outranks the amplitude drive; stale falls back', async () => {
      const chan = await connectedChannel();
      // Attach the remote stream so the amplitude drive exists.
      pcs[0].ontrack!({ streams: [{} as MediaStream] });
      driveOpenness.set(0.9);
      const opennesses: [string, number][] = [];
      svc.onPeerOpenness = (u, o) => opennesses.push([u, o]);
      // Fresh camera frame: jawOpen 128/255 ≈ 0.5 wins over amplitude 0.9.
      const vec = new Uint8Array(BLENDSHAPE_COUNT);
      vec[JAW_OPEN_INDEX] = 128;
      chan.onmessage!({ data: encodeBlendshapesFrame(vec) });
      svc.tickOpenness();
      const last = opennesses.filter(([u]) => u === HIGHER).pop()!;
      expect(last[1]).toBeCloseTo(128 / 255, 2);
      // 800ms later the vector is stale — amplitude resumes.
      fakeNow += 800;
      svc.tickOpenness();
      const after = opennesses.filter(([u]) => u === HIGHER).pop()!;
      expect(after[1]).toBe(0.9);
    });

    it('SPEAKING: the peer\'s channel flag is authoritative and forwarded on change only', async () => {
      const chan = await connectedChannel();
      const flags: [string, boolean][] = [];
      svc.onPeerSpeaking = (u, s) => flags.push([u, s]);
      chan.onmessage!({ data: encodeSpeakingFrame(true) });
      svc.tickOpenness();
      svc.tickOpenness(); // unchanged ⇒ not re-forwarded
      expect(flags.filter(([u]) => u === HIGHER)).toEqual([[HIGHER, true]]);
      chan.onmessage!({ data: encodeSpeakingFrame(false) });
      svc.tickOpenness();
      expect(flags.filter(([u]) => u === HIGHER)).toEqual([[HIGHER, true], [HIGHER, false]]);
    });

    it('broadcasts MY speaking flag on change, driven by the local amplitude detector', async () => {
      await join(ME, true);
      svc.setParticipants([HIGHER]);
      await flush();
      const chan = pcs[0].channels[0];
      const flags: [string, boolean][] = [];
      svc.onPeerSpeaking = (u, s) => flags.push([u, s]);
      driveOpenness.set(0.5); // above the speaking threshold
      svc.tickOpenness();
      expect(flags).toContain([ME, true]);
      const speakingFrames = chan.sent.filter((b) => new Uint8Array(b)[0] === FRAME_SPEAKING);
      expect(speakingFrames.length).toBe(1);
      expect(new Uint8Array(speakingFrames[0])[1]).toBe(1);
      svc.tickOpenness(); // unchanged ⇒ no re-broadcast
      expect(chan.sent.filter((b) => new Uint8Array(b)[0] === FRAME_SPEAKING).length).toBe(1);
    });
  });

  it('LEAVE hangs up every live pair and tears everything down', async () => {
    await join(ME, true);
    svc.setParticipants([HIGHER]);
    await flush();
    const callId = String(sentSignals('m.call.invite')[0]['call_id']);
    await svc.leave();
    const hangups = sentSignals('m.call.hangup');
    expect(hangups.length).toBe(1);
    expect(hangups[0]['call_id']).toBe(callId);
    expect(pcs[0].closed).toBeTrue();
    expect(svc.active()).toBeFalse();
    expect(svc.micLive()).toBeFalse();
    expect((localTracks[0] as unknown as { stop: jasmine.Spy }).stop).toHaveBeenCalled();
    expect(svc.peerStates()).toEqual({});
  });
});

/** A scripted MatrixRtcService: the flag, the advertised focus, the join outcome. */
class RtcStub {
  enabled = true;
  focus: LivekitFocus | null = { type: 'livekit', livekit_service_url: 'https://rtc.test/livekit/jwt' };
  discoverFocus = jasmine.createSpy('discoverFocus').and.callFake(async () => this.focus);
  joinResult: () => RtcJoinResult = () => ({ ok: true, session: this.session, membershipPublished: true });
  join = jasmine.createSpy('join').and.callFake(async () => this.joinResult());
  session = new FakeSession();
}

class FakeSession implements RtcGroupSession {
  readonly focus: LivekitFocus = { type: 'livekit', livekit_service_url: 'https://rtc.test/livekit/jwt' };
  onPeerAudio: ((userId: string, stream: MediaStream) => void) | null = null;
  onPeerLeft: ((userId: string) => void) | null = null;
  onData: ((userId: string, frame: ArrayBuffer) => void) | null = null;
  onDisconnected: (() => void) | null = null;
  sent: ArrayBuffer[] = [];
  mics: MediaStreamTrack[] = [];
  /** What the real session retains per user (LivekitGroupSession.remoteAudio). */
  audio = new Map<string, MediaStream>();
  leave = jasmine.createSpy('leave').and.resolveTo(undefined);
  remoteAudio(userId: string): MediaStream | null {
    return this.audio.get(userId) ?? null;
  }
  /** A TrackSubscribed as the real session surfaces it: retained, THEN handed on (if a handler is set). */
  deliverAudio(userId: string, stream: MediaStream): void {
    this.audio.set(userId, stream);
    this.onPeerAudio?.(userId, stream);
  }
  async publishMic(track: MediaStreamTrack): Promise<void> {
    this.mics.push(track);
  }
  sendData(frame: ArrayBuffer): void {
    this.sent.push(frame);
  }
}

/** A longer flush for the routing chain (discover → join → switch). */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

/** Nine sorted mxids: me first, so I am the p2p initiator for every pair. */
const ROOM_OF_9 = ['@b1:test', '@b2:test', '@b3:test', '@b4:test', '@b5:test', '@b6:test', '@b7:test', '@b8:test'];

describe('MeshCallService above the p2p cap (MatrixRTC route, hugmesh-admin-bff-api#98)', () => {
  let svc: MeshCallService;
  let matrix: MatrixStub;
  let rtc: RtcStub;
  let pcs: FakePc[];
  let localTracks: MediaStreamTrack[];
  const sinks: { stream: unknown; remove: jasmine.Spy }[] = [];

  beforeEach(() => {
    matrix = new MatrixStub();
    rtc = new RtcStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: MatrixService, useValue: matrix },
        { provide: MatrixRtcService, useValue: rtc },
      ],
    });
    svc = TestBed.inject(MeshCallService);
    pcs = [];
    sinks.length = 0;
    localTracks = [({ enabled: true, stop: jasmine.createSpy('stop') }) as unknown as MediaStreamTrack];
    svc.pcFactory = (config) => {
      const pc = new FakePc(config);
      pcs.push(pc);
      return pc;
    };
    svc.mediaFactory = async () => ({
      getTracks: () => localTracks,
      getAudioTracks: () => localTracks,
    }) as unknown as MediaStream;
    svc.audioSinkFactory = (stream) => {
      const sink = { srcObject: null, stream, remove: jasmine.createSpy('remove') };
      sinks.push(sink);
      return sink;
    };
    svc.driveFactory = () => ({ openness: signal(0), stop: jasmine.createSpy('stop') });
  });

  afterEach(async () => {
    await svc.leave();
  });

  function sentSignals(type: string): Record<string, unknown>[] {
    return matrix.sendEvent.calls.allArgs().filter((a) => a[1] === type).map((a) => a[2] as Record<string, unknown>);
  }

  it('AT the cap (8 of 8) stays peer-to-peer and never asks for a focus', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9.slice(0, 7));
    await settle();
    expect(rtc.discoverFocus).not.toHaveBeenCalled();
    expect(svc.transport()).toBe('p2p');
    expect(sentSignals('m.call.invite').length).toBe(7);
  });

  it('CAP + 1 participants → the SFU path: p2p pairs hung up, voice + motion move to the session', async () => {
    await svc.join('!r:test', ME, { micEnabled: true, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    expect(rtc.discoverFocus).toHaveBeenCalledTimes(1);
    expect(rtc.join).toHaveBeenCalledOnceWith('!r:test', ME, rtc.focus);
    expect(svc.transport()).toBe('sfu');
    // Every pair the p2p mesh had opened got a real hangup and a closed pc.
    expect(sentSignals('m.call.hangup').length).toBe(sentSignals('m.call.invite').length);
    expect(pcs.every((pc) => pc.closed)).toBeTrue();
    expect(svc.peerStates()).toEqual({});
    // Everyone is admitted on the SFU, nothing strains, and the note says why.
    expect(svc.admitted()).toBeTrue();
    expect(svc.meshWarning()).toBeFalse();
    expect(svc.routeNote()).toContain('9 participants');
    expect(svc.routeNote()).toContain('peer-to-peer voice cap of 8');
    expect(svc.routeNote()).toContain('media server');
    expect(svc.callMemberNote()).toBe('');
    // The ALREADY-captured mic is published — no second capture.
    expect(rtc.session.mics).toEqual([localTracks[0]]);
  });

  it('on the SFU: remote audio gets a sink + drive, frames decode, my broadcast is ONE publish', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    const poses: [string, unknown][] = [];
    svc.onPeerPose = (u, p) => poses.push([u, p]);
    const stream = { id: 'remote' } as unknown as MediaStream;
    rtc.session.onPeerAudio!('@b3:test', stream);
    expect(sinks.map((x) => x.stream)).toEqual([stream]);
    expect(svc.peerStates()).toEqual({ '@b3:test': 'connected' });
    rtc.session.onData!('@b3:test', encodePoseFrame(1, 2, 0, 3));
    expect(poses).toEqual([['@b3:test', { x: 1, z: 2, yaw: 0, seat: 3 }]]);
    svc.poseProvider = () => ({ x: 0, z: 0, yaw: 0, seat: 1 });
    svc.tickPose();
    expect(rtc.session.sent.length).toBe(1);
    expect(pcs.every((pc) => pc.channels.every((c) => c.sent.length === 0))).toBeTrue();
  });

  it('on the SFU: a stranger outside the 3D roster (or my own other tab) conjures NOTHING', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    const poses: string[] = [];
    svc.onPeerPose = (u) => poses.push(u);
    rtc.session.onPeerAudio!('@mallory:test', {} as MediaStream);
    rtc.session.onData!('@mallory:test', encodePoseFrame(1, 2, 0, 3));
    rtc.session.onPeerAudio!(ME, {} as MediaStream);
    expect(sinks.length).toBe(0);
    expect(poses).toEqual([]);
    expect(svc.peerStates()).toEqual({});
  });

  it('on the SFU the m.call pump is OFF — an inbound invite is not answered', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    matrix.roomEvents.calls.reset();
    await svc.pumpOnce();
    expect(matrix.roomEvents).not.toHaveBeenCalled();
  });

  it('DEBOUNCED: a dip under the cap for fewer than SFU_FALLBACK_TICKS rosters does not flap; departed sinks close', async () => {
    expect(SFU_FALLBACK_TICKS).toBe(3);
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    rtc.session.onPeerAudio!('@b8:test', {} as MediaStream);
    for (let i = 0; i < SFU_FALLBACK_TICKS - 1; i++) {
      svc.setParticipants(ROOM_OF_9.slice(0, 3));
      await settle();
    }
    expect(svc.transport()).toBe('sfu');
    expect(rtc.session.leave).not.toHaveBeenCalled();
    expect(sinks[0].remove).toHaveBeenCalled();
    expect(svc.peerStates()).toEqual({});
    // Back over the cap resets the count: two more dips still do not fall back.
    svc.setParticipants(ROOM_OF_9);
    for (let i = 0; i < SFU_FALLBACK_TICKS - 1; i++) {
      svc.setParticipants(ROOM_OF_9.slice(0, 3));
    }
    await settle();
    expect(svc.transport()).toBe('sfu');
    expect(rtc.join).toHaveBeenCalledTimes(1);
  });

  it('FALLS BACK after SFU_FALLBACK_TICKS rosters at the cap: SFU left, pump back on, p2p pairs re-form', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    rtc.session.onPeerAudio!('@b1:test', {} as MediaStream);
    const internals = svc as unknown as { signalTimer: unknown; hangupCooldown: Map<string, number> };
    expect(internals.signalTimer).withContext('no m.call pump on the SFU').toBeNull();
    // A hangup cooldown left from the move TO the SFU (a transport move, not a
    // member leaving the pair) must not delay re-forming that pair.
    internals.hangupCooldown.set('@b1:test', Date.now());
    matrix.sendEvent.calls.reset();
    const eight = ROOM_OF_9.slice(0, 7); // + me = 8 of 8
    for (let i = 0; i < SFU_FALLBACK_TICKS; i++) {
      svc.setParticipants(eight);
      await settle();
    }
    expect(svc.transport()).toBe('p2p');
    expect(rtc.session.leave).toHaveBeenCalledTimes(1); // which clears the membership event
    expect(sinks[0].remove).toHaveBeenCalled();
    expect(svc.routeNote()).toBe('');
    expect(svc.callMemberNote()).toBe('');
    // I am the lowest mxid, so I re-offer to all seven — what a newcomer that
    // arrived at 8 of 8 (and never left p2p) is waiting for.
    expect(sentSignals('m.call.invite').map((c) => c['invitee']).sort()).toEqual([...eight].sort());
    // The m.call pump answers again — its timer restarted, too.
    expect(internals.signalTimer).not.toBeNull();
    matrix.roomEvents.calls.reset();
    await svc.pumpOnce();
    expect(matrix.roomEvents).toHaveBeenCalled();
    // A late event from the session we left conjures nothing.
    rtc.session.onPeerAudio?.('@b2:test', {} as MediaStream);
    expect(sinks.length).toBe(1);
  });

  it('SPLIT-BRAIN (refute major): a newcomer\'s fresh invite, sent while this client was still on the SFU, is answered after the fall-back', async () => {
    // Me = @b5 (NOT the initiator towards the newcomer @a0). The room had 9 on
    // the SFU, two left, a newcomer arrived at 8 of 8 and stayed p2p.
    svc.now = () => SERVER_NOW;
    await svc.join('!r:test', '@b5:test', { micEnabled: false, maxParticipants: 8 });
    const nine = [ME, '@b1:test', '@b2:test', '@b3:test', '@b4:test', '@b6:test', '@b7:test', '@b8:test'];
    svc.setParticipants(nine);
    await settle();
    expect(svc.transport()).toBe('sfu');
    const withNewcomer = ['@a0:test', '@b1:test', '@b2:test', '@b3:test', '@b4:test', '@b6:test', '@b7:test'];
    // The newcomer's invite lands during the debounce window.
    matrix.roomEvents.and.resolveTo([callEvent('m.call.invite', '@a0:test', {
      call_id: `${MESH_CALL_ID_PREFIX}new1`, party_id: 'pN', version: 1, lifetime: INVITE_LIFETIME_MS,
      invitee: '@b5:test', offer: { type: 'offer', sdp: 'newcomer-sdp' },
    })]);
    await svc.pumpOnce(); // still on the SFU: not answered
    expect(sentSignals('m.call.answer').length).toBe(0);
    for (let i = 0; i < SFU_FALLBACK_TICKS; i++) {
      svc.setParticipants(withNewcomer);
      await settle();
    }
    expect(svc.transport()).toBe('p2p');
    await svc.pumpOnce();
    await settle();
    const answers = sentSignals('m.call.answer');
    expect(answers.length).toBe(1);
    expect(answers[0]['call_id']).toBe(`${MESH_CALL_ID_PREFIX}new1`);
    expect(svc.staleInviteNote()).toBe('');
  });

  it('PROBE-1 (refute major): audio that arrives BEFORE the sender is on the roster is attached once they are', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    const stream = { id: 'c9-voice' } as unknown as MediaStream;
    rtc.session.deliverAudio('@c9:test', stream); // not on the roster yet
    expect(sinks.length).toBe(0);
    svc.setParticipants([...ROOM_OF_9, '@c9:test']);
    await settle();
    expect(sinks.map((x) => x.stream)).toEqual([stream]);
    expect(svc.peerStates()['@c9:test']).toBe('connected');
    // A pose frame afterwards does not build a second sink.
    rtc.session.onData!('@c9:test', encodePoseFrame(1, 2, 0, 3));
    expect(sinks.length).toBe(1);
  });

  it('PROBE-2 (refute major): a one-poll roster blip re-attaches the SAME retained audio when the member returns', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    const ten = [...ROOM_OF_9, '@c9:test'];
    svc.setParticipants(ten);
    await settle();
    const stream = { id: 'b3-voice' } as unknown as MediaStream;
    rtc.session.deliverAudio('@b3:test', stream);
    expect(sinks.map((x) => x.stream)).toEqual([stream]);
    svc.setParticipants(ten.filter((u) => u !== '@b3:test')); // blip: still 9, still over the cap
    await settle();
    expect(sinks[0].remove).toHaveBeenCalled();
    svc.setParticipants(ten);
    await settle();
    expect(sinks.map((x) => x.stream)).toEqual([stream, stream]);
    expect(sinks[1].remove).not.toHaveBeenCalled();
  });

  it('audio the session retained BEFORE the switch (the join\'s membership round-trip window) is attached on switch', async () => {
    const early = { id: 'early' } as unknown as MediaStream;
    rtc.session.audio.set('@b2:test', early); // TrackSubscribed fired while onPeerAudio was still null
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    expect(svc.transport()).toBe('sfu');
    expect(sinks.map((x) => x.stream)).toEqual([early]);
    expect(svc.peerStates()).toEqual({ '@b2:test': 'connected' });
  });

  it('a participant leaving the SFU (still on the 3D roster) has its sink closed', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    rtc.session.deliverAudio('@b4:test', {} as MediaStream);
    rtc.session.audio.delete('@b4:test');
    rtc.session.onPeerLeft!('@b4:test');
    expect(sinks[0].remove).toHaveBeenCalled();
    expect(svc.peerStates()).toEqual({});
  });

  it('an unrequested SFU disconnect says so in the route note', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    rtc.session.onDisconnected!();
    expect(svc.routeNote()).toContain('media server dropped');
  });

  it('a leave() while focus discovery is in flight never joins the SFU', async () => {
    let releaseFocus!: (f: LivekitFocus | null) => void;
    rtc.discoverFocus.and.callFake(() => new Promise<LivekitFocus | null>((res) => (releaseFocus = res)));
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    await svc.leave();
    releaseFocus(rtc.focus);
    await settle();
    expect(rtc.join).not.toHaveBeenCalled();
    expect(svc.transport()).toBe('p2p');
  });

  it('back under the cap during discovery: stays p2p, and a later rise decides afresh', async () => {
    let releaseFocus!: (f: LivekitFocus | null) => void;
    rtc.discoverFocus.and.callFake(() => new Promise<LivekitFocus | null>((res) => (releaseFocus = res)));
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    svc.setParticipants(ROOM_OF_9); // another over-cap tick while discovery is in flight
    await settle();
    expect(rtc.discoverFocus).withContext('one discovery in flight at a time').toHaveBeenCalledTimes(1);
    svc.setParticipants(ROOM_OF_9.slice(0, 7));
    releaseFocus(rtc.focus);
    await settle();
    expect(rtc.join).not.toHaveBeenCalled();
    expect(svc.transport()).toBe('p2p');
    rtc.discoverFocus.and.callFake(async () => rtc.focus);
    svc.setParticipants(ROOM_OF_9);
    await settle();
    expect(rtc.join).toHaveBeenCalledTimes(1);
    expect(svc.transport()).toBe('sfu');
  });

  it('NO FOCUS advertised → keeps the p2p cap and says why in the UI note', async () => {
    rtc.focus = null;
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    expect(rtc.join).not.toHaveBeenCalled();
    expect(svc.transport()).toBe('p2p');
    // p2p admission is unchanged: I am in the first 8, so 7 pairs formed.
    expect(sentSignals('m.call.invite').length).toBe(7);
    expect(sentSignals('m.call.hangup').length).toBe(0);
    expect(svc.routeNote()).toContain('9 participants');
    expect(svc.routeNote()).toContain('advertises no group-call media server');
    expect(svc.routeNote()).toContain('only the first 8');
    // It asked ONCE for this over-cap episode, not on every roster tick.
    svc.setParticipants([...ROOM_OF_9]);
    await settle();
    expect(rtc.discoverFocus).toHaveBeenCalledTimes(1);
    // Back at the cap: the note no longer describes the room; a later rise asks again.
    svc.setParticipants(ROOM_OF_9.slice(0, 7));
    await settle();
    expect(svc.routeNote()).toBe('');
    svc.setParticipants(ROOM_OF_9);
    await settle();
    expect(rtc.discoverFocus).toHaveBeenCalledTimes(2);
  });

  it('a FAILED SFU join stays p2p with the failing step named', async () => {
    rtc.joinResult = () => ({ ok: false, step: 'token' });
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    expect(svc.transport()).toBe('p2p');
    expect(svc.routeNote()).toContain('refused a join token');
    // Honest about the isolation: everyone else moved to the media server.
    expect(svc.routeNote()).toContain('you may hear no one');
    expect(svc.routeNote()).not.toContain('only the first');
    expect(sentSignals('m.call.hangup').length).toBe(0);
    // Settled for this over-cap episode (no retry every tick) ...
    svc.setParticipants([...ROOM_OF_9]);
    await settle();
    expect(rtc.join).toHaveBeenCalledTimes(1);
    // ... and re-armed once the room is back at the cap.
    svc.setParticipants(ROOM_OF_9.slice(0, 7));
    await settle();
    rtc.joinResult = () => ({ ok: true, session: rtc.session, membershipPublished: true });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    expect(rtc.join).toHaveBeenCalledTimes(2);
    expect(svc.transport()).toBe('sfu');
  });

  it('a refused membership publish keeps the SFU call and says other call apps will not list me', async () => {
    rtc.joinResult = () => ({ ok: true, session: rtc.session, membershipPublished: false });
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    expect(svc.transport()).toBe('sfu');
    expect(svc.callMemberNote()).toContain('org.matrix.msc3401.call.member');
  });

  it('LEAVE (also the moderator kill switch) leaves the SFU session — which clears the membership', async () => {
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    await svc.leave();
    expect(rtc.session.leave).toHaveBeenCalledTimes(1);
    expect(svc.transport()).toBe('p2p');
    expect(svc.routeNote()).toBe('');
  });

  it('a leave() while the SFU join is in flight does not adopt the session — it is left', async () => {
    let release!: (r: RtcJoinResult) => void;
    rtc.join.and.callFake(() => new Promise<RtcJoinResult>((res) => (release = res)));
    await svc.join('!r:test', ME, { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants(ROOM_OF_9);
    await settle();
    await svc.leave();
    release({ ok: true, session: rtc.session, membershipPublished: true });
    await settle();
    expect(svc.transport()).toBe('p2p');
    expect(rtc.session.leave).toHaveBeenCalledTimes(1);
  });

  it('flag OFF: above the cap nothing is asked and the mesh behaves exactly as before', async () => {
    rtc.enabled = false;
    await svc.join('!r:test', '@b5:test', { micEnabled: false, maxParticipants: 8 });
    svc.setParticipants([ME, ...ROOM_OF_9]);
    await settle();
    expect(rtc.discoverFocus).not.toHaveBeenCalled();
    expect(rtc.join).not.toHaveBeenCalled();
    expect(svc.transport()).toBe('p2p');
    expect(svc.routeNote()).toBe('');
    expect(svc.meshWarning()).toBeTrue();
  });
});

describe('MeshCallService with the REAL MatrixRtcService and no flag hook (the shipped default)', () => {
  it('a 17-member roster makes NO well-known request and keeps the p2p admission', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: MatrixService, useValue: new MatrixStub() }] });
    const svc = TestBed.inject(MeshCallService);
    const rtc = TestBed.inject(MatrixRtcService);
    const fetchSpy = jasmine.createSpy('fetch');
    rtc.fetchFn = fetchSpy;
    svc.pcFactory = (config) => new FakePc(config);
    await svc.join('!r:test', '@zz:test', { micEnabled: false, maxParticipants: 16 });
    svc.setParticipants(Array.from({ length: 17 }, (_, i) => `@m${String(i).padStart(2, '0')}:test`));
    await settle();
    expect(rtc.enabled).toBeFalse();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(svc.transport()).toBe('p2p');
    expect(svc.admitted()).toBeFalse();
    await svc.leave();
  });
});
