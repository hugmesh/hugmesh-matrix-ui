import {
  DEFAULT_SCENE_MIN_POWER_LEVEL,
  RoomPowerLevels,
  SceneRateLimiter,
  parseRoomPowerLevels,
  requiredScenePowerLevel,
  senderMayDriveScene,
  senderPowerLevel,
} from './vn-scene-moderation';
import { VN_SCENE_STATE_TYPE } from './vn-scene-state.service';

describe('parseRoomPowerLevels (untrusted m.room.power_levels content)', () => {
  it('reads users / users_default / events / state_default', () => {
    const pl = parseRoomPowerLevels({
      users: { '@mod:snap': 50, '@admin:snap': 100 },
      users_default: 0,
      events: { [VN_SCENE_STATE_TYPE]: 25 },
      state_default: 50,
    });
    expect(pl).toEqual({
      users: { '@mod:snap': 50, '@admin:snap': 100 },
      usersDefault: 0,
      events: { [VN_SCENE_STATE_TYPE]: 25 },
      stateDefault: 50,
    });
  });

  it('FAIL-SOFT: missing/garbage content yields SAFE Matrix defaults (default 0, state_default 50)', () => {
    for (const raw of [null, undefined, 'nope', 42, {}]) {
      expect(parseRoomPowerLevels(raw)).toEqual({
        users: {},
        usersDefault: 0,
        events: {},
        stateDefault: 50,
      });
    }
  });

  it('drops non-number map entries (a hostile "users": {id: "99"} cannot forge a level)', () => {
    const pl = parseRoomPowerLevels({
      users: { '@a:snap': 50, '@b:snap': '99', '@c:snap': null, '@d:snap': Number.NaN },
      events: { [VN_SCENE_STATE_TYPE]: 'lots' },
    });
    expect(pl.users).toEqual({ '@a:snap': 50 });
    expect(pl.events).toEqual({});
  });
});

describe('requiredScenePowerLevel (fail-safe threshold)', () => {
  it('uses the per-event send requirement when set, floored at the moderator default', () => {
    const pl = parseRoomPowerLevels({ events: { [VN_SCENE_STATE_TYPE]: 75 }, state_default: 50 });
    expect(requiredScenePowerLevel(pl, VN_SCENE_STATE_TYPE)).toBe(75); // room stricter than floor
  });

  it('falls back to state_default when no per-event requirement, floored at the moderator default', () => {
    const pl = parseRoomPowerLevels({ state_default: 100 });
    expect(requiredScenePowerLevel(pl, VN_SCENE_STATE_TYPE)).toBe(100);
  });

  it('FLOORS a mis-configured lax room (state_default 0 / events 0) at the moderator default 50', () => {
    expect(requiredScenePowerLevel(parseRoomPowerLevels({ state_default: 0 }), VN_SCENE_STATE_TYPE)).toBe(50);
    expect(
      requiredScenePowerLevel(parseRoomPowerLevels({ events: { [VN_SCENE_STATE_TYPE]: 0 } }), VN_SCENE_STATE_TYPE),
    ).toBe(50);
  });

  it('unknown power levels ⇒ the floor applies', () => {
    expect(requiredScenePowerLevel(null, VN_SCENE_STATE_TYPE)).toBe(DEFAULT_SCENE_MIN_POWER_LEVEL);
  });

  it('honours a custom (lower) configurable floor', () => {
    const pl = parseRoomPowerLevels({ state_default: 10 });
    expect(requiredScenePowerLevel(pl, VN_SCENE_STATE_TYPE, 10)).toBe(10);
  });
});

describe('senderPowerLevel', () => {
  const pl: RoomPowerLevels = { users: { '@mod:snap': 50 }, usersDefault: 0, events: {}, stateDefault: 50 };

  it('reads an explicit users entry', () => {
    expect(senderPowerLevel(pl, '@mod:snap')).toBe(50);
  });

  it('falls back to users_default for an un-listed member', () => {
    expect(senderPowerLevel({ ...pl, usersDefault: 5 }, '@rando:snap')).toBe(5);
  });

  it('null pl / sender ⇒ 0 / users_default (never throws)', () => {
    expect(senderPowerLevel(null, '@x:snap')).toBe(0);
    expect(senderPowerLevel({ ...pl, usersDefault: 7 }, null)).toBe(7);
  });
});

describe('senderMayDriveScene', () => {
  // Default room: state_default 50, everyone else at users_default 0.
  const pl = parseRoomPowerLevels({
    users: { '@mod:snap': 50, '@admin:snap': 100 },
    users_default: 0,
    state_default: 50,
  });

  it('DENIES a below-power-level (default 0) member', () => {
    expect(senderMayDriveScene(pl, '@rando:snap', VN_SCENE_STATE_TYPE)).toBeFalse();
  });

  it('ALLOWS a member AT the threshold (moderator, PL 50)', () => {
    expect(senderMayDriveScene(pl, '@mod:snap', VN_SCENE_STATE_TYPE)).toBeTrue();
  });

  it('ALLOWS a member ABOVE the threshold (admin, PL 100)', () => {
    expect(senderMayDriveScene(pl, '@admin:snap', VN_SCENE_STATE_TYPE)).toBeTrue();
  });

  it('still DENIES an un-privileged member even when the room made the event lax (events 0)', () => {
    const lax = parseRoomPowerLevels({ users_default: 0, events: { [VN_SCENE_STATE_TYPE]: 0 }, state_default: 0 });
    expect(senderMayDriveScene(lax, '@rando:snap', VN_SCENE_STATE_TYPE)).toBeFalse();
  });
});

describe('SceneRateLimiter (burst coalescing)', () => {
  it('allows up to maxPerWindow changes, then COALESCES the rest until the window frees', () => {
    let clock = 1_000;
    const limiter = new SceneRateLimiter(3, 5_000, () => clock);

    // A tight burst at the same instant: first 3 apply, the rest are coalesced.
    expect(limiter.allow()).toBeTrue();
    expect(limiter.allow()).toBeTrue();
    expect(limiter.allow()).toBeTrue();
    expect(limiter.allow()).toBeFalse();
    expect(limiter.allow()).toBeFalse();

    // Still inside the 5s window ⇒ still coalesced.
    clock = 4_999;
    expect(limiter.allow()).toBeFalse();

    // Window elapsed ⇒ a fresh change applies again.
    clock = 6_001;
    expect(limiter.allow()).toBeTrue();
  });

  it('spreads applies as the window slides (never more than maxPerWindow in any window)', () => {
    let clock = 0;
    const limiter = new SceneRateLimiter(2, 1_000, () => clock);
    expect(limiter.allow()).toBeTrue();  // t=0
    clock = 400;
    expect(limiter.allow()).toBeTrue();  // t=400 (2 in window)
    clock = 900;
    expect(limiter.allow()).toBeFalse(); // t=900 still 2 in [−100,900]
    clock = 1_100;
    expect(limiter.allow()).toBeTrue();  // t=0 aged out → room for one more
  });
});
