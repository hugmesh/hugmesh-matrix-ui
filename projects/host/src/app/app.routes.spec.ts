import { Route, Routes } from '@angular/router';

import { routes } from './app.routes';
import { adminGuard } from './admin.guard';
import { registeredGuard } from './registration.guard';
import { modGuard } from './mod.guard';
import { gamesGuard } from './games.guard';
import { gamesAdminGuard } from './games-admin.guard';
import { DEFAULT_DEPS, GAMES_MOUNTS, GamesRemoteDeps } from './games-remote.routes';

describe('host app.routes wiring', () => {
  function routeFor(path: string): Route {
    const r = routes.find((x) => x.path === path);
    if (!r) throw new Error(`route '${path}' not found`);
    return r;
  }

  it('guards /admin with adminGuard', () => {
    expect(routeFor('admin').canActivate).toContain(adminGuard);
  });

  it('guards the social remotes with registeredGuard', () => {
    expect(routeFor('social/matrix').canActivate).toContain(registeredGuard);
    expect(routeFor('social/mastodon').canActivate).toContain(registeredGuard);
  });

  it('/mod is now guarded by modGuard (previously registeredGuard alone)', () => {
    const mod = routeFor('mod');
    expect(mod.canActivate).withContext('moderator-or-admin gate').toContain(modGuard);
    expect(mod.canActivate).withContext('no longer bare registeredGuard').not.toContain(registeredGuard);
    expect(mod.loadChildren).withContext('still mounts the real mod remote').toBeDefined();
  });

  // ── /games and /games/admin: the ONE `games` remote's two exposed modules ─
  // The behavioral specs below resolve the REAL `routes` entries' loadChildren,
  // with DEFAULT_DEPS temporarily pointed at a canned manifest + loader, so a
  // swap of './routes' and './admin-routes' in the mount table (or in
  // app.routes.ts) fails here, not only in games-remote.routes.spec.
  describe('games mounts (issue #2)', () => {
    const original = { fetchManifest: DEFAULT_DEPS.fetchManifest, loadRemote: DEFAULT_DEPS.loadRemote };
    const mutable = DEFAULT_DEPS as { fetchManifest: GamesRemoteDeps['fetchManifest']; loadRemote: GamesRemoteDeps['loadRemote'] };
    const ENTRY = 'http://localhost:4208/remoteEntry.json';
    let loadCalls: Array<[string, string, string]>;

    beforeEach(() => {
      loadCalls = [];
      mutable.fetchManifest = () => Promise.resolve({ games: ENTRY });
      mutable.loadRemote = (remoteName, remoteEntryUrl, exposedModule) => {
        loadCalls.push([remoteName, remoteEntryUrl, exposedModule]);
        return Promise.resolve({ GAMES_ROUTES: [{ path: '', children: [] }], GAMES_ADMIN_ROUTES: [{ path: 'admin-only', children: [] }] });
      };
    });
    afterEach(() => {
      mutable.fetchManifest = original.fetchManifest;
      mutable.loadRemote = original.loadRemote;
    });

    it('/games is a federated mount behind gamesGuard (no local placeholder)', () => {
      const games = routeFor('games');
      expect(games.canActivate).withContext('games entry-point gate').toContain(gamesGuard);
      expect(games.loadChildren).withContext('remote mount').toBeDefined();
      expect(games.loadComponent).withContext('placeholder is gone').toBeUndefined();
    });

    it("/games loads exposedModule './routes' (GAMES_ROUTES) from remoteEntry 'games'", async () => {
      const resolved = await (routeFor('games').loadChildren as () => Promise<Routes>)();
      expect(loadCalls).toEqual([['games', ENTRY, './routes']]);
      expect(resolved).toEqual([{ path: '', children: [] }]);
    });

    it('/games/admin is a federated mount behind gamesAdminGuard (no local placeholder)', () => {
      const gamesAdmin = routeFor('games/admin');
      expect(gamesAdmin.canActivate).withContext('derived games-admin gate').toContain(gamesAdminGuard);
      expect(gamesAdmin.loadChildren).withContext('remote mount').toBeDefined();
      expect(gamesAdmin.loadComponent).withContext('placeholder is gone').toBeUndefined();
    });

    it("/games/admin loads exposedModule './admin-routes' (GAMES_ADMIN_ROUTES) from the SAME remoteEntry 'games'", async () => {
      const resolved = await (routeFor('games/admin').loadChildren as () => Promise<Routes>)();
      expect(loadCalls).toEqual([['games', ENTRY, './admin-routes']]);
      expect(resolved).toEqual([{ path: 'admin-only', children: [] }]);
    });

    it('the mount table is the routes (no hand-written games rows left to drift)', () => {
      expect(GAMES_MOUNTS.map((m) => m.path)).toEqual(['games/admin', 'games']);
      for (const spec of GAMES_MOUNTS) {
        expect(routeFor(spec.path).canActivate).toEqual([...spec.canActivate]);
      }
    });
  });

  it('/games/admin is registered BEFORE /games so the specific path matches first', () => {
    const gamesAdminIdx = routes.findIndex((r) => r.path === 'games/admin');
    const gamesIdx = routes.findIndex((r) => r.path === 'games');
    expect(gamesAdminIdx).toBeGreaterThanOrEqual(0);
    expect(gamesAdminIdx).withContext('games/admin precedes the games mount').toBeLessThan(gamesIdx);
  });
});
