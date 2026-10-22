import {
  LEGACY_BRANDS_GLOBAL,
  LEGACY_CHAT3D_STATE_TYPES,
  LEGACY_MESH_EVENT_CONTENT_FIELDS,
  buildLegacyReadLists,
  parseLegacyBrands,
} from './legacy-read';

describe('legacy-read (pre-canonical wire names, injected legacy brand)', () => {
  it('names the runtime hook in the shared __HUG_*__ convention', () => {
    expect(LEGACY_BRANDS_GLOBAL).toBe('__HUG_LEGACY_EVENT_BRANDS__');
  });

  it('with NO injected brand, every chain is the public generation only and the content-field chain is empty', () => {
    const lists = buildLegacyReadLists(parseLegacyBrands(undefined));
    expect(lists.chat3dState).toEqual(['systems.hugmesh.chat3d']);
    expect(lists.chat3dScene).toEqual(['systems.hugmesh.chat3d.scene']);
    expect(lists.chat3dAvatar).toEqual(['systems.hugmesh.chat3d.avatar']);
    expect(lists.chat3dStage).toEqual(['systems.hugmesh.chat3d.stage']);
    expect(lists.meshBridgeState).toEqual(['systems.hugmesh.mesh.bridge']);
    expect(lists.vnSceneState).toEqual(['systems.hugmesh.vn.scene']);
    expect(lists.chatThemeAccountData).toEqual(['systems.hugmesh.chat_theme']);
    expect(lists.vnStickerContentFields).toEqual(['systems.hugmesh.vn']);
    expect(lists.meshEventContentFields).toEqual([]);
  });

  it('an injected brand adds the oldest generation AFTER the public one, on every chain', () => {
    const lists = buildLegacyReadLists(parseLegacyBrands(['exampleorg']));
    expect(lists.chat3dState).toEqual(['systems.hugmesh.chat3d', 'systems.exampleorg.chat3d']);
    expect(lists.chat3dScene).toEqual(['systems.hugmesh.chat3d.scene', 'systems.exampleorg.chat3d.scene']);
    expect(lists.chat3dAvatar).toEqual(['systems.hugmesh.chat3d.avatar', 'systems.exampleorg.chat3d.avatar']);
    expect(lists.chat3dStage).toEqual(['systems.hugmesh.chat3d.stage', 'systems.exampleorg.chat3d.stage']);
    expect(lists.meshBridgeState).toEqual(['systems.hugmesh.mesh.bridge', 'systems.exampleorg.mesh.bridge']);
    expect(lists.vnSceneState).toEqual(['systems.hugmesh.vn.scene', 'systems.exampleorg.vn.scene']);
    expect(lists.chatThemeAccountData).toEqual(['systems.hugmesh.chat_theme', 'systems.exampleorg.chat_theme']);
    expect(lists.vnStickerContentFields).toEqual(['systems.hugmesh.vn', 'systems.exampleorg.vn']);
    expect(lists.meshEventContentFields).toEqual(['com.exampleorg.mesh']);
  });

  it('accepts a single string as well as a list', () => {
    expect(parseLegacyBrands('exampleorg')).toEqual(['exampleorg']);
  });

  it('drops malformed, duplicate and current-brand stems, and caps the list', () => {
    expect(parseLegacyBrands([
      'Example', 'a.b', 'has space', '-lead', 'trail-', '', 42, null, 'hugmesh', 'exampleorg', 'exampleorg', ' example-two ',
    ])).toEqual(['exampleorg', 'example-two']);
    expect(parseLegacyBrands(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(parseLegacyBrands({ brand: 'exampleorg' })).toEqual([]);
    expect(parseLegacyBrands(42)).toEqual([]);
  });

  it('the module-level lists honour the hook set before load (test.ts sets the placeholder)', () => {
    expect((globalThis as Record<string, unknown>)[LEGACY_BRANDS_GLOBAL]).toEqual(['exampleorg']);
    expect(LEGACY_CHAT3D_STATE_TYPES).toEqual(['systems.hugmesh.chat3d', 'systems.exampleorg.chat3d']);
    expect(LEGACY_MESH_EVENT_CONTENT_FIELDS).toEqual(['com.exampleorg.mesh']);
  });
});
