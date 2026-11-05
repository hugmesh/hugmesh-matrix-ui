import { CanActivateFn, Route, Routes } from '@angular/router';
import { loadRemoteModule } from '@angular-architects/native-federation';

import { gamesGuard } from './games.guard';
import { gamesAdminGuard } from './games-admin.guard';

/**
 * Games remote mounts (issue #2) — /games and /games/admin are TWO exposed
 * modules of ONE native-federation remote, hugmesh-games/games-ui, whose
 * federation name is `games` (its `federation.config.js`):
 *
 *   './routes'       -> GAMES_ROUTES        mounted at /games        (gamesGuard)
 *   './admin-routes' -> GAMES_ADMIN_ROUTES  mounted at /games/admin  (gamesAdminGuard)
 *
 * This mirrors hugmesh-host-shell commit b3c4fc76, which replaced the same two
 * TODO placeholders in the production shell. The manifest key (`games`), the
 * remote's self-declared name and the exposed-module keys above are a
 * cross-repo contract with games-ui: change any one and the games views break
 * only at `loadRemoteModule()` time, never at build time. There is no separate
 * `games-admin` remote any more; the old `GAMES_ADMIN_REMOTE` key is retired.
 *
 * Loader shape: at navigation time the loader re-reads the SAME static
 * federation manifest `main.ts` booted `initFederation()` from and hands the
 * entry URL to native-federation as `remoteEntry`. The remote now exists, so
 * there is no "not built yet" fallback: a missing manifest row or a broken
 * remote both PROPAGATE to the router exactly like a broken sibling remote
 * (login/matrix/admin/...). A faked "coming soon" surface for a remote that
 * ships would be dishonest in the other direction.
 *
 * NOTE (runtime behavior, MEASURED against the installed
 * @softarc/native-federation-runtime — see `remoteLoadOptions()`): the
 * name-only `loadRemoteModule(name, exposed)` form throws `unknown remote` for
 * any remote `initFederation()` did not process at boot. This loader therefore
 * passes the manifest entry as `remoteEntry`, which `ensureRemoteInitialized()`
 * uses to fetch-and-register a not-yet-registered remote on demand. It
 * deliberately does NOT also pass `remoteName`; `remoteLoadOptions()` records
 * why, with the measurement (the PR #16 fix, kept verbatim).
 */

/** Same asset `main.ts` boots `initFederation()` from — keep the two in sync. */
export const FEDERATION_MANIFEST_URL = 'assets/federation.manifest.json';

/** Manifest key == games-ui's federation `name` == the remote's self-declared name. */
export const GAMES_REMOTE = 'games';
export const GAMES_EXPOSED = './routes';
export const GAMES_ROUTES_CONST = 'GAMES_ROUTES';
export const GAMES_ADMIN_EXPOSED = './admin-routes';
export const GAMES_ADMIN_ROUTES_CONST = 'GAMES_ADMIN_ROUTES';

/** Injectable seams so specs can drive the loader without spying the frozen
 *  native-federation ESM namespace or the global fetch. */
export interface GamesRemoteDeps {
  readonly fetchManifest: () => Promise<Record<string, string>>;
  readonly loadRemote: (
    remoteName: string,
    remoteEntryUrl: string,
    exposedModule: string,
  ) => Promise<Record<string, unknown>>;
}

/**
 * Re-read the static federation manifest. Resolved against `document.baseURI`
 * (NOT a root-absolute path) so a non-root `base-href` deployment still finds
 * it — the base-href trap that bites federated remotes under the host shell
 * applies to this host's own assets the same way.
 */
export async function fetchFederationManifest(): Promise<Record<string, string>> {
  const url = new URL(FEDERATION_MANIFEST_URL, document.baseURI).toString();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`federation manifest fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as Record<string, string>;
}

/**
 * The option object handed to native-federation's `loadRemoteModule()`.
 *
 * It carries `remoteEntry` + `exposedModule` and DELIBERATELY OMITS
 * `remoteName`, which is the whole point of this function existing — the
 * omission is load-bearing and silently reverting it re-breaks the lazy mount.
 *
 * Why (measured against the installed @softarc/native-federation-runtime,
 * `fesm2022/softarc-native-federation-runtime.mjs`, by driving the real
 * `loadRemoteModule` with a stubbed `fetch`/`document` — not by reading):
 *
 *   - `ensureRemoteInitialized()` lazily registers an entry `initFederation()`
 *     never processed by calling `fetchAndRegisterRemote(remoteEntry)` with NO
 *     name, so `addRemote()` keys it under the remote's OWN self-declared
 *     `remoteEntry.json` `name` — NOT under our manifest key.
 *   - `getRemoteNameByOptions()` then prefers `options.remoteName` when given.
 *     Pass the manifest key and the subsequent `getRemote(key)` misses,
 *     throwing `unknown remote games` AFTER a perfectly successful fetch.
 *   - Omit `remoteName` and the name is resolved by base URL instead
 *     (`getRemoteNameByBaseUrl()`), which is populated by BOTH paths:
 *     `initFederation()` (keyed by the manifest key) and the lazy register
 *     (keyed by the self-declared name). So it resolves in every case.
 *
 * Measured outcomes, manifest key `games`, entry `https://games.hugmesh.net/
 * remoteEntry.json` (reaching the module import = the registry lookup passed):
 *
 *   self-name | boot-registered | remoteName passed | result
 *   ----------|-----------------|-------------------|---------------------
 *   games     | no              | yes               | mounts
 *   games-ui  | no              | yes               | THROWS unknown remote
 *   games-ui  | no              | no                | mounts
 *   games     | yes             | no                | mounts
 *   games-ui  | yes             | no                | mounts
 *
 * games-ui's federation.config.js names itself `games` today, so the broken
 * row is not the live configuration — but the omission is kept because it is
 * the only shape that mounts in EVERY row, including a future rename, and the
 * failure mode of the other shape is a successful fetch followed by a throw.
 *
 * `remoteName` is still a parameter (and is still asserted by the specs)
 * because it is what makes the failure message name the right remote; it is
 * simply not part of what the runtime is asked to resolve.
 */
export function remoteLoadOptions(
  // Accepted, and intentionally unused: taking the manifest key here is what
  // lets a spec assert it never reaches the runtime options object.
  _manifestKey: string,
  remoteEntryUrl: string,
  exposedModule: string,
): { remoteEntry: string; exposedModule: string } {
  return { remoteEntry: remoteEntryUrl, exposedModule };
}

/**
 * Composes any loader (real `loadRemoteModule`, or a spec's plain fake — no
 * cast against the library's overloaded type needed, since this only
 * requires the one options-object call shape `remoteLoadOptions()` produces)
 * with `remoteLoadOptions()`. This is the ONLY place production code may
 * call a loader with the manifest key + entry — `DEFAULT_DEPS.loadRemote`
 * below is required to be its output, never a hand-written duplicate, so a
 * spec that drives `makeDefaultLoadRemote` with a fake loader is exercising
 * the exact composition production uses, not a lookalike.
 */
export function makeDefaultLoadRemote(
  loader: (options: ReturnType<typeof remoteLoadOptions>) => Promise<Record<string, unknown>>,
): GamesRemoteDeps['loadRemote'] {
  return (remoteName, remoteEntryUrl, exposedModule) =>
    loader(remoteLoadOptions(remoteName, remoteEntryUrl, exposedModule));
}

/**
 * The ACTUAL production composition (real `loadRemoteModule` bound in), named
 * and exported so a spec can pin it two ways: (1) drive it with a fake loader
 * to assert `remoteName` never reaches whatever loader it wraps — see the
 * `makeDefaultLoadRemote` describe block; (2) assert `DEFAULT_DEPS.loadRemote
 * === defaultLoadRemote` by reference below. (2) is what a spec on (1) alone
 * cannot catch: someone hand-reverting the `DEFAULT_DEPS` field to a NEW
 * inline arrow (PR #15's bug, pasted back) would leave `makeDefaultLoadRemote`
 * itself untouched and its own spec green, while production silently regains
 * the bug. Binding `DEFAULT_DEPS.loadRemote` to this named constant, and
 * pinning that exact reference, forces such a revert to change (and therefore
 * be caught failing) this spec too.
 */
export const defaultLoadRemote: GamesRemoteDeps['loadRemote'] = makeDefaultLoadRemote(loadRemoteModule);

export const DEFAULT_DEPS: GamesRemoteDeps = {
  fetchManifest: fetchFederationManifest,
  loadRemote: defaultLoadRemote,
};

/**
 * loadChildren body for one games-namespace mount: resolve the `games` entry
 * from the manifest, load `exposedModule` from it, return its `routesConst`.
 * Every failure (manifest unreadable, `games` row missing, remote load error,
 * wrong export) rejects — the router then reports it like any sibling remote.
 */
export async function loadGamesChildRoutes(
  exposedModule: string,
  routesConst: string,
  deps: GamesRemoteDeps = DEFAULT_DEPS,
): Promise<Routes> {
  const manifest = await deps.fetchManifest();
  const entry = manifest?.[GAMES_REMOTE];
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error(
      `remote '${GAMES_REMOTE}' is not registered in ${FEDERATION_MANIFEST_URL}; ` +
        `cannot load '${exposedModule}'`,
    );
  }
  const mod = await deps.loadRemote(GAMES_REMOTE, entry, exposedModule);
  const routes = mod[routesConst];
  if (!Array.isArray(routes)) {
    throw new Error(`remote '${GAMES_REMOTE}' '${exposedModule}' did not export ${routesConst}`);
  }
  return routes as Routes;
}

/** One row of the games mount table: which exposed module lands on which path. */
export interface GamesMountSpec {
  readonly path: string;
  readonly exposed: string;
  readonly routesConst: string;
  readonly canActivate: readonly CanActivateFn[];
}

/**
 * The games mount table, data-driven like host-shell's REMOTE_ROUTES rows.
 * ORDER MATTERS: 'games/admin' MUST precede 'games' (specific-before-general)
 * or the member mount's loadChildren swallows the admin path. Guards are the
 * ones the placeholders carried: gamesGuard on the entry point, the derived
 * gamesAdminGuard on the admin console.
 */
export const GAMES_MOUNTS: readonly GamesMountSpec[] = [
  { path: 'games/admin', exposed: GAMES_ADMIN_EXPOSED, routesConst: GAMES_ADMIN_ROUTES_CONST, canActivate: [gamesAdminGuard] },
  { path: 'games', exposed: GAMES_EXPOSED, routesConst: GAMES_ROUTES_CONST, canActivate: [gamesGuard] },
];

/** Turn a mount-table row into the Angular route that lazy-loads it. */
export function gamesMountRoute(spec: GamesMountSpec): Route {
  return {
    path: spec.path,
    canActivate: [...spec.canActivate],
    loadChildren: () => loadGamesChildRoutes(spec.exposed, spec.routesConst),
  };
}
