import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Phase 8 ROLE_GAMES entry-point. This is a GUARDED PLACEHOLDER (see gamesGuard
 * on the /games route), NOT a federated mount: no games-namespace UI remote
 * exists (or is registered in federation.manifest.json) yet, so there is
 * deliberately NO loadRemoteModule('games') here.
 *
 * Honest-disclosure invariant: this NEVER fakes a working games surface — a
 * ROLE_GAMES holder reaching /games sees an explicit TODO, not a silent 404 or a
 * faked success state.
 *
 * TODO(games-ui): swap this placeholder for the real games-namespace UI remote.
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
        not been built yet. This is a placeholder route — no remote is mounted
        here.
      </p>
      <a routerLink="/" data-testid="games-back">Back to home</a>
    </section>
  `,
})
export class GamesPlaceholderComponent {
  /** Surfaced in the template so the TODO is impossible to miss. */
  readonly futureRemote = 'hugmesh-games-ui';
}
