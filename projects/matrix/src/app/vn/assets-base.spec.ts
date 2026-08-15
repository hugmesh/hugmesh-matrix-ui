import { assetsAnchor, assetsBaseFrom, resolveAssetsBase } from './assets-base';

/**
 * The regression guard for the FEDERATED 404 the operator hit on 2026-08-14:
 * `https://localhost:8488/assets/vn/scenes/scenes.json` → 404, because the VN
 * asset bases were bare relative strings resolved against the SHELL document
 * rather than against this remote's own module chunk.
 */
/** Any absolute URL (has a scheme). The karma harness rewrites `import.meta.url`
 *  to a `file://` source URL; the shipped native-federation bundle keeps the real
 *  `https://` chunk URL (verified in the deployed studio bundle). Either way the
 *  point of the assertion is the same: NOT the bare relative string. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

describe('assets-base', () => {
  // The shell mounts this remote at /social/matrix WITHOUT a trailing slash, so
  // the document's directory is /social/ — one level ABOVE the remote.
  const SHELL_DOCUMENT = 'https://mesh.example/social/matrix';
  // The chunk this module is bundled into is always served from the remote's own
  // mount, in either host.
  const MODULE_CHUNK = 'https://mesh.example/social/matrix/chunk-4CLCTAJ7.js';
  const STANDALONE_CHUNK = 'https://matrix.mesh.example/chunk-4CLCTAJ7.js';

  it('anchors on the MODULE chunk, not the document — the federated 404', () => {
    expect(assetsBaseFrom(MODULE_CHUNK)).toBe('https://mesh.example/social/matrix/assets/vn/');
    expect(assetsBaseFrom(MODULE_CHUNK, 'assets/vn/scenes/'))
      .toBe('https://mesh.example/social/matrix/assets/vn/scenes/');

    // What the OLD bare-string code did: resolved against the shell document and
    // landed a directory too high, which is exactly the observed 404 path.
    expect(new URL('assets/vn/scenes/', SHELL_DOCUMENT).href)
      .toBe('https://mesh.example/social/assets/vn/scenes/');
    expect(assetsBaseFrom(MODULE_CHUNK, 'assets/vn/scenes/'))
      .not.toBe(new URL('assets/vn/scenes/', SHELL_DOCUMENT).href);
  });

  it('still resolves inside the remote when it runs STANDALONE at the origin root', () => {
    expect(assetsBaseFrom(STANDALONE_CHUNK)).toBe('https://matrix.mesh.example/assets/vn/');
  });

  it('never emits a shell-root path for the scenes manifest', () => {
    const url = `${assetsBaseFrom(MODULE_CHUNK, 'assets/vn/scenes/')}scenes.json`;
    expect(url).toBe('https://mesh.example/social/matrix/assets/vn/scenes/scenes.json');
    expect(new URL(url).pathname).not.toBe('/assets/vn/scenes/scenes.json');
  });

  it('falls back to the bare relative path when the anchor is unusable', () => {
    expect(assetsBaseFrom('not a url', 'assets/vn/')).toBe('assets/vn/');
  });

  it('resolveAssetsBase() produces an ABSOLUTE url ending in the requested path', () => {
    const base = resolveAssetsBase();
    // A bare 'assets/vn/' — the defect — would fail both of these.
    expect(base).toMatch(ABSOLUTE_URL);
    expect(base.endsWith('assets/vn/')).toBeTrue();
    expect(resolveAssetsBase('assets/vn/scenes/')).toBe(assetsBaseFrom(assetsAnchor(), 'assets/vn/scenes/'));
  });

  it('takes its anchor from the module graph, not from the HTML document', () => {
    const anchor = assetsAnchor();
    expect(anchor).toMatch(ABSOLUTE_URL);
    // Equality with the document would mean the resolver had fallen back to
    // document.baseURI — precisely the defect. Under karma the module resolves
    // to a file:// source URL while the document is the http:// karma context
    // page, so this comparison is a real discriminator here.
    expect(anchor).not.toBe(document.baseURI);
    expect(resolveAssetsBase()).not.toBe(new URL('assets/vn/', document.baseURI).href);
  });
});
