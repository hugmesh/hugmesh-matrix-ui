import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/** Gate the Matrix/Mastodon micro-frontends: usable only after the user has
 *  fully completed registration through our login/registration UI. */
export const registeredGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.fullyRegistered()) return true;
  return router.parseUrl('/login');
};
