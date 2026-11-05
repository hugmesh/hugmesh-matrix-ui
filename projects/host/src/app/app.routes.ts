import { Routes } from '@angular/router';
import { loadRemoteModule } from '@angular-architects/native-federation';
import { adminGuard } from './admin.guard';
import { registeredGuard } from './registration.guard';
import { modGuard } from './mod.guard';
import { GAMES_MOUNTS, gamesMountRoute } from './games-remote.routes';

/**
 * Host shell routes. Every feature is a native-federation remote (its own repo
 * + nginx), loaded at runtime from the URLs in
 * `src/assets/federation.manifest.json`:
 *   login    → hugmesh-login-ui      (Casdoor + Google/Discord, two-stage reg)
 *   matrix   → hugmesh-matrix-ui      (this repo's matrix remote)
 *   mastodon → hugmesh-mastodon-ui
 *   admin    → hugmesh-admin-ui       (allowlist / usage / namespaces)
 *   mod      → hugmesh-mod-ui         (moderation queue + actions)
 *   user     → hugmesh-user-ui        (user profile / settings / self-service)
 *   apidocs  → hugmesh-api-docs       (OpenAPI / developer documentation)
 *   games    → hugmesh-games/games-ui  remote 'games' exposes ./routes (GAMES_ROUTES)
 *                                      AND ./admin-routes (GAMES_ADMIN_ROUTES)
 * Matrix/Mastodon/user require full registration; Admin requires the Casdoor
 * admin role; mod requires the Casdoor mod (or admin) role (modGuard).
 *
 * Issue #2: /games and /games/admin mount the ONE `games` remote's two exposed
 * modules (GAMES_MOUNTS in games-remote.routes.ts, mirroring hugmesh-host-shell
 * b3c4fc76). The former TODO placeholders are gone; a missing manifest row or a
 * broken remote fails the way any sibling remote does.
 */
const remote = (remoteName: string, exposed = './routes') => (key: string) =>
  loadRemoteModule(remoteName, exposed).then((m) => m[key]);

export const routes: Routes = [
  { path: 'login', loadChildren: () => remote('login')('LOGIN_ROUTES') },
  { path: 'admin', canActivate: [adminGuard], loadChildren: () => remote('admin')('ADMIN_ROUTES') },
  { path: 'social/matrix', canActivate: [registeredGuard], loadChildren: () => remote('matrix')('MATRIX_ROUTES') },
  { path: 'social/mastodon', canActivate: [registeredGuard], loadChildren: () => remote('mastodon')('MASTODON_ROUTES') },
  // Previously guarded by registeredGuard alone (any fully-registered user, not
  // just moderators, could reach it). Now gated on the Casdoor mod (or admin)
  // role, matching the ROLE_MOD-conditional nav entry (modGuard).
  { path: 'mod', canActivate: [modGuard], loadChildren: () => remote('mod')('MOD_ROUTES') },
  { path: 'user', canActivate: [registeredGuard], loadChildren: () => remote('user')('USER_ROUTES') },
  { path: 'apidocs', loadChildren: () => remote('apidocs')('APIDOCS_ROUTES') },
  // Games member + admin mounts of the single 'games' remote. The table keeps
  // 'games/admin' before 'games' (specific-before-general) and the guards.
  ...GAMES_MOUNTS.map(gamesMountRoute),
  { path: '', children: [] },
];
