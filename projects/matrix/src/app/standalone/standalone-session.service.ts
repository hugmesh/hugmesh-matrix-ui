import { Injectable, inject, signal } from '@angular/core';
import { SessionService, HugSession } from '../session.service';

export type StandaloneState = 'loading' | 'signed-out' | 'signed-in' | 'error';

/** Why a sign-in attempt did not work, in words a person can act on. */
export type LoginProblem = 'wrong-credentials' | 'too-many-attempts' | 'unavailable' | null;

/**
 * The sign-in state of a STANDALONE deployment (hugmesh-tuwunel-web in front of a Tuwunel homeserver). There is no host
 * shell and no Casdoor: the user types their Matrix username and password into this app, the web service logs in to the
 * homeserver and keeps the access token on the server, so the browser only ever holds an opaque HttpOnly session cookie.
 * This service asks `/bff/user/session` who that cookie belongs to and fills the same {@link SessionService} the rest of
 * the UI already reads.
 */
@Injectable({ providedIn: 'root' })
export class StandaloneSessionService {
  private readonly session = inject(SessionService);

  readonly state = signal<StandaloneState>('loading');
  readonly problem = signal<LoginProblem>(null);
  readonly busy = signal(false);

  /** Reads the session once at start-up. Never throws. */
  async init(): Promise<void> {
    try {
      const r = await fetch('/bff/user/session', { credentials: 'include', cache: 'no-store' });
      if (r.status === 401) {
        this.session.clear();
        this.state.set('signed-out');
        return;
      }
      if (!r.ok) {
        this.state.set('error');
        return;
      }
      const s = (await r.json()) as HugSession;
      // The UI reads the homeserver NAME (for mxc:// links) from this hook; a standalone server's name is the part of the
      // user id after the colon. Set it before anything that injects the Matrix service runs.
      const server = StandaloneSessionService.serverName(s.id);
      if (server) (globalThis as any).__HUG_MATRIX_URL__ = `https://${server}`;
      this.session.set(s);
      this.state.set('signed-in');
    } catch {
      this.state.set('error');
    }
  }

  /** Sign in with a Matrix username and password. Resolves to true when the server accepted them. */
  async login(username: string, password: string): Promise<boolean> {
    this.problem.set(null);
    if (!username.trim() || !password) {
      this.problem.set('wrong-credentials');
      return false;
    }
    this.busy.set(true);
    try {
      const r = await fetch('/bff/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (r.status === 429) {
        this.problem.set('too-many-attempts');
        return false;
      }
      if (r.status === 401 || r.status === 403) {
        this.problem.set('wrong-credentials');
        return false;
      }
      if (!r.ok) {
        this.problem.set('unavailable');
        return false;
      }
      await this.init();
      return this.state() === 'signed-in';
    } catch {
      this.problem.set('unavailable');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async signOut(): Promise<void> {
    try {
      await fetch('/bff/logout', { method: 'POST', credentials: 'include' });
    } catch {
      /* the local state is cleared either way; the session cookie expires on its own */
    }
    this.session.clear();
    this.state.set('signed-out');
  }

  /** `@alice:example.org` -> `example.org`; anything else -> ''. */
  static serverName(userId: string): string {
    const m = /^@[^:]+:(.+)$/.exec(userId ?? '');
    return m ? m[1] : '';
  }
}
