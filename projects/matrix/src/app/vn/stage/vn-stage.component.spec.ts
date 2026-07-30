import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StageParticipant, VnStageComponent } from './vn-stage.component';
import { SceneService, VnPropDef, VnSceneDef } from '../scenes/scene.service';

const SCENES: VnSceneDef[] = [
  { id: 'vn_scene_cafe', displayName: 'Café', file: 'vn_scene_cafe.svg', tags: ['indoor'] },
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

function part(id: string, over: Partial<StageParticipant> = {}): StageParticipant {
  return { userId: id, displayName: id.replace(/^@/, '').split(':')[0], imgUrl: `blob:${id}`, speaking: false, openness: 0, ...over };
}

describe('VnStageComponent', () => {
  let fixture: ComponentFixture<VnStageComponent>;
  let scenes: SceneStub;

  beforeEach(async () => {
    scenes = new SceneStub();
    await TestBed.configureTestingModule({
      imports: [VnStageComponent],
      providers: [{ provide: SceneService, useValue: scenes }],
    }).compileComponents();
    fixture = TestBed.createComponent(VnStageComponent);
  });

  const q = <T extends Element>(sel: string): T | null => fixture.nativeElement.querySelector(sel);
  const qa = (sel: string): Element[] => Array.from(fixture.nativeElement.querySelectorAll(sel));

  it('kicks the (cached, fail-soft) manifest load on construction', () => {
    fixture.detectChanges();
    expect(scenes.load).toHaveBeenCalled();
  });

  it('renders the scene background <img> from the manifest URL', () => {
    fixture.componentRef.setInput('scene', 'vn_scene_cafe');
    fixture.detectChanges();
    const bg = q<HTMLImageElement>('[data-testid="scene-bg"]');
    expect(bg).toBeTruthy();
    expect(bg!.getAttribute('src')).toBe('assets/vn/scenes/vn_scene_cafe.svg');
    // Decorative ambience — never part of the accessible name.
    expect(bg!.getAttribute('alt')).toBe('');
    expect(bg!.getAttribute('aria-hidden')).toBe('true');
  });

  it('FAIL-SOFT: null or unknown scene renders NO background img (plain stage)', () => {
    fixture.detectChanges();
    expect(q('[data-testid="scene-bg"]')).toBeNull();

    fixture.componentRef.setInput('scene', 'vn_scene_unknown');
    fixture.detectChanges();
    expect(q('[data-testid="scene-bg"]')).toBeNull();
    // The stage frame itself still renders.
    expect(q('[data-testid="vn-stage"]')).toBeTruthy();
  });

  it('positions props by normalized coords (% left/top) and scales their width', () => {
    fixture.componentRef.setInput('props', [
      { propId: 'vn_prop_lamp', x: 0.25, y: 0.8, scale: 1 },
      { propId: 'vn_prop_drink', x: 0.5, y: 0.5, scale: 2 },
    ]);
    fixture.detectChanges();

    const props = qa('[data-testid="stage-prop"]') as HTMLImageElement[];
    expect(props.length).toBe(2);
    expect(props[0].style.left).toBe('25%');
    expect(props[0].style.top).toBe('80%');
    expect(props[0].style.width).toBe('25%'); // base 25% × scale 1
    expect(props[1].style.width).toBe('50%'); // base 25% × scale 2
  });

  it('FAIL-SOFT: unknown prop ids render nothing (dropped, no broken img)', () => {
    fixture.componentRef.setInput('props', [
      { propId: 'vn_prop_ghost', x: 0.5, y: 0.5, scale: 1 },
      { propId: 'vn_prop_lamp', x: 0.1, y: 0.1, scale: 1 },
    ]);
    fixture.detectChanges();
    const props = qa('[data-testid="stage-prop"]');
    expect(props.length).toBe(1);
    expect(props[0].getAttribute('data-prop-id')).toBe('vn_prop_lamp');
  });

  it('LIMIT: re-caps the props INPUT at MAX_PROPS=32 even when the host bypasses the state parse', () => {
    // 40 known props straight into the input (no parse clamp on this path).
    fixture.componentRef.setInput(
      'props',
      Array.from({ length: 40 }, () => ({ propId: 'vn_prop_lamp', x: 0.5, y: 0.5, scale: 1 })),
    );
    fixture.detectChanges();
    expect(qa('[data-testid="stage-prop"]').length).toBe(32);
  });

  it('COMBINATION SWEEP: sprite count is min(participants, 4) for casts of 0..6', () => {
    for (let n = 0; n <= 6; n++) {
      fixture.componentRef.setInput(
        'participants',
        Array.from({ length: n }, (_, i) => part(`@p${i}:snap`)),
      );
      fixture.detectChanges();
      expect(qa('[data-testid="stage-sprite"]').length)
        .withContext(`${n} participants`)
        .toBe(Math.min(n, 4));
    }
  });

  it('arranges 1 participant CENTRED', () => {
    fixture.componentRef.setInput('participants', [part('@a:snap')]);
    fixture.detectChanges();
    const sprites = qa('[data-testid="stage-sprite"]') as HTMLElement[];
    expect(sprites.length).toBe(1);
    expect(sprites[0].style.left).toBe('50%');
    expect(sprites[0].classList.contains('flipped')).toBeFalse();
  });

  it('arranges 2 participants left/right FACING IN (right sprite flipped)', () => {
    fixture.componentRef.setInput('participants', [part('@a:snap'), part('@b:snap')]);
    fixture.detectChanges();
    const sprites = qa('[data-testid="stage-sprite"]') as HTMLElement[];
    expect(sprites.length).toBe(2);
    expect(sprites[0].style.left).toBe('30%');
    expect(sprites[1].style.left).toBe('70%');
    expect(sprites[0].classList.contains('flipped')).toBeFalse();
    expect(sprites[1].classList.contains('flipped')).toBeTrue();
  });

  it('staggers 3–4 participants (back-row class) and caps rendering at 4', () => {
    fixture.componentRef.setInput('participants', [
      part('@a:s'), part('@b:s'), part('@c:s'), part('@d:s'), part('@e:s'),
    ]);
    fixture.detectChanges();
    const sprites = qa('[data-testid="stage-sprite"]') as HTMLElement[];
    expect(sprites.length).toBe(4); // 5th participant not rendered
    expect(sprites[0].classList.contains('back-row')).toBeTrue();
    expect(sprites[1].classList.contains('back-row')).toBeFalse();
    expect(sprites[2].classList.contains('back-row')).toBeFalse();
    expect(sprites[3].classList.contains('back-row')).toBeTrue();
  });

  it('spotlights the ACTIVE SPEAKER and dims the others (saturation cue)', () => {
    fixture.componentRef.setInput('participants', [
      part('@quiet:s'),
      part('@loud:s', { speaking: true, openness: 0.6 }),
    ]);
    fixture.detectChanges();
    const sprites = qa('[data-testid="stage-sprite"]') as HTMLElement[];
    expect(sprites[0].classList.contains('dimmed')).toBeTrue();
    expect(sprites[0].classList.contains('speaking')).toBeFalse();
    expect(sprites[1].classList.contains('speaking')).toBeTrue();
    expect(sprites[1].classList.contains('dimmed')).toBeFalse();
  });

  it('nobody speaking ⇒ nobody dimmed', () => {
    fixture.componentRef.setInput('participants', [part('@a:s'), part('@b:s')]);
    fixture.detectChanges();
    expect(qa('.dimmed').length).toBe(0);
    expect(qa('.speaking').length).toBe(0);
  });

  it('renders the amplitude mouth overlay ONLY on a speaking sprite, ry scaling with openness', () => {
    fixture.componentRef.setInput('participants', [
      part('@quiet:s'),
      part('@loud:s', { speaking: true, openness: 0.5 }),
    ]);
    fixture.detectChanges();

    const sprites = qa('[data-testid="stage-sprite"]') as HTMLElement[];
    expect(sprites[0].querySelector('[data-testid="mouth-overlay"]')).toBeNull();
    const shape = sprites[1].querySelector('[data-testid="mouth-shape"]');
    expect(shape).toBeTruthy();
    expect(Number(shape!.getAttribute('ry'))).toBe(11); // round(0.5 × 22)

    // Openness pinned to 0 (e.g. reduced motion drive) keeps the mouth closed.
    fixture.componentRef.setInput('participants', [
      part('@quiet:s'),
      part('@loud:s', { speaking: true, openness: 0 }),
    ]);
    fixture.detectChanges();
    const closed = qa('[data-testid="mouth-shape"]')[0];
    expect(Number(closed.getAttribute('ry'))).toBe(0);
  });

  it('XSS BOUNDARY: the sprite is a plain <img> and the overlay is a SIBLING layer, never injected', () => {
    fixture.componentRef.setInput('participants', [part('@loud:s', { speaking: true, openness: 1 })]);
    fixture.detectChanges();
    const img = q<HTMLImageElement>('[data-testid="sprite-img"]')!;
    const overlay = q('[data-testid="mouth-overlay"]')!;
    expect(img.tagName.toLowerCase()).toBe('img');
    expect(img.contains(overlay)).toBeFalse();
    expect(img.parentElement!.contains(overlay)).toBeTrue(); // sibling under .sprite-body
  });

  it('shows name plates, preferring displayName, falling back to the Matrix id', () => {
    fixture.componentRef.setInput('participants', [
      part('@a:s', { displayName: 'Aria' }),
      part('@b:s', { displayName: undefined }),
    ]);
    fixture.detectChanges();
    const plates = qa('[data-testid="name-plate"]') as HTMLElement[];
    expect(plates[0].textContent).toContain('Aria');
    expect(plates[1].textContent).toContain('@b:s');
  });

  it('sprite alt announces the ASCII screen-reader name + expression (a11y contract)', () => {
    fixture.componentRef.setInput('participants', [
      part('@a:s', { displayName: 'Áría', screenReaderName: 'Aria', expression: 'happy' }),
    ]);
    fixture.detectChanges();
    expect(q('[data-testid="sprite-img"]')!.getAttribute('alt')).toBe('Aria character, happy');
  });
});

@Component({
  standalone: true,
  imports: [VnStageComponent],
  template: `<hug-vn-stage [scene]="null">She said the line.</hug-vn-stage>`,
})
class DialogueHostComponent {}

describe('VnStageComponent dialogue projection', () => {
  it('content-projects the classic VN dialogue bar', async () => {
    await TestBed.configureTestingModule({
      imports: [DialogueHostComponent],
      providers: [{ provide: SceneService, useValue: new SceneStub() }],
    }).compileComponents();
    const fixture = TestBed.createComponent(DialogueHostComponent);
    fixture.detectChanges();
    const box = fixture.nativeElement.querySelector('[data-testid="dialogue-box"]');
    expect(box).toBeTruthy();
    expect(box.textContent).toContain('She said the line.');
  });
});
