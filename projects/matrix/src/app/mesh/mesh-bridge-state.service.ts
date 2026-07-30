import { Injectable, inject } from '@angular/core';
import { MatrixService } from '../matrix.service';

/**
 * The room STATE event type carrying the per-room Meshtastic LoRa-mesh bridge
 * setting. State (not timeline) so the setting is per-room, latest-wins, and
 * readable by any joined member — the bridge appservice watches this event to
 * decide which rooms it relays, and anyone the room's power levels allow can
 * change it.
 */
export const MESH_BRIDGE_STATE_TYPE = 'systems.hugmesh.mesh.bridge';

/** Device id a malformed/absent `device` falls back to (the bridge's stock radio). */
export const DEFAULT_MESH_DEVICE = 'default';
/** LIMIT: longest bridge device id the state will carry (guards a hostile event). */
export const MAX_MESH_DEVICE_LENGTH = 64;
/** Lowest Meshtastic channel slot a radio exposes. */
export const MESH_CHANNEL_MIN = 0;
/** Highest Meshtastic channel slot a radio exposes (8 slots, 0..7). */
export const MESH_CHANNEL_MAX = 7;

/** Device ids are hostname-ish tokens: letters/digits/dot/underscore/hyphen only. */
const MESH_DEVICE_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The per-room bridge setting: whether to relay, over which radio, on which channel. */
export interface MeshBridgeState {
  /** Whether the bridge relays this room at all. */
  enabled: boolean;
  /** Which bridge radio serves the room ({@link DEFAULT_MESH_DEVICE} = the stock one). */
  device: string;
  /** Meshtastic channel slot the room is bridged to (0..7). */
  meshChannel: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Parse a raw `systems.hugmesh.mesh.bridge` state-event content into a
 * {@link MeshBridgeState}. Tolerant/fail-soft — the content comes from OTHER
 * room members, so treat it as untrusted: `enabled` is strict (`=== true`, a
 * truthy string never turns a radio bridge on), a non-token/overlong `device`
 * falls back to {@link DEFAULT_MESH_DEVICE}, and `meshChannel` must be an
 * integer, clamped into 0..7 (else 0). Returns null only when the content is
 * not an object at all. Pure + exported so the untrusted-input handling is
 * unit-testable in isolation.
 */
export function parseMeshBridgeState(raw: unknown): MeshBridgeState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const rawDevice = obj['device'];
  const device =
    typeof rawDevice === 'string' &&
    rawDevice.length > 0 &&
    rawDevice.length <= MAX_MESH_DEVICE_LENGTH &&
    MESH_DEVICE_PATTERN.test(rawDevice)
      ? rawDevice
      : DEFAULT_MESH_DEVICE;
  const rawChannel = obj['meshChannel'];
  const meshChannel = typeof rawChannel === 'number' && Number.isInteger(rawChannel)
    ? clamp(rawChannel, MESH_CHANNEL_MIN, MESH_CHANNEL_MAX)
    : 0;
  return { enabled: obj['enabled'] === true, device, meshChannel };
}

/**
 * Reads/writes the per-room Meshtastic LoRa-mesh bridge setting as the room
 * state event {@link MESH_BRIDGE_STATE_TYPE} (content `{"enabled": boolean,
 * "device": string, "meshChannel": 0..7}`) via the existing
 * {@link MatrixService.getStateEvent}/{@link MatrixService.setStateEvent}
 * thin CS-API wrappers (GET/PUT `/_matrix/client/v3/rooms/{roomId}/state/
 * {type}/{stateKey}` through the BFF hsproxy, cookie auth). The bridge
 * appservice reads the same event server-side; the UI never talks to the
 * bridge directly.
 *
 * FAIL-SOFT: an unset event, a denied read, or malformed content resolves to
 * `null` (callers render the bridge as off); a denied/failed write resolves to
 * `false`, never a throw.
 */
@Injectable({ providedIn: 'root' })
export class MeshBridgeStateService {
  private readonly matrix = inject(MatrixService);

  /**
   * Read the room's bridge setting. Null when unset, unreadable, or malformed —
   * callers treat null as "not bridged".
   */
  async getMeshBridgeState(roomId: string): Promise<MeshBridgeState | null> {
    if (!roomId) {
      return null;
    }
    try {
      const raw = await this.matrix.getStateEvent(roomId, MESH_BRIDGE_STATE_TYPE);
      return parseMeshBridgeState(raw);
    } catch {
      return null;
    }
  }

  /**
   * Write the room's bridge setting (normalized through the same clamping
   * parse, so we never PUT an out-of-range channel or a junk device id
   * ourselves). True on success; false on any failure (e.g. insufficient power
   * level) — never a throw.
   */
  async setMeshBridgeState(roomId: string, state: MeshBridgeState): Promise<boolean> {
    if (!roomId) {
      return false;
    }
    const normalized = parseMeshBridgeState(state) ?? { enabled: false, device: DEFAULT_MESH_DEVICE, meshChannel: 0 };
    const content = {
      enabled: normalized.enabled,
      device: normalized.device,
      meshChannel: normalized.meshChannel,
    };
    try {
      await this.matrix.setStateEvent(roomId, MESH_BRIDGE_STATE_TYPE, content);
      return true;
    } catch {
      return false;
    }
  }
}
