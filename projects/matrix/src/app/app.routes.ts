import { Routes } from '@angular/router';
import { MATRIX_ROUTES } from './matrix.routes';

/** Dev-shell routes: mount the exposed Matrix routes at the root so the remote
 *  is browsable standalone. The host ignores this and loads `./routes`. */
export const routes: Routes = [{ path: '', children: MATRIX_ROUTES }];
