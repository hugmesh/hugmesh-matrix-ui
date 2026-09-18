import { Routes } from '@angular/router';

import {
  DEFAULT_DEPS,
  FEDERATION_MANIFEST_URL,
  GAMES_ADMIN_REMOTE,
  GAMES_ADMIN_ROUTES_CONST,
  GAMES_REMOTE,
  GAMES_ROUTES_CONST,
  GamesRemoteDeps,
  defaultLoadRemote,
  gamesAdminPlaceholderRoutes,
  gamesPlaceholderRoutes,
  loadGamesChildRoutes,
  makeDefaultLoadRemote,
  remoteLoadOptions,
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
    const ENTRY = 'https://games.hugmesh.net/remoteEntry.json';

    it('passes the manifest entry URL as `remoteEntry` (the lazy-register switch)', () => {
      expect(remoteLoadOptions(GAMES_REMOTE, ENTRY, './routes')).toEqual({
        remoteEntry: ENTRY,
        exposedModule: './routes',
      });
    });

    it('does NOT pass `remoteName` — a remote self-naming `hugmesh-games-ui` must still mount', () => {
      const opts = remoteLoadOptions(GAMES_REMOTE, ENTRY, './routes') as Record<string, unknown>;
      // `toEqual` above already pins the shape; this asserts the omission
      // directly so the reason survives a refactor that widens the object.
      expect('remoteName' in opts)
        .withContext('remoteName is resolved by base URL, not by the manifest key')
        .toBeFalse();
      expect(opts['remoteName']).toBeUndefined();
    });

    it('carries the games-admin exposed contract the same way', () => {
      const entry = 'https://games.hugmesh.net/admin/remoteEntry.json';
      expect(remoteLoadOptions(GAMES_ADMIN_REMOTE, entry, './routes')).toEqual({
        remoteEntry: entry,
        exposedModule: './routes',
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
    const ENTRY = 'https://games.hugmesh.net/remoteEntry.json';

    it('never lets `remoteName` reach the wrapped loader', async () => {
      const calls: Array<{ remoteEntry: string; exposedModule: string }> = [];
      const fakeLoader = (opts: { remoteEntry: string; exposedModule: string }) => {
        calls.push(opts);
        return Promise.resolve({});
      };
      const loadRemote = makeDefaultLoadRemote(fakeLoader);
      await loadRemote(GAMES_REMOTE, ENTRY, './routes');
      expect(calls.length).toBe(1);
      expect('remoteName' in (calls[0] as Record<string, unknown>))
        .withContext('remoteName is resolved by base URL, not by the manifest key')
        .toBeFalse();
      expect(calls[0]).toEqual({ remoteEntry: ENTRY, exposedModule: './routes' });
    });

    it('DEFAULT_DEPS.loadRemote IS `defaultLoadRemote` (the real loadRemoteModule composition), not a lookalike', () => {
      // Reference equality, not behavioral: a hand-reverted inline arrow at
      // the DEFAULT_DEPS callsite is a DIFFERENT closure even if it happens
      // to read similarly, so this fails the moment the wiring is bypassed.
      expect(DEFAULT_DEPS.loadRemote).toBe(defaultLoadRemote);
    });
  });
});
