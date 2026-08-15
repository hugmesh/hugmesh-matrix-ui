import { Component, Input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { MatrixService, Paginated, TimelineEvent } from '../matrix.service';
import { RoomMediaPanelComponent } from './room-media-panel.component';
import { Chat3dState } from './chat3d-state.service';
import { Chat3dJoinComponent } from './chat3d-join.component';
import { CharacterPackService } from '../vn/character-pack.service';
import { CharacterForgeBffService } from './character-forge-bff.service';
import { GAMES_BASE_URL } from './chat3d-bridge';
import { MeshCallService } from './mesh-call.service';
import { FaceTrackService } from './face-track.service';
import { signal } from '@angular/core';

/**
 * FEDERATION GUARD for the chat3d surface's in-app links.
 *
 * The defect (operator report 2026-08-14, same class as 1337ed2): the chat3d
 * templates used ABSOLUTE `['/rooms', …]` router links. Under the host shell the
 * injected Router is the SHELL's, whose root is `/`, so `/rooms/<id>` matches no
 * shell route and the shell's fallback bounces the user to `/user` — clicking
 * "Back to room" or "View thread" left Matrix entirely. Standalone it looked
 * fine, because there the remote's own router owns `/`.
 *
 * This spec mounts the remote under a NESTED path (`/social/matrix`, exactly how
 * the shell mounts it) with a REAL router, so an absolute link and a
 * mount-relative link produce DIFFERENT hrefs — which is what makes the
 * assertion able to fail. A regression to `['/rooms', …]` renders
 * `/rooms/!r:test/...` and the expectation below breaks.
 */

const ROOM = '!r:test';
const MOUNT = '/social/matrix';

function page(events: TimelineEvent[], end = ''): Paginated {
  return { events, start: '', end };
}

class MatrixStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  messages = jasmine.createSpy('messages').and.resolveTo(page([]));
  getThreads = jasmine.createSpy('getThreads').and.resolveTo(page([{
    eventId: '$t1', roomId: ROOM, type: 'm.room.message', sender: '@bob:test',
    originServerTs: 0, msgtype: 'm.text', body: 'a thread root', content: { msgtype: 'm.text', body: 'a thread root' },
  } as unknown as TimelineEvent]));
  getPinnedEvents = jasmine.createSpy('getPinnedEvents').and.resolveTo([]);
  getEvent = jasmine.createSpy('getEvent').and.rejectWith(new Error('not found'));
  getStateEvent = jasmine.createSpy('getStateEvent').and.callFake(
    async (_r: string, type: string) => (type === 'm.room.power_levels'
      ? { users: { '@me:test': 0 }, users_default: 0, state_default: 50, events: { 'net.hugmesh.chat3d.scene': 0 } }
      : null));
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt');
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('blob:fake-url');
}

const enabledConfig: Chat3dState = {
  enabled: true, style: 'noir', maxParticipants: 8, allowMedia: true, stageModOnly: false,
};

/** A stand-in for the routed chat3d page: it exists only so the media panel is
 *  rendered UNDER the remote's mount, the way the host component renders it. */
@Component({
  selector: 'hug-chat3d-route-stub',
  standalone: true,
  imports: [RoomMediaPanelComponent],
  template: `<hug-chat3d-media-panel [roomId]="roomId" [config]="config"></hug-chat3d-media-panel>`,
})
class Chat3dRouteStubComponent {
  @Input() roomId = ROOM;
  config: Chat3dState | null = enabledConfig;
}

describe('chat3d in-app links (mount-relative under the host shell)', () => {
  let matrix: MatrixStub;

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [
        // The remote's routes, mounted where the SHELL mounts them.
        provideRouter([
          {
            path: 'social/matrix',
            children: [
              { path: 'rooms/:roomId/chat3d', component: Chat3dRouteStubComponent },
              { path: 'rooms/:roomId', component: Chat3dRouteStubComponent },
              { path: 'rooms/:roomId/thread/:eventId', component: Chat3dRouteStubComponent },
            ],
          },
        ]),
        { provide: MatrixService, useValue: matrix },
      ],
    });
  });

  it('the channel-media THREAD link stays inside the remote mount', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`${MOUNT}/rooms/${ROOM}/chat3d`, Chat3dRouteStubComponent);
    for (let i = 0; i < 8; i++) {
      await harness.fixture.whenStable();
    }
    harness.detectChanges();

    const link: HTMLAnchorElement | null =
      harness.routeNativeElement!.querySelector('[data-testid="media-item-thread-link-$t1"]');
    expect(link).withContext('the thread link must render for a thread root').toBeTruthy();

    // MOUNT-RELATIVE: ['rooms', roomId, 'thread', eventId] + [relativeTo]="mount".
    // The ABSOLUTE form the bug shipped would render '/rooms/!r:test/thread/$t1'
    // — off the remote entirely, straight into the shell's /user fallback.
    expect(link!.getAttribute('href')).toBe(`${MOUNT}/rooms/${ROOM}/thread/$t1`);
    expect(link!.getAttribute('href')!.startsWith(`${MOUNT}/`)).toBeTrue();
  });
});

/** The A/V collaborators the embedded host would start — stubbed so a unit spec
 *  never reaches getUserMedia (same reasoning as chat3d-join.component.spec.ts). */
class MeshStub {
  active = signal(false);
  admitted = signal(true);
  turnAvailable = signal(true);
  meshWarning = signal(false);
  micLive = signal(false);
  micNote = signal('');
  staleInviteNote = signal('');
  peerStates = signal({});
  poseProvider: unknown = null;
  blendshapesProvider: unknown = null;
  onPeerPose: unknown = null;
  onPeerOpenness: unknown = null;
  onPeerBlendshapes: unknown = null;
  onPeerSpeaking: unknown = null;
  join = jasmine.createSpy('join').and.resolveTo(undefined);
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
  latestQuantized = (): null => null;
  start = jasmine.createSpy('start').and.resolveTo(true);
  stop = jasmine.createSpy('stop');
}

describe('chat3d join menu "Back to room" (mount-relative under the host shell)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'social/matrix',
            children: [
              { path: 'rooms/:roomId/chat3d', component: Chat3dJoinComponent },
              { path: 'rooms/:roomId', component: Chat3dRouteStubComponent },
            ],
          },
        ]),
        {
          provide: MatrixService,
          useValue: {
            whoami: jasmine.createSpy('whoami').and.resolveTo('@alice:test'),
            getStateEvent: jasmine.createSpy('getStateEvent').and.resolveTo(enabledConfig),
            setStateEvent: jasmine.createSpy('setStateEvent').and.resolveTo('$evt:1'),
            roomState: jasmine.createSpy('roomState').and.resolveTo([]),
          },
        },
        { provide: CharacterForgeBffService, useValue: { getActiveCharacter: jasmine.createSpy('getActiveCharacter').and.resolveTo(null) } },
        {
          provide: CharacterPackService,
          useValue: {
            resolveCharacterPack: jasmine.createSpy('resolveCharacterPack').and.resolveTo(null),
            imageFor: jasmine.createSpy('imageFor').and.returnValue(null),
          },
        },
        { provide: MeshCallService, useValue: new MeshStub() },
        { provide: FaceTrackService, useValue: new FaceTrackStub() },
        { provide: GAMES_BASE_URL, useValue: 'http://games.test' },
      ],
    });
  });

  it('resolves the back link against the remote mount, not the shell root', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`${MOUNT}/rooms/${ROOM}/chat3d`, Chat3dJoinComponent);
    for (let i = 0; i < 10; i++) {
      await harness.fixture.whenStable();
    }
    harness.detectChanges();

    const back: HTMLAnchorElement | null =
      harness.routeNativeElement!.querySelector('[data-testid="btn-chat3d-join-back"]');
    expect(back).withContext('the back link renders once the room id is known').toBeTruthy();
    // The absolute ['/rooms', rid] form would render '/rooms/!r:test'.
    expect(back!.getAttribute('href')).toBe(`${MOUNT}/rooms/${ROOM}`);
  });

  it('the EMBEDDED ROOM HOST back link is mount-relative too', async () => {
    const harness = await RouterTestingHarness.create();
    const join = await harness.navigateByUrl(`${MOUNT}/rooms/${ROOM}/chat3d`, Chat3dJoinComponent);
    for (let i = 0; i < 10; i++) {
      await harness.fixture.whenStable();
    }
    harness.detectChanges();

    // Entering swaps the menu for the real Chat3dHostComponent (A/V stubbed).
    join.guestSeed = 'motoko';
    join.enter();
    harness.detectChanges();
    for (let i = 0; i < 10; i++) {
      await harness.fixture.whenStable();
    }
    harness.detectChanges();

    const host = harness.routeNativeElement!.querySelector('[data-testid="chat3d-host"]');
    expect(host).withContext('enter() renders the embedded host').toBeTruthy();
    const back: HTMLAnchorElement | null =
      harness.routeNativeElement!.querySelector('[data-testid="btn-chat3d-back"]');
    expect(back).toBeTruthy();
    expect(back!.getAttribute('href')).toBe(`${MOUNT}/rooms/${ROOM}`);
  });
});
