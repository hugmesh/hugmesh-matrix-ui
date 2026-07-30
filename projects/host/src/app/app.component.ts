import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterOutlet } from '@angular/router';
import { SessionService } from './session.service';

/**
 * Demo host standing in for the hugmesh.systems Angular front page. In
 * production this host federates the login/matrix/mastodon/admin micro-frontends
 * (each its own repo + nginx). Matrix/Mastodon links appear only after full
 * registration; the Admin link only for the Casdoor admin role.
 *
 * Phase 8/10: the Moderation / Games / Games Admin entries follow the
 * disabled+helptext idiom (grey + EXPLAIN, never silently hide) rather than the
 * older *ngIf-hide-entirely pattern above — a signed-in principal lacking the
 * role still sees the entry, disabled, with an aria-describedby reason, so the
 * gate is discoverable rather than invisible.
 */
@Component({
  selector: 'hug-root',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterOutlet],
  template: `
    <header>
      <a routerLink="/" data-testid="brand">hugmesh.systems</a>
      <nav>
        <ng-container *ngIf="session.loggedIn(); else anon">
          <ng-container *ngIf="session.fullyRegistered()">
            <a routerLink="/social/matrix" data-testid="nav-matrix">Matrix</a>
            <a routerLink="/social/mastodon" data-testid="nav-mastodon">Mastodon</a>
          </ng-container>
          <a *ngIf="!session.fullyRegistered()" routerLink="/login" data-testid="nav-complete">Complete registration</a>
          <a *ngIf="session.isAdmin()" routerLink="/admin" data-testid="nav-admin">Admin</a>
          <a *ngIf="session.isAdmin()" routerLink="/admin/usage" data-testid="nav-usage">Usage</a>
          <a *ngIf="session.isAdmin()" routerLink="/admin/namespaces" data-testid="nav-namespaces">Namespaces</a>
          <a *ngIf="session.isAdmin()" [href]="uptraceUrl" target="_blank" data-testid="nav-uptrace">Uptrace</a>

          <!-- ROLE_MOD moderation entry-point (Phase 10): the sibling rule —
               admin is NOT auto a mod in the nav; session.isMod() requires the
               explicit 'mod' role. -->
          <ng-container *ngIf="session.isMod(); else modDisabled">
            <a routerLink="/mod" data-testid="nav-mod">Moderation</a>
          </ng-container>
          <ng-template #modDisabled>
            <span
              class="nav-disabled"
              aria-disabled="true"
              data-testid="nav-mod"
              aria-describedby="nav-mod-help"
              >Moderation</span
            >
            <span id="nav-mod-help" class="field-help" data-testid="nav-mod-help"
              >Sign in as a moderator to use this.</span
            >
          </ng-template>

          <!-- ROLE_GAMES games entry-point (Phase 8): the ENTRY-POINT gate
               ONLY — distinct from Games Admin below (a bare ROLE_GAMES does
               NOT earn games-admin; see SessionService.isGamesAdmin). -->
          <ng-container *ngIf="session.isGames(); else gamesDisabled">
            <a routerLink="/games" data-testid="nav-games">Games</a>
          </ng-container>
          <ng-template #gamesDisabled>
            <span
              class="nav-disabled"
              aria-disabled="true"
              data-testid="nav-games"
              aria-describedby="nav-games-help"
              >Games</span
            >
            <span id="nav-games-help" class="field-help" data-testid="nav-games-help"
              >Sign in as a games member to use this.</span
            >
          </ng-template>

          <!-- DERIVED ROLE_GAMES_ADMIN console (Phase 8/10): ROLE_GAMES ∩
               (ROLE_ADMIN ∪ ROLE_MOD) — session.isGamesAdmin(). A bare games
               member or a bare admin/mod WITHOUT games does not earn it. -->
          <ng-container *ngIf="session.isGamesAdmin(); else gamesAdminDisabled">
            <a routerLink="/games/admin" data-testid="nav-games-admin">Games Admin</a>
          </ng-container>
          <ng-template #gamesAdminDisabled>
            <span
              class="nav-disabled"
              aria-disabled="true"
              data-testid="nav-games-admin"
              aria-describedby="nav-games-admin-help"
              >Games Admin</span
            >
            <span id="nav-games-admin-help" class="field-help" data-testid="nav-games-admin-help"
              >Sign in as a games admin to use this.</span
            >
          </ng-template>

          <span data-testid="nav-user">{{ session.session()?.label }}</span>
          <button data-testid="logout" (click)="logout()">Sign out</button>
        </ng-container>
        <ng-template #anon>
          <a routerLink="/login" data-testid="nav-login">Sign in</a>
        </ng-template>
      </nav>
    </header>
    <main>
      <router-outlet />
      <p *ngIf="!session.loggedIn()" data-testid="welcome">
        Welcome to hugmesh.systems. Sign in to reach the federated
        <strong>Matrix</strong> and <strong>Mastodon</strong> communities.
      </p>
    </main>
  `,
})
export class AppComponent {
  readonly session = inject(SessionService);
  // Admin-only observability link (Uptrace), reached through the pki gateway.
  // The login remote brokers service tokens into the shared session; each
  // remote reads its own token, so the shell injects nothing.
  readonly uptraceUrl = (globalThis as any).__HUG_UPTRACE_URL__ ?? 'https://uptrace.hugmesh.systems';
  logout(): void { this.session.clear(); location.href = '/'; }
}
