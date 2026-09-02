import { Routes } from '@angular/router';

import {
  FEDERATION_MANIFEST_URL,
  GAMES_ADMIN_REMOTE,
  GAMES_ADMIN_ROUTES_CONST,
  GAMES_REMOTE,
  GAMES_ROUTES_CONST,
  GamesRemoteDeps,
  gamesAdminPlaceholderRoutes,
  gamesPlaceholderRoutes,
  loadGamesChildRoutes,
} from './games-remote.routes';
import { GamesPlaceholderComponent } from './games-placeholder.component';
import { GamesAdminPlaceholderComponent } from './games-admin-placeholder.component';

/** Spec deps: a canned manifest + a spy-able remote loader. */
function deps(
  manifest: Record<string, string> | 'unreadable',
  remoteModule: Record<string, unknown> | Error = {},
): GamesRemoteDeps & { loadCalls: Array<[string, string, string]> } {
  const loadCalls: Array<[string, string, string]> = [];
  return {
    loadCalls,
    fetchManifest: () =>
      manifest === 'unreadable'
        ? Promise.reject(new Error('manifest fetch failed: HTTP 404'))
        : Promise.resolve(manifest),
    loadRemote: (remoteName, remoteEntryUrl, exposedModule) => {
      loadCalls.push([remoteName, remoteEntryUrl, exposedModule]);
      return remoteModule instanceof Error
        ? Promise.reject(remoteModule)
        : Promise.resolve(remoteModule);
    },
  };
}

describe('games-remote.routes (manifest-driven games mounts, issue #2)', () => {
  it('boots federation from the same manifest asset this loader re-reads', () => {
    // main.ts calls initFederation('assets/federation.manifest.json'); the
    // loader must consult the SAME asset or the two views of "registered"
    // could diverge.
    expect(FEDERATION_MANIFEST_URL).toBe('assets/federation.manifest.json');
  });

  it('falls back to the placeholder routes when the remote is NOT registered', async () => {
    const d = deps({ login: 'http://localhost:4203/remoteEntry.json' });
    const routes = await loadGamesChildRoutes(GAMES_REMOTE, GAMES_ROUTES_CONST, gamesPlaceholderRoutes, d);
    expect(routes.length).toBe(1);
    expect(routes[0].component).toBe(GamesPlaceholderComponent);
    expect(d.loadCalls.length).withContext('no remote load attempted').toBe(0);
  });

  it('falls back to the placeholder routes when the manifest is unreadable', async () => {
    const d = deps('unreadable');
    const routes = await loadGamesChildRoutes(GAMES_REMOTE, GAMES_ROUTES_CONST, gamesPlaceholderRoutes, d);
    expect(routes.length).toBe(1);
    expect(routes[0].component).toBe(GamesPlaceholderComponent);
    expect(d.loadCalls.length).withContext('no remote load attempted').toBe(0);
  });

  it("mounts the REGISTERED remote's exported routes via its './routes' contract", async () => {
    const gamesRoutes: Routes = [{ path: '', children: [] }];
    const entry = 'http://localhost:4208/remoteEntry.json';
    const d = deps({ [GAMES_REMOTE]: entry }, { [GAMES_ROUTES_CONST]: gamesRoutes });
    const routes = await loadGamesChildRoutes(GAMES_REMOTE, GAMES_ROUTES_CONST, gamesPlaceholderRoutes, d);
    expect(routes).toBe(gamesRoutes);
    // remoteEntry is passed through so the runtime can fetch-and-register a
    // remote initFederation did not process (manifest entry = single switch).
    expect(d.loadCalls).toEqual([[GAMES_REMOTE, entry, './routes']]);
  });

  it('PROPAGATES a registered-but-broken remote load failure (never the "not built" placeholder)', async () => {
    const boom = new Error('remoteEntry fetch failed');
    const d = deps({ [GAMES_REMOTE]: 'http://localhost:4208/remoteEntry.json' }, boom);
    await expectAsync(
      loadGamesChildRoutes(GAMES_REMOTE, GAMES_ROUTES_CONST, gamesPlaceholderRoutes, d),
    ).toBeRejectedWith(boom);
  });

  it('throws when a registered remote does not export the expected routes const', async () => {
    const d = deps({ [GAMES_REMOTE]: 'http://localhost:4208/remoteEntry.json' }, { WRONG: [] });
    await expectAsync(
      loadGamesChildRoutes(GAMES_REMOTE, GAMES_ROUTES_CONST, gamesPlaceholderRoutes, d),
    ).toBeRejectedWithError(/did not export GAMES_ROUTES/);
  });

  it('drives the games-admin mount off its own remote name + routes const', async () => {
    const adminRoutes: Routes = [{ path: '', children: [] }];
    const entry = 'http://localhost:4209/remoteEntry.json';
    const d = deps({ [GAMES_ADMIN_REMOTE]: entry }, { [GAMES_ADMIN_ROUTES_CONST]: adminRoutes });
    const routes = await loadGamesChildRoutes(
      GAMES_ADMIN_REMOTE,
      GAMES_ADMIN_ROUTES_CONST,
      gamesAdminPlaceholderRoutes,
      d,
    );
    expect(routes).toBe(adminRoutes);
    expect(d.loadCalls).toEqual([[GAMES_ADMIN_REMOTE, entry, './routes']]);
  });

  it('games-admin falls back to ITS placeholder when only `games` is registered', async () => {
    const d = deps({ [GAMES_REMOTE]: 'http://localhost:4208/remoteEntry.json' });
    const routes = await loadGamesChildRoutes(
      GAMES_ADMIN_REMOTE,
      GAMES_ADMIN_ROUTES_CONST,
      gamesAdminPlaceholderRoutes,
      d,
    );
    expect(routes.length).toBe(1);
    expect(routes[0].component).toBe(GamesAdminPlaceholderComponent);
  });
});
