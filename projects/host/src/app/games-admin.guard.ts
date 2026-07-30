import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/** Gate the GAMES-ADMIN mount (Phase 8/10, route 'games/admin') on the DERIVED
 *  ROLE_GAMES_ADMIN tier (session.isGamesAdmin — ROLE_GAMES ∩ (ROLE_ADMIN ∪
 *  ROLE_MOD)). A bare ROLE_GAMES (e2e-gamesonly) or a bare ROLE_ADMIN
 *  (e2e-adminonly) does NOT earn it. Mirrors modGuard/adminGuard: allow vs the
 *  exact /login redirect. */
export const gamesAdminGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.isGamesAdmin()) return true;
  return router.parseUrl('/login');
};
