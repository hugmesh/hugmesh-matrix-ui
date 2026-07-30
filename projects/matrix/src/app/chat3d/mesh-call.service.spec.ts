import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MatrixService } from '../matrix.service';
import {
  INVITE_CLOCK_SKEW_MS, INVITE_LIFETIME_MS, MAX_INVITE_LIFETIME_MS,
  MAX_QUEUED_CANDIDATES, MESH_CALL_ID_PREFIX, MeshCallService, MeshChannelLike,
  MeshPcLike, REOFFER_COOLDOWN_MS,
} from './mesh-call.service';
import {
  BLENDSHAPE_COUNT, JAW_OPEN_INDEX, encodeBlendshapesFrame, encodePoseFrame,
  encodeSpeakingFrame, FRAME_SPEAKING,
} from './av-channel';

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
