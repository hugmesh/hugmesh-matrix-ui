import {
  HEAD_FAMILIES,
  MAX_CHAR3D_JSON_BYTES,
  hashSeed,
  parseChar3dConfig,
  randomChar3dConfig,
} from './char3d-config';

/** A fully-valid §2 Char3DConfig (the parse must round-trip it unchanged). */
function validConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'Vex',
    source: null,
    body: { archetype: 'canid', build: 0.5, height: 1 },
    head: { family: 'canid', variant: 'wolf-01', snoutLength: 0.6, earStyle: 'pointed', hornStyle: null },
    parts: { tail: 'tail-01', wings: null, ears: null, feature: null, accessory: null, markings: null, hair: null },
    materials: {
      fur: '#8a5a2b', accent: '#ffffff', detail: '#222222', line: '#000000',
      iris: '#3a6ea5', skin: '#d9b8a2', hair: '#4a3b2f',
    },
    style: 'toon',
    ...over,
  };
}

describe('parseChar3dConfig (§3 server-validation mirror, untrusted input)', () => {
  it('round-trips a fully-valid config', () => {
    const parsed = parseChar3dConfig(validConfig());
    expect(parsed).toEqual(jasmine.objectContaining({
      schemaVersion: 1,
      name: 'Vex',
      source: null,
      style: 'toon',
    }));
    expect(parsed!.body).toEqual({ archetype: 'canid', build: 0.5, height: 1 });
    expect(parsed!.head).toEqual({ family: 'canid', variant: 'wolf-01', snoutLength: 0.6, earStyle: 'pointed', hornStyle: null });
    expect(parsed!.parts['tail']).toBe('tail-01');
    expect(parsed!.materials['fur']).toBe('#8a5a2b');
  });

  it('rejects non-objects and arrays outright', () => {
    expect(parseChar3dConfig(null)).toBeNull();
    expect(parseChar3dConfig(undefined)).toBeNull();
    expect(parseChar3dConfig('config')).toBeNull();
    expect(parseChar3dConfig(42)).toBeNull();
    expect(parseChar3dConfig([validConfig()])).toBeNull();
  });

  it('REJECTS unknown keys at every object level (payload smuggling), exactly like the BFF', () => {
    expect(parseChar3dConfig(validConfig({ extra: 'smuggled' }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ body: { archetype: 'canid', build: 0.5, height: 1, x: 1 } }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ head: { family: 'canid', variant: '', snoutLength: 0, earStyle: null, hornStyle: null, sneaky: true } }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ parts: { tail: null, notASlot: 'x' } }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ materials: { fur: '#fff', glow: '#f00' } }))).toBeNull();
  });

  it('rejects a wrong/missing schemaVersion', () => {
    expect(parseChar3dConfig(validConfig({ schemaVersion: 2 }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ schemaVersion: '1' }))).toBeNull();
    const noVersion = validConfig();
    delete noVersion['schemaVersion'];
    expect(parseChar3dConfig(noVersion)).toBeNull();
  });

  it('rejects an unknown head family / body archetype / style (no safe fallback mesh)', () => {
    expect(parseChar3dConfig(validConfig({ head: { family: 'xenomorph', variant: '', snoutLength: 0, earStyle: null, hornStyle: null } }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ body: { archetype: 'blob', build: 0.5, height: 1 } }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ style: 'photoreal' }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ style: 7 }))).toBeNull();
  });

  it('accepts every declared head family for both head and body', () => {
    for (const family of HEAD_FAMILIES) {
      const parsed = parseChar3dConfig(validConfig({
        body: { archetype: family, build: 0, height: 1 },
        head: { family, variant: '', snoutLength: 0, earStyle: null, hornStyle: null },
      }));
      expect(parsed).withContext(family).not.toBeNull();
      expect(parsed!.head.family).toBe(family);
      expect(parsed!.body.archetype).toBe(family);
    }
  });

  it('CLAMPS numerics into their §2 ranges (build 0..1, height 0.5..1.5, snout 0..1)', () => {
    const parsed = parseChar3dConfig(validConfig({
      body: { archetype: 'felid', build: 99, height: -3 },
      head: { family: 'felid', variant: '', snoutLength: 2, earStyle: null, hornStyle: null },
    }))!;
    expect(parsed.body.build).toBe(1);
    expect(parsed.body.height).toBe(0.5);
    expect(parsed.head.snoutLength).toBe(1);
  });

  it('non-finite / non-number numerics fall back to their defaults', () => {
    const parsed = parseChar3dConfig(validConfig({
      body: { archetype: 'felid', build: Number.NaN, height: 'tall' },
      head: { family: 'felid', variant: '', snoutLength: Number.POSITIVE_INFINITY, earStyle: null, hornStyle: null },
    }))!;
    expect(parsed.body.build).toBe(0.5);
    expect(parsed.body.height).toBe(1);
    expect(parsed.head.snoutLength).toBe(0.5);
  });

  it('regex-checks material hexes — an invalid region falls back to a neutral default', () => {
    const parsed = parseChar3dConfig(validConfig({
      materials: { fur: 'red', accent: '#gggggg', detail: 'url(javascript:x)', line: '#000000' },
    }))!;
    expect(parsed.materials['fur']).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(parsed.materials['fur']).not.toBe('red');
    expect(parsed.materials['accent']).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(parsed.materials['detail']).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(parsed.materials['line']).toBe('#000000'); // valid one kept
  });

  it('truncates an overlong name and tokenizes overlong part ids', () => {
    const parsed = parseChar3dConfig(validConfig({
      name: 'n'.repeat(500),
      parts: { tail: 't'.repeat(200) },
    }))!;
    expect(parsed.name.length).toBe(120);
    expect(parsed.parts['tail']!.length).toBe(64);
  });

  it(`rejects a config whose serialized JSON exceeds ${MAX_CHAR3D_JSON_BYTES} bytes (§3 cap)`, () => {
    // The oversize check runs BEFORE truncation — a 20KB name is a hostile
    // payload, not a long name.
    expect(parseChar3dConfig(validConfig({ name: 'a'.repeat(20_000) }))).toBeNull();
  });

  it('parses the optional source echo (clamped) and drops a malformed one without failing the config', () => {
    const withSource = parseChar3dConfig(validConfig({
      source: {
        packId: 'menagerie-v1',
        slots: { head: 'head_wolf', tail: null },
        palette: { fur: '#8a5a2b', bad: 'not-a-hex' },
        defaultExpression: 'happy',
      },
    }))!;
    expect(withSource.source).toEqual({
      packId: 'menagerie-v1',
      slots: { head: 'head_wolf', tail: null },
      palette: { fur: '#8a5a2b' }, // invalid hex dropped
      defaultExpression: 'happy',
    });

    const junkSource = parseChar3dConfig(validConfig({ source: { packId: 42 } }))!;
    expect(junkSource).not.toBeNull();
    expect(junkSource.source).toBeNull();

    const unknownExpr = parseChar3dConfig(validConfig({
      source: { packId: 'p', slots: {}, palette: {}, defaultExpression: 'zalgo' },
    }))!;
    expect(unknownExpr.source!.defaultExpression).toBe('neutral');
  });
});

describe('randomChar3dConfig (seeded guest)', () => {
  it('is DETERMINISTIC: the same seed always yields the same character', () => {
    expect(randomChar3dConfig('kusanagi')).toEqual(randomChar3dConfig('kusanagi'));
    expect(hashSeed('kusanagi')).toBe(hashSeed('kusanagi'));
  });

  it('different seeds yield different characters', () => {
    expect(JSON.stringify(randomChar3dConfig('alpha')))
      .not.toBe(JSON.stringify(randomChar3dConfig('beta')));
  });

  it('ALWAYS round-trips the §3 mirror validation (guests publish as room state)', () => {
    for (const seed of ['a', 'b', 'motoko', '9', 'долгий', '🐉']) {
      const config = randomChar3dConfig(seed);
      const roundTripped = parseChar3dConfig(JSON.parse(JSON.stringify(config)));
      expect(roundTripped).withContext(seed).toEqual(config);
    }
  });
});
