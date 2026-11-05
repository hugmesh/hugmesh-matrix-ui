import { Routes } from '@angular/router';

import { gamesGuard } from './games.guard';
import { gamesAdminGuard } from './games-admin.guard';
import {
  DEFAULT_DEPS,
  FEDERATION_MANIFEST_URL,
  GAMES_ADMIN_EXPOSED,
  GAMES_ADMIN_ROUTES_CONST,
  GAMES_EXPOSED,
  GAMES_MOUNTS,
  GAMES_REMOTE,
  GAMES_ROUTES_CONST,
  GamesRemoteDeps,
  defaultLoadRemote,
  gamesMountRoute,
  loadGamesChildRoutes,
  makeDefaultLoadRemote,
  remoteLoadOptions,
} from './games-remote.routes';

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

const ENTRY = 'http://localhost:4208/remoteEntry.json';

describe('games-remote.routes (the games remote mounted at /games and /games/admin, issue #2)', () => {
  it('boots federation from the same manifest asset this loader re-reads', () => {
    // main.ts calls initFederation('assets/federation.manifest.json'); the
    // loader must consult the SAME asset or the two views of "registered"
    // could diverge.
    expect(FEDERATION_MANIFEST_URL).toBe('assets/federation.manifest.json');
  });

  // ── The cross-repo contract with hugmesh-games/games-ui ───────────────────
  // games-ui's federation.config.js: name 'games', exposes './routes' ->
  // GAMES_ROUTES and './admin-routes' -> GAMES_ADMIN_ROUTES. The manifest key
  // must equal that name (native-federation registers the remote under the
  // name it declares, not under the key the host used).
  it("names the remote 'games' and its two exposed modules exactly as games-ui exposes them", () => {
    expect(GAMES_REMOTE).toBe('games');
    expect(GAMES_EXPOSED).toBe('./routes');
    expect(GAMES_ROUTES_CONST).toBe('GAMES_ROUTES');
    expect(GAMES_ADMIN_EXPOSED).toBe('./admin-routes');
    expect(GAMES_ADMIN_ROUTES_CONST).toBe('GAMES_ADMIN_ROUTES');
  });

  it("mounts './admin-routes' at games/admin BEFORE './routes' at games, with the right guards", () => {
    expect(GAMES_MOUNTS.map((m) => m.path)).toEqual(['games/admin', 'games']);
    expect(GAMES_MOUNTS).toEqual([
      jasmine.objectContaining({ path: 'games/admin', exposed: './admin-routes', routesConst: 'GAMES_ADMIN_ROUTES' }),
      jasmine.objectContaining({ path: 'games', exposed: './routes', routesConst: 'GAMES_ROUTES' }),
    ]);
    expect(GAMES_MOUNTS[0].canActivate).toEqual([gamesAdminGuard]);
    expect(GAMES_MOUNTS[1].canActivate).toEqual([gamesGuard]);
  });

  // ── loadGamesChildRoutes: one remote, two exposed modules ─────────────────
  it("loads './routes' from the manifest's `games` entry and returns GAMES_ROUTES", async () => {
    const gamesRoutes: Routes = [{ path: '', children: [] }];
    const d = deps({ [GAMES_REMOTE]: ENTRY }, { [GAMES_ROUTES_CONST]: gamesRoutes });
    const routes = await loadGamesChildRoutes(GAMES_EXPOSED, GAMES_ROUTES_CONST, d);
    expect(routes).toBe(gamesRoutes);
    // remoteEntry is passed through so the runtime can fetch-and-register a
    // remote initFederation did not process (manifest entry = single switch).
    expect(d.loadCalls).toEqual([[GAMES_REMOTE, ENTRY, './routes']]);
  });

  it("loads './admin-routes' from the SAME `games` entry and returns GAMES_ADMIN_ROUTES", async () => {
    const adminRoutes: Routes = [{ path: '', children: [] }];
    const d = deps({ [GAMES_REMOTE]: ENTRY }, { [GAMES_ADMIN_ROUTES_CONST]: adminRoutes });
    const routes = await loadGamesChildRoutes(GAMES_ADMIN_EXPOSED, GAMES_ADMIN_ROUTES_CONST, d);
    expect(routes).toBe(adminRoutes);
    expect(d.loadCalls).toEqual([[GAMES_REMOTE, ENTRY, './admin-routes']]);
  });

  it('REJECTS when the manifest has no `games` row (no placeholder fallback any more)', async () => {
    const d = deps({ login: 'http://localhost:4203/remoteEntry.json', 'games-admin': ENTRY });
    await expectAsync(loadGamesChildRoutes(GAMES_EXPOSED, GAMES_ROUTES_CONST, d)).toBeRejectedWithError(
      /remote 'games' is not registered/,
    );
    expect(d.loadCalls.length).withContext('no remote load attempted').toBe(0);
  });

  it('REJECTS when the manifest is unreadable', async () => {
    const d = deps('unreadable');
    await expectAsync(loadGamesChildRoutes(GAMES_EXPOSED, GAMES_ROUTES_CONST, d)).toBeRejectedWithError(
      /manifest fetch failed/,
    );
    expect(d.loadCalls.length).withContext('no remote load attempted').toBe(0);
  });

  it('PROPAGATES a remote load failure', async () => {
    const boom = new Error('remoteEntry fetch failed');
    const d = deps({ [GAMES_REMOTE]: ENTRY }, boom);
    await expectAsync(loadGamesChildRoutes(GAMES_EXPOSED, GAMES_ROUTES_CONST, d)).toBeRejectedWith(boom);
  });

  it('throws when the remote does not export the expected routes const', async () => {
    const d = deps({ [GAMES_REMOTE]: ENTRY }, { WRONG: [] });
    await expectAsync(
      loadGamesChildRoutes(GAMES_ADMIN_EXPOSED, GAMES_ADMIN_ROUTES_CONST, d),
    ).toBeRejectedWithError(/'\.\/admin-routes' did not export GAMES_ADMIN_ROUTES/);
  });

  // ── gamesMountRoute: the table row becomes a guarded lazy route ───────────
  describe('gamesMountRoute', () => {
    const original = { fetchManifest: DEFAULT_DEPS.fetchManifest, loadRemote: DEFAULT_DEPS.loadRemote };
    const mutable = DEFAULT_DEPS as { fetchManifest: GamesRemoteDeps['fetchManifest']; loadRemote: GamesRemoteDeps['loadRemote'] };
    afterEach(() => {
      mutable.fetchManifest = original.fetchManifest;
      mutable.loadRemote = original.loadRemote;
    });

    it('keeps the path and guards of the row', () => {
      const route = gamesMountRoute(GAMES_MOUNTS[0]);
      expect(route.path).toBe('games/admin');
      expect(route.canActivate).toEqual([gamesAdminGuard]);
      expect(route.loadComponent).withContext('a remote mount, not a local component').toBeUndefined();
    });

    it("drives loadChildren through DEFAULT_DEPS with the row's exposed module + const", async () => {
      const adminRoutes: Routes = [{ path: '', children: [] }];
      const d = deps({ [GAMES_REMOTE]: ENTRY }, { [GAMES_ADMIN_ROUTES_CONST]: adminRoutes });
      mutable.fetchManifest = d.fetchManifest;
      mutable.loadRemote = d.loadRemote;
      const route = gamesMountRoute(GAMES_MOUNTS[0]);
      const resolved = await (route.loadChildren as () => Promise<Routes>)();
      expect(resolved).toBe(adminRoutes);
      expect(d.loadCalls).toEqual([[GAMES_REMOTE, ENTRY, './admin-routes']]);
    });
  });

  // ── The options object handed to native-federation ────────────────────────
  // MEASURED against the installed @softarc/native-federation-runtime: when
  // `ensureRemoteInitialized()` lazily registers an entry `initFederation()`
  // never processed, it calls `fetchAndRegisterRemote(remoteEntry)` with no
  // name, so the remote lands in the registry under its OWN self-declared
  // `remoteEntry.json` name. Passing `remoteName` then makes
  // `getRemoteNameByOptions()` look up our MANIFEST KEY, miss, and throw
  // `unknown remote games` after a successful fetch. Omitting it resolves by
  // base URL, which both the boot path and the lazy path populate.
  describe('remoteLoadOptions (what actually reaches loadRemoteModule)', () => {
    const PROD_ENTRY = 'https://games.hugmesh.net/remoteEntry.json';

    it('passes the manifest entry URL as `remoteEntry` (the lazy-register switch)', () => {
      expect(remoteLoadOptions(GAMES_REMOTE, PROD_ENTRY, './routes')).toEqual({
        remoteEntry: PROD_ENTRY,
        exposedModule: './routes',
      });
    });

    it('does NOT pass `remoteName` — a remote self-naming differently from the key must still mount', () => {
      const opts = remoteLoadOptions(GAMES_REMOTE, PROD_ENTRY, './routes') as Record<string, unknown>;
      // `toEqual` above already pins the shape; this asserts the omission
      // directly so the reason survives a refactor that widens the object.
      expect('remoteName' in opts)
        .withContext('remoteName is resolved by base URL, not by the manifest key')
        .toBeFalse();
      expect(opts['remoteName']).toBeUndefined();
    });

    it("carries the games-admin exposed module './admin-routes' from the SAME entry the same way", () => {
      expect(remoteLoadOptions(GAMES_REMOTE, PROD_ENTRY, GAMES_ADMIN_EXPOSED)).toEqual({
        remoteEntry: PROD_ENTRY,
        exposedModule: './admin-routes',
      });
    });
  });

  // ── The PRODUCTION composition (what DEFAULT_DEPS.loadRemote actually is) ─
  // Two specs, closing two DIFFERENT ways the fix could regress:
  //   (a) `makeDefaultLoadRemote`'s own logic breaks (e.g. someone inlines
  //       `remoteName` back into the loader call inside it) — caught by
  //       driving it with a fake loader, no ESM mocking required.
  //   (b) `DEFAULT_DEPS.loadRemote` stops being `defaultLoadRemote` at all —
  //       e.g. a revert that pastes PR #15's inline arrow back at the
  //       `DEFAULT_DEPS` callsite, bypassing this composition entirely and
  //       leaving (a) green because `makeDefaultLoadRemote` itself was never
  //       touched. Caught by reference equality: nothing else may construct
  //       `DEFAULT_DEPS.loadRemote`.
  describe('makeDefaultLoadRemote (the composition DEFAULT_DEPS.loadRemote is built from)', () => {
    const PROD_ENTRY = 'https://games.hugmesh.net/remoteEntry.json';

    it('never lets `remoteName` reach the wrapped loader', async () => {
      const calls: Array<{ remoteEntry: string; exposedModule: string }> = [];
      const fakeLoader = (opts: { remoteEntry: string; exposedModule: string }) => {
        calls.push(opts);
        return Promise.resolve({});
      };
      const loadRemote = makeDefaultLoadRemote(fakeLoader);
      await loadRemote(GAMES_REMOTE, PROD_ENTRY, './routes');
      expect(calls.length).toBe(1);
      expect('remoteName' in (calls[0] as Record<string, unknown>))
        .withContext('remoteName is resolved by base URL, not by the manifest key')
        .toBeFalse();
      expect(calls[0]).toEqual({ remoteEntry: PROD_ENTRY, exposedModule: './routes' });
    });

    it('DEFAULT_DEPS.loadRemote IS `defaultLoadRemote` (the real loadRemoteModule composition), not a lookalike', () => {
      // Reference equality, not behavioral: a hand-reverted inline arrow at
      // the DEFAULT_DEPS callsite is a DIFFERENT closure even if it happens
      // to read similarly, so this fails the moment the wiring is bypassed.
      expect(DEFAULT_DEPS.loadRemote).toBe(defaultLoadRemote);
    });
  });
});
