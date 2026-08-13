/**
 * MODERATION guards for the shared VN scene (`net.hugmesh.vn.scene` room
 * STATE). The scene is per-room latest-wins state that any member the room's
 * power levels allow can write — and at some room presets that is EVERY member,
 * so a hostile peer could flip or spam the stage. These pure helpers let the
 * receive path DEFEND itself, independent of whether the homeserver enforced the
 * write:
 *
 *   1. POWER LEVEL — a scene event whose SENDER sits below the required power
 *      level is ignored. The required level is the room's own required-to-send
 *      threshold for the scene state event (per-event override, else
 *      `state_default`), floored at a configurable minimum (default moderator
 *      PL 50) so even a mis-configured room can't let anyone drive the stage.
 *   2. RATE LIMIT — {@link SceneRateLimiter} coalesces bursts so even an
 *      authorized-but-hostile driver cannot seizure the stage.
 *
 * Everything here is pure / clock-injectable so the trust boundary is unit
 * testable in isolation (see vn-scene-moderation.spec.ts). It never throws.
 */

/** Default minimum power level (Matrix "moderator") required to drive the shared scene. */
export const DEFAULT_SCENE_MIN_POWER_LEVEL = 50;

/** The subset of `m.room.power_levels` the scene guard reads. */
export interface RoomPowerLevels {
  /** Explicit per-user power levels (`users` map). */
  users: Record<string, number>;
  /** Power level of a user with no explicit entry (`users_default`, default 0). */
  usersDefault: number;
  /** Per-event-type send requirements (`events` map). */
  events: Record<string, number>;
  /** Required level to send a state event with no per-event entry (`state_default`, default 50). */
  stateDefault: number;
}

const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Copy only the finite-number entries of a raw `{id: level}` map (fail-soft). */
const numberMap = (raw: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[k] = v;
      }
    }
  }
  return out;
};

/**
 * Parse raw `m.room.power_levels` content into the subset the scene guard reads.
 * Fail-soft: a missing/malformed content yields the Matrix defaults
 * (`users_default` 0, `state_default` 50, empty maps) so an unreadable PL event
 * still produces a SAFE (restrictive) view rather than throwing.
 */
export function parseRoomPowerLevels(raw: unknown): RoomPowerLevels {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    users: numberMap(o['users']),
    usersDefault: finiteOr(o['users_default'], 0),
    events: numberMap(o['events']),
    // Matrix default state_default is 50 when the PL event omits it.
    stateDefault: finiteOr(o['state_default'], 50),
  };
}

/**
 * The power level a member must hold for the client to APPLY their scene event.
 * Fail-safe: the room's own required-to-send threshold for `sceneEventType`
 * (the per-event override, else `state_default`), floored at `floor` so even a
 * mis-configured room (e.g. `state_default` 0) still demands at least a
 * moderator. When PL is unknown, the floor applies.
 *
 * The `events` lookup is keyed by exact type NAME, so dual-read callers must
 * pass the type the event ACTUALLY arrived under (canonical or a LEGACY_*
 * generation) — an older-generation room's per-event override names the older
 * type, and looking the canonical name up there would miss it. The floor makes
 * that miss restrictive, never permissive.
 */
export function requiredScenePowerLevel(
  pl: RoomPowerLevels | null | undefined,
  sceneEventType: string,
  floor: number = DEFAULT_SCENE_MIN_POWER_LEVEL,
): number {
  if (!pl) {
    return floor;
  }
  const perEvent = pl.events[sceneEventType];
  const roomRequired = typeof perEvent === 'number' && Number.isFinite(perEvent) ? perEvent : pl.stateDefault;
  return Math.max(roomRequired, floor);
}

/** `sender`'s effective power level (explicit `users` entry, else `users_default`). */
export function senderPowerLevel(
  pl: RoomPowerLevels | null | undefined,
  sender: string | null | undefined,
): number {
  if (!pl) {
    return 0;
  }
  if (!sender) {
    return pl.usersDefault;
  }
  const explicit = pl.users[sender];
  return typeof explicit === 'number' && Number.isFinite(explicit) ? explicit : pl.usersDefault;
}

/**
 * True when `sender` may drive the shared scene — their effective power level is
 * at or above the {@link requiredScenePowerLevel}. A below-threshold sender's
 * scene event MUST be ignored by the receive path.
 */
export function senderMayDriveScene(
  pl: RoomPowerLevels | null | undefined,
  sender: string | null | undefined,
  sceneEventType: string,
  floor: number = DEFAULT_SCENE_MIN_POWER_LEVEL,
): boolean {
  return senderPowerLevel(pl, sender) >= requiredScenePowerLevel(pl, sceneEventType, floor);
}

/**
 * Sliding-window rate limiter that COALESCES bursts of shared-scene changes so
 * even an authorized-but-hostile driver cannot seizure the stage: at most
 * `maxPerWindow` applied changes per `windowMs`. {@link allow} returns `false`
 * once the window is saturated — the caller then drops/coalesces that flip and
 * keeps the last applied scene until the window frees, at which point a later
 * poll re-applies the newest state. Clock-injectable for deterministic tests.
 */
export class SceneRateLimiter {
  /** Timestamps of the changes applied inside the current window (oldest first). */
  private readonly stamps: number[] = [];

  constructor(
    /** Most applied scene changes tolerated within one window (default 3). */
    private readonly maxPerWindow: number = 3,
    /** Sliding window length in ms (default 5000 → at most 3 flips / 5s). */
    private readonly windowMs: number = 5_000,
    /** Injectable clock (default wall clock). */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Consume a token for ONE scene change. Returns `true` when the change may be
   * applied, `false` when the burst window is saturated and the change must be
   * dropped/coalesced. Only call this for a GENUINE change (a no-op re-read of
   * the same scene should not spend a token).
   */
  allow(): boolean {
    const t = this.now();
    while (this.stamps.length > 0 && t - this.stamps[0] >= this.windowMs) {
      this.stamps.shift();
    }
    if (this.stamps.length >= this.maxPerWindow) {
      return false;
    }
    this.stamps.push(t);
    return true;
  }
}
