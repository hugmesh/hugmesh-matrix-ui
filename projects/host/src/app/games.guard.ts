import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/** Gate the GAMES entry-point mount (Phase 8, route 'games') on the games access
 *  tier. Mirrors modGuard/adminGuard: allow vs the exact /login redirect.
 *
 *  GAMES entry-point cascade: a plain ROLE_GAMES member reaches the entry point
 *  (this is the ENTRY-POINT gate ONLY — it does NOT admit games ADMIN, see
 *  {@link gamesAdminGuard}), plus an ADMIN always reaches it (oversight). A bare
 *  MOD without ROLE_GAMES is NOT admitted. */
export const gamesGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.isGames() || session.isAdmin()) return true;
  return router.parseUrl('/login');
};
