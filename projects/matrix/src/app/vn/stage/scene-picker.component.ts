import { Component, ElementRef, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SceneService, VnPropDef } from '../scenes/scene.service';
import { MAX_PROPS, VnPlacedProp, VnSceneState } from '../scenes/vn-scene-state.service';

/** Arrow-key nudge step in normalized stage units (Shift = coarse step). */
const NUDGE_STEP = 0.02;
const NUDGE_STEP_COARSE = 0.1;
/** +/- rescale factor per keypress, clamped to the state service's sane range. */
const SCALE_STEP = 1.15;
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
/** Where a freshly added prop lands (mid-stage, slightly low = "on the set"). */
const DROP_X = 0.5;
const DROP_Y = 0.6;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * `hug-vn-scene-picker` — the scene + prop EDITOR for the shared VN stage:
 * an accessible radiogroup grid of scene thumbnails (incl. a "No scene"
 * option) plus a prop palette (add prop / nudge x/y with arrow keys / rescale
 * with +/- / remove). PURE UI: it renders the CURRENT shared state from the
 * {@link state} input and emits the WHOLE next {@link VnSceneState} on every
 * change ({@link stateChange}) — persistence belongs to the host
 * (hug-vn-scene-controls wires it to VnSceneStateService).
 *
 * A11y: scene tiles are a `radiogroup` (one checked scene); each placed prop
 * row's Move control documents its keyboard contract in its accessible name
 * (arrow keys nudge — Shift for coarse steps — +/- resize, Delete removes),
 * and every thumbnail `<img>` is decorative (alt="") beside its visible text.
 * Thumbnails are the static manifest SVGs via relative `<img src>` — no user
 * content, no innerHTML.
 */
@Component({
  selector: 'hug-vn-scene-picker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './scene-picker.component.html',
  styleUrl: './scene-picker.component.scss',
})
export class ScenePickerComponent {
  readonly scenes = inject(SceneService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The current shared scene state (null = nothing set yet). */
  readonly state = input<VnSceneState | null>(null);

  /** Emits the FULL next state on every edit; the host persists it. */
  readonly stateChange = output<VnSceneState>();

  /** The shared-state prop ceiling, surfaced for the template's cap notice. */
  readonly maxProps = MAX_PROPS;

  constructor() {
    void this.scenes.load();
  }

  /** The effective current state (null input → the empty state). */
  readonly current = computed<VnSceneState>(() => this.state() ?? { sceneId: null, props: [] });

  /** True at the placed-prop ceiling — Add is disabled (see MAX_PROPS). */
  readonly atPropCap = computed(() => this.current().props.length >= MAX_PROPS);

  /** Placed props hydrated with display names for the placed-list rows. */
  readonly placed = computed(() =>
    this.current().props.map((prop) => ({
      prop,
      name: this.scenes.propById(prop.propId)?.displayName ?? prop.propId,
      url: this.scenes.propUrl(prop.propId),
    })),
  );

  /** Select a scene background (null = clear to a plain stage). */
  selectScene(sceneId: string | null): void {
    this.stateChange.emit({ ...this.current(), sceneId });
  }

  /** Add a prop at the default drop spot with its manifest default scale.
   *  No-op at the MAX_PROPS ceiling (the Add tiles are also disabled then) —
   *  the local optimistic state must never outgrow what the shared-state
   *  parse would round-trip. */
  addProp(def: VnPropDef): void {
    const cur = this.current();
    if (cur.props.length >= MAX_PROPS) {
      return;
    }
    const placed: VnPlacedProp = { propId: def.id, x: DROP_X, y: DROP_Y, scale: def.defaultScale };
    this.stateChange.emit({ ...cur, props: [...cur.props, placed] });
  }

  /** Remove the placed prop at `index`. */
  removeProp(index: number): void {
    const cur = this.current();
    this.stateChange.emit({ ...cur, props: cur.props.filter((_, i) => i !== index) });
  }

  /** Nudge a placed prop by normalized deltas, clamped to the 0..1 stage. */
  nudgeProp(index: number, dx: number, dy: number): void {
    this.updateProp(index, (p) => ({ ...p, x: clamp(p.x + dx, 0, 1), y: clamp(p.y + dy, 0, 1) }));
  }

  /** Rescale a placed prop by `factor`, clamped to a sane range. */
  rescaleProp(index: number, factor: number): void {
    this.updateProp(index, (p) => ({ ...p, scale: clamp(p.scale * factor, MIN_SCALE, MAX_SCALE) }));
  }

  /**
   * Keyboard contract for a placed prop's Move control: arrow keys nudge
   * (Shift = coarse), `+`/`-` resize, Delete/Backspace removes.
   */
  onPropKeydown(ev: KeyboardEvent, index: number): void {
    const step = ev.shiftKey ? NUDGE_STEP_COARSE : NUDGE_STEP;
    switch (ev.key) {
      case 'ArrowLeft':
        this.nudgeProp(index, -step, 0);
        break;
      case 'ArrowRight':
        this.nudgeProp(index, step, 0);
        break;
      case 'ArrowUp':
        this.nudgeProp(index, 0, -step);
        break;
      case 'ArrowDown':
        this.nudgeProp(index, 0, step);
        break;
      case '+':
      case '=':
        this.rescaleProp(index, SCALE_STEP);
        break;
      case '-':
      case '_':
        this.rescaleProp(index, 1 / SCALE_STEP);
        break;
      case 'Delete':
      case 'Backspace':
        this.removeProp(index);
        break;
      default:
        return;
    }
    ev.preventDefault();
  }

  /** Whether `sceneId` is the currently selected background. */
  isSelected(sceneId: string | null): boolean {
    return this.current().sceneId === sceneId;
  }

  /**
   * Roving tabindex for the scene radiogroup (APG radio pattern): only the
   * checked tile is in the tab order; arrow keys move within the group.
   * A saved sceneId the manifest doesn't know keeps "No scene" tabbable so
   * the group never becomes keyboard-unreachable.
   */
  radioTabindex(sceneId: string | null): number {
    const cur = this.current().sceneId;
    const known = cur !== null && this.scenes.scenes().some((s) => s.id === cur);
    return (known ? cur === sceneId : sceneId === null) ? 0 : -1;
  }

  /**
   * Radiogroup keyboard contract: ArrowRight/Down select the NEXT scene,
   * ArrowLeft/Up the previous (wrapping), selection follows focus — the
   * standard APG radio-group behaviour on top of the tiles' native
   * button Enter/Space activation.
   */
  onSceneKeydown(ev: KeyboardEvent, from: string | null): void {
    let delta: number;
    switch (ev.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        delta = 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        delta = -1;
        break;
      default:
        return;
    }
    ev.preventDefault();
    // Option order mirrors the template: "No scene" first, then the manifest.
    const options: (string | null)[] = [null, ...this.scenes.scenes().map((s) => s.id)];
    const idx = options.indexOf(from);
    const next = options[(idx + delta + options.length) % options.length];
    this.selectScene(next);
    this.focusSceneTile(next);
  }

  /** Move DOM focus to a scene tile (roving-tabindex companion). */
  private focusSceneTile(sceneId: string | null): void {
    const sel = sceneId === null
      ? '[data-testid="scene-none"]'
      : `[data-testid="scene-tile"][data-scene-id="${CSS.escape(sceneId)}"]`;
    this.host.nativeElement.querySelector<HTMLButtonElement>(sel)?.focus();
  }

  /** Accessible name for a placed prop's Move control (keyboard contract included). */
  moveLabel(name: string): string {
    return `Move ${name} prop: arrow keys to nudge, plus and minus to resize, Delete to remove`;
  }

  /** Rewrite one placed prop immutably and emit the whole next state. */
  private updateProp(index: number, fn: (p: VnPlacedProp) => VnPlacedProp): void {
    const cur = this.current();
    if (index < 0 || index >= cur.props.length) {
      return;
    }
    const props = cur.props.map((p, i) => (i === index ? fn(p) : p));
    this.stateChange.emit({ ...cur, props });
  }
}
