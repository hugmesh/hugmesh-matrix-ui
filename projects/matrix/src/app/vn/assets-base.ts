/**
 * Where this remote's own shipped asset tree lives, as an ABSOLUTE URL.
 *
 * THE TRAP: a bare relative string like `'assets/vn/'` is resolved by `fetch()`
 * (and by `new Image().src` / an `<img src>` binding) against the DOCUMENT's URL
 * — NOT against the Angular app's base href, and NOT against this remote's
 * mount. Standalone that is harmless, because the document already sits inside
 * the remote. Federated into the host shell the document is the SHELL, at
 * `/social/matrix` with no trailing slash, so `assets/vn/scenes/scenes.json`
 * resolves to `/assets/vn/scenes/scenes.json` at the SHELL ROOT and 404s.
 * Verified live on the operator mesh 2026-08-14:
 * `https://localhost:8488/assets/vn/scenes/scenes.json` → 404, while the file
 * is present in the remote's own container at
 * `/usr/share/nginx/html/assets/vn/scenes/scenes.json`.
 *
 * `import.meta.url` is the URL of the very chunk this module is bundled into,
 * which is served from the remote's own mount in BOTH cases (`/social/matrix/…`
 * federated, `/` standalone) — so anchoring on it needs no hardcoded mount path
 * and no build-time base href. `document.baseURI` is the fallback for a non-ESM
 * or test context.
 *
 * Ported verbatim in spirit from the canonical fix in
 * hugmesh-character-studio-ui (`src/app/character-studio/services/assets-base.ts`),
 * which learned the hard way that fixing only the manifest loader leaves every
 * PART image on the bare string — the same bug, one layer down. Every consumer
 * of the asset tree MUST anchor here: {@link SvgRigService} (`assets/vn/`) and
 * {@link SceneService} (`assets/vn/scenes/`) both do.
 */

/**
 * The anchor URL asset paths resolve against: this module's own chunk URL, with
 * the document as a non-ESM/test fallback. Exported for {@link assetsBaseFrom}
 * tests — production code should call {@link resolveAssetsBase}.
 */
export function assetsAnchor(): string {
  return typeof import.meta?.url === 'string'
    ? import.meta.url
    : typeof document !== 'undefined'
      ? document.baseURI
      : '/';
}

/**
 * Resolve `relative` against an explicit `anchor`. Pure, so a test can prove the
 * shell-mounted case without a shell.
 */
export function assetsBaseFrom(anchor: string, relative = 'assets/vn/'): string {
  try {
    // Chunks are emitted beside index.html, so the module's directory IS the
    // app root; new URL() normalises it into an absolute href.
    return new URL(relative, anchor).href;
  } catch {
    return relative;
  }
}

/**
 * The absolute URL of `relative` (default `assets/vn/`) inside THIS remote,
 * whichever mount it is served from.
 */
export function resolveAssetsBase(relative = 'assets/vn/'): string {
  return assetsBaseFrom(assetsAnchor(), relative);
}
