import { Route, Routes } from '@angular/router';

import { routes } from './app.routes';
import { adminGuard } from './admin.guard';
import { registeredGuard } from './registration.guard';
import { modGuard } from './mod.guard';
import { gamesGuard } from './games.guard';
import { gamesAdminGuard } from './games-admin.guard';

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

  it('/games is a MANIFEST-DRIVEN federated mount behind gamesGuard (issue #2)', () => {
    const games = routeFor('games');
    expect(games.canActivate).withContext('games entry-point gate').toContain(gamesGuard);
    expect(games.loadChildren).withContext('manifest-driven remote mount').toBeDefined();
    expect(games.loadComponent)
      .withContext('no longer a hardcoded local placeholder')
      .toBeUndefined();
  });

  it('/games loadChildren falls back to GamesPlaceholderComponent while no games remote is registered', async () => {
    // The test env has no `games` manifest entry (the karma server does not
    // even serve the manifest asset), so the loader must take the honest
    // placeholder fallback — the exact production behavior today.
    const { GamesPlaceholderComponent } = await import('./games-placeholder.component');
    const resolved = await (routeFor('games').loadChildren as () => Promise<Routes>)();
    expect(resolved.length).toBe(1);
    expect(resolved[0].path).toBe('');
    expect(resolved[0].component).toBe(GamesPlaceholderComponent);
  });

  it('/games/admin is a MANIFEST-DRIVEN federated mount behind gamesAdminGuard (issue #2)', () => {
    const gamesAdmin = routeFor('games/admin');
    expect(gamesAdmin.canActivate).withContext('derived games-admin gate').toContain(gamesAdminGuard);
    expect(gamesAdmin.loadChildren).withContext('manifest-driven remote mount').toBeDefined();
    expect(gamesAdmin.loadComponent)
      .withContext('no longer a hardcoded local placeholder')
      .toBeUndefined();
  });

  it('/games/admin loadChildren falls back to GamesAdminPlaceholderComponent while no games-admin remote is registered', async () => {
    const { GamesAdminPlaceholderComponent } = await import('./games-admin-placeholder.component');
    const resolved = await (routeFor('games/admin').loadChildren as () => Promise<Routes>)();
    expect(resolved.length).toBe(1);
    expect(resolved[0].path).toBe('');
    expect(resolved[0].component).toBe(GamesAdminPlaceholderComponent);
  });

  it('/games/admin is registered BEFORE /games so the specific path matches first', () => {
    const gamesAdminIdx = routes.findIndex((r) => r.path === 'games/admin');
    const gamesIdx = routes.findIndex((r) => r.path === 'games');
    expect(gamesAdminIdx).toBeGreaterThanOrEqual(0);
    expect(gamesAdminIdx).withContext('games/admin precedes the games mount').toBeLessThan(gamesIdx);
  });
});
