import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/** Gate the /mod route (the federated hugmesh-mod-ui remote) on the Casdoor
 *  moderator role (session.isMod: 'mod' ONLY — the sibling rule, admin is NOT
 *  auto a mod here unless ALSO ROLE_MOD). Previously this route was guarded
 *  only by registeredGuard — any fully-registered user, not just moderators,
 *  could reach it. Non-moderators (including a bare admin) are sent to /login. */
export const modGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.isMod()) return true;
  return router.parseUrl('/login');
};
