import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { MatrixService, TimelineEvent } from '../matrix.service';
import {
  Chat3dHostComponent, MAX_QUEUED_ENVELOPES, MAX_ROSTER_ENTRIES, bytesToBase64,
} from './chat3d-host.component';
import { CHAT3D_STATE_TYPE } from './chat3d-state.service';
import { CHAT3D_SCENE_TYPE } from './chat3d-scene.service';
import { CHAT3D_AVATAR_TYPE, Chat3dAvatarState } from './chat3d-avatar.service';
import { GAMES_BASE_URL, HostEnvelope, decodeAsGame } from './chat3d-bridge';
import { randomChar3dConfig } from './char3d-config';
import { MeshCallService } from './mesh-call.service';
import { FaceTrackService } from './face-track.service';
import { BLENDSHAPE_COUNT, JAW_OPEN_INDEX } from './av-channel';

const GAMES = 'http://games.test';

class MatrixStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@alice:test');
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt:1');
  roomState = jasmine.createSpy('roomState').and.resolveTo([]);
  getEvent = jasmine.createSpy('getEvent').and.rejectWith(new Error('not stubbed'));
  fetchMediaBytes = jasmine.createSpy('fetchMediaBytes').and.resolveTo(null);
  // The media panel (rendered when toggled open) probes these fail-soft.
  messages = jasmine.createSpy('messages').and.resolveTo({ events: [], start: '', end: '' });
  getThreads = jasmine.createSpy('getThreads').and.resolveTo({ events: [], start: '', end: '' });
  getPinnedEvents = jasmine.createSpy('getPinnedEvents').and.resolveTo([]);
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('');
}

/** The mesh surface the host drives — real signals, spied methods, assignable
 *  callbacks (the specs invoke them to emulate peer traffic). */
class MeshStub {
  active = signal(false);
  admitted = signal(true);
  turnAvailable = signal(true);
  meshWarning = signal(false);
  micLive = signal(false);
  micNote = signal('');
  staleInviteNote = signal('');
  peerStates = signal({});
  poseProvider: (() => unknown) | null = null;
  blendshapesProvider: (() => unknown) | null = null;
  onPeerPose: ((userId: string, pose: { x: number; z: number; yaw: number; seat: number }) => void) | null = null;
  onPeerOpenness: ((userId: string, openness: number) => void) | null = null;
  onPeerBlendshapes: ((userId: string, values: Uint8Array) => void) | null = null;
  onPeerSpeaking: ((userId: string, speaking: boolean) => void) | null = null;
  join = jasmine.createSpy('join').and.callFake(async () => {
    this.active.set(true);
  });
  leave = jasmine.createSpy('leave').and.resolveTo(undefined);
  setParticipants = jasmine.createSpy('setParticipants');
  setMaxParticipants = jasmine.createSpy('setMaxParticipants');
}

class FaceTrackStub {
  status = signal<'idle' | 'starting' | 'running' | 'unavailable'>('idle');
  delegate = signal<'GPU' | 'CPU' | null>(null);
  note = signal('');
  faceVisible = signal(false);
  blendshapes = signal<Float32Array | null>(null);
  quantized: { values: Uint8Array; ts: number } | null = null;
  latestQuantized = (): { values: Uint8Array; ts: number } | null => this.quantized;
  start = jasmine.createSpy('start').and.resolveTo(true);
  stop = jasmine.createSpy('stop');
}

function stateEvent(type: string, content: unknown, sender = '@mod:test', stateKey = ''): TimelineEvent {
  return { type, content, sender, stateKey, eventId: `$${type}${stateKey}`, roomId: '!r:test', originServerTs: 0 } as unknown as TimelineEvent;
}

const enabledConfig = (over: Record<string, unknown> = {}) =>
  stateEvent(CHAT3D_STATE_TYPE, { enabled: true, style: 'noir', maxParticipants: 8, allowMedia: true, stageModOnly: false, ...over });

const powerLevels = () =>
  stateEvent('m.room.power_levels', { users: { '@mod:test': 50 }, users_default: 0, state_default: 50, events: { [CHAT3D_SCENE_TYPE]: 0 } });

const avatarEvent = (owner: string, name: string) =>
  stateEvent(CHAT3D_AVATAR_TYPE, { v: 1, mode: 'guest', config: randomChar3dConfig(name), sticker: null, name }, owner, owner);

const memberEvent = (member: string, membership = 'join') =>
  stateEvent('m.room.member', { membership }, member, member);

/**
 * A room-state array as `/rooms/{id}/state` really returns it: the caller's
 * events PLUS a JOINED `m.room.member` row for me and for every avatar owner
 * that has none yet. The roster is membership-bound (departed/banned members
 * are not participants), so a fixture without membership rows is not a room —
 * a test that wants a DEPARTED member simply passes that member's own row.
 */
function roomState(...events: TimelineEvent[]): TimelineEvent[] {
  const stated = new Set(events.filter((e) => e.type === 'm.room.member').map((e) => e.stateKey));
  const implied = ['@alice:test', ...events.filter((e) => e.type === CHAT3D_AVATAR_TYPE).map((e) => e.stateKey ?? '')]
    .filter((m) => m && !stated.has(m));
  return [...new Set(implied)].map((m) => memberEvent(m)).concat(events);
}

const sceneEvent = (placements: unknown[]) =>
  stateEvent(CHAT3D_SCENE_TYPE, { placements }, '@member:test');

const placementRow = (surfaceId: string, label: string, kind = 'image') => ({ surfaceId, eventId: '$media1', kind, label });

const myAvatar = (): Chat3dAvatarState =>
  ({ mode: 'guest', config: randomChar3dConfig('me'), sticker: null, name: 'Guest me' });

describe('Chat3dHostComponent (iframe embed + §5 postMessage bridge, host side)', () => {
  let fixture: ComponentFixture<Chat3dHostComponent>;
  let component: Chat3dHostComponent;
  let matrix: MatrixStub;
  let mesh: MeshStub;
  let faceTrack: FaceTrackStub;
  let posted: HostEnvelope[];

  /** The embedded frame's contentWindow (the only legitimate message source). */
  function frameWindow(): Window {
    return fixture.nativeElement.querySelector('iframe').contentWindow;
  }

  /** Deliver a synthetic game→host message through the component chokepoint. */
  function deliver(data: unknown, origin = GAMES, source: unknown = frameWindow()): void {
    component.handleMessage(new MessageEvent('message', { data, origin, source: source as Window }));
  }

  async function create(events: TimelineEvent[], inputs: Partial<{ micEnabled: boolean; cameraEnabled: boolean }> = {}): Promise<void> {
    matrix.roomState.and.resolveTo(roomState(...events));
    fixture = TestBed.createComponent(Chat3dHostComponent);
    component = fixture.componentInstance;
    component.roomId = '!r:test';
    component.avatar = myAvatar();
    if (inputs.micEnabled !== undefined) {
      fixture.componentRef.setInput('micEnabled', inputs.micEnabled);
    }
    if (inputs.cameraEnabled !== undefined) {
      fixture.componentRef.setInput('cameraEnabled', inputs.cameraEnabled);
    }
    posted = [];
    spyOn(component, 'postToGame').and.callFake((env: HostEnvelope) => posted.push(env));
    fixture.detectChanges();
    // ngOnInit's chain is MANY promise hops deep (whoami → publishMyAvatar →
    // setStateEvent → initial pollOnce → roomState → getAvatarStates →
    // getModeratedSceneState). Each whenStable() round only re-queues the
    // test's continuation behind the chain's NEXT hop (room-settings mesh
    // precedent: "one whenStable() flakes, two is stable" for a 3-hop chain),
    // so settle with hop-count-plus-slack rounds — otherwise assertions race
    // the tail hops (queue still empty at deliver(ready), placements not yet
    // tracked, the avatar-publish rejection not yet noted).
    for (let i = 0; i < 10; i++) {
      await fixture.whenStable();
    }
    fixture.detectChanges();
  }

  beforeEach(() => {
    matrix = new MatrixStub();
    mesh = new MeshStub();
    faceTrack = new FaceTrackStub();
    TestBed.configureTestingModule({
      imports: [Chat3dHostComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: GAMES_BASE_URL, useValue: GAMES },
        { provide: MeshCallService, useValue: mesh },
        { provide: FaceTrackService, useValue: faceTrack },
      ],
    });
  });

  afterEach(() => fixture?.destroy());

  it('embeds the games wasm bundle in matrix mode with XR/mic/camera allow and NO sandbox', async () => {
    await create([enabledConfig()]);
    const iframe = fixture.nativeElement.querySelector('[data-testid="chat3d-frame"]');
    expect(iframe.getAttribute('src'))
      .toBe(`${GAMES}/_remotes/wasm-fragment/shadows-of-the-net/index.html?mode=matrix`
        + `&origin=${encodeURIComponent(window.location.origin)}`);
    expect(iframe.getAttribute('allow')).toBe('xr-spatial-tracking; microphone; camera; autoplay');
    // Godot needs full script execution — the isolation boundary is the
    // cross-origin iframe + origin-checked bridge, NOT a sandbox attribute.
    expect(iframe.hasAttribute('sandbox')).toBeFalse();
    expect(iframe.getAttribute('title')).toContain('Shadows of the Net');
  });

  it('REGRESSION: the frame URL carries ?origin= — the game shim has no other way '
     + 'to learn our origin (referrerpolicy=no-referrer kills its referrer fallback)', async () => {
    await create([enabledConfig()]);
    const iframe = fixture.nativeElement.querySelector('[data-testid="chat3d-frame"]');
    // no-referrer is deliberate (least leakage) — which is exactly why the
    // origin MUST travel in the query string instead.
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    const url = new URL(iframe.getAttribute('src'));
    expect(url.searchParams.get('mode')).toBe('matrix');
    expect(url.searchParams.get('origin')).toBe(window.location.origin);
    // A game shim that resolves no allowed origin disables postMessage in BOTH
    // directions, so an empty/absent origin param is a dead room.
    expect(url.searchParams.get('origin')).not.toBe('');
  });

  it('publishes MY avatar as room state (state_key = my mxid) on entry', async () => {
    await create([enabledConfig()]);
    expect(matrix.setStateEvent).toHaveBeenCalledWith(
      '!r:test', CHAT3D_AVATAR_TYPE,
      jasmine.objectContaining({ v: 1, mode: 'guest', name: 'Guest me' }),
      '@alice:test',
    );
    expect(component.avatarNote()).toBe('');
  });

  it('surfaces an honest note when the avatar publish is refused (silhouette warning)', async () => {
    matrix.setStateEvent.and.rejectWith(new Error('403'));
    await create([enabledConfig()]);
    fixture.detectChanges();
    expect(component.avatarNote().toLowerCase()).toContain('silhouette');
    expect(fixture.nativeElement.querySelector('[data-testid="chat3d-avatar-note"]')).toBeTruthy();
  });

  it('ORIGIN CHECK: drops a ready handshake from any non-games origin', async () => {
    await create([enabledConfig()]);
    deliver({ v: 1, t: 'ready' }, 'https://evil.test');
    expect(component.ready()).toBeFalse();
    deliver({ v: 1, t: 'ready' }, '');
    expect(component.ready()).toBeFalse();
  });

  it('SOURCE CHECK: drops a games-origin message that is not from OUR embedded frame', async () => {
    await create([enabledConfig()]);
    deliver({ v: 1, t: 'ready' }, GAMES, null);
    expect(component.ready()).toBeFalse();
    deliver({ v: 1, t: 'ready' }, GAMES, window); // some other window
    expect(component.ready()).toBeFalse();
  });

  it('drops malformed payloads even from the right origin+source', async () => {
    await create([enabledConfig()]);
    deliver({ t: 'ready' });               // no version
    deliver({ v: 1, t: 'selfDestruct' });  // unknown type
    deliver('ready');                      // not an object
    expect(component.ready()).toBeFalse();
    expect(posted.length).toBe(0);
  });

  it('READY HANDSHAKE: identifies the local player first, then flushes the queued world', async () => {
    await create([
      enabledConfig(), powerLevels(),
      avatarEvent('@bob:test', 'bob'),
      sceneEvent([placementRow('table-1', 'sunset', 'file')]),
    ]);
    // The initial poll ran before ready — everything queued, nothing posted.
    expect(posted.length).toBe(0);

    deliver({ v: 1, t: 'ready' });

    expect(component.ready()).toBeTrue();
    expect(posted[0]).toEqual(jasmine.objectContaining({ t: 'setLocal', userId: '@alice:test' }));
    const types = posted.map((e) => e['t']);
    expect(types).toContain('roster');
    expect(types).toContain('avatar');
    expect(types).toContain('placeMedia');
    // Decoded through the GAME's own argument mapping, never our field names.
    const roster = decodeAsGame(posted.find((e) => e['t'] === 'roster')!)!;
    expect(JSON.parse(roster[0] as string)).toEqual([{ userId: '@bob:test', name: 'bob' }]);
    const avatar = posted.find((e) => e['t'] === 'avatar')!;
    const avatarArgs = decodeAsGame(avatar)!;
    expect(avatarArgs[0]).toBe('@bob:test');
    expect(JSON.parse(avatarArgs[1] as string)).toEqual(randomChar3dConfig('bob'));
    expect(avatar['mode']).toBe('guest'); // extra (outside §5) billboard hint
    const place = decodeAsGame(posted.find((e) => e['t'] === 'placeMedia')!)!;
    expect(place[0]).toBe('table-1');
    expect(JSON.parse(place[1] as string)).toEqual({ eventId: '$media1', kind: 'file', label: 'sunset' });
    expect(place[2]).toBeNull(); // file kind = label plaque, no texture
  });

  it('DIFFS: an unchanged poll resends nothing; a removed placement sends clearMedia', async () => {
    await create([
      enabledConfig(), powerLevels(),
      avatarEvent('@bob:test', 'bob'),
      sceneEvent([placementRow('table-1', 'sunset', 'file')]),
    ]);
    deliver({ v: 1, t: 'ready' });
    const afterReady = posted.length;

    await component.pollOnce();
    expect(posted.length).toBe(afterReady); // nothing changed ⇒ nothing sent

    matrix.roomState.and.resolveTo(roomState(
      enabledConfig(), powerLevels(),
      avatarEvent('@bob:test', 'bob'),
      sceneEvent([]),
    ));
    await component.pollOnce();
    const clear = posted[posted.length - 1];
    expect(clear['t']).toBe('clearMedia');
    expect(decodeAsGame(clear)).toEqual(['table-1']);
  });

  it('shows the disabled note and pushes no WORLD when the room state stops parsing enabled', async () => {
    await create([enabledConfig({ enabled: false })]);
    deliver({ v: 1, t: 'ready' });
    await component.pollOnce();
    fixture.detectChanges();
    expect(component.disabledNote().toLowerCase()).toContain('disabled');
    expect(fixture.nativeElement.querySelector('[data-testid="chat3d-disabled-note"]')).toBeTruthy();
    // Nothing but the world-emptying calls — no roster/avatar/placeMedia.
    expect(posted.map((e) => e['t']).filter((t) => t !== 'setLocal' && t !== 'roster' && t !== 'clearMedia'))
      .toEqual([]);
  });

  it('REGRESSION: the moderator kill switch actually STOPS the live mic, camera and peer '
     + 'connections of everyone already inside — it is not just a notice', async () => {
    await create([
      enabledConfig(), powerLevels(),
      avatarEvent('@bob:test', 'bob'),
      sceneEvent([placementRow('table-1', 'sunset', 'file')]),
    ], { micEnabled: true, cameraEnabled: true });
    deliver({ v: 1, t: 'ready' });
    expect(mesh.leave).not.toHaveBeenCalled();
    expect(faceTrack.stop).not.toHaveBeenCalled();
    const before = posted.length;

    // A moderator unticks "Enable the 3D room" mid-session.
    matrix.roomState.and.resolveTo(roomState(
      enabledConfig({ enabled: false }), powerLevels(),
      avatarEvent('@bob:test', 'bob'),
      sceneEvent([placementRow('table-1', 'sunset', 'file')]),
    ));
    await component.pollOnce();
    fixture.detectChanges();

    // The mic capture, the camera tracker and every RTCPeerConnection are gone
    // (mesh.leave() sends the real m.call.hangup and clears the 1Hz/10Hz/15Hz
    // /30Hz timers) — previously they all stayed live for the tab's lifetime.
    expect(mesh.leave).toHaveBeenCalled();
    expect(faceTrack.stop).toHaveBeenCalled();
    // …and the note SAYS so rather than claiming only that nothing more loads.
    expect(component.disabledNote().toLowerCase()).toContain('microphone');
    // The world is blanked too: no ghost roster, no channel media left on the
    // surfaces of a room a moderator just switched off.
    const tail = posted.slice(before);
    expect(decodeAsGame(tail.find((e) => e['t'] === 'roster')!)![0]).toBe('[]');
    expect(decodeAsGame(tail.find((e) => e['t'] === 'clearMedia')!)).toEqual(['table-1']);

    // IDEMPOTENT: a room that stays disabled must not re-tear-down and re-push
    // an empty world on every 1Hz poll.
    const settled = posted.length;
    mesh.leave.calls.reset();
    await component.pollOnce();
    await component.pollOnce();
    expect(posted.length).toBe(settled);
    expect(mesh.leave).not.toHaveBeenCalled();
  });

  it('a re-ENABLED room brings the A/V legs back and re-pushes the whole world', async () => {
    await create([enabledConfig(), powerLevels(), avatarEvent('@bob:test', 'bob')], { cameraEnabled: true });
    deliver({ v: 1, t: 'ready' });
    matrix.roomState.and.resolveTo(roomState(enabledConfig({ enabled: false })));
    await component.pollOnce();
    mesh.join.calls.reset();
    faceTrack.start.calls.reset();

    matrix.roomState.and.resolveTo(roomState(enabledConfig(), powerLevels(), avatarEvent('@bob:test', 'bob')));
    const before = posted.length;
    await component.pollOnce();

    expect(component.disabledNote()).toBe('');
    expect(mesh.join).toHaveBeenCalled();
    expect(faceTrack.start).toHaveBeenCalled();
    // The diff baseline was dropped with the world, so bob is pushed again.
    const tail = posted.slice(before).map((e) => e['t']);
    expect(tail).toContain('roster');
    expect(tail).toContain('avatar');
  });

  it('vrState drives the VR badge; mediaActivate surfaces the placement label AND opens the media panel on it', async () => {
    await create([
      enabledConfig(), powerLevels(),
      sceneEvent([placementRow('screen-2', 'quarterly-report', 'file')]),
    ]);
    deliver({ v: 1, t: 'ready' });

    deliver({ v: 1, t: 'vrState', active: true });
    fixture.detectChanges();
    expect(component.vrActive()).toBeTrue();
    expect(fixture.nativeElement.querySelector('[data-testid="chat3d-vr-badge"]')).toBeTruthy();

    deliver({ v: 1, t: 'mediaActivate', surfaceId: 'screen-2' });
    fixture.detectChanges();
    expect(component.activatedLabel()).toBe('quarterly-report');
    expect(component.activatedPlacement()).toEqual(jasmine.objectContaining({ surfaceId: 'screen-2', eventId: '$media1' }));
    expect(component.mediaPanelOpen()).toBeTrue();
    expect(fixture.nativeElement.querySelector('[data-testid="chat3d-activated"]').textContent)
      .toContain('quarterly-report');
  });

  it('localPose is kept for the mesh broadcast (validated + clamped) and served by poseProvider', async () => {
    await create([enabledConfig()]);
    deliver({ v: 1, t: 'localPose', x: 1, z: 2, yaw: 0.25, seat: 4 });
    expect(component.lastLocalPose()).toEqual({ x: 1, z: 2, yaw: 0.25, seat: 4 });
    // The mesh's 10Hz pose tick reads exactly this via the provider the host wired.
    expect(mesh.poseProvider!()).toEqual({ x: 1, z: 2, yaw: 0.25, seat: 4 });
  });

  it('Enter VR posts ONLY once the game is ready (a queued enterVR would lose its user gesture)', async () => {
    await create([enabledConfig()]);
    const btn = fixture.nativeElement.querySelector('[data-testid="btn-chat3d-enter-vr"]');
    expect(btn.disabled).toBeTrue();
    component.enterVr();
    expect(posted.some((e) => e['t'] === 'enterVR')).toBeFalse();

    deliver({ v: 1, t: 'ready' });
    fixture.detectChanges();
    expect(btn.disabled).toBeFalse();
    component.enterVr();
    expect(posted[posted.length - 1]).toEqual(jasmine.objectContaining({ t: 'enterVR' }));
  });

  // ───────────────────── Stage 2: A/V mesh wiring ─────────────────────

  it('JOINS the A/V mesh on entry (always — the data channel is the only pose transport) with the mic choice', async () => {
    await create([enabledConfig()], { micEnabled: true });
    expect(mesh.join).toHaveBeenCalledWith('!r:test', '@alice:test', { micEnabled: true });
    await create([enabledConfig()], { micEnabled: false });
    expect(mesh.join).toHaveBeenCalledWith('!r:test', '@alice:test', { micEnabled: false });
  });

  it('feeds the avatar-state roster and the room cap into the mesh each poll', async () => {
    await create([
      enabledConfig({ maxParticipants: 5 }), powerLevels(),
      avatarEvent('@bob:test', 'bob'), avatarEvent('@carol:test', 'carol'),
    ]);
    expect(mesh.setMaxParticipants).toHaveBeenCalledWith(5);
    expect(mesh.setParticipants).toHaveBeenCalledWith(['@bob:test', '@carol:test']);
  });

  it('REGRESSION: a member who LEFT or was BANNED is not a 3D participant — no ghost in the '
     + 'roster, no ghost in the mesh, no ghost holding an admission seat', async () => {
    await create([
      enabledConfig({ maxParticipants: 2 }), powerLevels(),
      memberEvent('@bob:test', 'leave'),
      memberEvent('@carol:test', 'ban'),
      avatarEvent('@bob:test', 'bob'),
      avatarEvent('@carol:test', 'carol'),
      avatarEvent('@dave:test', 'dave'),
    ]);
    deliver({ v: 1, t: 'ready' });

    // Nothing retracts a departed member's avatar for them and Matrix keeps the
    // state row, so without the membership bind @bob + @carol sort ahead of
    // @dave, fill both admission seats forever, and keep rendering in the scene.
    expect(mesh.setParticipants).toHaveBeenCalledWith(['@dave:test']);
    const roster = JSON.parse(decodeAsGame(posted.find((e) => e['t'] === 'roster')!)![0] as string);
    expect(roster).toEqual([{ userId: '@dave:test', name: 'dave' }]);
    expect(posted.filter((e) => e['t'] === 'avatar').map((e) => e['userId'])).toEqual(['@dave:test']);
  });

  it('REGRESSION: the roster push is CAPPED — a huge channel where everyone once entered '
     + 'cannot push hundreds of ≤8KB avatar envelopes into the iframe', async () => {
    const many = Array.from({ length: MAX_ROSTER_ENTRIES + 40 }, (_, i) =>
      avatarEvent(`@u${String(i).padStart(3, '0')}:test`, `u${i}`));
    await create([enabledConfig(), powerLevels(), ...many]);
    deliver({ v: 1, t: 'ready' });

    const roster = JSON.parse(decodeAsGame(posted.find((e) => e['t'] === 'roster')!)![0] as string);
    expect(roster.length).toBe(MAX_ROSTER_ENTRIES);
    expect(posted.filter((e) => e['t'] === 'avatar').length).toBe(MAX_ROSTER_ENTRIES);
    // Deterministic prefix of the sorted mxids, so every client picks the SAME
    // set — a per-client selection would desync who can see whom.
    expect(roster[0].userId).toBe('@u000:test');
    expect(roster[MAX_ROSTER_ENTRIES - 1].userId).toBe(`@u${String(MAX_ROSTER_ENTRIES - 1).padStart(3, '0')}:test`);
    expect((mesh.setParticipants.calls.mostRecent().args[0] as string[]).length).toBe(MAX_ROSTER_ENTRIES);
  });

  it('MY OWN row survives the roster cap even when my mxid sorts past it', async () => {
    // @alice sorts after every @u… mxid, so the plain prefix would drop me and
    // I would never see my own character in the room.
    const many = Array.from({ length: MAX_ROSTER_ENTRIES + 5 }, (_, i) =>
      avatarEvent(`@0u${String(i).padStart(3, '0')}:test`, `u${i}`));
    await create([enabledConfig(), powerLevels(), ...many, avatarEvent('@alice:test', 'me')]);
    deliver({ v: 1, t: 'ready' });

    const roster = JSON.parse(decodeAsGame(posted.find((e) => e['t'] === 'roster')!)![0] as string);
    expect(roster.map((r: { userId: string }) => r.userId)).toContain('@alice:test');
  });

  it('REGRESSION: leaving the view RETRACTS my avatar so I stop holding a 3D seat', async () => {
    await create([enabledConfig()]);
    matrix.setStateEvent.calls.reset();
    fixture.destroy();
    // Empty content = the retract; every receiver's strict parse drops it.
    expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', CHAT3D_AVATAR_TYPE, {}, '@alice:test');
  });

  it('relays peer traffic INTO the game: pose, openness, blendshapes (base64), speaking', async () => {
    await create([enabledConfig()]);
    deliver({ v: 1, t: 'ready' });
    const before = posted.length;

    mesh.onPeerPose!('@bob:test', { x: 1, z: -2, yaw: 0.5, seat: 3 });
    mesh.onPeerOpenness!('@bob:test', 0.4);
    const vec = new Uint8Array(BLENDSHAPE_COUNT);
    vec[JAW_OPEN_INDEX] = 200;
    mesh.onPeerBlendshapes!('@bob:test', vec);
    mesh.onPeerSpeaking!('@bob:test', true);

    const tail = posted.slice(before);
    expect(tail.map((e) => e['t'])).toEqual(['pose', 'openness', 'blendshapes', 'speaking']);
    expect(decodeAsGame(tail[0])).toEqual(['@bob:test', 1, -2, 0.5, 3]);
    expect(decodeAsGame(tail[1])).toEqual(['@bob:test', 0.4]);
    const blend = decodeAsGame(tail[2])!;
    expect(blend[0]).toBe('@bob:test');
    expect(atob(String(blend[1])).charCodeAt(JAW_OPEN_INDEX)).toBe(200);
    expect(decodeAsGame(tail[3])).toEqual(['@bob:test', true]);
  });

  it('peer traffic arriving BEFORE the ready handshake queues instead of dropping', async () => {
    await create([enabledConfig()]);
    mesh.onPeerSpeaking!('@bob:test', true);
    expect(posted.length).toBe(0);
    deliver({ v: 1, t: 'ready' });
    const speaking = posted.filter((e) => e['t'] === 'speaking').map((e) => decodeAsGame(e)!);
    expect(speaking.some((a) => a[0] === '@bob:test' && a[1] === true)).toBeTrue();
  });

  it('REGRESSION: the pre-handshake queue COALESCES per (call, subject) instead of '
     + 'growing without bound while the game is silent', async () => {
    await create([enabledConfig()]);
    // The 10-30Hz motion ticks would otherwise pile up one envelope each for as
    // long as the handshake is missing — a whole-session leak on the failure path.
    for (let i = 0; i < 5_000; i++) {
      mesh.onPeerPose!('@bob:test', { x: i, z: 0, yaw: 0, seat: 1 });
      mesh.onPeerOpenness!('@bob:test', (i % 100) / 100);
    }
    expect(posted.length).toBe(0);

    deliver({ v: 1, t: 'ready' });
    const poses = posted.filter((e) => e['t'] === 'pose');
    const openness = posted.filter((e) => e['t'] === 'openness');
    expect(poses.length).toBe(1);
    expect(openness.length).toBe(1);
    // …and the value replayed is the NEWEST, not the oldest.
    expect(decodeAsGame(poses[0])![1]).toBe(4_999);
  });

  it('REGRESSION: the pre-handshake queue is HARD-CAPPED across distinct subjects — '
     + 'coalescing alone does not bound it', async () => {
    await create([enabledConfig()]);
    // Coalescing bounds the queue only per (call, subject). The subject space
    // is NOT fixed: peers enter and leave the 3D view for as long as the
    // handshake is missing, so `pose|@userN` keys accumulate one per mxid ever
    // seen — in a large channel that is the whole membership. The cap is the
    // only thing standing between a silent game and a session-long leak.
    const subjects = MAX_QUEUED_ENVELOPES * 3;
    for (let i = 0; i < subjects; i++) {
      mesh.onPeerPose!(`@peer${i}:test`, { x: i, z: 0, yaw: 0, seat: 1 });
    }
    expect(posted.length).toBe(0);

    deliver({ v: 1, t: 'ready' });
    // +1 = the setLocal the handshake sends before the flush.
    expect(posted.length).toBeLessThanOrEqual(MAX_QUEUED_ENVELOPES + 1);
    // The cap must really have BITTEN — otherwise this test would still pass
    // with the cap deleted (all 768 would simply be replayed).
    expect(posted.length).toBeLessThan(subjects);
    // Eviction is oldest-first, so the NEWEST subjects are the ones kept: the
    // queue must not degrade into "the first N mxids, forever".
    const kept = posted.filter((e) => e['t'] === 'pose').map((e) => decodeAsGame(e)![0]);
    expect(kept).toContain(`@peer${subjects - 1}:test`);
    expect(kept).not.toContain('@peer0:test');
  });

  it('REGRESSION: a game that never sends `ready` but DOES emit still unblocks the room '
     + '(the game re-announces only a bounded number of times)', async () => {
    await create([
      enabledConfig(), powerLevels(),
      avatarEvent('@bob:test', 'bob'),
    ]);
    expect(posted.length).toBe(0);
    expect(component.ready()).toBeFalse();

    // localPose is the ~10Hz callback the game emits for the whole session; it
    // can only exist once the in-frame shim installed and origin-matched.
    deliver({ v: 1, t: 'localPose', x: 1, z: 2, yaw: 0, seat: 0 });

    expect(component.ready()).toBeTrue();
    expect(posted[0]).toEqual(jasmine.objectContaining({ t: 'setLocal' }));
    expect(posted.map((e) => e['t'])).toContain('roster');
    expect(posted.map((e) => e['t'])).toContain('avatar');
  });

  it('starts the opt-in camera tracker ONLY when the join menu asked for it', async () => {
    await create([enabledConfig()], { cameraEnabled: false });
    expect(faceTrack.start).not.toHaveBeenCalled();
    await create([enabledConfig()], { cameraEnabled: true });
    expect(faceTrack.start).toHaveBeenCalled();
    // And the mesh's 15Hz broadcast reads the tracker through the provider.
    faceTrack.quantized = { values: new Uint8Array(BLENDSHAPE_COUNT), ts: 42 };
    expect(mesh.blendshapesProvider!()).toEqual({ values: new Uint8Array(BLENDSHAPE_COUNT), ts: 42 });
  });

  it('MY live face drives MY avatar in the game (desktop-first: local blendshapes envelope)', async () => {
    await create([enabledConfig()], { cameraEnabled: true });
    deliver({ v: 1, t: 'ready' });
    const before = posted.length;
    const raw = new Float32Array(BLENDSHAPE_COUNT);
    raw[JAW_OPEN_INDEX] = 1;
    faceTrack.quantized = { values: new Uint8Array(BLENDSHAPE_COUNT).fill(0), ts: 7 };
    faceTrack.quantized.values[JAW_OPEN_INDEX] = 255;
    faceTrack.blendshapes.set(raw);
    fixture.detectChanges(); // flush the effect
    const mine = posted.slice(before)
      .filter((e) => e['t'] === 'blendshapes')
      .map((e) => decodeAsGame(e)!)
      .find((a) => a[0] === '@alice:test')!;
    expect(mine).toBeDefined();
    expect(atob(String(mine[1])).charCodeAt(JAW_OPEN_INDEX)).toBe(255);
  });

  it('TEXTURE BYTES: an image placement posts real fetched bytes; video posts its poster thumbnail', async () => {
    matrix.getEvent.and.resolveTo({ eventId: '$media1', content: { url: 'mxc://t/pic' } } as TimelineEvent);
    matrix.fetchMediaBytes.and.resolveTo(new Uint8Array([9, 9, 9]).buffer);
    await create([
      enabledConfig(), powerLevels(),
      sceneEvent([placementRow('table-1', 'sunset', 'image')]),
    ]);
    deliver({ v: 1, t: 'ready' });
    const place = decodeAsGame(posted.find((e) => e['t'] === 'placeMedia')!)!;
    // BASE64, not an ArrayBuffer: the game JSON.stringify()s its inbound queue.
    expect(typeof place[2]).toBe('string');
    expect(place[2]).toBe(bytesToBase64(new Uint8Array([9, 9, 9]).buffer));
    expect(atob(place[2] as string).split('').map((c) => c.charCodeAt(0))).toEqual([9, 9, 9]);
    expect(matrix.fetchMediaBytes).toHaveBeenCalledWith('mxc://t/pic');

    // Video v1 = poster frame: the thumbnail endpoint, not the full file.
    matrix.roomState.and.resolveTo(roomState(
      enabledConfig(), powerLevels(),
      sceneEvent([placementRow('screen-1', 'clip', 'video')]),
    ));
    matrix.getEvent.and.resolveTo({ eventId: '$media1', content: { url: 'mxc://t/vid' } } as TimelineEvent);
    await component.pollOnce();
    expect(matrix.fetchMediaBytes).toHaveBeenCalledWith('mxc://t/vid', { thumbnail: true, w: 640, h: 360, method: 'scale' });
  });

  it('TEXTURE BYTES fail-soft: an unfetchable image degrades to a label plaque (bytes null)', async () => {
    matrix.getEvent.and.rejectWith(new Error('gone'));
    await create([
      enabledConfig(), powerLevels(),
      sceneEvent([placementRow('table-1', 'sunset', 'image')]),
    ]);
    deliver({ v: 1, t: 'ready' });
    const place = decodeAsGame(posted.find((e) => e['t'] === 'placeMedia')!)!;
    expect(place[2]).toBeNull();
    expect(JSON.parse(place[1] as string)).toEqual(jasmine.objectContaining({ label: 'sunset' }));
  });

  it('HONEST A/V notes: dark TURN, refused mic, mesh strain and a full mesh each say WHY', async () => {
    await create([enabledConfig()], { micEnabled: true });
    fixture.detectChanges();
    expect(component.avNotes()).toEqual([]); // all capabilities live ⇒ silence

    mesh.turnAvailable.set(false);
    mesh.micNote.set('Microphone unavailable or refused — you are in the room listen-only.');
    mesh.meshWarning.set(true);
    mesh.admitted.set(false);
    mesh.staleInviteNote.set('A voice invitation was ignored because it was too old — check your device clock.');
    fixture.detectChanges();
    const notes = component.avNotes().join(' | ').toLowerCase();
    expect(notes).toContain('host/lan-only');
    expect(notes).toContain('listen-only');
    expect(notes).toContain('8 participants');
    expect(notes).toContain('full');
    // A dropped-as-stale invite is otherwise INVISIBLE: the member sits in a
    // silent room with no idea their clock (or a replaying peer) is the cause.
    expect(notes).toContain('too old');
    const rendered = fixture.nativeElement.querySelectorAll('[data-testid="chat3d-av-note"]');
    expect(rendered.length).toBe(5);
  });

  it('camera notes surface only when the camera was requested', async () => {
    await create([enabledConfig()], { cameraEnabled: false });
    faceTrack.note.set('Face tracking failed to load — your avatar\'s mouth follows your voice instead.');
    fixture.detectChanges();
    expect(component.avNotes()).toEqual([]);
    await create([enabledConfig()], { cameraEnabled: true });
    faceTrack.note.set('Face tracking failed to load — your avatar\'s mouth follows your voice instead.');
    fixture.detectChanges();
    expect(component.avNotes().join(' ').toLowerCase()).toContain('face tracking failed');
  });

  it('tears the A/V stack down on destroy (mesh hangups + camera off)', async () => {
    await create([enabledConfig()], { cameraEnabled: true });
    fixture.destroy();
    expect(mesh.leave).toHaveBeenCalled();
    expect(faceTrack.stop).toHaveBeenCalled();
  });

  it('the media panel toggle renders the channel-media panel beside the frame', async () => {
    await create([enabledConfig()]);
    expect(fixture.nativeElement.querySelector('hug-chat3d-media-panel')).toBeNull();
    fixture.nativeElement.querySelector('[data-testid="btn-chat3d-media-panel"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('hug-chat3d-media-panel')).toBeTruthy();
  });
});
