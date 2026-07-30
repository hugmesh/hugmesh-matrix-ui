import { Injectable, signal, computed } from '@angular/core';

export interface HugSession {
  id: string;                 // casdoor identity, e.g. google:alice@gmail.com
  label: string;              // display (email or discord handle)
  provider: 'google' | 'discord' | 'password' | 'oidc';  // 'password' = native username/password login
  roles: string[];
  registrationComplete: boolean;
  // No bearer token is ever held here — auth rides on the HttpOnly `bff_`
  // session cookie (credentials: 'include' on every /bff/* call).
}

/**
 * NATIVE-LOGIN cookie-session mode. When the shell sets
 * {@code globalThis.__HUG_SESSION_COOKIE_MODE__ = true}, the browser holds ONLY the
 * opaque httpOnly {@code bff_} cookie — the session metadata is NOT persisted to
 * localStorage, so the host must hydrate it from {@code GET /bff/session} (the login-ui
 * remote runs the same mode). Off (legacy) it reads the persisted {@code hug.session}.
 */
function cookieModeEnabled(): boolean {
  return (globalThis as unknown as Record<string, unknown>)['__HUG_SESSION_COOKIE_MODE__'] === true;
}
/** Same-origin BFF base ('' → relative, proxied); mirrors the login-ui BffService. */
const BFF_BASE = ((globalThis as unknown as Record<string, unknown>)['__HUG_BFF_URL__'] as string) ?? '';

/** Holds the logged-in session and derives the Casdoor-style role flags + the
 *  registration-complete gate the host uses to unlock the Matrix/Mastodon
 *  micro-frontends. Legacy mode persists to localStorage; native cookie mode
 *  hydrates from {@code GET /bff/session} (nothing is persisted). */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly key = 'hug.session';
  private readonly channel = 'hug-session-change';
  readonly session = signal<HugSession | null>(this.load());
  readonly loggedIn = computed(() => this.session() !== null);
  readonly isAdmin = computed(() => (this.session()?.roles ?? []).includes('admin'));
  /** Moderator ENTRY-POINT (Phase 10): the Casdoor 'mod' role ONLY. Sibling rule
   *  (generator spec 18): admin is NOT auto a mod in the nav/route unless ALSO
   *  ROLE_MOD — matches the platform-wide "systems" host convention (an admin
   *  without the explicit mod role does not reach /mod through this shell).
   *  This is intentionally STRICTER than the matrix remote's OWN
   *  SessionService.isMod (mod OR admin, mirroring mod-bff-api's
   *  hasAnyRole('MOD','ADMIN') defence-in-depth for actual moderation actions
   *  once inside) — that is a separate file with its own established contract
   *  this change does not touch; this host-shell gate is nav/route ENTRY only. */
  readonly isMod = computed(() => (this.session()?.roles ?? []).includes('mod'));
  /** GAMES entry-point role (Phase 8): plain ROLE_GAMES grants access to the games
   *  namespace ENTRY-POINT ONLY — it does NOT by itself grant games ADMIN (see
   *  {@link isGamesAdmin}). Lowercase 'games' role string, mirroring isAdmin/isMod. */
  readonly isGames = computed(() => (this.session()?.roles ?? []).includes('games'));
  /** GAMES-ADMIN role (Phase 8/10): mirrors the server-computed DERIVED role
   *  materialized by manifests/casdoor/games-admin-sync-job.yaml —
   *      ROLE_GAMES_ADMIN = ROLE_GAMES ∩ (ROLE_ADMIN ∪ ROLE_MOD)
   *  — i.e. ROLE_GAMES_ADMIN is NEVER granted directly; it is earned by holding
   *  ROLE_GAMES together with either ROLE_ADMIN or ROLE_MOD. A bare ROLE_GAMES
   *  (e2e-gamesonly) or a bare ROLE_ADMIN (e2e-adminonly) must NOT earn it
   *  (default-deny). This client-side derivation is defence-in-depth only — the
   *  sync job + gateway route-access rows are the real authorization boundary —
   *  so it must never grant a tier the server wouldn't also grant. */
  readonly isGamesAdmin = computed(() => this.isGames() && (this.isAdmin() || this.isMod()));
  /** Matrix/Mastodon are usable only after full registration completes. */
  readonly fullyRegistered = computed(() => this.session()?.registrationComplete === true);

  constructor() {
    // The host shell and each federated remote each hold their OWN SessionService
    // instance over the same session state. Re-sync on a same-document broadcast
    // (dispatched by whichever instance wrote) so every nav/guard reading this signal
    // stays in sync — e.g. the login remote completing registration must unlock the
    // host shell's Matrix/Mastodon nav.
    if (typeof window !== 'undefined') {
      if (cookieModeEnabled()) {
        // NATIVE cookie mode: nothing is persisted to localStorage. Hydrate from
        // GET /bff/session on init, and RE-hydrate on the same-document broadcast the
        // login remote fires after login/complete (its detail can't be trusted across
        // remote builds, so we re-read the authoritative /bff/session instead of
        // this.load(), which would read an always-empty localStorage in this mode).
        void this.hydrate();
        window.addEventListener(this.channel, () => { void this.hydrate(); });
      } else {
        window.addEventListener(this.channel, () => this.session.set(this.load()));
        window.addEventListener('storage', (e) => { if (e.key === this.key) this.session.set(this.load()); });
      }
    }
  }

  /**
   * NATIVE cookie mode: hydrate the non-secret session identity from
   * {@code GET /bff/session} — the bff_ cookie rides via {@code credentials:'include'}.
   * A non-OK response means "not logged in". No-op in legacy localStorage mode.
   */
  async hydrate(): Promise<HugSession | null> {
    if (!cookieModeEnabled() || typeof fetch === 'undefined') { return this.session(); }
    try {
      const r = await fetch(`${BFF_BASE}/bff/session`, {
        method: 'GET', credentials: 'include', headers: { accept: 'application/json' },
      });
      if (!r.ok) { this.session.set(null); return null; }
      const d = (await r.json()) as Partial<HugSession>;
      const s: HugSession = {
        id: d.id ?? '', label: d.label ?? '',
        provider: (d.provider as HugSession['provider']) ?? 'password',
        roles: Array.isArray(d.roles) ? d.roles : [],
        registrationComplete: !!d.registrationComplete,
      };
      this.session.set(s);
      return s;
    } catch { this.session.set(null); return null; }
  }

  private load(): HugSession | null {
    // Cookie mode starts EMPTY — the session is hydrated from GET /bff/session, never
    // from web storage (nothing is persisted there in the native model).
    if (cookieModeEnabled()) { return null; }
    try { const raw = localStorage.getItem(this.key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  set(s: HugSession): void { localStorage.setItem(this.key, JSON.stringify(s)); this.session.set(s); this.broadcast(); }
  patch(p: Partial<HugSession>): void { const s = this.session(); if (s) this.set({ ...s, ...p }); }
  clear(): void { localStorage.removeItem(this.key); this.session.set(null); this.broadcast(); }
  /** Notify the other in-page SessionService instances (host + remotes) to re-read. */
  private broadcast(): void { if (typeof window !== 'undefined') window.dispatchEvent(new Event(this.channel)); }
}
