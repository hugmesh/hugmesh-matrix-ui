import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Phase 8/10 DERIVED ROLE_GAMES_ADMIN mount — UNREGISTERED-REMOTE FALLBACK
 * (issue #2). /games/admin is now a manifest-driven federated mount (see
 * games-remote.routes.ts): when `federation.manifest.json` registers the
 * `games-admin` remote, its exposed GAMES_ADMIN_ROUTES mount there and this
 * component is never reached. While no games-admin UI remote exists (or is
 * registered), the loader falls back here.
 *
 * Honest-disclosure invariant: this NEVER fakes a working games-admin console —
 * a derived ROLE_GAMES_ADMIN holder reaching /games/admin sees an explicit TODO,
 * not a silent 404 or a faked success state.
 *
 * TODO(games-admin-ui): once the games-admin remote ships and its `games-admin`
 * manifest entry lands, delete this fallback component + its spec (the mount
 * needs no change).
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
        has not been built yet, so no <code>games-admin</code> remote is
        registered in the federation manifest. This is a placeholder fallback —
        no remote is mounted here.
      </p>
      <a routerLink="/" data-testid="games-admin-back">Back to home</a>
    </section>
  `,
})
export class GamesAdminPlaceholderComponent {
  /** Surfaced in the template so the TODO is impossible to miss. */
  readonly futureRemote = 'hugmesh-games-admin-ui';
}
