import { Component, Type } from '@angular/core';
import { Chat3dHostComponent } from './chat3d/chat3d-host.component';
import { Chat3dJoinComponent } from './chat3d/chat3d-join.component';
import { RoomMediaPanelComponent } from './chat3d/room-media-panel.component';
import { MatrixChatComponent } from './matrix-chat.component';
import { MatrixCallComponent } from './matrix-call.component';
import { RoomSettingsComponent } from './room-settings.component';
import { RoomViewComponent } from './room-view.component';
import { MemberListComponent } from './member-list.component';
import { ModerationPanelComponent } from './moderation-panel.component';
import { ComposerComponent } from './composer.component';

/** The element-prefix this remote's components are namespaced under. */
export const MATRIX_SELECTOR_PREFIX = 'hug-';

/** Read the `selector` off a component's compiled Angular metadata. */
function selectorOf(type: Type<unknown>): string {
  const def = (type as unknown as { ɵcmp?: { selectors?: unknown[][] } }).ɵcmp;
  const first = def?.selectors?.[0]?.[0];
  return typeof first === 'string' ? first : '';
}

/**
 * REGRESSION (rebrand identifier drift): the whole fleet renamed
 * hugmesh → hugmesh, and every component in this remote is namespaced
 * `hug-*` — except the three chat3d components, which shipped as
 * `snap-chat3d-host` / `snap-chat3d-join` / `snap-chat3d-media-panel`. Custom
 * element names are INTERNAL (unlike the `net.hugmesh.chat3d.*` state
 * event types, which are wire identifiers with deployed readers and must NOT
 * be renamed), so the drift was pure inconsistency — and the kind that
 * multiplies, because the next component is written by copying a neighbour.
 *
 * This pins the convention for every component the remote declares, so a new
 * one cannot reintroduce a second namespace unnoticed.
 */
describe('component selector namespace', () => {
  const components: Type<unknown>[] = [
    Chat3dHostComponent, Chat3dJoinComponent, RoomMediaPanelComponent,
    MatrixChatComponent, MatrixCallComponent, RoomSettingsComponent,
    RoomViewComponent, MemberListComponent, ModerationPanelComponent,
    ComposerComponent,
  ];

  it(`every component element is namespaced ${MATRIX_SELECTOR_PREFIX}*`, () => {
    for (const type of components) {
      const selector = selectorOf(type);
      // Guard against the metadata read silently returning '' and passing a
      // startsWith check on nothing.
      expect(selector).withContext(`${type.name} has a readable selector`).toBeTruthy();
      expect(selector.startsWith(MATRIX_SELECTOR_PREFIX))
        .withContext(`${type.name} selector "${selector}" must start with "${MATRIX_SELECTOR_PREFIX}"`)
        .toBeTrue();
    }
  });

  it('the chat3d components in particular carry no legacy snap- prefix', () => {
    for (const type of [Chat3dHostComponent, Chat3dJoinComponent, RoomMediaPanelComponent]) {
      expect(selectorOf(type)).not.toMatch(/^snap-/);
    }
  });

  it('SANITY: the reader really reads a selector (it is not vacuously empty)', () => {
    @Component({ selector: 'snap-example', standalone: true, template: '' })
    class Example {}
    expect(selectorOf(Example)).toBe('snap-example');
    expect(selectorOf(Example).startsWith(MATRIX_SELECTOR_PREFIX)).toBeFalse();
  });
});
