import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MatrixCallComponent, NEUTRAL_SILHOUETTE_URL } from './matrix-call.component';
import { MatrixService, MatrixRoom } from './matrix.service';
import { CharacterPackService, UserEmotesPack } from './vn/character-pack.service';
import { SceneService } from './vn/scenes/scene.service';
import { VnSceneState, VnSceneStateService } from './vn/scenes/vn-scene-state.service';
import { expectDescribedByHelp } from './a11y-help.spec-util';

const ROOM: MatrixRoom = { roomId: '!call:test', name: 'Call Room' };

class MatrixServiceStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  joinedRooms = jasmine.createSpy('joinedRooms').and.resolveTo([ROOM]);
  roomEvents = jasmine.createSpy('roomEvents').and.resolveTo([]);
  sendEvent = jasmine.createSpy('sendEvent').and.resolveTo('$evt');
  joinedMembers = jasmine.createSpy('joinedMembers').and.resolveTo([
    { userId: '@me:test', displayName: 'Me', membership: 'join', powerLevel: 0 },
    { userId: '@peer:test', displayName: 'Peer', membership: 'join', powerLevel: 0 },
  ]);
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('');
  getProfile = jasmine.createSpy('getProfile').and.callFake(async (userId: string) => ({ userId }));
  // Default: no TURN configured (coturn ships dark) → host-only candidates, the
  // byte-identical default behaviour. Individual specs override this to exercise
  // the TURN-present path.
  turnServer = jasmine.createSpy('turnServer').and.resolveTo([] as RTCIceServer[]);
}

/** VN-mode collaborator stubs: no character packs, no shared scene, no manifest
 *  fetches — every leg fail-soft, exactly the services' contract. */
class CharacterPackServiceStub {
  resolveCharacterPack = jasmine.createSpy('resolveCharacterPack').and.resolveTo(null as UserEmotesPack | null);
  imageFor = (pack: UserEmotesPack | null, expression: string) =>
    pack ? (pack.images[expression] ?? pack.images['neutral'] ?? null) : null;
}
class VnSceneStateServiceStub {
  getSceneState = jasmine.createSpy('getSceneState').and.resolveTo(null as VnSceneState | null);
  // The RECEIVE path (pumpSceneState) reads through the MODERATED method.
  getModeratedSceneState = jasmine.createSpy('getModeratedSceneState').and.resolveTo(null as VnSceneState | null);
  setSceneState = jasmine.createSpy('setSceneState').and.resolveTo(true);
}
class SceneServiceStub {
  load = jasmine.createSpy('load').and.resolveTo(undefined);
  scenes = () => [];
  props = () => [];
  loaded = () => true;
  sceneById = () => null;
  propById = () => null;
  sceneUrl = () => null;
  propUrl = () => null;
}

describe('MatrixCallComponent', () => {
  let fixture: ComponentFixture<MatrixCallComponent>;
  let component: MatrixCallComponent;
  let matrix: MatrixServiceStub;

  beforeEach(async () => {
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [MatrixCallComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: CharacterPackService, useValue: new CharacterPackServiceStub() },
        { provide: VnSceneStateService, useValue: new VnSceneStateServiceStub() },
        { provide: SceneService, useValue: new SceneServiceStub() },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MatrixCallComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    component.ngOnDestroy(); // stop the 1s signalling poll so the spec doesn't churn
    fixture.detectChanges();
  });

  it('labels the call region and the call controls group', () => {
    const view = fixture.nativeElement.querySelector('[data-testid="call-view"]');
    expect(view.getAttribute('aria-label')).toBe('Matrix video call');
    const controls = fixture.nativeElement.querySelector('.actions');
    expect(controls.getAttribute('role')).toBe('group');
    expect(controls.getAttribute('aria-label')).toBe('Call controls');
  });

  it('exposes the call state as a polite live region', () => {
    const state = fixture.nativeElement.querySelector('[data-testid="call-state"]');
    expect(state.getAttribute('role')).toBe('status');
    expect(state.getAttribute('aria-live')).toBe('polite');
    expect(state.textContent).toBe('idle');
  });

  it('gives both <video> elements an accessible label', () => {
    const local = fixture.nativeElement.querySelector('[data-testid="local-video"]');
    const remote = fixture.nativeElement.querySelector('[data-testid="remote-video"]');
    expect(local.getAttribute('aria-label')).toBe('Your camera');
    expect(remote.getAttribute('aria-label')).toBe('Remote participant');
  });

  it('resolves the call room from the joined rooms', () => {
    expect(component.room()?.roomId).toBe('!call:test');
  });

  it('MODE DEFAULT: no ?mode= renders the video tiles and NO VN stage', () => {
    expect(component.mode()).toBe('video');
    expect(fixture.nativeElement.querySelector('.videos')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="vn-call"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('hug-vn-stage')).toBeNull();
  });

  it('MODE DEFAULT: start() requests camera AND microphone (unchanged behaviour)', async () => {
    const gum = spyOn(navigator.mediaDevices, 'getUserMedia').and.resolveTo(new MediaStream());
    await component.start();
    expect(gum).toHaveBeenCalledWith({ video: true, audio: true });
    component.hangup();
  });

  it('enables Start only while idle and Hang up only while not idle', () => {
    fixture.detectChanges();
    const start: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="call-start"]');
    const hangup: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="call-hangup"]');
    expect(start.disabled).toBeFalse(); // idle
    expect(hangup.disabled).toBeTrue();
    component.state.set('connected');
    fixture.detectChanges();
    expect(start.disabled).toBeTrue();
    expect(hangup.disabled).toBeFalse();
  });

  it('transitions to "ringing" when an m.call.invite arrives for another sender', async () => {
    matrix.roomEvents.and.resolveTo([
      { event_id: '$inv', type: 'm.call.invite', sender: '@peer:test', content: { call_id: 'c1', offer: { type: 'offer', sdp: 'x' } } },
    ]);
    await (component as unknown as { pump(): Promise<void> }).pump();
    expect(component.state()).toBe('ringing');
  });

  it('returns to idle and stays idle after hang up', () => {
    component.state.set('connected');
    component.hangup();
    expect(component.state()).toBe('idle');
  });

  // ───────── HELP TEXT (disabled-control + contextual) ─────────
  describe('help text wiring', () => {
    it('wires each call button to present help and announces it as a live region', () => {
      const el = fixture.nativeElement as HTMLElement;
      expectDescribedByHelp(el, '[data-testid="call-start"]');
      expectDescribedByHelp(el, '[data-testid="call-join"]');
      expectDescribedByHelp(el, '[data-testid="call-hangup"]');
      const help = el.querySelector('[data-testid="call-help"]')!;
      expect(help.getAttribute('aria-live')).toBe('polite');
    });

    it('updates the contextual help copy as the call state changes', () => {
      // idle: explains Start; ringing: explains Join
      expect(component.callHelp.toLowerCase()).toContain('start call');
      component.state.set('ringing');
      fixture.detectChanges();
      expect(component.callHelp.toLowerCase()).toContain('join');
      const help = fixture.nativeElement.querySelector('[data-testid="call-help"]');
      expect(help.textContent.toLowerCase()).toContain('join');
    });
  });

  // ───────── ICE / TURN capability (host-only default, graceful degrade) ─────────
  describe('ICE / TURN wiring', () => {
    it('fetches the ICE servers ONCE on init (not per call)', () => {
      expect(matrix.turnServer).toHaveBeenCalledTimes(1);
    });

    it('appends the host/LAN-only capability note to callHelp when no TURN relay is configured (default)', () => {
      // Default stub resolves turnServer → [] (coturn dark), so the honesty note shows.
      expect(component.turnAvailable()).toBeFalse();
      expect(component.callHelp.toLowerCase()).toContain('host/lan-only');
      const help = fixture.nativeElement.querySelector('[data-testid="call-help"]');
      expect(help.textContent.toLowerCase()).toContain('host/lan-only');
    });

    it('FAIL-SOFT: rejected whoami/joinedRooms still complete init (ICE fetched, view degraded not dead)', async () => {
      // Regression pin: the identity/room-list awaits sit BEFORE the ICE fetch
      // in ngOnInit — unguarded, a BFF outage would skip the TURN probe and
      // the signalling poll and leave the call view dead instead of idle.
      matrix.whoami.and.rejectWith(new Error('bff down'));
      matrix.joinedRooms.and.rejectWith(new Error('bff down'));
      const fx = TestBed.createComponent(MatrixCallComponent);
      await fx.componentInstance.ngOnInit(); // must NOT reject
      // Reaching the poll arm is the proof init got PAST the identity/room
      // fetches to the ICE fetch + signalling loop at the end of ngOnInit.
      const priv = fx.componentInstance as unknown as { poll?: unknown; me(): string | null };
      const pollArmed = priv.poll;
      fx.componentInstance.ngOnDestroy();
      expect(priv.me()).toBeNull(); // identity degraded, not fatal
      expect(fx.componentInstance.room()).toBeNull(); // degraded: no room picked
      expect(pollArmed).toBeTruthy();
    });

    it('keeps the host/LAN-only capability note when NO room is resolved (the no-room help must not swallow it)', () => {
      // Regression pin: the offline e2e idle-state scenario opens /call with no
      // ?room= and still asserts the TURN honesty note — the capability caveat
      // is a deployment property, not a room property, so the no-room guidance
      // APPENDS it rather than early-returning past it.
      component.room.set(null);
      const help = component.callHelp.toLowerCase();
      expect(help).toContain('open this view from a room');
      expect(help).toContain('host/lan-only');
      expect(help).toContain('turn relay');
    });

    it('newPc() uses iceServers:[] when no TURN is configured — byte-identical host-only default', () => {
      const captured: RTCConfiguration[] = [];
      const RealPc = (window as any).RTCPeerConnection;
      spyOn(window as any, 'RTCPeerConnection').and.callFake(function (this: unknown, cfg: RTCConfiguration) {
        captured.push(cfg);
        return new RealPc(cfg);
      });
      const pc = (component as unknown as { newPc(): RTCPeerConnection }).newPc();
      pc.close();
      expect(captured.length).toBe(1);
      expect(captured[0].iceServers).toEqual([]);
    });
  });

  describe('ICE / TURN wiring (relay present)', () => {
    const RELAY: RTCIceServer[] = [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'p' }];

    beforeEach(async () => {
      matrix.turnServer.and.resolveTo(RELAY);
      // Re-init the component with the relay-present stub.
      fixture = TestBed.createComponent(MatrixCallComponent);
      component = fixture.componentInstance;
      await component.ngOnInit();
      component.ngOnDestroy();
      fixture.detectChanges();
    });

    it('marks TURN available and DROPS the host/LAN-only note when a relay is returned', () => {
      expect(component.turnAvailable()).toBeTrue();
      expect(component.callHelp.toLowerCase()).not.toContain('host/lan-only');
    });

    it('newPc() passes the fetched relay servers into the RTCPeerConnection (non-vacuous)', () => {
      const captured: RTCConfiguration[] = [];
      const RealPc = (window as any).RTCPeerConnection;
      spyOn(window as any, 'RTCPeerConnection').and.callFake(function (this: unknown, cfg: RTCConfiguration) {
        captured.push(cfg);
        return new RealPc(cfg);
      });
      const pc = (component as unknown as { newPc(): RTCPeerConnection }).newPc();
      pc.close();
      expect(captured.length).toBe(1);
      expect(captured[0].iceServers).toEqual(RELAY);
    });
  });
});

// ───────────────────────── VN VOICE MODE (?mode=vn-voice) ─────────────────────────

describe('MatrixCallComponent (VN voice mode)', () => {
  let fixture: ComponentFixture<MatrixCallComponent>;
  let component: MatrixCallComponent;
  let matrix: MatrixServiceStub;
  let packs: CharacterPackServiceStub;
  let sceneSvc: VnSceneStateServiceStub;

  /** Private-member accessor, matching the existing pump() cast convention. */
  const internals = () =>
    component as unknown as {
      pump(): Promise<void>;
      pumpSceneState(roomId: string): Promise<void>;
      resolveParticipantImage(userId: string, expression: string): Promise<string>;
      localSpeaking: { set(v: boolean): void };
      localOpenness: { set(v: number): void };
    };

  beforeEach(async () => {
    matrix = new MatrixServiceStub();
    packs = new CharacterPackServiceStub();
    sceneSvc = new VnSceneStateServiceStub();
    await TestBed.configureTestingModule({
      imports: [MatrixCallComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: CharacterPackService, useValue: packs },
        { provide: VnSceneStateService, useValue: sceneSvc },
        { provide: SceneService, useValue: new SceneServiceStub() },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ mode: 'vn-voice', room: '!call:test' }) } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MatrixCallComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    component.ngOnDestroy(); // stop the 1s signalling poll so the spec doesn't churn
    fixture.detectChanges();
    // Flush the fail-soft VN context chain (roster + sprite-image resolution).
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    fixture.detectChanges();
  });

  // ───────── mode selection ─────────

  it('parses ?mode=vn-voice and renders the VN STAGE instead of the video tiles', () => {
    expect(component.mode()).toBe('vn-voice');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="vn-call"]')).toBeTruthy();
    expect(el.querySelector('hug-vn-stage')).toBeTruthy();
    expect(el.querySelector('[data-testid="local-video"]')).toBeNull();
    expect(el.querySelector('[data-testid="remote-video"]')).toBeNull();
    // Honest region label + heading for the mode.
    expect(el.querySelector('[data-testid="call-view"]')!.getAttribute('aria-label'))
      .toBe('Visual novel voice chat');
  });

  it('mounts the scene controls (picker host) and a hidden remote-audio sink in-call', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="scene-tools"]')).toBeTruthy();
    expect(el.querySelector('hug-vn-scene-controls')).toBeTruthy();
    const audio = el.querySelector('[data-testid="remote-audio"]') as HTMLAudioElement;
    expect(audio).toBeTruthy();
    expect(audio.autoplay).toBeTrue();
  });

  it('start() requests the MICROPHONE ONLY — no camera permission in VN mode', async () => {
    const gum = spyOn(navigator.mediaDevices, 'getUserMedia').and.resolveTo(new MediaStream());
    await component.start();
    expect(gum).toHaveBeenCalledWith({ audio: true });
    component.hangup();
  });

  // ───────── signalling + scene + dialogue on the SAME 1Hz pump ─────────

  it('pump(): m.call signalling unchanged, and the SAME tick feeds scene state + dialogue', async () => {
    matrix.roomEvents.and.resolveTo([
      // dir=b: newest first — the message is newer than the invite.
      { event_id: '$msg', type: 'm.room.message', sender: '@peer:test', content: { msgtype: 'm.text', body: 'lol hello' } },
      { event_id: '$inv', type: 'm.call.invite', sender: '@peer:test', content: { call_id: 'c1', offer: { type: 'offer', sdp: 'x' } } },
    ]);
    sceneSvc.getModeratedSceneState.and.resolveTo({ sceneId: 'vn_scene_cafe', props: [] });

    await internals().pump();

    // The existing signalling contract still holds…
    expect(component.state()).toBe('ringing');
    // …the peer was identified for the stage…
    expect(component.remoteUserId()).toBe('@peer:test');
    // …the shared scene was pulled on the same tick…
    expect(component.sceneState()).toEqual({ sceneId: 'vn_scene_cafe', props: [] });
    // …and the newest m.room.message became the dialogue line (roster name).
    expect(component.dialogue()).toEqual(jasmine.objectContaining({
      eventId: '$msg', sender: '@peer:test', senderName: 'Peer', body: 'lol hello',
    }));
  });

  it('maps both call members onto the stage, with the message SENTIMENT as the sender expression', async () => {
    matrix.roomEvents.and.resolveTo([
      { event_id: '$msg', type: 'm.room.message', sender: '@peer:test', content: { msgtype: 'm.text', body: 'lol hello' } },
      { event_id: '$inv', type: 'm.call.invite', sender: '@peer:test', content: { call_id: 'c1', offer: { type: 'offer', sdp: 'x' } } },
    ]);
    await internals().pump();

    const cast = component.stageParticipants();
    expect(cast.length).toBe(2);
    expect(cast[0].userId).toBe('@me:test');
    expect(cast[1].userId).toBe('@peer:test');
    expect(cast[1].displayName).toBe('Peer');
    expect(cast[1].expression).toBe('happy'); // 'lol' → sentiment rule
    expect(cast[0].expression).toBe('neutral');
  });

  it('SPEAKING MAPPING: the detector-driven signals surface as the participant speaking/openness', () => {
    internals().localSpeaking.set(true);
    internals().localOpenness.set(0.5);
    const me = component.stageParticipants()[0];
    expect(me.speaking).toBeTrue();
    expect(me.openness).toBe(0.5);
  });

  it('renders the dialogue line into the stage dialogue box (typewriter node keyed per event)', () => {
    component.dialogue.set({ eventId: '$d1', sender: '@peer:test', senderName: 'Peer', body: 'On stage!', fullBody: 'On stage!' });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const line = el.querySelector('[data-testid="dialogue-line"]')!;
    expect(line).toBeTruthy();
    expect(el.querySelector('[data-testid="dialogue-sender"]')!.textContent).toContain('Peer');
    expect(el.querySelector('[data-testid="dialogue-text"]')!.textContent).toContain('On stage!');
    // Inside the stage's projected dialogue box, announced politely.
    expect(line.closest('[data-testid="dialogue-box"]')).toBeTruthy();
    expect(line.closest('[role="status"]')!.getAttribute('aria-live')).toBe('polite');
  });

  it('a LOCAL scene edit is optimistic and suppresses the remote poll for the grace window', async () => {
    const edited: VnSceneState = { sceneId: 'vn_scene_starship', props: [] };
    component.onSceneEdited(edited);
    expect(component.sceneState()).toEqual(edited);

    sceneSvc.getModeratedSceneState.calls.reset();
    await internals().pumpSceneState('!call:test');
    // Within the grace window the poll must NOT clobber the optimistic state.
    expect(sceneSvc.getModeratedSceneState).not.toHaveBeenCalled();
    expect(component.sceneState()).toEqual(edited);
  });

  // ───────── overflow limits on the 1Hz poll paths ─────────

  describe('poll-path limits', () => {
    it('clamps the RENDERED dialogue to MAX_DIALOGUE_CHARS=500 with an ellipsis, keeping the full body for title/aria', async () => {
      const long = 'a'.repeat(2_000);
      matrix.roomEvents.and.resolveTo([
        { event_id: '$long', type: 'm.room.message', sender: '@peer:test', content: { msgtype: 'm.text', body: long } },
      ]);
      await internals().pump();

      const line = component.dialogue()!;
      expect(line.body.length).toBe(501); // 500 chars + the ellipsis
      expect(line.body.endsWith('…')).toBeTrue();
      expect(line.fullBody).toBe(long); // untruncated original preserved

      fixture.detectChanges();
      const span = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="dialogue-text"]')!;
      expect(span.textContent!.length).toBe(501);
      expect(span.getAttribute('title')).toBe(long); // full text via tooltip
      expect(span.getAttribute('aria-label')).toBe(long); // and for SR users
    });

    it('a short dialogue body renders UNCLAMPED with no aria-label override (title still offered)', async () => {
      matrix.roomEvents.and.resolveTo([
        { event_id: '$s', type: 'm.room.message', sender: '@peer:test', content: { msgtype: 'm.text', body: 'short' } },
      ]);
      await internals().pump();
      expect(component.dialogue()!.body).toBe('short');
      fixture.detectChanges();
      const span = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="dialogue-text"]')!;
      expect(span.getAttribute('aria-label')).toBeNull();
    });

    it('caps the m.call dedupe set: ids that left the fetch window are pruned once past MAX_SEEN_EVENTS', async () => {
      const priv = component as unknown as { seen: Set<string> };
      // Simulate an hour-long call's accumulated ids (all outside the window).
      priv.seen = new Set(Array.from({ length: 2_500 }, (_, i) => `$old-${i}`));
      matrix.roomEvents.and.resolveTo([
        { event_id: '$fresh', type: 'm.call.candidate', sender: '@peer:test', content: { candidate: { candidate: 'c' } } },
      ]);
      await internals().pump();
      // Pruned to the ids still inside the window (+ the fresh one just seen).
      expect(priv.seen.size).toBeLessThanOrEqual(2);
      expect(priv.seen.has('$fresh')).toBeTrue();
    });

    it('bounds the queued remote ICE candidates at 64, dropping the OLDEST first', async () => {
      const priv = component as unknown as { remoteCands: RTCIceCandidateInit[] };
      matrix.roomEvents.and.resolveTo(
        Array.from({ length: 100 }, (_, i) => ({
          event_id: `$cand-${i}`,
          type: 'm.call.candidate',
          sender: '@peer:test',
          content: { candidate: { candidate: `cand-${i}` } },
        })),
      );
      await internals().pump(); // no pc yet ⇒ nothing flushes, all 100 queue up
      expect(priv.remoteCands.length).toBe(64);
      // The stub list is newest-first (dir=b); the reversal makes cand-99 the
      // FIRST queued (i.e. the oldest), so drop-oldest evicts it.
      expect(priv.remoteCands.some((c) => (c as { candidate?: string }).candidate === 'cand-99')).toBeFalse();
    });
  });

  // ───────── the sprite-image fallback chain (mocked services) ─────────

  describe('participant image fallback chain', () => {
    it('① sticker-pack frame wins when the sender has an active VN character', async () => {
      packs.resolveCharacterPack.and.resolveTo({
        images: { happy: { url: 'mxc://packs/happy' }, neutral: { url: 'mxc://packs/neutral' } },
        pack: {},
      } as UserEmotesPack);
      matrix.fetchMediaObjectUrl.and.resolveTo('blob:sticker-frame');

      const url = await internals().resolveParticipantImage('@peer:test', 'happy');
      expect(url).toBe('blob:sticker-frame');
      expect(matrix.fetchMediaObjectUrl).toHaveBeenCalledWith(
        'mxc://packs/happy', { thumbnail: true, w: 160, h: 160, method: 'scale' });
    });

    it('② falls back to the Matrix avatar when there is no pack', async () => {
      matrix.getProfile.and.resolveTo({ userId: '@peer:test', avatarUrl: 'mxc://avatars/peer' });
      matrix.fetchMediaObjectUrl.and.resolveTo('blob:avatar');

      const url = await internals().resolveParticipantImage('@peer:test', 'neutral');
      expect(url).toBe('blob:avatar');
      expect(matrix.fetchMediaObjectUrl).toHaveBeenCalledWith(
        'mxc://avatars/peer', { thumbnail: true, w: 160, h: 160, method: 'crop' });
    });

    it('③ falls back to the neutral SILHOUETTE when there is no pack and no avatar', async () => {
      const url = await internals().resolveParticipantImage('@nobody:test', 'neutral');
      expect(url).toBe(NEUTRAL_SILHOUETTE_URL);
      expect(url.startsWith('data:image/svg+xml')).toBeTrue();
      expect(matrix.fetchMediaObjectUrl).not.toHaveBeenCalled();
    });

    it('FAIL-SOFT: a throwing media fetch still lands on the silhouette, never a broken sprite', async () => {
      packs.resolveCharacterPack.and.resolveTo({
        images: { neutral: { url: 'mxc://packs/neutral' } }, pack: {},
      } as UserEmotesPack);
      matrix.fetchMediaObjectUrl.and.rejectWith(new Error('media down'));
      matrix.getProfile.and.rejectWith(new Error('profile down'));

      const url = await internals().resolveParticipantImage('@peer:test', 'neutral');
      expect(url).toBe(NEUTRAL_SILHOUETTE_URL);
    });

    it('a participant with nothing resolved renders with the silhouette on the stage', () => {
      component.remoteUserId.set('@peer:test');
      const cast = component.stageParticipants();
      expect(cast.every((p) => p.imgUrl.startsWith('data:image/svg+xml') || p.imgUrl.startsWith('blob:'))).toBeTrue();
    });
  });
});
