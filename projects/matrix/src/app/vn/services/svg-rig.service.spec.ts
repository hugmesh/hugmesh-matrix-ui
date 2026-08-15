import { SvgRigService } from './svg-rig.service';
import { SceneService } from '../scenes/scene.service';
import { resolveAssetsBase } from '../assets-base';
import { PartManifest } from '../models/vn-manifest';
import { VnCharacter } from '../models/vn-character';

/**
 * The FEDERATION regression guard for {@link SvgRigService}'s asset base.
 *
 * `svg-rig.service.ts` resolves its `assetsBase` from the module (via
 * `../assets-base`, anchored on `import.meta.url`) rather than from a bare
 * `'assets/vn/'`. Without this file that fix was UNPINNED: `assets-base.spec.ts`
 * only exercises the pure resolver, and `scene.service.spec.ts` only pins
 * SceneService — so reverting the rig's base to the bare string alone left the
 * whole matrix suite green while every pack PART silently 404'd under the shell.
 *
 * The live defect (operator mesh, 2026-08-14): the remote is mounted at
 * `/social/matrix` with NO trailing slash, so a bare relative asset path is
 * resolved by `fetch()` against the SHELL document and lands at the shell root —
 * `https://localhost:8488/assets/vn/scenes/scenes.json` → 404, and identically
 * for `assets/vn/packs/<pack>/<part>.svg`.
 *
 * The assertions here read the URL the service ACTUALLY fetches, so they pin the
 * consumer's own field (`private readonly assetsBase = resolveAssetsBase()`) and
 * not merely the resolver it calls.
 */

/** Any absolute URL (has a scheme). The karma harness rewrites `import.meta.url`
 *  to its own source URL; the shipped native-federation bundle keeps the real
 *  `https://` chunk URL. Either way the point of the assertion is the same:
 *  NOT the bare relative string. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The MODULE-anchored base the rig is expected to resolve against. */
const RIG_BASE = resolveAssetsBase();
/** The MODULE-anchored base SceneService is expected to resolve against. */
const SCENES_BASE = resolveAssetsBase('assets/vn/scenes/');

/** What the DEFECT produced: the bare document-relative path. */
const BARE_PART_PATH = 'assets/vn/packs/test-pack/body.svg';

const PACK: PartManifest = {
  packId: 'test-pack',
  version: '1.0.0',
  displayName: 'Test Pack',
  canvas: { width: 512, height: 512 },
  slots: [
    {
      slot: 'body',
      zOrder: 0,
      required: true,
      anchor: { x: 0.5, y: 0.5 },
      parts: [
        {
          id: 'body_a',
          displayName: 'Body A',
          file: 'body.svg',
          tintRegions: [{ region: 'fur', svgClass: 'region-fur', defaultPalette: '#aabbcc' }],
        },
      ],
    },
  ],
};

const CHARACTER: VnCharacter = {
  schemaVersion: 1,
  packId: 'test-pack',
  name: 'Test',
  slots: { body: 'body_a' },
  palette: { fur: '#112233' },
  transform: { scale: 1, offsetX: 0, offsetY: 0 },
  defaultExpression: 'neutral',
};

function svgResponse(body = '<svg xmlns="http://www.w3.org/2000/svg"><rect class="region-fur"/></svg>'): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

describe('SvgRigService asset base (federation guard)', () => {
  let rig: SvgRigService;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    // Fresh instance per test (no TestBed needed — the service has no deps), so
    // the internal part cache never hides a fetch.
    rig = new SvgRigService();
    fetchSpy = spyOn(globalThis, 'fetch').and.resolveTo(svgResponse());
  });

  it('fetches pack parts from the MODULE-anchored base, never the bare relative path', async () => {
    await rig.compose(CHARACTER, PACK);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const fetched = fetchSpy.calls.mostRecent().args[0] as string;

    // The exact URL the fixed service must request.
    expect(fetched).toBe(`${RIG_BASE}packs/test-pack/body.svg`);
    // The defect, spelled out: a bare document-relative path.
    expect(fetched).not.toBe(BARE_PART_PATH);
    expect(fetched).toMatch(ABSOLUTE_URL);
    expect(fetched.endsWith('assets/vn/packs/test-pack/body.svg')).toBeTrue();
  });

  it('never resolves a part against the HTML document — the /social/matrix 404', async () => {
    await rig.compose(CHARACTER, PACK);
    const fetched = fetchSpy.calls.mostRecent().args[0] as string;

    // Resolving the bare string against the document is precisely what 404'd at
    // the shell root; under karma the document differs from the module chunk, so
    // this is a real discriminator.
    expect(fetched).not.toBe(new URL(BARE_PART_PATH, document.baseURI).href);
    // ...and it must not be a root-absolute shell path either.
    expect(new URL(fetched, document.baseURI).pathname)
      .not.toBe('/assets/vn/packs/test-pack/body.svg');
  });

  it('still requests the module-anchored URL through the sanitized data-URL path', async () => {
    const dataUrl = await rig.composeSanitizedDataUrl(CHARACTER, PACK);

    expect(dataUrl.startsWith('data:image/svg+xml;utf8,')).toBeTrue();
    expect(fetchSpy.calls.mostRecent().args[0] as string)
      .toBe(`${RIG_BASE}packs/test-pack/body.svg`);
  });

  it('pins BOTH matrix asset bases: the rig and SceneService share one remote root', async () => {
    await rig.compose(CHARACTER, PACK);
    const partUrl = fetchSpy.calls.mostRecent().args[0] as string;

    fetchSpy.and.resolveTo({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ schemaVersion: 1, scenes: [], props: [] }),
    } as unknown as Response);
    const scenes = new SceneService();
    await scenes.load();
    const manifestUrl = fetchSpy.calls.mostRecent().args[0] as string;

    // Both bases absolute...
    expect(RIG_BASE).toMatch(ABSOLUTE_URL);
    expect(RIG_BASE).not.toBe('assets/vn/');
    expect(SCENES_BASE).toMatch(ABSOLUTE_URL);
    expect(SCENES_BASE).not.toBe('assets/vn/scenes/');
    // ...and both consumers actually fetching under that same remote root, so a
    // revert of EITHER field to a bare string breaks this expectation.
    expect(partUrl.startsWith(RIG_BASE)).toBeTrue();
    expect(manifestUrl).toBe(`${SCENES_BASE}scenes.json`);
    expect(SCENES_BASE.startsWith(RIG_BASE)).toBeTrue();
    expect(new URL(manifestUrl).origin).toBe(new URL(partUrl).origin);
  });
});
