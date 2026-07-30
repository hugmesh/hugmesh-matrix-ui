import { TestBed } from '@angular/core/testing';
import { MatrixService } from '../../matrix.service';
import {
  VN_SCENE_STATE_TYPE,
  VnSceneState,
  VnSceneStateService,
  parseVnSceneState,
} from './vn-scene-state.service';

class MatrixStub {
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt:1');
  // The MODERATED read pulls the full room state (scene event + its SENDER +
  // m.room.power_levels), which the single-event GET cannot expose.
  roomState = jasmine.createSpy('roomState').and.resolveTo([] as any[]);
}

/** Build a room-state array carrying a vn.scene event (with sender) + power levels. */
function roomStateWith(opts: {
  sender: string;
  scene: VnSceneState;
  users?: Record<string, number>;
  usersDefault?: number;
  stateDefault?: number;
  events?: Record<string, number>;
}): any[] {
  return [
    { type: VN_SCENE_STATE_TYPE, stateKey: '', sender: opts.sender, content: opts.scene },
    {
      type: 'm.room.power_levels',
      stateKey: '',
      sender: '@creator:snap',
      content: {
        users: opts.users ?? { '@mod:snap': 50, '@admin:snap': 100 },
        users_default: opts.usersDefault ?? 0,
        state_default: opts.stateDefault ?? 50,
        events: opts.events ?? {},
      },
    },
  ];
}

describe('parseVnSceneState (untrusted room-state content)', () => {
  it('parses a well-formed content', () => {
    const state = parseVnSceneState({
      sceneId: 'vn_scene_cafe',
      props: [{ propId: 'vn_prop_lamp', x: 0.2, y: 0.8, scale: 1.5 }],
    });
    expect(state).toEqual({
      sceneId: 'vn_scene_cafe',
      props: [{ propId: 'vn_prop_lamp', x: 0.2, y: 0.8, scale: 1.5 }],
    });
  });

  it('null / non-object content parses to null (unset scene)', () => {
    expect(parseVnSceneState(null)).toBeNull();
    expect(parseVnSceneState(undefined)).toBeNull();
    expect(parseVnSceneState('nope')).toBeNull();
    expect(parseVnSceneState(42)).toBeNull();
  });

  it('a non-string/empty sceneId becomes null (plain stage), props still parse', () => {
    expect(parseVnSceneState({ sceneId: 7, props: [] })!.sceneId).toBeNull();
    expect(parseVnSceneState({ sceneId: '', props: [] })!.sceneId).toBeNull();
    const state = parseVnSceneState({ sceneId: {}, props: [{ propId: 'p', x: 0.5, y: 0.5, scale: 1 }] })!;
    expect(state.sceneId).toBeNull();
    expect(state.props.length).toBe(1);
  });

  it('CLAMPS hostile coords/scale into range and DEFAULTS non-finite values', () => {
    const state = parseVnSceneState({
      sceneId: 's',
      props: [
        { propId: 'a', x: -3, y: 99, scale: 1000 },
        { propId: 'b', x: Number.NaN, y: Number.POSITIVE_INFINITY, scale: 'huge' },
      ],
    })!;
    expect(state.props[0]).toEqual({ propId: 'a', x: 0, y: 1, scale: 4 });
    expect(state.props[1]).toEqual({ propId: 'b', x: 0.5, y: 0.5, scale: 1 });
  });

  it('drops malformed prop rows (no/empty propId, non-objects)', () => {
    const state = parseVnSceneState({
      sceneId: 's',
      props: [{ x: 1, y: 1 }, { propId: '' }, 'junk', null, { propId: 'ok' }],
    })!;
    expect(state.props).toEqual([{ propId: 'ok', x: 0.5, y: 0.5, scale: 1 }]);
  });

  it('caps the placed-prop count (hostile 1000-prop event does not DoS the stage)', () => {
    const props = Array.from({ length: 1000 }, (_, i) => ({ propId: `p${i}`, x: 0.5, y: 0.5, scale: 1 }));
    const state = parseVnSceneState({ sceneId: 's', props })!;
    expect(state.props.length).toBe(32);
  });

  it('BOUNDARY COMBOS: prop counts 0 / 1 / 32 / 33 parse to 0 / 1 / 32 / 32', () => {
    for (const [count, expected] of [[0, 0], [1, 1], [32, 32], [33, 32]] as const) {
      const props = Array.from({ length: count }, (_, i) => ({ propId: `p${i}`, x: 0, y: 1, scale: 1 }));
      const state = parseVnSceneState({ sceneId: 's', props })!;
      expect(state.props.length).withContext(`${count} props in`).toBe(expected);
    }
  });

  it('SEEDED RANDOM SWEEP: 200 arbitrary rows always parse INTO the invariants (x/y 0..1, scale 0.05..4, ≤32 props)', () => {
    // mulberry32, fixed seed — the same hostile rows every run (deterministic).
    let s = 0xBADF00D;
    const rnd = (): number => {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const weird = (): unknown => {
      const roll = rnd();
      if (roll < 0.3) return (rnd() - 0.5) * 1e6; // wild but finite numbers
      if (roll < 0.4) return Number.NaN;
      if (roll < 0.5) return Number.POSITIVE_INFINITY;
      if (roll < 0.6) return String(rnd()); // numeric-looking string (still invalid)
      if (roll < 0.7) return null;
      return rnd(); // in-range number
    };
    const rows = Array.from({ length: 200 }, (_, i) => ({
      propId: rnd() < 0.9 ? `p${i}` : (rnd() < 0.5 ? '' : 123 as unknown as string),
      x: weird(), y: weird(), scale: weird(),
    }));
    const state = parseVnSceneState({ sceneId: 'sweep', props: rows })!;
    expect(state.props.length).toBeLessThanOrEqual(32);
    for (const p of state.props) {
      expect(typeof p.propId).toBe('string');
      expect(p.propId.length).toBeGreaterThan(0);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
      expect(p.scale).toBeGreaterThanOrEqual(0.05);
      expect(p.scale).toBeLessThanOrEqual(4);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.scale)).toBeTrue();
    }
  });
});

describe('VnSceneStateService', () => {
  let service: VnSceneStateService;
  let matrix: MatrixStub;

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [{ provide: MatrixService, useValue: matrix }],
    });
    service = TestBed.inject(VnSceneStateService);
  });

  it('reads the shared scene from the systems.hugmesh.vn.scene state event', async () => {
    matrix.getStateEvent.and.resolveTo({
      sceneId: 'vn_scene_beach_sunset',
      props: [{ propId: 'vn_prop_drink', x: 0.7, y: 0.75, scale: 0.35 }],
    });

    const state = await service.getSceneState('!room:snap');

    expect(matrix.getStateEvent).toHaveBeenCalledWith('!room:snap', VN_SCENE_STATE_TYPE);
    expect(state).toEqual({
      sceneId: 'vn_scene_beach_sunset',
      props: [{ propId: 'vn_prop_drink', x: 0.7, y: 0.75, scale: 0.35 }],
    });
  });

  it('FAIL-SOFT read: unset event (null), a thrown read, or no room ⇒ null scene', async () => {
    expect(await service.getSceneState('!room:snap')).toBeNull(); // stub resolves null

    matrix.getStateEvent.and.rejectWith(new Error('403'));
    expect(await service.getSceneState('!room:snap')).toBeNull();

    expect(await service.getSceneState('')).toBeNull();
    // No room id must not even hit the wire.
    expect(matrix.getStateEvent).toHaveBeenCalledTimes(2);
  });

  it('writes the shared scene as the exact spec content shape', async () => {
    const state: VnSceneState = {
      sceneId: 'vn_scene_castle_hall',
      props: [{ propId: 'vn_prop_banner', x: 0.5, y: 0.2, scale: 1.4 }],
    };

    const ok = await service.setSceneState('!room:snap', state);

    expect(ok).toBeTrue();
    expect(matrix.setStateEvent).toHaveBeenCalledWith('!room:snap', VN_SCENE_STATE_TYPE, {
      sceneId: 'vn_scene_castle_hall',
      props: [{ propId: 'vn_prop_banner', x: 0.5, y: 0.2, scale: 1.4 }],
    });
  });

  it('normalizes (clamps) our own writes so out-of-range coords never go out', async () => {
    await service.setSceneState('!room:snap', {
      sceneId: 's',
      props: [{ propId: 'p', x: 5, y: -1, scale: 99 }],
    });
    const content = matrix.setStateEvent.calls.mostRecent().args[2] as VnSceneState;
    expect(content.props[0]).toEqual({ propId: 'p', x: 1, y: 0, scale: 4 });
  });

  it('FAIL-SOFT write: a rejected PUT (e.g. power level) resolves false, never throws', async () => {
    matrix.setStateEvent.and.rejectWith(new Error('403 M_FORBIDDEN'));
    const ok = await service.setSceneState('!room:snap', { sceneId: null, props: [] });
    expect(ok).toBeFalse();
  });

  it('no room id ⇒ false without touching the wire', async () => {
    expect(await service.setSceneState('', { sceneId: null, props: [] })).toBeFalse();
    expect(matrix.setStateEvent).not.toHaveBeenCalled();
  });

  // ───────── MODERATED receive path: power-level + rate-limit guards ─────────
  describe('getModeratedSceneState (hostile-member defence)', () => {
    const CAFE: VnSceneState = { sceneId: 'vn_scene_cafe', props: [] };

    it('IGNORES a scene from a BELOW-power-level sender (a hostile member cannot flip the stage)', async () => {
      matrix.roomState.and.resolveTo(roomStateWith({ sender: '@rando:snap', scene: CAFE })); // PL 0 < 50
      expect(await service.getModeratedSceneState('!room:snap')).toBeNull();
    });

    it('APPLIES a scene from an AT-threshold sender (moderator, PL 50)', async () => {
      matrix.roomState.and.resolveTo(roomStateWith({ sender: '@mod:snap', scene: CAFE }));
      expect(await service.getModeratedSceneState('!room:snap')).toEqual(CAFE);
    });

    it('APPLIES a scene from an ABOVE-threshold sender (admin, PL 100)', async () => {
      const beach: VnSceneState = { sceneId: 'vn_scene_beach_sunset', props: [] };
      matrix.roomState.and.resolveTo(roomStateWith({ sender: '@admin:snap', scene: beach }));
      expect(await service.getModeratedSceneState('!room:snap')).toEqual(beach);
    });

    it('KEEPS clamping a below-range prop from an authorized-but-hostile sender (fail-safe, no crash)', async () => {
      const hostile: VnSceneState = { sceneId: 's', props: [{ propId: 'p', x: 9 as number, y: -9 as number, scale: 999 as number }] };
      matrix.roomState.and.resolveTo(roomStateWith({ sender: '@mod:snap', scene: hostile }));
      const applied = await service.getModeratedSceneState('!room:snap');
      expect(applied!.props[0]).toEqual({ propId: 'p', x: 1, y: 0, scale: 4 });
    });

    it('COALESCES a rapid burst: only the first few flips from an authorized sender are applied', async () => {
      const scenes = ['vn_scene_cafe', 'vn_scene_beach_sunset', 'vn_scene_castle_hall', 'vn_scene_starship', 'vn_scene_void']
        .map((sceneId) => ({ sceneId, props: [] } as VnSceneState));
      const applied: (VnSceneState | null)[] = [];
      for (const scene of scenes) {
        matrix.roomState.and.resolveTo(roomStateWith({ sender: '@admin:snap', scene }));
        applied.push(await service.getModeratedSceneState('!room:snap'));
      }
      // Default limiter: 3 changes / 5s. All five reads land within the window,
      // so flips 4 and 5 are coalesced back to the last APPLIED scene (#3).
      expect(applied[0]).toEqual(scenes[0]);
      expect(applied[1]).toEqual(scenes[1]);
      expect(applied[2]).toEqual(scenes[2]);
      expect(applied[3]).toEqual(scenes[2]); // coalesced — stage does NOT seizure
      expect(applied[4]).toEqual(scenes[2]);
    });

    it('FAIL-SOFT: an unset scene, a thrown read, or no room id ⇒ null (never throws)', async () => {
      matrix.roomState.and.resolveTo([]); // no vn.scene event
      expect(await service.getModeratedSceneState('!room:snap')).toBeNull();

      matrix.roomState.and.rejectWith(new Error('boom'));
      expect(await service.getModeratedSceneState('!room:snap')).toBeNull();

      expect(await service.getModeratedSceneState('')).toBeNull();
    });
  });
});
