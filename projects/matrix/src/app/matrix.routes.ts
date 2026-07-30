import { Routes } from '@angular/router';
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

/** Lazy-loadable routes for the Matrix module. Mounted by the host at
 *  /social/matrix. The full Element-like web UI: a 3-pane chat shell at '',
 *  room/thread/member/settings views, user settings, search, the role-aware
 *  'moderation' safety panel, plus the existing WebRTC call view at 'call'.
 *  'rooms/:roomId/chat3d' is the Shadows-of-the-Net 3D room join menu (offered
 *  from room-view only when the room's chat3d state parses enabled).
 *  Static 'rooms' is listed before 'rooms/:roomId' so Angular matches it first.
 *  '' and 'call' are preserved unchanged. */
export const MATRIX_ROUTES: Routes = [
  { path: '', component: MatrixChatComponent },
  { path: 'rooms', component: RoomListComponent },
  { path: 'rooms/:roomId', component: RoomViewComponent },
  { path: 'rooms/:roomId/members', component: MemberListComponent },
  { path: 'rooms/:roomId/settings', component: RoomSettingsComponent },
  { path: 'rooms/:roomId/thread/:eventId', component: ThreadPanelComponent },
  { path: 'rooms/:roomId/chat3d', component: Chat3dJoinComponent },
  { path: 'settings', component: UserSettingsComponent },
  { path: 'search', component: SearchComponent },
  { path: 'moderation', component: ModerationPanelComponent },
  { path: 'call', component: MatrixCallComponent },
];
