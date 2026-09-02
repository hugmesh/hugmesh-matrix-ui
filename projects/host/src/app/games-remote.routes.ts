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
 * NOTE (runtime behavior, verified against @softarc/native-federation-runtime):
 * the name-only `loadRemoteModule(name, exposed)` form throws `unknown remote`
 * for any remote `initFederation()` did not process at boot. This loader
 * therefore passes the manifest entry as `remoteEntry` too, which
 * `ensureRemoteInitialized()` uses to fetch-and-register a not-yet-registered
 * remote on demand — so the manifest entry really is the single switch, even
 * when the entry appears without a host rebuild/reboot.
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

const DEFAULT_DEPS: GamesRemoteDeps = {
  fetchManifest: fetchFederationManifest,
  loadRemote: (remoteName, remoteEntryUrl, exposedModule) =>
    loadRemoteModule({ remoteName, remoteEntry: remoteEntryUrl, exposedModule }),
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
