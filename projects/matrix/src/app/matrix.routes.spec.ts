import { MATRIX_ROUTES } from './matrix.routes';
import { MatrixChatComponent } from './matrix-chat.component';
import { MatrixCallComponent } from './matrix-call.component';
import { RoomListComponent } from './room-list.component';
import { RoomViewComponent } from './room-view.component';
import { MemberListComponent } from './member-list.component';
import { RoomSettingsComponent } from './room-settings.component';
import { ThreadPanelComponent } from './thread-panel.component';
import { UserSettingsComponent } from './user-settings.component';
import { SearchComponent } from './search.component';
import { ModerationPanelComponent } from './moderation-panel.component';
import { Chat3dJoinComponent } from './chat3d/chat3d-join.component';

/**
 * These specs lock down the federation contract: `./routes` (exposed under the
 * remote name "matrix") is the single module the hugmesh.systems host mounts
 * at /social/matrix. The host depends on these paths and components, so a
 * regression here would silently break the host.
 */
describe('MATRIX_ROUTES (exposed ./routes federation contract)', () => {
  const byPath = (path: string) => MATRIX_ROUTES.find((r) => r.path === path);

  it('mounts the chat shell at the empty path (default mount point)', () => {
    const root = byPath('');
    expect(root).toBeDefined();
    expect(root!.component).toBe(MatrixChatComponent);
  });

  it('wires each feature route to its dedicated component', () => {
    expect(byPath('rooms')!.component).toBe(RoomListComponent);
    expect(byPath('rooms/:roomId')!.component).toBe(RoomViewComponent);
    expect(byPath('rooms/:roomId/members')!.component).toBe(MemberListComponent);
    expect(byPath('rooms/:roomId/settings')!.component).toBe(RoomSettingsComponent);
    expect(byPath('rooms/:roomId/thread/:eventId')!.component).toBe(ThreadPanelComponent);
    expect(byPath('rooms/:roomId/chat3d')!.component).toBe(Chat3dJoinComponent);
    expect(byPath('settings')!.component).toBe(UserSettingsComponent);
    expect(byPath('search')!.component).toBe(SearchComponent);
    expect(byPath('moderation')!.component).toBe(ModerationPanelComponent);
    expect(byPath('call')!.component).toBe(MatrixCallComponent);
  });

  it('lists the static "rooms" route before the parameterised "rooms/:roomId"', () => {
    const staticIdx = MATRIX_ROUTES.findIndex((r) => r.path === 'rooms');
    const paramIdx = MATRIX_ROUTES.findIndex((r) => r.path === 'rooms/:roomId');
    expect(staticIdx).toBeGreaterThanOrEqual(0);
    expect(paramIdx).toBeGreaterThanOrEqual(0);
    expect(staticIdx).toBeLessThan(paramIdx);
  });

  it('declares every route with either a component or children (no dead routes)', () => {
    for (const route of MATRIX_ROUTES) {
      expect(route.component || route.children).withContext(`route ${route.path}`).toBeTruthy();
    }
  });

  it('contains no duplicate paths', () => {
    const paths = MATRIX_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
