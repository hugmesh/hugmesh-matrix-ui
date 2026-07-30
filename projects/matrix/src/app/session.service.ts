import { Injectable, signal, computed } from '@angular/core';

export interface HugSession {
  id: string;                 // casdoor identity, e.g. google:alice@gmail.com
  label: string;              // display (email or discord handle)
  provider: 'google' | 'discord';
  roles: string[];
  registrationComplete: boolean;
  // No bearer token is ever held here. Auth rides on the HttpOnly `bff_` session
  // cookie (credentials: 'include' on every /bff/* call) — the gateway's
  // BffCookieToBearerWebFilter mints the upstream bearer server-side. See
  // UserBffService/ModBffService/MatrixService and the README's Session section.
}

/** Holds the logged-in session (persisted to localStorage) and derives the
 *  Casdoor-style role tier flags the role-responsive surfaces gate on.
 *
 *  Copied from the canonical hugmesh-mod-ui SessionService (which already
 *  carries both isAdmin + isMod) and extended with an explicit `isUser` accessor
 *  for the USER tier. The role strings in `roles[]` are the LOWERCASE Casdoor
 *  roles ('user' | 'mod' | 'admin'); the bff-apis enforce the matching
 *  ROLE_USER/MOD/ADMIN @PreAuthorize server-side, so this UI gating is
 *  defence-in-depth only (it must never SHOW a tier the role can't use).
 *
 *  The role-tier invariant (USER never sees MOD/ADMIN; MOD never sees ADMIN) is
 *  satisfied because the tiers are ADDITIVE: isMod is true for mod OR admin, and
 *  isAdmin is true only for admin — so a mod's isAdmin is false and a plain
 *  user's isMod/isAdmin are both false. */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly key = 'hug.session';
  private readonly channel = 'hug-session-change';
  readonly session = signal<HugSession | null>(this.load());
  readonly loggedIn = computed(() => this.session() !== null);

  /** USER tier — every authenticated user. (A logged-in session always carries
   *  at least the 'user' role; we key off loggedIn so the tier renders even if
   *  the roles array is momentarily empty.) */
  readonly isUser = computed(() => this.session() !== null);

  /** Moderator surface: a Casdoor 'mod' OR 'admin' role unlocks it, matching the
   *  mod-bff-api's defence-in-depth hasAnyRole('MOD','ADMIN'). */
  readonly isMod = computed(() => {
    const roles = this.session()?.roles ?? [];
    return roles.includes('mod') || roles.includes('admin');
  });

  /** Admin surface: ONLY a Casdoor 'admin' role. */
  readonly isAdmin = computed(() => (this.session()?.roles ?? []).includes('admin'));

  /**
   * SOCIAL LOCAL-ONLY marker — true when the caller is Matrix DOMAIN-LOCKED.
   *
   * This is NOT a tier; it is an ADDITIVE *restriction* flag. The admin-bff
   * (PR #26 domainlock pass-through) lifts the `ROLE_MATRIX_DOMAINLOCKED`
   * marker authority off the validated JWT and folds it into the session
   * `roles[]` as the LOWERCASE string `matrix_domainlocked` (see
   * AuthController#domainlockRoles / #mergeRoles). When present, the Matrix
   * compose/room/federation surface must force LOCAL-ONLY: any cross-domain /
   * federation target is greyed-out with WHY-helptext, while local interaction
   * stays fully usable. UI gating here is defence-in-depth — the homeserver /
   * BFF still enforces force-local server-side — so it must never grey out a
   * local action, only federation targets. */
  readonly isMatrixDomainLocked = computed(() =>
    (this.session()?.roles ?? []).includes('matrix_domainlocked'));

  /** Matrix/Mastodon are usable only after full registration completes. */
  readonly fullyRegistered = computed(() => this.session()?.registrationComplete === true);

  constructor() {
    // The host shell and each federated remote each hold their OWN SessionService
    // instance over the same localStorage key. Re-read on a same-document broadcast
    // (dispatched by whichever instance wrote) and on cross-tab storage events, so
    // every nav/guard reading this signal stays in sync — e.g. the login remote
    // completing registration must unlock the host shell's Matrix/Mastodon nav.
    if (typeof window !== 'undefined') {
      window.addEventListener(this.channel, () => this.session.set(this.load()));
      window.addEventListener('storage', (e) => { if (e.key === this.key) this.session.set(this.load()); });
    }
  }

  private load(): HugSession | null {
    try { const raw = localStorage.getItem(this.key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  set(s: HugSession): void { localStorage.setItem(this.key, JSON.stringify(s)); this.session.set(s); this.broadcast(); }
  patch(p: Partial<HugSession>): void { const s = this.session(); if (s) this.set({ ...s, ...p }); }
  clear(): void { localStorage.removeItem(this.key); this.session.set(null); this.broadcast(); }
  /** Notify the other in-page SessionService instances (host + remotes) to re-read. */
  private broadcast(): void { if (typeof window !== 'undefined') window.dispatchEvent(new Event(this.channel)); }
}
