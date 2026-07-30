import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { MatrixService } from '../matrix.service';
import { CharacterPackService } from '../vn/character-pack.service';
import { Chat3dJoinComponent } from './chat3d-join.component';
import { CharacterForgeBffService } from './character-forge-bff.service';
import { GAMES_BASE_URL } from './chat3d-bridge';
import { MeshCallService } from './mesh-call.service';
import { FaceTrackService } from './face-track.service';
import { randomChar3dConfig } from './char3d-config';

class MatrixStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@alice:test');
  // Chat3dStateService rides this: default = enabled room.
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo({
    enabled: true, style: 'noir', maxParticipants: 8, allowMedia: true, stageModOnly: true,
  });
  // The embedded host (after enter()) needs these:
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt:1');
  roomState = jasmine.createSpy('roomState').and.resolveTo([]);
}

class ForgeStub {
  getActiveCharacter = jasmine.createSpy('getActiveCharacter').and.resolveTo(null);
}

/**
 * The A/V collaborators the embedded host starts on enter().
 *
 * These MUST be stubbed here. `enter()` renders the real Chat3dHostComponent,
 * whose startAv() calls MeshCallService.join() (→ getUserMedia({audio})) and
 * FaceTrackService.start() (→ getUserMedia({video}) + MediaPipe) — real device
 * access from a unit spec. It used to be "safe" only by accident: MatrixStub
 * has no turnServer(), so join() threw a TypeError before reaching the mic and
 * left an unhandled rejection in the log. join() is fail-soft about that now,
 * so the accident is gone and the stubs are what keeps the camera shut.
 */
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

class PackStub {
  resolveCharacterPack = jasmine.createSpy('resolveCharacterPack').and.resolveTo(null);
  imageFor = jasmine.createSpy('imageFor').and.callFake(
    (pack: { images: Record<string, { url: string }> } | null, expr: string) => pack?.images?.[expr] ?? null);
}

describe('Chat3dJoinComponent (3D-room join menu)', () => {
  let fixture: ComponentFixture<Chat3dJoinComponent>;
  let component: Chat3dJoinComponent;
  let matrix: MatrixStub;
  let forge: ForgeStub;
  let packs: PackStub;
  let mesh: MeshStub;
  let faceTrack: FaceTrackStub;

  /** Settle the embedded host's own ngOnInit chain (whoami → publishMyAvatar →
   *  setStateEvent → startAv), which is several promise hops past enter(). */
  async function settle(): Promise<void> {
    fixture.detectChanges();
    for (let i = 0; i < 10; i++) {
      await fixture.whenStable();
    }
    fixture.detectChanges();
  }

  async function create(): Promise<void> {
    fixture = TestBed.createComponent(Chat3dJoinComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    // load() is MANY promise hops deep (paramMap → getChat3dState →
    // getStateEvent → whoami → getActiveCharacter → resolveCharacterPack →
    // imageFor). Each whenStable() round only re-queues the test's
    // continuation behind the chain's NEXT hop (room-settings mesh precedent:
    // "one whenStable() flakes, two is stable" for a 3-hop chain), so settle
    // with hop-count-plus-slack rounds — otherwise assertions race the tail
    // hops (source still 'guest', probe results not yet rendered).
    for (let i = 0; i < 10; i++) {
      await fixture.whenStable();
    }
    fixture.detectChanges();
  }

  beforeEach(() => {
    matrix = new MatrixStub();
    forge = new ForgeStub();
    packs = new PackStub();
    mesh = new MeshStub();
    faceTrack = new FaceTrackStub();
    TestBed.configureTestingModule({
      imports: [Chat3dJoinComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: CharacterForgeBffService, useValue: forge },
        { provide: CharacterPackService, useValue: packs },
        { provide: MeshCallService, useValue: mesh },
        { provide: FaceTrackService, useValue: faceTrack },
        { provide: GAMES_BASE_URL, useValue: 'http://games.test' },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ roomId: '!r:test' })) } },
      ],
    });
  });

  afterEach(() => fixture?.destroy());

  it('DEEP-LINK HONESTY: a disabled room explains itself and offers no join controls', async () => {
    matrix.getStateEvent.and.resolveTo({ enabled: false });
    await create();
    const el = fixture.nativeElement;
    expect(el.querySelector('[data-testid="chat3d-join-disabled"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="chat3d-join-disabled"]').textContent).toContain('not enabled');
    expect(el.querySelector('[data-testid="chat3d-source"]')).toBeNull();
    expect(el.querySelector('[data-testid="btn-chat3d-enter"]')).toBeNull();
    // No source probes for a closed door.
    expect(forge.getActiveCharacter).not.toHaveBeenCalled();
  });

  it('defaults to the FORGE source when an active character exists, showing its name', async () => {
    forge.getActiveCharacter.and.resolveTo({ name: 'Vex', definition: randomChar3dConfig('vex') });
    await create();
    expect(component.source).toBe('forge');
    const el = fixture.nativeElement;
    expect(el.querySelector('[data-testid="chat3d-forge-name"]').textContent).toContain('Vex');
    expect(el.querySelector('[data-testid="input-source-forge"]').disabled).toBeFalse();
    expect(el.querySelector('[data-testid="chat3d-forge-why"]')).toBeNull();
  });

  it('falls back to BILLBOARD when forge is dark but a sticker pack exists — forge greyed with WHY', async () => {
    packs.resolveCharacterPack.and.resolveTo({ images: { neutral: { url: 'mxc://t/neutral' } }, pack: {} });
    await create();
    expect(component.source).toBe('billboard');
    const el = fixture.nativeElement;
    const forgeRadio = el.querySelector('[data-testid="input-source-forge"]');
    expect(forgeRadio.disabled).toBeTrue();
    const why = el.querySelector('[data-testid="chat3d-forge-why"]');
    expect(why).toBeTruthy();
    expect(why.textContent).toContain('Character Forge');
    // The greyed control is never bare: aria-describedby wires the WHY.
    expect(forgeRadio.getAttribute('aria-describedby')).toContain('c3d-forge-why');
  });

  it('falls back to the seeded GUEST when neither source exists — both greyed with WHY', async () => {
    await create();
    expect(component.source).toBe('guest');
    const el = fixture.nativeElement;
    expect(el.querySelector('[data-testid="input-source-forge"]').disabled).toBeTrue();
    expect(el.querySelector('[data-testid="input-source-billboard"]').disabled).toBeTrue();
    expect(el.querySelector('[data-testid="chat3d-billboard-why"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="input-source-guest"]').disabled).toBeFalse();
  });

  it('buildAvatar: forge mode carries the active definition; billboard the sticker mxc; guest a seeded config', async () => {
    const definition = randomChar3dConfig('vex');
    forge.getActiveCharacter.and.resolveTo({ name: 'Vex', definition });
    packs.resolveCharacterPack.and.resolveTo({ images: { neutral: { url: 'mxc://t/neutral' } }, pack: {} });
    await create();

    component.source = 'forge';
    expect(component.buildAvatar()).toEqual({ mode: 'forge', config: definition, sticker: null, name: 'Vex' });

    component.source = 'billboard';
    expect(component.buildAvatar()).toEqual({ mode: 'billboard', config: null, sticker: 'mxc://t/neutral', name: 'alice' });

    component.source = 'guest';
    component.guestSeed = 'motoko';
    expect(component.buildAvatar()).toEqual({
      mode: 'guest', config: randomChar3dConfig('motoko'), sticker: null, name: 'Guest motoko',
    });
  });

  it('a source that lost its backing degrades to the seeded guest instead of failing the join', async () => {
    await create();
    component.source = 'forge'; // never actually offered — simulate a stale pick
    component.guestSeed = 'fallback';
    expect(component.buildAvatar().mode).toBe('guest');
  });

  it('enter() freezes the avatar and swaps the menu for the embedded room host', async () => {
    await create();
    component.guestSeed = 'motoko';
    component.micEnabled = true;

    component.enter();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.entered()).toBeTrue();
    expect(component.joinedAvatar()!.mode).toBe('guest');
    const el = fixture.nativeElement;
    expect(el.querySelector('[data-testid="chat3d-join"]')).toBeNull();
    expect(el.querySelector('[data-testid="chat3d-host"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="chat3d-frame"]')).toBeTruthy();
  });

  it('REGRESSION: the mic/camera consent copy does NOT claim the toggles are inert — '
     + 'both are wired straight to getUserMedia', async () => {
    await create();
    const micHelp = fixture.nativeElement.querySelector('[data-testid="chat3d-mic-help"]').textContent as string;
    const camHelp = fixture.nativeElement.querySelector('[data-testid="chat3d-camera-help"]').textContent as string;

    // The shipped copy said "Not live yet in this build" for BOTH, while the
    // host passes micEnabled into MeshCallService.join() (→ mediaFactory() →
    // getUserMedia({audio:true})) and cameraEnabled into FaceTrackService.start()
    // (→ getUserMedia({video})). A user who reads "not live", concludes the box
    // is a no-op and ticks it to pre-set a preference gets their microphone and
    // webcam opened — with no prompt at all when this origin already holds a
    // persistent grant from the 1:1 matrix-call view.
    for (const copy of [micHelp, camHelp]) {
      expect(copy.toLowerCase()).not.toContain('not live');
      expect(copy.toLowerCase()).not.toContain('takes effect when');
    }
    // …and it says what actually happens, including the no-second-prompt case.
    expect(micHelp.toLowerCase()).toContain('opens your microphone');
    expect(camHelp.toLowerCase()).toContain('opens your camera');
    expect(micHelp.toLowerCase()).toContain('no further prompt');
    expect(camHelp.toLowerCase()).toContain('no further prompt');
    // The device-local promise the camera copy makes must stay true.
    expect(camHelp.toLowerCase()).toContain('never leave');
  });

  it('REGRESSION: the join menu\'s choices reach the host that opens the devices', async () => {
    await create();
    component.micEnabled = true;
    component.cameraEnabled = true;
    component.enter();
    await settle();

    // This is what makes the consent copy load-bearing: the checkboxes are the
    // ONLY consent surface between the user and getUserMedia.
    const host = fixture.debugElement.children
      .map((c) => c.componentInstance)
      .find((c) => c && 'micEnabled' in c && 'cameraEnabled' in c);
    expect(host).toBeDefined();
    expect(host.micEnabled).toBeTrue();
    expect(host.cameraEnabled).toBeTrue();
    // …and the host really does act on them. Asserting only the @Inputs would
    // still pass if startAv() stopped opening anything, which would make the
    // consent copy describe a device that never opens.
    expect(mesh.join).toHaveBeenCalledWith('!r:test', '@alice:test', { micEnabled: true });
    expect(faceTrack.start).toHaveBeenCalled();
  });

  it('the join menu\'s DEFAULTS open neither device', async () => {
    // The copy promises the devices open because the boxes are ticked — so the
    // untouched menu must open nothing at all.
    await create();
    component.enter();
    await settle();
    expect(mesh.join).toHaveBeenCalledWith('!r:test', '@alice:test', { micEnabled: false });
    expect(faceTrack.start).not.toHaveBeenCalled();
  });

  it('enter() refuses while the room is disabled (defence-in-depth with the hidden button)', async () => {
    matrix.getStateEvent.and.resolveTo(null);
    await create();
    component.enter();
    expect(component.entered()).toBeFalse();
  });
});
