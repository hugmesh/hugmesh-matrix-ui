import { Routes } from '@angular/router';
import { loadRemoteModule } from '@angular-architects/native-federation';

/**
 * Manifest-driven games / games-admin mounts (issue #2).
 *
 * The /games and /games/admin routes are now REAL federated mounts with the
 * placeholder demoted to an "unregistered" fallback: at navigation time the
 * loader re-reads the SAME static federation manifest `main.ts` booted
 * `initFederation()` from, and
 *
 *   - remote REGISTERED in the manifest  -> `loadRemoteModule(...)` and mount
 *     the exported routes const, exactly like every sibling remote
 *     (login/matrix/admin/...). A load failure PROPAGATES to the router the way
 *     a broken sibling remote does — falling back to the "not built yet"
 *     placeholder for a remote that exists-but-is-broken would be dishonest.
 *   - remote NOT registered (or the manifest is unreadable) -> the honest TODO
 *     placeholder, preserving the honest-disclosure invariant: a ROLE_GAMES /
 *     derived ROLE_GAMES_ADMIN holder sees an explicit TODO, never a silent 404
 *     or a faked surface.
 *
 * Remote contract (mirrors the './routes' convention of every sibling):
 *   games       -> hugmesh-games-ui        exposes './routes' -> GAMES_ROUTES
 *   games-admin -> hugmesh-games-admin-ui  exposes './routes' -> GAMES_ADMIN_ROUTES
 *
 * Neither remote exists yet (2026-09: no hugmesh-games-ui / games-admin repo;
 * hugmesh-games' frontend is its own standalone HOST, not a remote), so neither
 * is registered in `assets/federation.manifest.json`. The day one ships, adding
 * its manifest entry mounts it here with NO code change; the fallback
 * components + their specs can then be deleted.
 *
 * NOTE (runtime behavior, MEASURED against the installed
 * @softarc/native-federation-runtime — see `remoteLoadOptions()`): the
 * name-only `loadRemoteModule(name, exposed)` form throws `unknown remote` for
 * any remote `initFederation()` did not process at boot. This loader therefore
 * passes the manifest entry as `remoteEntry`, which `ensureRemoteInitialized()`
 * uses to fetch-and-register a not-yet-registered remote on demand — so the
 * manifest entry really is the single switch, even when the entry appears
 * without a host rebuild/reboot. It deliberately does NOT also pass
 * `remoteName`; `remoteLoadOptions()` records why, with the measurement.
 */

/** Same asset `main.ts` boots `initFederation()` from — keep the two in sync. */
export const FEDERATION_MANIFEST_URL = 'assets/federation.manifest.json';

export const GAMES_REMOTE = 'games';
export const GAMES_ROUTES_CONST = 'GAMES_ROUTES';
export const GAMES_ADMIN_REMOTE = 'games-admin';
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
 * The broken row is the likely real configuration: the placeholder already
 * names the future remote `hugmesh-games-ui`, and a native-federation remote's
 * `federation.config.js` name is conventionally its own package name, not the
 * host's manifest key.
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
 * loadChildren body for a games-namespace mount: the real remote when the
 * manifest registers `remoteName`, the honest placeholder otherwise.
 */
export async function loadGamesChildRoutes(
  remoteName: string,
  routesConst: string,
  placeholder: () => Promise<Routes>,
  deps: GamesRemoteDeps = DEFAULT_DEPS,
): Promise<Routes> {
  let entry: string | undefined;
  try {
    const manifest = await deps.fetchManifest();
    entry = manifest?.[remoteName];
  } catch {
    // Manifest unreadable -> the host cannot know a remote exists; the honest
    // placeholder beats a guaranteed-broken mount. (initFederation already
    // surfaced the underlying failure at boot.)
    entry = undefined;
  }
  if (typeof entry !== 'string' || entry.length === 0) {
    return placeholder();
  }
  // Registered: behave exactly like a sibling remote mount — failures propagate.
  const mod = await deps.loadRemote(remoteName, entry, './routes');
  const routes = mod[routesConst];
  if (!Array.isArray(routes)) {
    throw new Error(`remote '${remoteName}' './routes' did not export ${routesConst}`);
  }
  return routes as Routes;
}

/** Unregistered-remote fallback for /games (see GamesPlaceholderComponent). */
export async function gamesPlaceholderRoutes(): Promise<Routes> {
  const { GamesPlaceholderComponent } = await import('./games-placeholder.component');
  return [{ path: '', component: GamesPlaceholderComponent }];
}

/** Unregistered-remote fallback for /games/admin (see GamesAdminPlaceholderComponent). */
export async function gamesAdminPlaceholderRoutes(): Promise<Routes> {
  const { GamesAdminPlaceholderComponent } = await import('./games-admin-placeholder.component');
  return [{ path: '', component: GamesAdminPlaceholderComponent }];
}
