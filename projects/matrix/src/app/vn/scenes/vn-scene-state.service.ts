import { Injectable, inject } from '@angular/core';
import { MatrixService, firstStateEvent } from '../../matrix.service';
import {
  DEFAULT_SCENE_MIN_POWER_LEVEL,
  SceneRateLimiter,
  parseRoomPowerLevels,
  senderMayDriveScene,
} from './vn-scene-moderation';

/**
 * The room STATE event type carrying the shared VN scene. State (not timeline)
 * so the scene is per-room, latest-wins, and readable by any joined member —
 * every participant sees the SAME stage, and anyone the room's power levels
 * allow can change it.
 */
export const VN_SCENE_STATE_TYPE = 'net.hugmesh.vn.scene';

/**
 * Pre-rebrand generations of {@link VN_SCENE_STATE_TYPE}; read-fallback only —
 * never written. A scene staged under an older branding still lives under that
 * name, and BOTH old generations are real data — `systems.hugmesh.*` (every
 * post-squash build before the .net domain move) and `systems.snapdragon.*`
 * (pre-rebrand rooms). Ordered newest first: reads try the canonical name,
 * then each generation in order (a newer event wins whenever it exists);
 * writes stay canonical-only, so the first post-move scene change migrates the
 * room forward.
 */
export const LEGACY_VN_SCENE_STATE_TYPES: readonly string[] = [
  'systems.hugmesh.vn.scene', 'systems.snapdragon.vn.scene',
];

/** One placed prop in the shared scene: normalized stage coords + scale. */
export interface VnPlacedProp {
  /** Manifest prop id (`vn_prop_lamp`). Unknown ids render nothing (fail-soft). */
  propId: string;
  /** Horizontal centre, normalized 0..1 across the 16:9 stage. */
  x: number;
  /** Vertical centre, normalized 0..1 down the stage. */
  y: number;
  /** Size multiplier (1 = the prop's natural stage size). */
  scale: number;
}

/** The shared per-room scene: which background + which props where. */
export interface VnSceneState {
  /** Manifest scene id, or null = no scene chosen (plain stage). */
  sceneId: string | null;
  props: VnPlacedProp[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Widest prop-scale the state will carry (guards a hostile/buggy peer's event). */
const MAX_PROP_SCALE = 4;
const MIN_PROP_SCALE = 0.05;
/**
 * LIMIT MAX_PROPS=32: cap on placed props parsed from a room's state (guards a
 * hostile event) AND the picker's add-prop ceiling (scene-picker disables Add
 * at the cap so the optimistic local state can never outgrow what the parse
 * would round-trip). 32 props is triple a densely dressed 10-prop set.
 */
export const MAX_PROPS = 32;

/**
 * Parse a raw `net.hugmesh.vn.scene` state-event content into a
 * {@link VnSceneState}. Tolerant/fail-soft — the content comes from OTHER room
 * members, so treat it as untrusted: non-string sceneIds become null, malformed
 * prop rows are dropped, x/y are clamped into 0..1, scale into a sane range,
 * and the prop count is capped. Returns null only when the content is not an
 * object at all. Pure + exported so the untrusted-input handling is
 * unit-testable in isolation.
 */
export function parseVnSceneState(raw: unknown): VnSceneState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const sceneId = typeof obj['sceneId'] === 'string' && obj['sceneId'].length > 0 ? obj['sceneId'] : null;
  const props: VnPlacedProp[] = [];
  for (const row of Array.isArray(obj['props']) ? (obj['props'] as unknown[]) : []) {
    if (props.length >= MAX_PROPS) {
      break;
    }
    const p = row as Record<string, unknown>;
    if (typeof p?.['propId'] !== 'string' || p['propId'].length === 0) {
      continue;
    }
    const x = typeof p['x'] === 'number' && Number.isFinite(p['x']) ? clamp(p['x'], 0, 1) : 0.5;
    const y = typeof p['y'] === 'number' && Number.isFinite(p['y']) ? clamp(p['y'], 0, 1) : 0.5;
    const scale = typeof p['scale'] === 'number' && Number.isFinite(p['scale'])
      ? clamp(p['scale'], MIN_PROP_SCALE, MAX_PROP_SCALE)
      : 1;
    props.push({ propId: p['propId'], x, y, scale });
  }
  return { sceneId, props };
}

/**
 * Reads/writes the SHARED per-room VN scene as the room state event
 * {@link VN_SCENE_STATE_TYPE} (content `{"sceneId": string|null, "props":
 * [{"propId","x","y","scale"}]}`, x/y normalized 0..1) via the existing
 * {@link MatrixService.getStateEvent}/{@link MatrixService.setStateEvent}
 * thin CS-API wrappers (GET/PUT `/_matrix/client/v3/rooms/{roomId}/state/
 * {type}/{stateKey}` through the BFF hsproxy, cookie auth). Because it is room
 * STATE, every participant sees the same scene and any member the room's power
 * levels allow can change it.
 *
 * FAIL-SOFT: an unset event, a denied read, or malformed content resolves to
 * `null` (callers render a plain stage); a denied/failed write resolves to
 * `false`, never a throw.
 */
@Injectable({ providedIn: 'root' })
export class VnSceneStateService {
  private readonly matrix = inject(MatrixService);

  /**
   * Per-room burst coalescer for {@link getModeratedSceneState}: caps how fast a
   * (even authorized) driver's scene FLIPS can hit the stage. Per-room so two
   * open rooms never starve each other's rate budget.
   */
  private readonly limiters = new Map<string, SceneRateLimiter>();
  /**
   * The last scene {@link getModeratedSceneState} actually APPLIED per room. Held
   * so a below-power-level or rate-limited event keeps the last GOOD scene
   * (never regressing to a hostile overwrite) and so change-detection can tell a
   * genuine flip from a redundant re-read.
   */
  private readonly lastApplied = new Map<string, VnSceneState | null>();

  /**
   * Low-level RAW read of the room's shared scene content (no sender/power-level
   * check). Null when unset, unreadable, or malformed. The RECEIVE path that
   * renders scenes from OTHER members must instead use
   * {@link getModeratedSceneState}, which enforces the power-level + rate-limit
   * trust boundary; this primitive is the un-guarded content read.
   */
  async getSceneState(roomId: string): Promise<VnSceneState | null> {
    if (!roomId) {
      return null;
    }
    // Canonical name first, then each older generation — first parseable wins.
    // Inline (no helper) so the canonical-hit path keeps the exact promise-hop
    // depth the pre-chain read had (caller settling is hop-count sensitive).
    for (const type of [VN_SCENE_STATE_TYPE, ...LEGACY_VN_SCENE_STATE_TYPES]) {
      try {
        const state = parseVnSceneState(await this.matrix.getStateEvent(roomId, type));
        if (state !== null) {
          return state;
        }
      } catch { /* unset/denied under this name — try the older generation */ }
    }
    return null;
  }

  /**
   * Write the room's shared scene (normalized through the same clamping parse,
   * so we never PUT out-of-range coords ourselves). True on success; false on
   * any failure (e.g. insufficient power level) — never a throw.
   */
  async setSceneState(roomId: string, state: VnSceneState): Promise<boolean> {
    if (!roomId) {
      return false;
    }
    const normalized = parseVnSceneState(state) ?? { sceneId: null, props: [] };
    const content = {
      sceneId: normalized.sceneId,
      props: normalized.props.map((p) => ({ propId: p.propId, x: p.x, y: p.y, scale: p.scale })),
    };
    try {
      await this.matrix.setStateEvent(roomId, VN_SCENE_STATE_TYPE, content);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * MODERATED read for the RECEIVE path — the scene the caller may safely RENDER
   * from other members. Reads the room's full state once (which carries the
   * scene event's SENDER and `m.room.power_levels`, neither of which the single
   * `GET /state/{type}` primitive exposes) and applies two guards before
   * returning:
   *
   *   1. POWER LEVEL — a scene event whose sender is below the required level
   *      (default moderator PL {@link DEFAULT_SCENE_MIN_POWER_LEVEL}, or the
   *      room-configured send threshold, whichever is higher) is IGNORED; the
   *      last applied scene is kept rather than the hostile overwrite.
   *   2. RATE LIMIT — a genuine change beyond a small burst rate is COALESCED
   *      (dropped for now, keeping the last scene) so even an authorized-but-
   *      hostile driver cannot seizure the stage; a later poll re-applies the
   *      newest state once the burst window frees.
   *
   * FAIL-SOFT: an unset scene, a denied/failed read, malformed content, or a
   * rejected event all resolve to the last applied scene (or null) — never a
   * throw. The per-prop clamps in {@link parseVnSceneState} still run. `floor`
   * (default {@link DEFAULT_SCENE_MIN_POWER_LEVEL}) is the configurable minimum
   * power level the guard will never drop below.
   */
  async getModeratedSceneState(
    roomId: string,
    floor: number = DEFAULT_SCENE_MIN_POWER_LEVEL,
  ): Promise<VnSceneState | null> {
    if (!roomId) {
      return null;
    }
    const last = this.lastApplied.get(roomId) ?? null;
    let events;
    try {
      events = await this.matrix.roomState(roomId);
    } catch {
      return last;
    }
    // The newest-generation scene event wins whenever it exists — a canonical
    // clear must keep suppressing an older-generation scene, not resurrect it.
    const sceneEvt = firstStateEvent(events, [VN_SCENE_STATE_TYPE, ...LEGACY_VN_SCENE_STATE_TYPES]);
    if (!sceneEvt) {
      // Unset scene — keep whatever we last applied (or a plain stage).
      return last;
    }
    const pl = parseRoomPowerLevels(
      events.find((e) => e.type === 'm.room.power_levels' && (e.stateKey ?? '') === '')?.content,
    );
    // GUARD 1: ignore a below-power-level sender's scene entirely. The
    // required-to-send lookup is keyed by the type the event ACTUALLY arrived
    // under (`sceneEvt.type`) — an older-generation room's power levels carry
    // their per-event override under that generation's name.
    if (!senderMayDriveScene(pl, sceneEvt.sender, sceneEvt.type, floor)) {
      return last;
    }
    const candidate = parseVnSceneState(sceneEvt.content);
    if (candidate === null) {
      return last;
    }
    // No genuine change ⇒ nothing to apply and no rate token spent.
    if (JSON.stringify(candidate) === JSON.stringify(last)) {
      return last;
    }
    // GUARD 2: coalesce bursts — drop this flip (keep the last scene) when the
    // burst window is saturated; a later poll re-applies once it frees.
    if (!this.limiterFor(roomId).allow()) {
      return last;
    }
    this.lastApplied.set(roomId, candidate);
    return candidate;
  }

  private limiterFor(roomId: string): SceneRateLimiter {
    let limiter = this.limiters.get(roomId);
    if (!limiter) {
      limiter = new SceneRateLimiter();
      this.limiters.set(roomId, limiter);
    }
    return limiter;
  }
}
