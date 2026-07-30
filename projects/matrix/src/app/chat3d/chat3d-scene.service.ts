import { Injectable, inject } from '@angular/core';
import { MatrixService, TimelineEvent } from '../matrix.service';
import {
  DEFAULT_SCENE_MIN_POWER_LEVEL,
  SceneRateLimiter,
  parseRoomPowerLevels,
  senderMayDriveScene,
} from '../vn/scenes/vn-scene-moderation';
import { CHAT3D_STATE_TYPE, Chat3dState, parseChat3dState } from './chat3d-state.service';

/**
 * The room STATE event type carrying the shared 3D-room media placements.
 * State (not timeline) so the placements are per-room, latest-wins, and
 * readable by any joined member — every participant sees the SAME table/
 * screens/stage dressing (vn.scene precedent).
 */
export const CHAT3D_SCENE_TYPE = 'systems.hugmesh.chat3d.scene';

/** The scene's media surfaces: 6 round-table spots, 4 wall screens, 1 stage. */
export const SURFACE_ID_PATTERN = /^(table-[1-6]|screen-[1-4]|stage)$/;
/** The moderator-gated spotlight surface (when `stageModOnly`). */
export const STAGE_SURFACE_ID = 'stage';

/** What a placed timeline item renders as on its surface. */
export const PLACEMENT_KINDS = ['image', 'file', 'video', 'thread'] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];
/** Kind a malformed `kind` falls back to (renders as a label plaque, no bytes). */
export const DEFAULT_PLACEMENT_KIND: PlacementKind = 'file';

/** LIMIT: longest placement label carried (guards a hostile event). */
export const MAX_PLACEMENT_LABEL_LENGTH = 80;
/** LIMIT: most placement rows parsed from one event (guards a hostile event —
 *  the scene has only 11 surfaces, so 24 is comfortably above any honest use). */
export const MAX_PLACEMENTS = 24;
/** Matrix event ids are `$`-prefixed opaque tokens; cap defends the parse. */
const EVENT_ID_PATTERN = /^\$.{1,254}$/;

/** One channel item placed on a scene surface. */
export interface Chat3dPlacement {
  /** Which surface (`table-1..6`, `screen-1..4`, `stage`). */
  surfaceId: string;
  /** The room timeline event the placement points at (media/thread root). */
  eventId: string;
  /** How the surface renders it. */
  kind: PlacementKind;
  /** Short human label shown on the surface plaque. */
  label: string;
}

/** The shared per-room 3D scene: which channel items sit on which surfaces. */
export interface Chat3dSceneState {
  placements: Chat3dPlacement[];
}

/**
 * Parse a raw `systems.hugmesh.chat3d.scene` state-event content into a
 * {@link Chat3dSceneState}. Tolerant/fail-soft — the content comes from OTHER
 * room members (the enable flow lowers the send PL so ordinary members can
 * write it), so treat it as untrusted: rows without a valid surfaceId/eventId
 * are dropped, an unknown kind falls back to `file` (label plaque, no bytes),
 * labels are truncated, the row count is capped, and each surface keeps only
 * its FIRST row (one item per surface — a hostile event cannot stack a
 * surface). Returns null only when the content is not an object at all. Pure +
 * exported so the untrusted-input handling is unit-testable in isolation
 * (vn-scene precedent).
 */
export function parseChat3dSceneState(raw: unknown): Chat3dSceneState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const placements: Chat3dPlacement[] = [];
  const taken = new Set<string>();
  for (const row of Array.isArray(obj['placements']) ? (obj['placements'] as unknown[]) : []) {
    if (placements.length >= MAX_PLACEMENTS) {
      break;
    }
    const p = row as Record<string, unknown>;
    const surfaceId = p?.['surfaceId'];
    if (typeof surfaceId !== 'string' || !SURFACE_ID_PATTERN.test(surfaceId) || taken.has(surfaceId)) {
      continue;
    }
    const eventId = p['eventId'];
    if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) {
      continue;
    }
    const kind = p['kind'];
    const label = p['label'];
    taken.add(surfaceId);
    placements.push({
      surfaceId,
      eventId,
      kind: typeof kind === 'string' && (PLACEMENT_KINDS as readonly string[]).includes(kind)
        ? (kind as PlacementKind)
        : DEFAULT_PLACEMENT_KIND,
      label: typeof label === 'string' ? label.slice(0, MAX_PLACEMENT_LABEL_LENGTH) : '',
    });
  }
  return { placements };
}

/**
 * Reads/writes the SHARED per-room 3D scene placements as the room state event
 * {@link CHAT3D_SCENE_TYPE} (content `{"placements": [{"surfaceId","eventId",
 * "kind","label"}]}`) via the thin CS-API wrappers, and MODERATES the receive
 * path.
 *
 * WHO CAN WRITE IT depends on the room, and the receive path must not assume:
 * the chat3d enable flow sets `events[chat3d.scene]` to 50 when `stageModOnly`
 * (the default — moderators only) and to 0 when it is off (every member can
 * place). A room whose power levels were never written by that flow — the write
 * is best-effort and can fail, and a room admin can set them by hand — can also
 * sit at `state_default` or at 0 with `stageModOnly` ON, which is exactly the
 * case guard 3 below exists for. The receive-side trust boundary is therefore:
 *
 *   1. the per-field clamps in {@link parseChat3dSceneState};
 *   2. `allowMedia === false` ⇒ NO placements render at all;
 *   3. when `stageModOnly`, a below-moderator sender's STAGE placement is
 *      dropped (the rest of their placements stay — the stage spotlight is the
 *      only moderator-reserved surface);
 *   4. the shared {@link SceneRateLimiter} coalesces bursts so even an
 *      authorized-but-hostile driver cannot seizure the surfaces.
 *
 * FAIL-SOFT throughout: unset/denied/malformed resolves to the last applied
 * scene (or null); a failed write resolves to `false` — never a throw.
 */
@Injectable({ providedIn: 'root' })
export class Chat3dSceneService {
  private readonly matrix = inject(MatrixService);

  /** Per-room burst coalescer (vn-scene precedent — per-room so two open rooms
   *  never starve each other's rate budget). */
  private readonly limiters = new Map<string, SceneRateLimiter>();
  /** The last scene actually APPLIED per room, kept so a rejected event never
   *  regresses the surfaces to a hostile overwrite. */
  private readonly lastApplied = new Map<string, Chat3dSceneState | null>();

  /**
   * Low-level RAW read (no sender/PL/config check). Null when unset,
   * unreadable, or malformed. The RECEIVE path that renders placements from
   * OTHER members must use {@link getModeratedSceneState} instead.
   */
  async getSceneState(roomId: string): Promise<Chat3dSceneState | null> {
    if (!roomId) {
      return null;
    }
    try {
      const raw = await this.matrix.getStateEvent(roomId, CHAT3D_SCENE_TYPE);
      return parseChat3dSceneState(raw);
    } catch {
      return null;
    }
  }

  /**
   * Write the room's shared placements (normalized through the same clamping
   * parse, so we never PUT junk surfaces/ids ourselves). True on success;
   * false on any failure — never a throw.
   */
  async setSceneState(roomId: string, state: Chat3dSceneState): Promise<boolean> {
    if (!roomId) {
      return false;
    }
    const normalized = parseChat3dSceneState(state) ?? { placements: [] };
    const content = {
      placements: normalized.placements.map((p) => ({
        surfaceId: p.surfaceId, eventId: p.eventId, kind: p.kind, label: p.label,
      })),
    };
    try {
      await this.matrix.setStateEvent(roomId, CHAT3D_SCENE_TYPE, content);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * MODERATED read for the RECEIVE path — the placements the caller may safely
   * RENDER from other members (guards 1-4 above). Reads the room's full state
   * once (sender + `m.room.power_levels` + the chat3d config event all come
   * from that one fetch); callers polling at the room-view cadence may hand in
   * an already-fetched `stateEvents` array to avoid a duplicate round-trip.
   *
   * FAIL-SOFT: an unset scene, a denied/failed read, malformed content, a
   * disabled room, or a rate-limited flip all resolve to the last applied
   * scene (or null) — never a throw.
   */
  async getModeratedSceneState(
    roomId: string,
    floor: number = DEFAULT_SCENE_MIN_POWER_LEVEL,
    stateEvents?: TimelineEvent[],
  ): Promise<Chat3dSceneState | null> {
    if (!roomId) {
      return null;
    }
    const last = this.lastApplied.get(roomId) ?? null;
    let events = stateEvents;
    if (!events) {
      try {
        events = await this.matrix.roomState(roomId);
      } catch {
        return last;
      }
    }
    const pickContent = (type: string) =>
      events!.find((e) => e.type === type && (e.stateKey ?? '') === '')?.content;
    // The 3D room must be ON for any placement to render — a disabled/unset
    // room resolves to null (and clears nothing: last stays for a re-enable).
    const config: Chat3dState | null = parseChat3dState(pickContent(CHAT3D_STATE_TYPE));
    if (!config?.enabled) {
      return null;
    }
    const sceneEvt = events.find((e) => e.type === CHAT3D_SCENE_TYPE && (e.stateKey ?? '') === '');
    if (!sceneEvt) {
      return last;
    }
    const candidate = parseChat3dSceneState(sceneEvt.content);
    if (candidate === null) {
      return last;
    }
    // GUARD 2: media disabled ⇒ nothing renders, regardless of sender.
    if (!config.allowMedia) {
      candidate.placements = [];
    } else if (config.stageModOnly) {
      // GUARD 3: the STAGE spotlight is moderator-reserved — drop a
      // below-threshold sender's stage placement, keep their other surfaces.
      const pl = parseRoomPowerLevels(pickContent('m.room.power_levels'));
      if (!senderMayDriveScene(pl, sceneEvt.sender, CHAT3D_SCENE_TYPE, floor)) {
        candidate.placements = candidate.placements.filter((p) => p.surfaceId !== STAGE_SURFACE_ID);
      }
    }
    // No genuine change ⇒ nothing to apply and no rate token spent.
    if (JSON.stringify(candidate) === JSON.stringify(last)) {
      return last;
    }
    // GUARD 4: coalesce bursts — drop this flip (keep the last scene) when the
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
