import { TestBed } from '@angular/core/testing';
import {
  CHAT3D_BUNDLE_PATH,
  CHAT3D_PROTOCOL_VERSION,
  GAMES_BASE_URL,
  GameMessage,
  HOST_CALL_SIGNATURES,
  HostEnvelope,
  MAX_POSE_COORD,
  chat3dFrameUrl,
  decodeAsGame,
  hostMsg,
  mxidLocalpart,
  originAllowed,
  parseGameMessage,
} from './chat3d-bridge';
import { randomChar3dConfig } from './char3d-config';

/** Narrow a parsed message to localPose — fails the test LOUDLY otherwise
 *  (never a silent undefined property on the union type). */
function asLocalPose(msg: GameMessage | null): Extract<GameMessage, { t: 'localPose' }> {
  if (!msg || msg.t !== 'localPose') {
    throw new Error(`expected a localPose message, got ${JSON.stringify(msg)}`);
  }
  return msg;
}

describe('GAMES_BASE_URL (env hook + CSP-agreeing default)', () => {
  const g = globalThis as unknown as Record<string, unknown>;

  afterEach(() => {
    delete g['__HUG_GAMES_URL__'];
    delete g['__SNAP_GAMES_URL__'];
  });

  it('reads the fleet-wide __HUG_* global-hook convention, NOT a __SNAP_* hook', () => {
    // Every other configurable base in this repo (__HUG_BFF_URL__,
    // __HUG_MATRIX_URL__, __HUG_VOICE_TTS__ …) uses this prefix and nothing in
    // the fleet ever produces a __SNAP_* global, so reading one is a hook that
    // can never be set — the deployment silently gets the default instead.
    g['__SNAP_GAMES_URL__'] = 'http://snap-hook-must-be-ignored:1';
    g['__HUG_GAMES_URL__'] = 'http://games.local:8080';
    expect(TestBed.inject(GAMES_BASE_URL)).toBe('http://games.local:8080');
  });

  it('defaults to the SAME origin nginx.conf allows in frame-src', () => {
    // nginx.conf: map "" $games_origin { default "https://games.hugmesh.net"; }
    // Two disagreeing defaults for one value = a frame the CSP always blocks.
    expect(TestBed.inject(GAMES_BASE_URL)).toBe('https://games.hugmesh.net');
    expect(new URL(TestBed.inject(GAMES_BASE_URL)).origin).toBe('https://games.hugmesh.net');
  });
});

describe('chat3dFrameUrl', () => {
  it('carries BOTH mode=matrix and the parent origin the game shim gates on', () => {
    const url = new URL(chat3dFrameUrl('https://games.example.test', 'https://chat.example.test'));
    expect(url.origin + url.pathname).toBe(`https://games.example.test${CHAT3D_BUNDLE_PATH}`);
    expect(url.searchParams.get('mode')).toBe('matrix');
    expect(url.searchParams.get('origin')).toBe('https://chat.example.test');
  });

  it('percent-encodes the origin so it cannot smuggle extra query parameters', () => {
    const url = new URL(chat3dFrameUrl('https://g.test', 'https://a.test&mode=session'));
    expect(url.searchParams.get('mode')).toBe('matrix');
    expect(url.searchParams.get('origin')).toBe('https://a.test&mode=session');
  });
});

describe('originAllowed (games-origin allow-list)', () => {
  const allow = ['https://games.hugmesh.net'];

  it('accepts ONLY an exact full-origin match', () => {
    expect(originAllowed('https://games.hugmesh.net', allow)).toBeTrue();
  });

  it('rejects lookalike, prefix, suffix, scheme and empty origins', () => {
    expect(originAllowed('https://games.hugmesh.net.evil.tld', allow)).toBeFalse();
    expect(originAllowed('https://evil.games.hugmesh.net', allow)).toBeFalse();
    expect(originAllowed('http://games.hugmesh.net', allow)).toBeFalse();
    expect(originAllowed('https://games.hugmesh.ne', allow)).toBeFalse();
    expect(originAllowed('', allow)).toBeFalse();
    expect(originAllowed('null', allow)).toBeFalse();
  });
});

describe('parseGameMessage (untrusted iframe input)', () => {
  it('rejects non-objects, wrong versions and unknown types', () => {
    expect(parseGameMessage(null)).toBeNull();
    expect(parseGameMessage('ready')).toBeNull();
    expect(parseGameMessage([])).toBeNull();
    expect(parseGameMessage({ t: 'ready' })).toBeNull(); // missing v
    expect(parseGameMessage({ v: 2, t: 'ready' })).toBeNull();
    expect(parseGameMessage({ v: 1, t: 'formatHardDrive' })).toBeNull();
    // Host→game types must NEVER validate as inbound (reflection).
    expect(parseGameMessage({ v: 1, t: 'roster' })).toBeNull();
    expect(parseGameMessage({ v: 1, t: 'placeMedia' })).toBeNull();
  });

  it('parses the ready handshake', () => {
    expect(parseGameMessage({ v: 1, t: 'ready' })).toEqual({ t: 'ready' });
  });

  it('clamps localPose coords, wraps yaw, and integer-bounds the seat', () => {
    const pose = parseGameMessage({ v: 1, t: 'localPose', x: 1e9, z: -1e9, yaw: 0.5, seat: 3 })!;
    expect(pose).toEqual({ t: 'localPose', x: MAX_POSE_COORD, z: -MAX_POSE_COORD, yaw: 0.5, seat: 3 });

    const junk = parseGameMessage({ v: 1, t: 'localPose', x: 'far', z: Number.NaN, yaw: Number.POSITIVE_INFINITY, seat: 99.5 })!;
    expect(junk).toEqual({ t: 'localPose', x: 0, z: 0, yaw: 0, seat: -1 });

    const seatHigh = asLocalPose(parseGameMessage({ v: 1, t: 'localPose', x: 0, z: 0, yaw: 0, seat: 99 }));
    expect(seatHigh.seat).toBe(15);
    const seatLow = asLocalPose(parseGameMessage({ v: 1, t: 'localPose', x: 0, z: 0, yaw: 0, seat: -9 }));
    expect(seatLow.seat).toBe(-1);
  });

  it('wraps a runaway yaw into (-π..π]', () => {
    const spun = asLocalPose(parseGameMessage({ v: 1, t: 'localPose', x: 0, z: 0, yaw: 7 * Math.PI + 0.25, seat: 0 }));
    expect(spun.yaw).toBeGreaterThan(-Math.PI - 1e-9);
    expect(spun.yaw).toBeLessThanOrEqual(Math.PI + 1e-9);
    expect(spun.yaw).toBeCloseTo(Math.atan2(Math.sin(7 * Math.PI + 0.25), Math.cos(7 * Math.PI + 0.25)), 10);
  });

  it('mediaActivate requires a real scene surface id', () => {
    expect(parseGameMessage({ v: 1, t: 'mediaActivate', surfaceId: 'table-3' }))
      .toEqual({ t: 'mediaActivate', surfaceId: 'table-3' });
    expect(parseGameMessage({ v: 1, t: 'mediaActivate', surfaceId: 'floor' })).toBeNull();
    expect(parseGameMessage({ v: 1, t: 'mediaActivate', surfaceId: 7 })).toBeNull();
    expect(parseGameMessage({ v: 1, t: 'mediaActivate' })).toBeNull();
  });

  it('vrState.active is STRICT === true', () => {
    expect(parseGameMessage({ v: 1, t: 'vrState', active: true })).toEqual({ t: 'vrState', active: true });
    expect(parseGameMessage({ v: 1, t: 'vrState', active: 'true' })).toEqual({ t: 'vrState', active: false });
    expect(parseGameMessage({ v: 1, t: 'vrState' })).toEqual({ t: 'vrState', active: false });
  });
});

describe('hostMsg (outbound §5 envelope builders)', () => {
  it('stamps every envelope with the protocol version', () => {
    const config = randomChar3dConfig('x');
    const envelopes = [
      hostMsg.roster([{ userId: '@a:t', name: 'a' }]),
      hostMsg.avatar('@a:t', config),
      hostMsg.pose('@a:t', 1, 2, 0.5, 3),
      hostMsg.openness('@a:t', 0.4),
      hostMsg.blendshapes('@a:t', 'AAEC'),
      hostMsg.speaking('@a:t', true),
      hostMsg.expression('@a:t', 'happy'),
      hostMsg.placeMedia('table-1', { eventId: '$e', kind: 'image', label: 'x' }, null),
      hostMsg.clearMedia('table-1'),
      hostMsg.stage('@a:t', true),
      hostMsg.setLocal('@a:t'),
      hostMsg.enterVR(),
    ];
    for (const env of envelopes) {
      expect(env['v']).withContext(env['t'] as string).toBe(CHAT3D_PROTOCOL_VERSION);
      expect(typeof env['t']).toBe('string');
    }
  });

  it('builds the exact §5 payload shapes the game consumes', () => {
    expect(decodeAsGame(hostMsg.pose('@a:t', 1, 2, 0.5, 3))).toEqual(['@a:t', 1, 2, 0.5, 3]);
    expect(decodeAsGame(hostMsg.placeMedia('stage', { eventId: '$e', kind: 'image', label: 'talk' }, null)))
      .toEqual(['stage', JSON.stringify({ eventId: '$e', kind: 'image', label: 'talk' }), null]);
    expect(decodeAsGame(hostMsg.clearMedia('screen-2'))).toEqual(['screen-2']);
    expect(decodeAsGame(hostMsg.setLocal('@me:t'))).toEqual(['@me:t']);
    expect(decodeAsGame(hostMsg.enterVR())).toEqual([]);
  });

  /**
   * REGRESSION (cross-repo contract drift): the builders used to emit their own
   * invented field names (`users`, `config`, `value`, `values`, `speaking`,
   * `on`, `meta`, `bytes`) with NO `args` array. The game maps an envelope with
   * `Array.isArray(d.args) ? d.args : SIG[t].map(k => d[k] ?? null)`, so 7 of
   * the 12 call types decoded to nulls — roster/avatar/openness/blendshapes/
   * speaking/stage/placeMedia all silently no-op'd. These tests decode with the
   * game's OWN mapping so an invented field name can never pass again.
   */
  describe('decoded through the GAME\'s own argument mapping (chat3d_bridge.gd SIGNATURES)', () => {
    const config = randomChar3dConfig('x');

    it('pins the signature table VERBATIM against the game\'s copy', () => {
      // Transcribed from hugmesh-games
      // games/shadows-of-the-net/scripts/chat3d_bridge.gd `const SIGNATURES`,
      // which is also what DESIGN §5 names. Any silent edit on either side
      // must break this.
      expect(HOST_CALL_SIGNATURES).toEqual({
        roster: ['json'],
        avatar: ['userId', 'configJson'],
        pose: ['userId', 'x', 'z', 'yaw', 'seat'],
        openness: ['userId', 'f'],
        blendshapes: ['userId', 'b64'],
        speaking: ['userId', 'value'],
        expression: ['userId', 'label'],
        placeMedia: ['surfaceId', 'metaJson', 'pngBase64'],
        clearMedia: ['surfaceId'],
        stage: ['userId', 'value'],
        setLocal: ['userId'],
        enterVR: [],
      });
      // …and every declared host→game type has a builder.
      const built = hostMsg as unknown as Record<string, unknown>;
      for (const type of Object.keys(HOST_CALL_SIGNATURES)) {
        expect(typeof built[type]).withContext(`${type} builder`).toBe('function');
      }
    });

    it('roster → a JSON STRING (the game JSON-parses it and expects an Array)', () => {
      const args = decodeAsGame(hostMsg.roster([{ userId: '@a:t', name: 'a' }]))!;
      expect(typeof args[0]).toBe('string');
      expect(JSON.parse(args[0] as string)).toEqual([{ userId: '@a:t', name: 'a' }]);
    });

    it('avatar → [userId, configJson STRING]; billboard mode sends null, never undefined', () => {
      const args = decodeAsGame(hostMsg.avatar('@a:t', config))!;
      expect(args[0]).toBe('@a:t');
      expect(JSON.parse(args[1] as string)).toEqual(config);
      expect(decodeAsGame(hostMsg.avatar('@a:t', null))!).toEqual(['@a:t', null]);
    });

    it('openness/blendshapes/speaking/stage decode to their real values, not null', () => {
      expect(decodeAsGame(hostMsg.openness('@a:t', 0.4))).toEqual(['@a:t', 0.4]);
      expect(decodeAsGame(hostMsg.blendshapes('@a:t', 'AAEC'))).toEqual(['@a:t', 'AAEC']);
      expect(decodeAsGame(hostMsg.speaking('@a:t', true))).toEqual(['@a:t', true]);
      // `false` must survive as false (a `?? null` on a falsy value would lie).
      expect(decodeAsGame(hostMsg.speaking('@a:t', false))).toEqual(['@a:t', false]);
      expect(decodeAsGame(hostMsg.stage('@a:t', true))).toEqual(['@a:t', true]);
      expect(decodeAsGame(hostMsg.stage('@a:t', false))).toEqual(['@a:t', false]);
      expect(decodeAsGame(hostMsg.openness('@a:t', 0))).toEqual(['@a:t', 0]);
      expect(decodeAsGame(hostMsg.expression('@a:t', 'happy'))).toEqual(['@a:t', 'happy']);
    });

    it('placeMedia → [surfaceId, metaJson STRING, pngBase64 STRING|null]', () => {
      const args = decodeAsGame(hostMsg.placeMedia('table-1', { eventId: '$e', kind: 'image', label: 'sunset' }, 'CQkJ'))!;
      expect(args[0]).toBe('table-1');
      expect(JSON.parse(args[1] as string)).toEqual({ eventId: '$e', kind: 'image', label: 'sunset' });
      expect(args[2]).toBe('CQkJ');
      // An ArrayBuffer here would JSON.stringify to {} inside the game's queue
      // drain and decode to zero bytes.
      expect(args[2] instanceof ArrayBuffer).toBeFalse();
    });

    /** One of every §5 call, built by the shipped builders. */
    const everyCall = (): HostEnvelope[] => [
      hostMsg.roster([{ userId: '@a:t', name: 'a' }]),
      hostMsg.avatar('@a:t', config),
      hostMsg.pose('@a:t', 1, 2, 0.5, 3),
      hostMsg.openness('@a:t', 0.4),
      hostMsg.blendshapes('@a:t', 'AAEC'),
      hostMsg.speaking('@a:t', true),
      hostMsg.expression('@a:t', 'happy'),
      hostMsg.placeMedia('table-1', { eventId: '$e', kind: 'image', label: 'l' }, null),
      hostMsg.clearMedia('table-1'),
      hostMsg.stage('@a:t', true),
      hostMsg.setLocal('@a:t'),
      hostMsg.enterVR(),
    ];

    /**
     * REGRESSION: every envelope really carries BOTH forms.
     *
     * The game's decoder is `Array.isArray(d.args) ? d.args : sig.map(...)`, so
     * the `args` array is the path it takes FIRST and the one DESIGN §5 names.
     * Asserting it only through {@link decodeAsGame} cannot see it: strip
     * `args` from every builder and the decoder silently falls through to the
     * named fields, so the comparison test below passes with the whole `args`
     * form deleted. This reads the raw envelope instead — the two forms must be
     * present, complete and in agreement.
     */
    it('carries the `args` ARRAY in signature order AND the signature-named fields', () => {
      for (const env of everyCall()) {
        const t = env['t'] as keyof typeof HOST_CALL_SIGNATURES;
        const sig = HOST_CALL_SIGNATURES[t];
        const args = env['args'];
        expect(Array.isArray(args)).withContext(`${t} args is an Array`).toBeTrue();
        // Exactly one slot per declared argument — no short/long arity, which
        // the game would map onto the wrong parameters.
        expect((args as unknown[]).length).withContext(`${t} arity`).toBe(sig.length);
        // …and the named form carries the SAME values under the signature's own
        // names (never an invented spelling the game cannot see).
        expect(sig.map((k) => env[k])).withContext(`${t} named fields`).toEqual(args as unknown[]);
        // Every signature name is actually present as a key (an `undefined`
        // read would compare equal above but vanish in a structured clone).
        for (const k of sig) {
          expect(Object.prototype.hasOwnProperty.call(env, k))
            .withContext(`${t}.${k} present`).toBeTrue();
        }
      }
    });

    it('the NAMED-field fallback path decodes identically to the args path', () => {
      // The game prefers `args`; if a future engine build drops it, the named
      // fields must still be the signature's names.
      for (const env of everyCall()) {
        const viaArgs = decodeAsGame(env)!;
        const { args, ...named } = env as Record<string, unknown>;
        // Guard against this comparison going vacuous: if the builders ever
        // stop emitting `args`, BOTH sides take the named path and the
        // assertion below proves nothing.
        expect(Array.isArray(args)).withContext(`${env['t']} still emits args`).toBeTrue();
        const viaNamed = decodeAsGame(named)!;
        expect(viaNamed).withContext(env['t'] as string).toEqual(viaArgs);
      }
    });
  });
});

describe('mxidLocalpart (the nametag fallback both sides must agree on)', () => {
  it('reduces an mxid to the localpart the game derives from the id alone', () => {
    expect(mxidLocalpart('@alice:example.org')).toBe('alice');
    expect(mxidLocalpart('@a.b-c_d:matrix.hugmesh.net')).toBe('a.b-c_d');
  });

  it('leaves anything that is not an mxid untouched (never returns empty)', () => {
    expect(mxidLocalpart('alice')).toBe('alice');
    expect(mxidLocalpart('@nocolon')).toBe('@nocolon');
    expect(mxidLocalpart('')).toBe('');
  });
});
