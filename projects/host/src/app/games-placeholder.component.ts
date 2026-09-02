import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Phase 8 ROLE_GAMES entry-point — UNREGISTERED-REMOTE FALLBACK (issue #2).
 * /games is now a manifest-driven federated mount (see games-remote.routes.ts):
 * when `federation.manifest.json` registers the `games` remote, its exposed
 * GAMES_ROUTES mount there and this component is never reached. While no
 * games-namespace UI remote exists (or is registered), the loader falls back
 * here.
 *
 * Honest-disclosure invariant: this NEVER fakes a working games surface — a
 * ROLE_GAMES holder reaching /games sees an explicit TODO, not a silent 404 or a
 * faked success state.
 *
 * TODO(games-ui): once hugmesh-games-ui ships and its `games` manifest entry
 * lands, delete this fallback component + its spec (the mount needs no change).
 */
@Component({
  selector: 'hug-games-placeholder',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section data-testid="games-placeholder">
      <span data-testid="games-todo-badge">TODO</span>
      <h1>Games</h1>
      <p data-testid="games-placeholder-message">
        You have the games role, but the games micro-frontend
        (<code data-testid="games-future-remote">{{ futureRemote }}</code>) has
        not been built yet, so no <code>games</code> remote is registered in
        the federation manifest. This is a placeholder fallback — no remote is
        mounted here.
      </p>
      <a routerLink="/" data-testid="games-back">Back to home</a>
    </section>
  `,
})
export class GamesPlaceholderComponent {
  /** Surfaced in the template so the TODO is impossible to miss. */
  readonly futureRemote = 'hugmesh-games-ui';
}
