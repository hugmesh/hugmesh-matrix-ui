import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Phase 8/10 DERIVED ROLE_GAMES_ADMIN mount. This is a GUARDED PLACEHOLDER (see
 * gamesAdminGuard on the /games/admin route), NOT a federated mount: no
 * games-admin UI remote exists yet, so there is deliberately NO
 * loadRemoteModule('gamesAdmin') here.
 *
 * Honest-disclosure invariant: this NEVER fakes a working games-admin console —
 * a derived ROLE_GAMES_ADMIN holder reaching /games/admin sees an explicit TODO,
 * not a silent 404 or a faked success state.
 *
 * TODO(games-admin-ui): swap this placeholder for the real games-admin UI remote.
 */
@Component({
  selector: 'hug-games-admin-placeholder',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section data-testid="games-admin-placeholder">
      <span data-testid="games-admin-todo-badge">TODO</span>
      <h1>Games admin</h1>
      <p data-testid="games-admin-placeholder-message">
        You have the derived games-admin role, but the games-admin
        micro-frontend
        (<code data-testid="games-admin-future-remote">{{ futureRemote }}</code>)
        has not been built yet. This is a placeholder route — no remote is
        mounted here.
      </p>
      <a routerLink="/" data-testid="games-admin-back">Back to home</a>
    </section>
  `,
})
export class GamesAdminPlaceholderComponent {
  /** Surfaced in the template so the TODO is impossible to miss. */
  readonly futureRemote = 'hugmesh-games-admin-ui';
}
