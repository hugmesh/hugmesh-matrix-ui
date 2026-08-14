import { inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

/**
 * This remote's MOUNT POINT, as an ActivatedRoute to resolve in-app links against.
 *
 * Every MATRIX route is a sibling under one parent, so the parent of whatever
 * route is active IS where the remote is mounted: `/social/matrix` under the host
 * shell, `/` when the remote runs standalone.
 *
 * Absolute links (`['/rooms', id]`) are WRONG under the shell: the injected
 * Router is the SHELL's, whose root is `/`, so `/rooms/<id>` matches no shell
 * route and its fallback bounces the user to `/user` — clicking a room navigated
 * out of Matrix entirely (operator report 2026-08-14). They only appeared to work
 * when the remote was loaded DIRECTLY at /social/matrix, where its own router owns
 * the URL. Identical defect, identical fix, to hugmesh-mastodon-ui's reply bubble.
 */
export function mountRoute(): ActivatedRoute {
  const route = inject(ActivatedRoute);
  return route.parent ?? route;
}
