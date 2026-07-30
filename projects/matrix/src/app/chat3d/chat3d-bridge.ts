import { InjectionToken } from '@angular/core';
import { SURFACE_ID_PATTERN } from './chat3d-scene.service';
import { Char3dConfig } from './char3d-config';

/**
 * The versioned postMessage protocol between THIS page (the Matrix remote,
 * "host") and the embedded Godot room iframe (the hugmesh-games
 * `shadows-of-the-net` wasm bundle in `mode=matrix`, "game"). It is the
 * postMessage transport of the `Chat3D` JS interface the game exposes via
 * JavaScriptBridge (XR-chat DESIGN §5): every host→game call name is a message
 * type, every game→host callback is a message type, wrapped in the versioned
 * envelope `{v: 1, t: "<type>", args: [...], ...signature-named fields}` —
 * see {@link HOST_CALL_SIGNATURES}. Texture bytes ride as BASE64 STRINGS: the
 * game drains its inbound queue through `JSON.stringify` before GDScript sees
 * it, so a structured-clone ArrayBuffer cannot survive the trip.
 *
 * TRUST BOUNDARY: the game runs on the GAMES origin inside an iframe. The host
 * checks the origin allow-list on EVERY inbound message (and pins the
 * targetOrigin on every outbound postMessage); inbound payloads are clamped by
 * {@link parseGameMessage} before anything touches component state — a
 * compromised or spoofing frame can neither read our messages nor push
 * out-of-range values in.
 */

/** Protocol version — bump on any incompatible envelope change. */
export const CHAT3D_PROTOCOL_VERSION = 1;

/**
 * Base URL of the games portal serving the room's wasm bundle.
 * Env-configurable via the shared global-hook convention this repo already
 * uses everywhere else (`__HUG_BFF_URL__`, `__HUG_MATRIX_URL__`,
 * `__HUG_VOICE_TTS__`, …) — there is NO `__SNAP_*` producer anywhere in the
 * fleet, so a `__SNAP_GAMES_URL__` hook could never be set and the room would
 * silently fall back to a dev URL the served CSP `frame-src` forbids.
 *
 * The default MUST agree with nginx.conf's `$games_origin` map default (which
 * is what the deployed CSP `frame-src` allows) — two disagreeing defaults for
 * the same value is a room that can never load.
 */
export const GAMES_BASE_URL = new InjectionToken<string>('GAMES_BASE_URL', {
  factory: () => (globalThis as any).__HUG_GAMES_URL__ ?? 'https://games.hugmesh.systems',
});

/** Path of the shadows-of-the-net web export inside the games portal (the
 *  chapter asset_url the games registry serves the wasm fragment at). */
export const CHAT3D_BUNDLE_PATH = '/_remotes/wasm-fragment/shadows-of-the-net/index.html';

/**
 * Build the iframe URL for the room.
 *
 * `origin` is NOT decoration: the game's in-frame `Chat3D` shim derives the
 * one origin it will accept messages from (and post messages to) from this
 * query parameter, falling back to `document.referrer` — and our iframe is
 * deliberately `referrerpolicy="no-referrer"`, so WITHOUT this parameter the
 * game resolves no allowed origin and disables its postMessage I/O entirely
 * (both directions). Pass our own `location.origin`.
 */
export function chat3dFrameUrl(gamesBase: string, hostOrigin: string): string {
  return `${gamesBase}${CHAT3D_BUNDLE_PATH}?mode=matrix&origin=${encodeURIComponent(hostOrigin)}`;
}

/** Message types the HOST sends INTO the game (the §5 Chat3D call surface). */
export const HOST_TO_GAME_TYPES = [
  'roster', 'avatar', 'pose', 'openness', 'blendshapes', 'speaking',
  'expression', 'placeMedia', 'clearMedia', 'stage', 'setLocal', 'enterVR',
] as const;
export type HostToGameType = (typeof HOST_TO_GAME_TYPES)[number];

/** Message types the GAME sends OUT to the host (the §5 callback surface,
 *  plus the `ready` bridge handshake the games shim emits once its JS side is
 *  listening — outbound messages queue until it arrives). */
export const GAME_TO_HOST_TYPES = ['ready', 'localPose', 'mediaActivate', 'vrState'] as const;
export type GameToHostType = (typeof GAME_TO_HOST_TYPES)[number];

/** A versioned envelope heading INTO the game. */
export interface HostEnvelope {
  v: typeof CHAT3D_PROTOCOL_VERSION;
  t: HostToGameType;
  [key: string]: unknown;
}

/** Room-scale bound for pose coordinates (metres from origin — the chamber is
 *  a ~20m circle; 64 leaves generous slack while stopping runaway floats). */
export const MAX_POSE_COORD = 64;
/** Seat anchors are 0..15 (16-seat ring); -1 = standing/no seat. */
export const MIN_SEAT = -1;
export const MAX_SEAT = 15;

/** A validated game→host message after {@link parseGameMessage}. */
export type GameMessage =
  | { t: 'ready' }
  | { t: 'localPose'; x: number; z: number; yaw: number; seat: number }
  | { t: 'mediaActivate'; surfaceId: string }
  | { t: 'vrState'; active: boolean };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Whether `origin` is on the allow-list. EXACT string comparison of full
 * origins — no prefix/suffix matching (a hostile `games.example.com.evil.tld`
 * must never pass). Empty/unknown origins never pass.
 */
export function originAllowed(origin: string, allowList: readonly string[]): boolean {
  return typeof origin === 'string' && origin.length > 0 && allowList.includes(origin);
}

/**
 * Parse + clamp an inbound game→host message. Returns null for anything that
 * is not a well-formed, current-version envelope of a known game→host type —
 * the caller drops it silently (fail-soft; a hostile frame gets no error
 * oracle). Numeric payloads are clamped into scene-sane ranges, surface ids
 * regex-checked, booleans strict.
 */
export function parseGameMessage(data: unknown): GameMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const obj = data as Record<string, unknown>;
  if (obj['v'] !== CHAT3D_PROTOCOL_VERSION) {
    return null;
  }
  const t = obj['t'];
  switch (t) {
    case 'ready':
      return { t: 'ready' };
    case 'localPose': {
      const seat = obj['seat'];
      return {
        t: 'localPose',
        x: clamp(finiteOr(obj['x'], 0), -MAX_POSE_COORD, MAX_POSE_COORD),
        z: clamp(finiteOr(obj['z'], 0), -MAX_POSE_COORD, MAX_POSE_COORD),
        // Yaw is periodic — wrap into (-π..π] rather than clamp (a spun-around
        // avatar is fine; a 1e9 yaw fed onward is not).
        yaw: Math.atan2(Math.sin(finiteOr(obj['yaw'], 0)), Math.cos(finiteOr(obj['yaw'], 0))),
        seat: typeof seat === 'number' && Number.isInteger(seat) ? clamp(seat, MIN_SEAT, MAX_SEAT) : MIN_SEAT,
      };
    }
    case 'mediaActivate': {
      const surfaceId = obj['surfaceId'];
      if (typeof surfaceId !== 'string' || !SURFACE_ID_PATTERN.test(surfaceId)) {
        return null;
      }
      return { t: 'mediaActivate', surfaceId };
    }
    case 'vrState':
      return { t: 'vrState', active: obj['active'] === true };
    default:
      return null;
  }
}

// ───────────────────── Outbound envelope builders ─────────────────────
// Small, typed constructors so every call site emits the exact §5 payload
// shape (and the specs can assert it field-for-field).

/**
 * Argument order per host→game call — the SINGLE source of the envelope
 * mapping, byte-for-byte the game's own `SIGNATURES` table
 * (`chat3d_bridge.gd`) and DESIGN §5's argument names.
 *
 * The game maps an inbound envelope to its call arguments with
 *   `Array.isArray(d.args) ? d.args : sig.map(k => d[k] ?? null)`
 * — i.e. it reads EITHER an `args` array in signature order, or the fields
 * named EXACTLY as below. Any other field name is invisible to it: an
 * envelope carrying `{speaking: true}` instead of `{value: true}` decodes to
 * `null` → `false`, silently, forever. Every builder therefore emits BOTH
 * forms (exactly as the game's own outbound `_emit` does).
 */
export const HOST_CALL_SIGNATURES: Readonly<Record<HostToGameType, readonly string[]>> = {
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
} as const;

/** One roster row the game renders a participant from. */
export interface RosterEntry {
  userId: string;
  name: string;
}

/**
 * Build one §5 envelope: `{v, t, args:[…]}` PLUS the signature-named fields,
 * so both of the game's decode paths yield identical arguments. `extra`
 * carries fields OUTSIDE the signature (the game ignores them today; they are
 * the forward-compatible slot for billboard mode).
 */
function envelope(t: HostToGameType, args: readonly unknown[], extra: Record<string, unknown> = {}): HostEnvelope {
  const named: Record<string, unknown> = {};
  HOST_CALL_SIGNATURES[t].forEach((key, i) => { named[key] = args[i] ?? null; });
  return { v: 1, t, args: [...args], ...named, ...extra };
}

export const hostMsg = {
  /** §5 `roster(json)` — the argument is a JSON *string*, not an array. */
  roster: (users: RosterEntry[]): HostEnvelope =>
    envelope('roster', [JSON.stringify(users)]),
  /** §5 `avatar(userId, configJson)` — a JSON *string*, or null in billboard
   *  mode (the game then keeps its deterministic guest rig). */
  avatar: (userId: string, config: Char3dConfig | null): HostEnvelope =>
    envelope('avatar', [userId, config === null ? null : JSON.stringify(config)]),
  pose: (userId: string, x: number, z: number, yaw: number, seat: number): HostEnvelope =>
    envelope('pose', [userId, x, z, yaw, seat]),
  openness: (userId: string, value: number): HostEnvelope =>
    envelope('openness', [userId, value]),
  blendshapes: (userId: string, values: string): HostEnvelope =>
    envelope('blendshapes', [userId, values]),
  speaking: (userId: string, speaking: boolean): HostEnvelope =>
    envelope('speaking', [userId, speaking]),
  expression: (userId: string, label: string): HostEnvelope =>
    envelope('expression', [userId, label]),
  /**
   * §5 `placeMedia(surfaceId, metaJson, pngBase64|null)`. The texture rides as
   * a BASE64 STRING, not an ArrayBuffer: the game drains its inbound queue
   * through `JSON.stringify` before GDScript ever sees it, so a structured
   * clone serializes to `{}` and the decoder (`Marshalls.base64_to_raw`) gets
   * nothing. null = meta-only plaque.
   */
  placeMedia: (surfaceId: string, meta: { eventId: string; kind: string; label: string }, pngBase64: string | null): HostEnvelope =>
    envelope('placeMedia', [surfaceId, JSON.stringify(meta), pngBase64]),
  clearMedia: (surfaceId: string): HostEnvelope =>
    envelope('clearMedia', [surfaceId]),
  stage: (userId: string, on: boolean): HostEnvelope =>
    envelope('stage', [userId, on]),
  setLocal: (userId: string): HostEnvelope =>
    envelope('setLocal', [userId]),
  enterVR: (): HostEnvelope =>
    envelope('enterVR', []),
} as const;

/**
 * The game's OWN inbound argument mapping, reimplemented verbatim from
 * `chat3d_bridge.gd`'s injected JS shim. Exported so the specs can decode our
 * envelopes exactly as the counterparty does instead of asserting our own
 * field names back at ourselves (the drift that let 7 of 12 call types ship
 * silently broken).
 */
export function decodeAsGame(envelopeIn: Record<string, unknown>): unknown[] | null {
  if (!envelopeIn || envelopeIn['v'] !== CHAT3D_PROTOCOL_VERSION || typeof envelopeIn['t'] !== 'string') {
    return null;
  }
  const sig = HOST_CALL_SIGNATURES[envelopeIn['t'] as HostToGameType];
  if (!sig) {
    return null;
  }
  const args = envelopeIn['args'];
  return Array.isArray(args) ? args : sig.map((k) => (envelopeIn[k] !== undefined ? envelopeIn[k] : null));
}
