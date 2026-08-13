import {
  CHAR3D_EXTENDED_MATERIAL_REGIONS,
  DEFAULT_MATERIALS,
  HEAD_FAMILIES,
  MAX_CHAR3D_JSON_BYTES,
  hashSeed,
  parseChar3dConfig,
  randomChar3dConfig,
  sanitizeDisplayName,
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

  it('truncates an overlong name', () => {
    const parsed = parseChar3dConfig(validConfig({ name: 'n'.repeat(500) }))!;
    expect(parsed.name.length).toBe(120);
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

describe('EXTENDED coat-block regions (kemono uplift — optional on the wire)', () => {
  const withExtended = (over: Record<string, unknown> = {}) => validConfig({
    materials: {
      fur: '#8a5a2b', accent: '#ffffff', detail: '#222222', line: '#000000',
      iris: '#3a6ea5', skin: '#d9b8a2', hair: '#4a3b2f',
      innerMuzzle: '#e8c39e', socks: '#f0f0f0', innerEar: '#ff99aa', tailTip: '#101010',
      ...over,
    },
  });

  it('REGRESSION: accepts a kemono character instead of hard-rejecting the whole definition', () => {
    // Before: `materials` allowed only the 7 canonical regions and unknown keys
    // are REJECTED, so a character carrying any extended coat block parsed to
    // null — i.e. rendered as a silhouette in every 3D room.
    const parsed = parseChar3dConfig(withExtended());
    expect(parsed).not.toBeNull();
    expect(parsed!.materials['innerMuzzle']).toBe('#e8c39e');
    expect(parsed!.materials['socks']).toBe('#f0f0f0');
    expect(parsed!.materials['innerEar']).toBe('#ff99aa');
    expect(parsed!.materials['tailTip']).toBe('#101010');
  });

  it('accepts each extended region on its own (all four are independently optional)', () => {
    for (const region of CHAR3D_EXTENDED_MATERIAL_REGIONS) {
      const parsed = parseChar3dConfig(validConfig({
        materials: {
          fur: '#8a5a2b', accent: '#ffffff', detail: '#222222', line: '#000000',
          iris: '#3a6ea5', skin: '#d9b8a2', hair: '#4a3b2f', [region]: '#abcdef',
        },
      }));
      expect(parsed).withContext(region).not.toBeNull();
      expect(parsed!.materials[region]).toBe('#abcdef');
    }
  });

  it('an ABSENT extended region stays absent — never defaulted (absence = "derive it")', () => {
    const parsed = parseChar3dConfig(validConfig())!;
    for (const region of CHAR3D_EXTENDED_MATERIAL_REGIONS) {
      expect(region in parsed.materials).withContext(region).toBeFalse();
    }
  });

  it('an UNUSABLE extended hex is omitted (derive) and never fails the config', () => {
    const parsed = parseChar3dConfig(withExtended({ socks: 'not-a-hex', innerEar: null }))!;
    expect(parsed).not.toBeNull();
    expect('socks' in parsed.materials).toBeFalse();
    expect('innerEar' in parsed.materials).toBeFalse();
    expect(parsed.materials['innerMuzzle']).toBe('#e8c39e'); // the valid ones survive
  });

  it('still rejects a genuinely unknown materials key (payload smuggling)', () => {
    expect(parseChar3dConfig(withExtended({ glow: '#ff0000' }))).toBeNull();
  });
});

describe('DEFAULT_MATERIALS (one canonical palette across all five copies)', () => {
  it('is byte-identical to Char3DConfigValidator.DEFAULT_MATERIALS (the authority)', () => {
    // hugmesh-character-forge-bff-api
    //   character/Char3DConfigValidator.java :: DEFAULT_MATERIALS
    expect(DEFAULT_MATERIALS).toEqual({
      fur: '#8b5a2b', accent: '#d2b48c', detail: '#4a3728', line: '#2f2f2f',
      iris: '#00bcd4', skin: '#ffdbac', hair: '#563d2d',
    });
  });

  it('an unset/invalid canonical region resolves to the AUTHORITY colour, not a local invention', () => {
    const parsed = parseChar3dConfig(validConfig({
      materials: { fur: null, accent: 'red', detail: '#gg0000' },
    }))!;
    expect(parsed.materials['fur']).toBe('#8b5a2b');
    expect(parsed.materials['accent']).toBe('#d2b48c');
    expect(parsed.materials['detail']).toBe('#4a3728');
    expect(parsed.materials['iris']).toBe('#00bcd4');
  });
});

describe('bounded-value patterns (the server literals, ported verbatim)', () => {
  it('REJECTS a part id outside PART_ID_PATTERN instead of truncating it', () => {
    // Truncating a 200-char id invented a DIFFERENT asset id; the BFF 400s it.
    expect(parseChar3dConfig(validConfig({ parts: { tail: 't'.repeat(200) } }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ parts: { tail: 'tail 01' } }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ parts: { tail: '../../etc/passwd' } }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ parts: { tail: '<script>' } }))).toBeNull();
    expect(parseChar3dConfig(validConfig({ parts: { tail: 42 } }))).toBeNull();
    // …and keeps a conforming one, including the 64-char boundary.
    expect(parseChar3dConfig(validConfig({ parts: { tail: 'Tail_01-b' } }))!.parts['tail'])
      .toBe('Tail_01-b');
    expect(parseChar3dConfig(validConfig({ parts: { tail: 't'.repeat(64) } }))!.parts['tail']!.length)
      .toBe(64);
    expect(parseChar3dConfig(validConfig({ parts: { tail: 't'.repeat(65) } }))).toBeNull();
  });

  it('REJECTS a non-blank variant/earStyle/hornStyle outside SHORT_STR_PATTERN', () => {
    const head = (over: Record<string, unknown>) => validConfig({
      head: { family: 'canid', variant: '', snoutLength: 0.5, earStyle: null, hornStyle: null, ...over },
    });
    expect(parseChar3dConfig(head({ variant: 'wolf/01' }))).toBeNull();
    expect(parseChar3dConfig(head({ variant: 'v'.repeat(41) }))).toBeNull();
    expect(parseChar3dConfig(head({ earStyle: 'pointed!' }))).toBeNull();
    expect(parseChar3dConfig(head({ hornStyle: 7 }))).toBeNull();
    // Blank IS the shipped encoding for "unset" — it must never reject.
    expect(parseChar3dConfig(head({ variant: '' }))!.head.variant).toBe('');
    expect(parseChar3dConfig(head({ earStyle: '   ' }))!.head.earStyle).toBeNull();
    expect(parseChar3dConfig(head({ variant: 'snow wolf-2' }))!.head.variant).toBe('snow wolf-2');
  });

  it('bounds the advisory source echo with KEY_PATTERN / PART_ID_PATTERN (drops the entry)', () => {
    const parsed = parseChar3dConfig(validConfig({
      source: {
        packId: 'menagerie-v1',
        slots: { head: 'head_wolf', 'Bad Key': 'x', tail: 'tail 01' },
        palette: { fur: '#8a5a2b', 'NOT-A-KEY': '#ffffff' },
        defaultExpression: 'happy',
      },
    }))!;
    expect(parsed.source!.slots).toEqual({ head: 'head_wolf' });
    expect(parsed.source!.palette).toEqual({ fur: '#8a5a2b' });
  });

  it('drops the whole echo when packId itself is unbounded', () => {
    expect(parseChar3dConfig(validConfig({ source: { packId: 'pack id with spaces' } }))!.source)
      .toBeNull();
  });
});

describe('sanitizeDisplayName (Cc/Cf/Zl/Zp — the nametag spoof gate)', () => {
  it('strips bidi overrides, isolates, zero-widths, controls and line separators', () => {
    expect(sanitizeDisplayName('Mo\u202Etoko')).toBe('Motoko');        // Cf RLO
    expect(sanitizeDisplayName('a\u2066b\u2069c')).toBe('abc');         // Cf isolates
    expect(sanitizeDisplayName('zero\u200Bwidth\uFEFF')).toBe('zerowidth');
    expect(sanitizeDisplayName('line\u2028break\u2029x')).toBe('linebreakx'); // Zl / Zp
    expect(sanitizeDisplayName('bell\u0007null\u0000')).toBe('bellnull');     // Cc
    expect(sanitizeDisplayName('tab\there\nnewline')).toBe('tabherenewline');
  });

  it('keeps ordinary international text and emoji, and caps the length', () => {
    expect(sanitizeDisplayName('долгий 🐉 Ünïcødé')).toBe('долгий 🐉 Ünïcødé');
    expect(sanitizeDisplayName('n'.repeat(500)).length).toBe(120);
    expect(sanitizeDisplayName(42)).toBe('');
    expect(sanitizeDisplayName(null)).toBe('');
  });

  it('the config parse and the avatar-state parse both run names through it', () => {
    expect(parseChar3dConfig(validConfig({ name: 'Vex\u202E' }))!.name).toBe('Vex');
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
