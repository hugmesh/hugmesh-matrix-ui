import { ComponentFixture, TestBed } from '@angular/core/testing';
import { VnSceneControlsComponent } from './vn-scene-controls.component';
import { VnSceneState, VnSceneStateService } from '../scenes/vn-scene-state.service';
import { SceneService } from '../scenes/scene.service';
import { signal } from '@angular/core';

class SceneStateStub {
  // reload() reads through the MODERATED method (power-level + rate-limit guard).
  getModeratedSceneState = jasmine.createSpy('getModeratedSceneState').and.resolveTo(null);
  setSceneState = jasmine.createSpy('setSceneState').and.resolveTo(true);
}

/** Minimal SceneService stub so the embedded picker renders without fetches. */
class SceneStub {
  scenes = signal([]);
  props = signal([]);
  loaded = signal(false);
  load = jasmine.createSpy('load').and.resolveTo(undefined);
  sceneById = () => null;
  propById = () => null;
  sceneUrl = () => null;
  propUrl = () => null;
}

const STATE: VnSceneState = {
  sceneId: 'vn_scene_cafe',
  props: [{ propId: 'vn_prop_lamp', x: 0.3, y: 0.7, scale: 1 }],
};

describe('VnSceneControlsComponent', () => {
  let fixture: ComponentFixture<VnSceneControlsComponent>;
  let sceneState: SceneStateStub;
  let emitted: VnSceneState[];

  beforeEach(async () => {
    sceneState = new SceneStateStub();
    await TestBed.configureTestingModule({
      imports: [VnSceneControlsComponent],
      providers: [
        { provide: VnSceneStateService, useValue: sceneState },
        { provide: SceneService, useClass: SceneStub },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(VnSceneControlsComponent);
    emitted = [];
    fixture.componentInstance.stateChange.subscribe((s: VnSceneState) => emitted.push(s));
  });

  it('loads the room\'s shared scene on roomId and re-emits it for the stage', async () => {
    sceneState.getModeratedSceneState.and.resolveTo(STATE);
    fixture.componentRef.setInput('roomId', '!room:snap');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(sceneState.getModeratedSceneState).toHaveBeenCalledWith('!room:snap');
    expect(fixture.componentInstance.state()).toEqual(STATE);
    expect(emitted).toEqual([STATE]);
  });

  it('FAIL-SOFT load: unset/denied state shows the empty picker (null, no emit)', async () => {
    fixture.componentRef.setInput('roomId', '!room:snap');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.state()).toBeNull();
    expect(emitted).toEqual([]);
  });

  it('persists a picker edit OPTIMISTICALLY: local state + emit first, then the PUT', async () => {
    fixture.componentRef.setInput('roomId', '!room:snap');
    fixture.detectChanges();
    await fixture.whenStable();

    const pending = fixture.componentInstance.onPicked(STATE);
    // Optimistic: visible locally BEFORE the write resolves.
    expect(fixture.componentInstance.state()).toEqual(STATE);
    expect(emitted).toEqual([STATE]);

    await pending;
    expect(sceneState.setSceneState).toHaveBeenCalledWith('!room:snap', STATE);
    expect(fixture.componentInstance.saveError()).toBe('');
  });

  it('a failed write keeps the optimistic state and surfaces the polite notice; a later success clears it', async () => {
    fixture.componentRef.setInput('roomId', '!room:snap');
    fixture.detectChanges();
    await fixture.whenStable();

    sceneState.setSceneState.and.resolveTo(false);
    await fixture.componentInstance.onPicked(STATE);
    fixture.detectChanges();

    expect(fixture.componentInstance.state()).toEqual(STATE); // kept locally
    const status = fixture.nativeElement.querySelector('[data-testid="scene-save-status"]');
    expect(status.textContent).toContain('shown locally only');
    expect(status.getAttribute('role')).toBe('status');

    sceneState.setSceneState.and.resolveTo(true);
    await fixture.componentInstance.onPicked(STATE);
    fixture.detectChanges();
    expect(status.textContent!.trim()).toBe('');
  });

  it('no roomId ⇒ null state and no wire calls', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.state()).toBeNull();
    expect(sceneState.getModeratedSceneState).not.toHaveBeenCalled();
  });
});
