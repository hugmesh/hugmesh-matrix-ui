import { routes } from './app.routes';
import { MATRIX_ROUTES } from './matrix.routes';

/**
 * The dev-shell routes (used only by `ng serve matrix` standalone) must mount
 * the exact same MATRIX_ROUTES the host federates, so standalone behaviour
 * matches the federated behaviour.
 */
describe('app.routes (standalone dev shell)', () => {
  it('mounts the exposed MATRIX_ROUTES as children of the root path', () => {
    expect(routes.length).toBe(1);
    expect(routes[0].path).toBe('');
    expect(routes[0].children).toBe(MATRIX_ROUTES);
  });
});
