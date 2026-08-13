import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScenePickerComponent } from './scene-picker.component';
import { VnSceneState, VnSceneStateService } from '../scenes/vn-scene-state.service';

/**
 * `hug-vn-scene-controls` — the HOST that wires the pure
 * {@link ScenePickerComponent} to the SHARED per-room scene state
 * ({@link VnSceneStateService} / the `net.hugmesh.vn.scene` room state
 * event): it loads the room's current scene into the picker, persists every
 * picker edit OPTIMISTICALLY (local state first, then the PUT), and re-emits
 * the new state ({@link stateChange}) so a sibling `hug-vn-stage` can render
 * it live without waiting for the next remote sync.
 *
 * FAIL-SOFT end to end: an unset/denied read shows the empty picker; a failed
 * write keeps the optimistic local state and surfaces a polite inline notice
 * (a later successful edit clears it) — never a throw, never a blank crash.
 */
@Component({
  selector: 'hug-vn-scene-controls',
  standalone: true,
  imports: [CommonModule, ScenePickerComponent],
  template: `
    <div class="scene-controls" data-testid="scene-controls">
      <hug-vn-scene-picker [state]="state()" (stateChange)="onPicked($event)" />
      <p class="save-status" data-testid="scene-save-status"
         role="status" aria-live="polite">{{ saveError() }}</p>
    </div>
  `,
  styles: `
    .scene-controls { display: block; }
    .save-status { min-height: 1rem; margin: 0.25rem 0 0; font-size: 0.8rem; color: var(--hug-error); }
    .save-status:empty { display: none; }
  `,
})
export class VnSceneControlsComponent {
  private readonly sceneState = inject(VnSceneStateService);

  /** The room whose shared scene is edited. Changing it reloads the state. */
  readonly roomId = input<string>('');

  /** The freshest scene state (optimistic on edit) — feed it to hug-vn-stage. */
  readonly state = signal<VnSceneState | null>(null);
  /** Polite inline write-failure notice ('' when the last save succeeded). */
  readonly saveError = signal('');

  /** Re-emits every (optimistic) state change so a parent can render it live. */
  readonly stateChange = output<VnSceneState>();

  constructor() {
    effect(() => {
      const room = this.roomId();
      untracked(() => void this.reload(room));
    });
  }

  /** Persist a picker edit: optimistic local state, then the fail-soft PUT. */
  async onPicked(next: VnSceneState): Promise<void> {
    this.state.set(next);
    this.stateChange.emit(next);
    const ok = await this.sceneState.setSceneState(this.roomId(), next);
    this.saveError.set(ok ? '' : 'Could not update the shared scene. Your change is shown locally only.');
  }

  /** (Re)load the room's shared scene; unset/denied → null (empty picker).
   *  MODERATED so a hostile below-power-level scene never loads into the picker
   *  (and thence the stage via {@link stateChange}). */
  private async reload(roomId: string): Promise<void> {
    this.saveError.set('');
    if (!roomId) {
      this.state.set(null);
      return;
    }
    const loaded = await this.sceneState.getModeratedSceneState(roomId);
    this.state.set(loaded);
    if (loaded) {
      this.stateChange.emit(loaded);
    }
  }
}
