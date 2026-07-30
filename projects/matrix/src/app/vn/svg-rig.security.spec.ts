import { TestBed } from '@angular/core/testing';
import { SvgRigService } from './services/svg-rig.service';
import { sanitizeSvgClient } from './util/svg-sanitize.client';
import { VnCharacter } from './models/vn-character';
import { PartManifest } from './models/vn-manifest';

/**
 * The XSS-boundary proof for B2 (Path A): a HOSTILE user-drawn part must be
 * NEUTRALIZED by the client sanitizer AND the composed character must only ever
 * leave as a `data:` URL for an `<img src>` — never markup fed to innerHTML.
 */
describe('VN SVG rig + client sanitize (XSS boundary)', () => {
  let rig: SvgRigService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [SvgRigService] });
    rig = TestBed.inject(SvgRigService);
  });

  it('sanitizeSvgClient strips <script> and inline event handlers', () => {
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<script>alert(1)</script>' +
      '<rect width="10" height="10" onload="alert(2)" onclick="steal()"/>' +
      '<image href="http://evil/x.png"/>' +
      '</svg>';
    const clean = sanitizeSvgClient(hostile);

    expect(clean.toLowerCase()).not.toContain('<script');
    expect(clean.toLowerCase()).not.toContain('onload');
    expect(clean.toLowerCase()).not.toContain('onclick');
    expect(clean.toLowerCase()).not.toContain('alert');
    // external-ref image vector is forbidden too
    expect(clean.toLowerCase()).not.toContain('<image');
    // a benign shape survives
    expect(clean.toLowerCase()).toContain('rect');
  });

  it('strips <foreignObject> (HTML-into-SVG escape) and javascript: hrefs', () => {
    // The two highest-signal SVG-XSS escapes beyond <script>/on*: a <foreignObject>
    // re-enters the HTML parser (smuggling scriptable markup), and a javascript: href
    // on <a> executes on activation. Both MUST be neutralized; this pins the regression
    // net so a future loosening of the sanitizer's FORBID_TAGS can't pass silently.
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">' +
      '<script>alert(3)</script><img src="x" onerror="alert(4)"/></body></foreignObject>' +
      '<a href="javascript:alert(5)"><rect width="4" height="4"/></a>' +
      '</svg>';
    const clean = sanitizeSvgClient(hostile).toLowerCase();

    expect(clean).not.toContain('<foreignobject');
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('alert');
    // a benign shape outside the hostile wrappers still survives
    expect(clean).toContain('rect');
  });

  it('composeSanitizedDataUrl neutralizes a hostile user-drawn part and yields a data: URL', async () => {
    const def: VnCharacter = {
      schemaVersion: 1,
      packId: 'p',
      name: 'X',
      slots: { body: null },
      palette: {},
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      defaultExpression: 'neutral',
      userParts: {
        body: {
          svgInline:
            '<svg xmlns="http://www.w3.org/2000/svg">' +
            '<script>alert(1)</script>' +
            '<circle cx="5" cy="5" r="4" onload="alert(2)"/>' +
            '</svg>',
          tintRegions: [],
        },
      },
    };
    const pack: PartManifest = {
      packId: 'p',
      version: '1',
      displayName: 'P',
      canvas: { width: 10, height: 10 },
      slots: [{ slot: 'body', zOrder: 0, required: true, anchor: { x: 0, y: 0 }, parts: [] }],
    };

    const url = await rig.composeSanitizedDataUrl(def, pack);

    // It is a data: SVG URL ready for <img src> — NOT raw markup for innerHTML.
    expect(url.startsWith('data:image/svg+xml')).toBeTrue();
    const decoded = decodeURIComponent(url.substring(url.indexOf(',') + 1)).toLowerCase();
    expect(decoded).not.toContain('<script');
    expect(decoded).not.toContain('onload');
    expect(decoded).not.toContain('alert');
    // the benign shape from the (sanitized) user part survives in the composite
    expect(decoded).toContain('circle');
  });

  it('compose() (unsanitized, pack-trusted path) still produces a valid <svg> document', async () => {
    const def: VnCharacter = {
      schemaVersion: 1,
      packId: 'p',
      name: 'X',
      slots: {},
      palette: {},
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      defaultExpression: 'neutral',
    };
    const pack: PartManifest = {
      packId: 'p',
      version: '1',
      displayName: 'P',
      canvas: { width: 20, height: 20 },
      slots: [],
    };
    const svg = await rig.compose(def, pack);
    expect(svg.startsWith('<svg')).toBeTrue();
    expect(svg).toContain('viewBox="0 0 20 20"');
  });

  /**
   * The re-sync fix: the DRAWABLE (composed-SVG) character must swap its mouth/eyes
   * per expression via the 3rd `expressionSlots` arg. With the stale 2-arg
   * compositor this map was ignored, so a drawable was INERT — neutral and happy
   * composed byte-identically. This pins the fix: an expression slot-override must
   * change which part SVG is inlined, hence a DIFFERENT composite.
   */
  it('compose() swaps the drawable mouth per expression slot-override (≠ neutral)', async () => {
    // A two-slot pack: a body and a "mouth" expression slot with neutral + happy parts.
    const def: VnCharacter = {
      schemaVersion: 1,
      packId: 'p',
      name: 'X',
      slots: { body: 'b0', mouth: 'm-neutral' },
      palette: {},
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      defaultExpression: 'neutral',
    };
    const pack: PartManifest = {
      packId: 'p',
      version: '1',
      displayName: 'P',
      canvas: { width: 10, height: 10 },
      expressionSlots: ['mouth'],
      expressions: [
        { id: 'happy', slots: { mouth: 'm-happy' } },
      ],
      slots: [
        {
          slot: 'body',
          zOrder: 0,
          required: true,
          anchor: { x: 0, y: 0 },
          parts: [{ id: 'b0', displayName: 'Body', file: 'b0.svg' }],
        },
        {
          slot: 'mouth',
          zOrder: 1,
          required: false,
          anchor: { x: 0, y: 0 },
          parts: [
            { id: 'm-neutral', displayName: 'Neutral mouth', file: 'm-neutral.svg' },
            { id: 'm-happy', displayName: 'Happy mouth', file: 'm-happy.svg' },
          ],
        },
      ],
    };
    // Return a DIFFERENT inner per part file so the swap is observable.
    spyOn<any>(rig, 'partFile').and.callFake((url: string) =>
      Promise.resolve(`<path data-file="${url.substring(url.lastIndexOf('/') + 1)}"/>`),
    );

    const neutral = await rig.compose(def, pack); // no override → base mouth
    const happy = await rig.compose(def, pack, pack.expressions![0].slots);

    // The neutral composite inlines the base mouth; the happy one inlines the swap.
    expect(neutral).toContain('m-neutral.svg');
    expect(neutral).not.toContain('m-happy.svg');
    expect(happy).toContain('m-happy.svg');
    expect(happy).not.toContain('m-neutral.svg');
    // The drawable is no longer inert: the expression changes the composite.
    expect(happy).not.toEqual(neutral);
    // The unrelated body slot is unchanged across the swap.
    expect(neutral).toContain('b0.svg');
    expect(happy).toContain('b0.svg');
  });

  /**
   * The XSS boundary must hold through the NEW 3-arg slot-override path too: a
   * hostile user-drawn part composed WITH an expression override is still fully
   * neutralized (script/onload/foreignObject/javascript: href) and still leaves
   * only as a `data:` URL for an `<img src>` — the slot override changes which
   * pack part is shown, never the sanitize/`<img>` boundary.
   */
  it('composeSanitizedDataUrl neutralizes XSS through the 3-arg expression-override path', async () => {
    const def: VnCharacter = {
      schemaVersion: 1,
      packId: 'p',
      name: 'X',
      slots: { body: 'b0' },
      palette: {},
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      defaultExpression: 'neutral',
      userParts: {
        body: {
          svgInline:
            '<svg xmlns="http://www.w3.org/2000/svg">' +
            '<script>alert(1)</script>' +
            '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">' +
            '<img src="x" onerror="alert(2)"/></body></foreignObject>' +
            '<a href="javascript:alert(3)"><rect width="4" height="4" onload="alert(4)"/></a>' +
            '</svg>',
          tintRegions: [],
        },
      },
    };
    const pack: PartManifest = {
      packId: 'p',
      version: '1',
      displayName: 'P',
      canvas: { width: 10, height: 10 },
      expressionSlots: ['mouth'],
      expressions: [{ id: 'happy', slots: { mouth: 'm-happy' } }],
      slots: [
        { slot: 'body', zOrder: 0, required: true, anchor: { x: 0, y: 0 }, parts: [] },
      ],
    };

    // Compose WITH an expression override — the hostile part must still be inert.
    const url = await rig.composeSanitizedDataUrl(def, pack, pack.expressions![0].slots);

    expect(url.startsWith('data:image/svg+xml')).toBeTrue();
    const decoded = decodeURIComponent(url.substring(url.indexOf(',') + 1)).toLowerCase();
    expect(decoded).not.toContain('<script');
    expect(decoded).not.toContain('<foreignobject');
    expect(decoded).not.toContain('onerror');
    expect(decoded).not.toContain('onload');
    expect(decoded).not.toContain('javascript:');
    expect(decoded).not.toContain('alert');
    // the benign shape from the (sanitized) user part survives in the composite
    expect(decoded).toContain('rect');
  });
});
