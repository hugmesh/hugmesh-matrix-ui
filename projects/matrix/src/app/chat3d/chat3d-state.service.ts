import { Injectable, inject } from '@angular/core';
import { MatrixService } from '../matrix.service';
import { LEGACY_CHAT3D_STATE_TYPES } from '../legacy-read';

/**
 * The room STATE event type carrying the per-room "Shadows of the Net" 3D chat
 * room setting. State (not timeline) so the setting is per-room, latest-wins,
 * and readable by any joined member — the room-view button and the join view
 * both read this event to decide whether the 3D room is offered, and anyone
 * the room's power levels allow can change it (mesh-bridge precedent).
 */
export const CHAT3D_STATE_TYPE = 'net.hugmesh.chat3d';

/**
 * Pre-rebrand generations of {@link CHAT3D_STATE_TYPE}; read-fallback only —
 * never written. Room state is immutable history: a room keeps whatever name
 * was current when its setting was last written, and BOTH old generations are
 * real data — spelled ONLY in `legacy-read.ts` (the consolidated legacy-read
 * list; see there for the generation policy). Ordered newest first: every
 * read path tries the canonical name, then each generation in order (a newer
 * event wins whenever it exists). Every write — and the room-settings
 * power-level mirroring — stays canonical-only, so the first post-move write
 * migrates the room forward.
 */
export { LEGACY_CHAT3D_STATE_TYPES };

/** Room visual style the Godot scene boots with. */
export const CHAT3D_STYLES = ['noir', 'default'] as const;
export type Chat3dRoomStyle = (typeof CHAT3D_STYLES)[number];
/** Style a malformed/absent `style` falls back to (the GitS ep.9 noir chamber). */
export const DEFAULT_CHAT3D_STYLE: Chat3dRoomStyle = 'noir';

/** Fewest participants a 3D room makes sense for. */
export const CHAT3D_MIN_PARTICIPANTS = 2;
/** Seat-ring capacity of the room scene (16 anchors). */
export const CHAT3D_MAX_PARTICIPANTS = 16;
/** Default participant cap (the practical full-mesh voice ceiling is ~8). */
export const CHAT3D_DEFAULT_PARTICIPANTS = 8;

/** The per-room 3D chat setting: whether the room is offered, and how. */
export interface Chat3dState {
  /** Whether the 3D room is enabled for this room at all. */
  enabled: boolean;
  /** Room visual style (`noir` = the GitS-style chamber, `default` = plain). */
  style: Chat3dRoomStyle;
  /** Most participants the room admits (2..16, seat-ring capacity). */
  maxParticipants: number;
  /** Whether members may place channel media on the room's surfaces. */
  allowMedia: boolean;
  /** Whether the stage surface is moderator-only (PL 50+ senders). */
  stageModOnly: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Parse a raw `net.hugmesh.chat3d` state-event content into a
 * {@link Chat3dState}. Tolerant/fail-soft — the content comes from OTHER room
 * members, so treat it as untrusted: `enabled` is strict (`=== true`, a truthy
 * string never opens a 3D room), an unknown `style` falls back to `noir`,
 * `maxParticipants` must be an integer clamped into 2..16 (else 8), and the
 * two policy booleans fall back to their SAFE defaults (`allowMedia` true,
 * `stageModOnly` true) unless a real boolean says otherwise. Returns null only
 * when the content is not an object at all. Pure + exported so the
 * untrusted-input handling is unit-testable in isolation (mesh-bridge
 * precedent).
 */
export function parseChat3dState(raw: unknown): Chat3dState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const rawStyle = obj['style'];
  const style: Chat3dRoomStyle =
    typeof rawStyle === 'string' && (CHAT3D_STYLES as readonly string[]).includes(rawStyle)
      ? (rawStyle as Chat3dRoomStyle)
      : DEFAULT_CHAT3D_STYLE;
  const rawMax = obj['maxParticipants'];
  const maxParticipants = typeof rawMax === 'number' && Number.isInteger(rawMax)
    ? clamp(rawMax, CHAT3D_MIN_PARTICIPANTS, CHAT3D_MAX_PARTICIPANTS)
    : CHAT3D_DEFAULT_PARTICIPANTS;
  return {
    enabled: obj['enabled'] === true,
    style,
    maxParticipants,
    allowMedia: typeof obj['allowMedia'] === 'boolean' ? obj['allowMedia'] : true,
    stageModOnly: typeof obj['stageModOnly'] === 'boolean' ? obj['stageModOnly'] : true,
  };
}

/**
 * Reads/writes the per-room 3D chat-room setting as the room state event
 * {@link CHAT3D_STATE_TYPE} (content `{"enabled": boolean, "style":
 * "noir"|"default", "maxParticipants": 2..16, "allowMedia": boolean,
 * "stageModOnly": boolean}`) via the existing
 * {@link MatrixService.getStateEvent}/{@link MatrixService.setStateEvent}
 * thin CS-API wrappers (GET/PUT `/_matrix/client/v3/rooms/{roomId}/state/
 * {type}/{stateKey}` through the BFF hsproxy, cookie auth).
 *
 * FAIL-SOFT: an unset event, a denied read, or malformed content resolves to
 * `null` (callers render the 3D room as off); a denied/failed write resolves
 * to `false`, never a throw. (Clone of the MeshBridgeStateService pattern.)
 */
@Injectable({ providedIn: 'root' })
export class Chat3dStateService {
  private readonly matrix = inject(MatrixService);

  /**
   * Read the room's 3D chat setting. Null when unset, unreadable, or malformed
   * — callers treat null as "no 3D room". Generation-chain read: the canonical
   * {@link CHAT3D_STATE_TYPE} first, then each {@link LEGACY_CHAT3D_STATE_TYPES}
   * name in order — the first generation that parses wins, so a room written
   * since the .net move answers from the canonical event (including a canonical
   * "disabled" over a stale older "enabled").
   */
  async getChat3dState(roomId: string): Promise<Chat3dState | null> {
    if (!roomId) {
      return null;
    }
    // Inline (no helper) so the canonical-hit path keeps the exact promise-hop
    // depth the pre-chain read had — settling in the callers' specs is
    // empirically hop-count sensitive (see room-settings' load notes).
    for (const type of [CHAT3D_STATE_TYPE, ...LEGACY_CHAT3D_STATE_TYPES]) {
      try {
        const state = parseChat3dState(await this.matrix.getStateEvent(roomId, type));
        if (state !== null) {
          return state;
        }
      } catch { /* unset/denied under this name — try the older generation */ }
    }
    return null;
  }

  /**
   * Write the room's 3D chat setting (normalized through the same clamping
   * parse, so we never PUT an out-of-range cap or junk style ourselves). True
   * on success; false on any failure (e.g. insufficient power level) — never a
   * throw.
   */
  async setChat3dState(roomId: string, state: Chat3dState): Promise<boolean> {
    if (!roomId) {
      return false;
    }
    const normalized = parseChat3dState(state) ?? {
      enabled: false,
      style: DEFAULT_CHAT3D_STYLE,
      maxParticipants: CHAT3D_DEFAULT_PARTICIPANTS,
      allowMedia: true,
      stageModOnly: true,
    };
    const content = {
      enabled: normalized.enabled,
      style: normalized.style,
      maxParticipants: normalized.maxParticipants,
      allowMedia: normalized.allowMedia,
      stageModOnly: normalized.stageModOnly,
    };
    try {
      await this.matrix.setStateEvent(roomId, CHAT3D_STATE_TYPE, content);
      return true;
    } catch {
      return false;
    }
  }
}
