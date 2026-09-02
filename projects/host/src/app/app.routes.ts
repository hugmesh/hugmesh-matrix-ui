import { Routes } from '@angular/router';
import { loadRemoteModule } from '@angular-architects/native-federation';
import { adminGuard } from './admin.guard';
import { registeredGuard } from './registration.guard';
import { modGuard } from './mod.guard';
import { gamesGuard } from './games.guard';
import { gamesAdminGuard } from './games-admin.guard';
import {
  GAMES_ADMIN_REMOTE,
  GAMES_ADMIN_ROUTES_CONST,
  GAMES_REMOTE,
  GAMES_ROUTES_CONST,
  gamesAdminPlaceholderRoutes,
  gamesPlaceholderRoutes,
  loadGamesChildRoutes,
} from './games-remote.routes';

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
 * Matrix/Mastodon/user require full registration; Admin requires the Casdoor
 * admin role; mod requires the Casdoor mod (or admin) role (modGuard).
 *
 * Phase 8/10 → issue #2: games/games-admin are MANIFEST-DRIVEN federated
 * mounts. When `federation.manifest.json` registers the `games` /
 * `games-admin` remote, `loadChildren` mounts its exposed './routes' exactly
 * like every sibling remote above; while unregistered (no games UI remote has
 * been built yet) the loader falls back to the honest TODO placeholder
 * (GamesPlaceholderComponent / GamesAdminPlaceholderComponent) — never a
 * silent 404 or a faked surface. See games-remote.routes.ts for the contract.
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
  // 'games/admin' MUST precede 'games' (specific-before-general).
  {
    path: 'games/admin',
    canActivate: [gamesAdminGuard],
    loadChildren: () =>
      loadGamesChildRoutes(GAMES_ADMIN_REMOTE, GAMES_ADMIN_ROUTES_CONST, gamesAdminPlaceholderRoutes),
  },
  {
    path: 'games',
    canActivate: [gamesGuard],
    loadChildren: () => loadGamesChildRoutes(GAMES_REMOTE, GAMES_ROUTES_CONST, gamesPlaceholderRoutes),
  },
  { path: '', children: [] },
];
