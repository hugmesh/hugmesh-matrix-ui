import DOMPurify from 'dompurify';

/**
 * CLIENT-SIDE SVG sanitization — PREVIEW ONLY, NOT AUTHORITATIVE.
 *
 * VENDORED (Path A, B2) from hugmesh-character-studio-ui
 * `src/app/character-studio/util/svg-sanitize.client.ts` — native-federation
 * forbids a shared cross-remote runtime import, so the matrix remote ships its
 * OWN byte-faithful copy. In matrix-ui this hardens the composed character SVG
 * before it is base64/`encodeURIComponent`d into a `data:`/`blob:` URL for an
 * `<img src>`. Note the live-render XSS boundary is the `<img>` itself (an
 * `<img>`-rendered SVG cannot execute script — no inline-event/script context),
 * so the panel never touches `[innerHTML]`/`bypassSecurityTrustHtml`; this pass
 * is defense-in-depth on top of that boundary, matching the studio source.
 *
 * User-drawn SVG is a stored-XSS vector. This DOMPurify pass (svg profile +
 * hardening) makes a drawn part safe enough to render in the live preview, but
 * it is NOT the security boundary: before any drawn part is persisted or served,
 * the user-bff server-side sanitizer (allowlist safe-subset) must re-sanitize it
 * — SANITIZE → MODERATE → STORE. Never trust client output. See
 * hugmesh-vn-character-studio-v2 §0/§2.
 */
export function sanitizeSvgClient(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // belt-and-braces over the profile defaults: no scripting / external-ref vectors.
    FORBID_TAGS: ['foreignObject', 'use', 'image', 'a', 'script', 'style', 'iframe'],
    FORBID_ATTR: ['href', 'xlink:href', 'onload', 'onclick', 'onmouseover'],
    // keep the region recolor classes
    ADD_ATTR: ['class'],
    // strip DOCTYPE/processing-instructions (XXE-ish surface)
    WHOLE_DOCUMENT: false,
  });
}
