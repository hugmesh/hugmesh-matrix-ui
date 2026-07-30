import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/** Gate the admin micro-frontend on the Casdoor admin role. */
export const adminGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.isAdmin()) return true;
  return router.parseUrl('/login');
};
