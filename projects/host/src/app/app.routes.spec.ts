import { Route } from '@angular/router';

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

  it('/games mounts a GUARDED LOCAL PLACEHOLDER behind gamesGuard (no games UI remote yet)', () => {
    const games = routeFor('games');
    expect(games.canActivate).withContext('games entry-point gate').toContain(gamesGuard);
    expect(games.loadComponent).withContext('local placeholder, not a remote mount').toBeDefined();
    expect(games.loadChildren).withContext('no games UI remote exists yet').toBeUndefined();
  });

  it('/games loadComponent resolves the GamesPlaceholderComponent', async () => {
    const { GamesPlaceholderComponent } = await import('./games-placeholder.component');
    const resolved = await (routeFor('games').loadComponent as () => Promise<unknown>)();
    expect(resolved).toBe(GamesPlaceholderComponent);
  });

  it('/games/admin mounts a GUARDED LOCAL PLACEHOLDER behind gamesAdminGuard (no games-admin UI remote yet)', () => {
    const gamesAdmin = routeFor('games/admin');
    expect(gamesAdmin.canActivate).withContext('derived games-admin gate').toContain(gamesAdminGuard);
    expect(gamesAdmin.loadComponent).withContext('local placeholder, not a remote mount').toBeDefined();
    expect(gamesAdmin.loadChildren).withContext('no games-admin UI remote exists yet').toBeUndefined();
  });

  it('/games/admin loadComponent resolves the GamesAdminPlaceholderComponent', async () => {
    const { GamesAdminPlaceholderComponent } = await import('./games-admin-placeholder.component');
    const resolved = await (routeFor('games/admin').loadComponent as () => Promise<unknown>)();
    expect(resolved).toBe(GamesAdminPlaceholderComponent);
  });

  it('/games/admin is registered BEFORE /games so the specific path matches first', () => {
    const gamesAdminIdx = routes.findIndex((r) => r.path === 'games/admin');
    const gamesIdx = routes.findIndex((r) => r.path === 'games');
    expect(gamesAdminIdx).toBeGreaterThanOrEqual(0);
    expect(gamesAdminIdx).withContext('games/admin precedes the games placeholder').toBeLessThan(gamesIdx);
  });
});
