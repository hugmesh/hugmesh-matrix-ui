import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScenePickerComponent } from './scene-picker.component';
import { SceneService, VnPropDef, VnSceneDef } from '../scenes/scene.service';
import { VnSceneState } from '../scenes/vn-scene-state.service';

const SCENES: VnSceneDef[] = [
  { id: 'vn_scene_cafe', displayName: 'Café', file: 'vn_scene_cafe.svg', tags: ['indoor'] },
  { id: 'vn_scene_night_city', displayName: 'Night City', file: 'vn_scene_night_city.svg', tags: ['night'] },
];
const PROPS: VnPropDef[] = [
  { id: 'vn_prop_lamp', displayName: 'Floor Lamp', file: 'vn_prop_lamp.svg', defaultScale: 1 },
  { id: 'vn_prop_drink', displayName: 'Drink', file: 'vn_prop_drink.svg', defaultScale: 0.35 },
];

/** SceneService stub: manifest already "loaded" via signals; no fetches. */
class SceneStub {
  scenes = signal(SCENES);
  props = signal(PROPS);
  loaded = signal(true);
  load = jasmine.createSpy('load').and.resolveTo(undefined);
  sceneById = (id: string | null | undefined) => this.scenes().find((s) => s.id === id) ?? null;
  propById = (id: string | null | undefined) => this.props().find((p) => p.id === id) ?? null;
  sceneUrl = (id: string | null | undefined) => {
    const def = this.sceneById(id);
    return def ? `assets/vn/scenes/${def.file}` : null;
  };
  propUrl = (id: string | null | undefined) => {
    const def = this.propById(id);
    return def ? `assets/vn/scenes/${def.file}` : null;
  };
}

describe('ScenePickerComponent', () => {
  let fixture: ComponentFixture<ScenePickerComponent>;
  let emitted: VnSceneState[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ScenePickerComponent],
      providers: [{ provide: SceneService, useClass: SceneStub }],
    }).compileComponents();
    fixture = TestBed.createComponent(ScenePickerComponent);
    emitted = [];
    fixture.componentInstance.stateChange.subscribe((s: VnSceneState) => emitted.push(s));
  });

  const q = <T extends Element>(sel: string): T | null => fixture.nativeElement.querySelector(sel);
  const qa = (sel: string): HTMLElement[] => Array.from(fixture.nativeElement.querySelectorAll(sel));
  const last = (): VnSceneState => emitted[emitted.length - 1];

  it('renders an accessible radiogroup of scene tiles plus the "No scene" option', () => {
    fixture.detectChanges();
    expect(q('[role="radiogroup"]')).toBeTruthy();
    expect(q('[data-testid="scene-none"]')).toBeTruthy();
    const tiles = qa('[data-testid="scene-tile"]');
    expect(tiles.length).toBe(2);
    expect(tiles[0].getAttribute('role')).toBe('radio');
  });

  it('checks the tile matching the CURRENT shared state (aria-checked)', () => {
    fixture.componentRef.setInput('state', { sceneId: 'vn_scene_night_city', props: [] });
    fixture.detectChanges();
    const checked = qa('[role="radio"][aria-checked="true"]');
    expect(checked.length).toBe(1);
    expect(checked[0].getAttribute('data-scene-id')).toBe('vn_scene_night_city');
  });

  it('selecting a scene emits the FULL next state, keeping the placed props', () => {
    fixture.componentRef.setInput('state', {
      sceneId: null,
      props: [{ propId: 'vn_prop_lamp', x: 0.2, y: 0.8, scale: 1 }],
    });
    fixture.detectChanges();
    qa('[data-testid="scene-tile"]')[0].click();
    expect(last()).toEqual({
      sceneId: 'vn_scene_cafe',
      props: [{ propId: 'vn_prop_lamp', x: 0.2, y: 0.8, scale: 1 }],
    });
  });

  it('"No scene" clears the background (sceneId null) without touching props', () => {
    fixture.componentRef.setInput('state', {
      sceneId: 'vn_scene_cafe',
      props: [{ propId: 'vn_prop_drink', x: 0.7, y: 0.7, scale: 0.35 }],
    });
    fixture.detectChanges();
    q<HTMLButtonElement>('[data-testid="scene-none"]')!.click();
    expect(last().sceneId).toBeNull();
    expect(last().props.length).toBe(1);
  });

  it('adding a prop appends it at the drop spot with its manifest defaultScale', () => {
    fixture.detectChanges();
    const add = qa('[data-testid="prop-add"]').find((b) => b.getAttribute('data-prop-id') === 'vn_prop_drink')!;
    add.click();
    expect(last()).toEqual({
      sceneId: null,
      props: [{ propId: 'vn_prop_drink', x: 0.5, y: 0.6, scale: 0.35 }],
    });
  });

  it('arrow keys NUDGE a placed prop (Shift = coarse), clamped to the 0..1 stage', () => {
    fixture.componentRef.setInput('state', {
      sceneId: null,
      props: [{ propId: 'vn_prop_lamp', x: 0.01, y: 0.5, scale: 1 }],
    });
    fixture.detectChanges();
    const move = q<HTMLButtonElement>('[data-testid="prop-move"]')!;

    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(last().props[0].x).toBe(0); // 0.01 - 0.02 clamped to 0

    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(last().props[0].y).toBeCloseTo(0.6, 10); // coarse 0.1 step
  });

  it('+/- RESCALE a placed prop within the sane range; Delete removes it', () => {
    fixture.componentRef.setInput('state', {
      sceneId: null,
      props: [{ propId: 'vn_prop_lamp', x: 0.5, y: 0.5, scale: 1 }],
    });
    fixture.detectChanges();
    const move = q<HTMLButtonElement>('[data-testid="prop-move"]')!;

    move.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    expect(last().props[0].scale).toBeCloseTo(1.15, 10);

    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(last().props).toEqual([]);
  });

  it('the Remove button removes exactly its row (pointer path)', () => {
    fixture.componentRef.setInput('state', {
      sceneId: null,
      props: [
        { propId: 'vn_prop_lamp', x: 0.2, y: 0.5, scale: 1 },
        { propId: 'vn_prop_drink', x: 0.8, y: 0.5, scale: 0.35 },
      ],
    });
    fixture.detectChanges();
    qa('[data-testid="prop-remove"]')[0].click();
    expect(last().props).toEqual([{ propId: 'vn_prop_drink', x: 0.8, y: 0.5, scale: 0.35 }]);
  });

  it('LIMIT MAX_PROPS=32: addProp is a NO-OP at the cap, Add tiles disable, and the cap notice announces', () => {
    const props = Array.from({ length: 32 }, () => ({ propId: 'vn_prop_lamp', x: 0.5, y: 0.5, scale: 1 }));
    fixture.componentRef.setInput('state', { sceneId: null, props });
    fixture.detectChanges();

    // The component API refuses to grow the state…
    fixture.componentInstance.addProp(PROPS[0]);
    expect(emitted.length).toBe(0);

    // …the Add tiles are disabled with a reason…
    const add = q<HTMLButtonElement>('[data-testid="prop-add"]')!;
    expect(add.disabled).toBeTrue();
    expect(add.getAttribute('title')).toContain('32');

    // …and the polite cap notice names the limit.
    const note = q('[data-testid="prop-cap-note"]')!;
    expect(note.getAttribute('aria-live')).toBe('polite');
    expect(note.textContent).toContain('32');
  });

  it('below the cap the Add tiles are enabled and no cap notice renders', () => {
    fixture.componentRef.setInput('state', {
      sceneId: null,
      props: [{ propId: 'vn_prop_lamp', x: 0.5, y: 0.5, scale: 1 }],
    });
    fixture.detectChanges();
    expect(q<HTMLButtonElement>('[data-testid="prop-add"]')!.disabled).toBeFalse();
    expect(q('[data-testid="prop-cap-note"]')).toBeNull();
  });

  // ───────── radiogroup keyboard (APG radio pattern) ─────────

  it('ROVING TABINDEX: only the checked scene tile is in the tab order', () => {
    fixture.componentRef.setInput('state', { sceneId: 'vn_scene_cafe', props: [] });
    fixture.detectChanges();
    const radios = qa('[role="radio"]');
    const tabbable = radios.filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable.length).toBe(1);
    expect(tabbable[0].getAttribute('data-scene-id')).toBe('vn_scene_cafe');
    expect(radios.filter((r) => r.getAttribute('tabindex') === '-1').length).toBe(radios.length - 1);
  });

  it('ROVING TABINDEX: an unknown saved sceneId keeps "No scene" tabbable (group never unreachable)', () => {
    fixture.componentRef.setInput('state', { sceneId: 'vn_scene_never_heard_of', props: [] });
    fixture.detectChanges();
    expect(q('[data-testid="scene-none"]')!.getAttribute('tabindex')).toBe('0');
  });

  it('ArrowRight/ArrowDown select the NEXT scene, ArrowLeft/ArrowUp the previous, wrapping', () => {
    // Order: [No scene, cafe, night_city]. Start at "No scene" (null).
    fixture.detectChanges();
    const none = q<HTMLButtonElement>('[data-testid="scene-none"]')!;

    none.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(last().sceneId).toBe('vn_scene_cafe');

    // Selection follows focus: from cafe, ArrowDown moves on to night_city.
    fixture.componentRef.setInput('state', { sceneId: 'vn_scene_cafe', props: [] });
    fixture.detectChanges();
    qa('[data-testid="scene-tile"]')[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(last().sceneId).toBe('vn_scene_night_city');

    // Wrap: ArrowLeft from "No scene" lands on the LAST option.
    fixture.componentRef.setInput('state', { sceneId: null, props: [] });
    fixture.detectChanges();
    none.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(last().sceneId).toBe('vn_scene_night_city');
  });

  it('arrow selection moves DOM focus onto the newly checked tile', () => {
    fixture.componentRef.setInput('state', { sceneId: null, props: [] });
    fixture.detectChanges();
    const none = q<HTMLButtonElement>('[data-testid="scene-none"]')!;
    none.focus();
    none.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    const cafe = qa('[data-testid="scene-tile"]').find((t) => t.getAttribute('data-scene-id') === 'vn_scene_cafe')!;
    expect(document.activeElement).toBe(cafe);
  });

  it('the Move control documents its keyboard contract in its accessible name', () => {
    fixture.componentRef.setInput('state', {
      sceneId: null,
      props: [{ propId: 'vn_prop_lamp', x: 0.5, y: 0.5, scale: 1 }],
    });
    fixture.detectChanges();
    const label = q('[data-testid="prop-move"]')!.getAttribute('aria-label') ?? '';
    expect(label).toContain('Floor Lamp');
    expect(label).toContain('arrow keys');
    expect(label).toContain('Delete');
  });
});
