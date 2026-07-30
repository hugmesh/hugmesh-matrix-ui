import { SceneService } from './scene.service';

const MANIFEST = {
  schemaVersion: 1,
  scenes: [
    { id: 'vn_scene_cafe', displayName: 'Café', file: 'vn_scene_cafe.svg', tags: ['indoor'] },
    { id: 'vn_scene_night_city', displayName: 'Night City', file: 'vn_scene_night_city.svg', tags: ['outdoor', 'night'] },
  ],
  props: [
    { id: 'vn_prop_lamp', displayName: 'Floor Lamp', file: 'vn_prop_lamp.svg', defaultScale: 1 },
    { id: 'vn_prop_drink', displayName: 'Drink', file: 'vn_prop_drink.svg', defaultScale: 0.35 },
  ],
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

describe('SceneService', () => {
  let service: SceneService;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    // Fresh instance per test (no TestBed needed — the service has no deps).
    service = new SceneService();
    fetchSpy = spyOn(globalThis, 'fetch').and.resolveTo(jsonResponse(MANIFEST));
  });

  it('loads the manifest and exposes scenes/props via signals', async () => {
    expect(service.scenes()).toEqual([]);
    expect(service.props()).toEqual([]);

    await service.load();

    expect(fetchSpy).toHaveBeenCalledWith('assets/vn/scenes/scenes.json', jasmine.objectContaining({ cache: 'force-cache' }));
    expect(service.scenes().map((s) => s.id)).toEqual(['vn_scene_cafe', 'vn_scene_night_city']);
    expect(service.props().map((p) => p.id)).toEqual(['vn_prop_lamp', 'vn_prop_drink']);
    expect(service.loaded()).toBeTrue();
  });

  it('caches the manifest: repeated/concurrent load() shares ONE fetch', async () => {
    await Promise.all([service.load(), service.load()]);
    await service.load();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves scene and prop URLs against the relative assets base', async () => {
    await service.load();
    expect(service.sceneUrl('vn_scene_cafe')).toBe('assets/vn/scenes/vn_scene_cafe.svg');
    expect(service.propUrl('vn_prop_drink')).toBe('assets/vn/scenes/vn_prop_drink.svg');
  });

  it('unknown / null ids resolve to null (fail-soft)', async () => {
    await service.load();
    expect(service.sceneUrl('vn_scene_nope')).toBeNull();
    expect(service.sceneUrl(null)).toBeNull();
    expect(service.propUrl('vn_prop_nope')).toBeNull();
    expect(service.sceneById('vn_scene_nope')).toBeNull();
    expect(service.propById(undefined)).toBeNull();
  });

  it('drops malformed manifest rows and defaults missing fields (tolerant parse)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      schemaVersion: 1,
      scenes: [
        { id: 'vn_scene_ok', file: 'ok.svg' },            // no displayName/tags → defaults
        { id: 42, file: 'bad.svg' },                       // non-string id → dropped
        { id: 'vn_scene_nofile' },                         // no file → dropped
        'garbage',
      ],
      props: [
        { id: 'vn_prop_ok', file: 'p.svg', defaultScale: -2 }, // bad scale → 1
        { file: 'orphan.svg' },                                 // no id → dropped
      ],
    }));

    await service.load();

    expect(service.scenes()).toEqual([{ id: 'vn_scene_ok', displayName: 'vn_scene_ok', file: 'ok.svg', tags: [] }]);
    expect(service.props()).toEqual([{ id: 'vn_prop_ok', displayName: 'vn_prop_ok', file: 'p.svg', defaultScale: 1 }]);
  });

  it('LIMIT MAX_MANIFEST_ENTRIES=64: an oversized/corrupt manifest is capped per list (UI never floods)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      schemaVersion: 1,
      scenes: Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, displayName: `S${i}`, file: `s${i}.svg`, tags: [] })),
      props: Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, displayName: `P${i}`, file: `p${i}.svg`, defaultScale: 1 })),
    }));
    await service.load();
    expect(service.scenes().length).toBe(64);
    expect(service.props().length).toBe(64);
  });

  it('FAIL-SOFT: a failed fetch resolves to empty lists (no throw) and RETRIES next call', async () => {
    fetchSpy.and.rejectWith(new Error('offline'));
    await service.load();

    expect(service.scenes()).toEqual([]);
    expect(service.loaded()).toBeFalse();

    // The failure is NOT cached: the next load() refetches and succeeds.
    fetchSpy.and.resolveTo(jsonResponse(MANIFEST));
    await service.load();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(service.scenes().length).toBe(2);
    expect(service.loaded()).toBeTrue();
  });

  it('FAIL-SOFT: a non-OK manifest response resolves to empty lists', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, false, 404));
    await service.load();
    expect(service.scenes()).toEqual([]);
    expect(service.props()).toEqual([]);
    expect(service.loaded()).toBeFalse();
  });
});
