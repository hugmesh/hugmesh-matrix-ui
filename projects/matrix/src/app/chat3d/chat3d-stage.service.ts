import { Injectable, inject } from '@angular/core';
import { MatrixService, TimelineEvent, firstStateEvent } from '../matrix.service';
import {
  DEFAULT_SCENE_MIN_POWER_LEVEL,
  parseRoomPowerLevels,
  senderMayDriveScene,
} from '../vn/scenes/vn-scene-moderation';
import { CHAT3D_STATE_TYPE, LEGACY_CHAT3D_STATE_TYPES, parseChat3dState } from './chat3d-state.service';
import { LEGACY_CHAT3D_STAGE_TYPES } from '../legacy-read';

/**
 * The room STATE event naming who currently holds the chamber's STAGE — the
 * spotlit platform the Godot room teleports a rig onto (`stage(userId, bool)`,
 * XR-chat DESIGN §5).
 *
 * WHY THIS EXISTS. `stage` was a fully-received, unit-tested channel in the
 * game with ZERO producers on the host: nothing anywhere could ever put anyone
 * on the platform in matrix mode. The game deliberately refuses to invent one
 * of its own ("Matrix mode is deliberately excluded: there the host page owns
 * stage grants … inventing a `stageRequest` emit would be a unilateral protocol
 * change" — `room_controller.gd`), so the producer HAD to land here. This is
 * that producer; the alternative was deleting a working feature from the game.
 *
 * State, not timeline: the holder is per-room, latest-wins and readable by every
 * joined member, exactly like the scene placements (`chat3d.scene` precedent).
 * ONE holder at a time — the chamber has one platform and the game tracks a
 * single `_stage_cid`, so a list would be a shape neither side can render.
 */
export const CHAT3D_STAGE_TYPE = 'net.hugmesh.chat3d.stage';

/**
 * Pre-rebrand generations of {@link CHAT3D_STAGE_TYPE}; read-fallback only —
 * never written. A grant written under an older branding still names a holder,
 * and BOTH old generations are real data — spelled ONLY in `legacy-read.ts`
 * (the consolidated legacy-read list; see there for the generation policy).
 * Ordered newest first: the roomState scan takes the NEWEST generation's
 * grant whenever it exists (including a newer "nobody", which must keep the
 * platform empty rather than resurrect an older grant); every write goes to
 * the canonical type only.
 */
export { LEGACY_CHAT3D_STAGE_TYPES };

/** LIMIT: the Matrix spec's user-id cap — the holder is an mxid or nothing. */
export const MAX_MXID_LENGTH = 255;

/**
 * Parse a raw {@link CHAT3D_STAGE_TYPE} content into the holder's mxid, or null
 * for "nobody" (unset, retracted, malformed). STRICT, because the content is
 * other members' input that decides whose rig gets teleported into everyone's
 * spotlight: unknown keys, a wrong `v`, or anything that is not a plausible
 * mxid ⇒ null. Pure + exported so the untrusted-input handling is unit-testable
 * in isolation.
 */
export function parseChat3dStageState(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (!Object.keys(obj).every((k) => ['v', 'userId'].includes(k))) {
    return null;
  }
  if (obj['v'] !== 1) {
    return null;
  }
  const userId = obj['userId'];
  if (typeof userId !== 'string') {
    return null; // null / absent = the stage is free
  }
  if (!userId.startsWith('@') || !userId.includes(':') || userId.length > MAX_MXID_LENGTH) {
    return null;
  }
  return userId;
}

/**
 * Reads/writes the room's single STAGE grant and MODERATES the receive path.
 *
 * The grant is written as {@link CHAT3D_STAGE_TYPE} room state, so the
 * homeserver's own power-level rules are the first gate (the event type has no
 * override, so it lands on `state_default` — moderators, on a default room).
 * That is not enough on its own: a room admin can lower `state_default` by hand,
 * and this room's own enable flow writes per-event overrides, so the RECEIVE
 * path re-checks rather than trusting the write:
 *
 *   1. the 3D room must parse ENABLED (a disabled room lights nobody);
 *   2. when `stageModOnly` (the default), the event's SENDER must clear the
 *      moderator floor — the identical guard the stage SURFACE already gets in
 *      {@link Chat3dSceneService}, so the spotlight has one rule, not two;
 *   3. the holder must be a plausible mxid, and the CALLER additionally
 *      restricts it to the room's 3D roster (a grant naming a non-participant
 *      would otherwise make the game `ensure()` a rig for somebody who is not
 *      in the room).
 *
 * FAIL-SOFT throughout: unset/denied/malformed ⇒ nobody on stage; a failed write
 * ⇒ `false`. Never throws.
 */
@Injectable({ providedIn: 'root' })
export class Chat3dStageService {
  private readonly matrix = inject(MatrixService);

  /**
   * The mxid currently holding the stage, or null. `stateEvents` lets a caller
   * that already fetched the room state (the host's 1Hz poll) avoid a second
   * round-trip.
   */
  async getStageHolder(
    roomId: string,
    stateEvents?: TimelineEvent[],
    floor: number = DEFAULT_SCENE_MIN_POWER_LEVEL,
  ): Promise<string | null> {
    if (!roomId) {
      return null;
    }
    let events = stateEvents;
    if (!events) {
      try {
        events = await this.matrix.roomState(roomId);
      } catch {
        return null;
      }
    }
    const pickContent = (type: string) =>
      events!.find((e) => e.type === type && (e.stateKey ?? '') === '')?.content;
    // Canonical config first, then each pre-rebrand generation (read-only).
    const config = parseChat3dState(
      firstStateEvent(events, [CHAT3D_STATE_TYPE, ...LEGACY_CHAT3D_STATE_TYPES])?.content,
    );
    if (!config?.enabled) {
      return null;
    }
    // The newest-generation grant wins whenever it exists — the newer event is
    // the newer word (writes only ever go to the canonical type).
    const evt = firstStateEvent(events, [CHAT3D_STAGE_TYPE, ...LEGACY_CHAT3D_STAGE_TYPES]);
    if (!evt) {
      return null;
    }
    if (config.stageModOnly) {
      // PL lookup keyed by the type the grant ACTUALLY arrived under — an
      // older-generation room's per-event override (if any) names that type.
      const pl = parseRoomPowerLevels(pickContent('m.room.power_levels'));
      if (!senderMayDriveScene(pl, evt.sender, evt.type, floor)) {
        return null; // below-threshold grant — ignored, exactly like a stage placement
      }
    }
    return parseChat3dStageState(evt.content);
  }

  /**
   * Whether `userId` may write the grant in this room. Mirrors the receive-side
   * guard so the UI can grey the control (and say WHY) instead of offering a
   * button whose PUT the homeserver will refuse.
   */
  mayDriveStage(
    stateEvents: readonly TimelineEvent[] | null | undefined,
    userId: string,
    floor: number = DEFAULT_SCENE_MIN_POWER_LEVEL,
  ): boolean {
    if (!userId) {
      return false;
    }
    const events = stateEvents ?? [];
    const pick = (type: string) =>
      events.find((e) => e.type === type && (e.stateKey ?? '') === '')?.content;
    // Canonical config first, then each pre-rebrand generation (read-only).
    const config = parseChat3dState(
      firstStateEvent(events, [CHAT3D_STATE_TYPE, ...LEGACY_CHAT3D_STATE_TYPES])?.content,
    );
    if (!config?.enabled) {
      return false;
    }
    if (!config.stageModOnly) {
      return true; // the room opened the spotlight to everyone
    }
    // The CANONICAL type on purpose: this mirrors the WRITE gate, and writes
    // only ever go to the canonical event.
    return senderMayDriveScene(parseRoomPowerLevels(pick('m.room.power_levels')), userId,
      CHAT3D_STAGE_TYPE, floor);
  }

  /**
   * Grant the stage to `userId`, or clear it with `null`. Normalized through the
   * same strict parse every receiver runs, so we never PUT a holder our peers
   * would drop. False on any failure — never a throw.
   */
  async setStageHolder(roomId: string, userId: string | null): Promise<boolean> {
    if (!roomId) {
      return false;
    }
    if (userId !== null && parseChat3dStageState({ v: 1, userId }) === null) {
      return false;
    }
    try {
      await this.matrix.setStateEvent(roomId, CHAT3D_STAGE_TYPE, { v: 1, userId }, '');
      return true;
    } catch {
      return false;
    }
  }
}
