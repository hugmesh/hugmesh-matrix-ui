import { MAX_POSE_COORD, MAX_SEAT, MIN_SEAT } from './chat3d-bridge';

/**
 * The BINARY frame protocol of the per-peer `chat3d` RTCDataChannel (XR-chat
 * DESIGN §6 Stage 2). Every frame is a 1-byte type tag followed by a fixed-size
 * payload — no JSON on the motion path (pose runs at 10Hz and blendshapes at
 * 15Hz per peer, so the fixed layout keeps a frame at 17/53/2 bytes):
 *
 *   0x01 pose         + 4×float32 LE  (x, z, yaw, seat)          = 17 bytes
 *   0x02 blendshapes  + 52×uint8     (scores quantized 0..255)   = 53 bytes
 *   0x03 speaking     + 1×uint8      (1 = speaking)              =  2 bytes
 *
 * TRUST BOUNDARY: frames arrive from OTHER participants' browsers over the
 * peer connection, so {@link decodeAvFrame} treats them as untrusted input —
 * unknown tags, wrong lengths and out-of-range numerics are rejected/clamped
 * exactly like the {@link parseGameMessage} bridge parses (same pose bounds,
 * same yaw wrap). Pure functions + exported so the wire format is
 * unit-testable in isolation of any RTCPeerConnection.
 */

/** Label of the per-peer data channel (DESIGN §6 Stage 2 — locked name). */
export const AV_CHANNEL_LABEL = 'chat3d';

/** Frame type tags (first byte of every frame). */
export const FRAME_POSE = 0x01;
export const FRAME_BLENDSHAPES = 0x02;
export const FRAME_SPEAKING = 0x03;

/** Broadcast cadences (DESIGN §6 Stage 2: pose @10Hz, blendshapes @15Hz). */
export const POSE_BROADCAST_MS = 100;
export const BLENDSHAPES_BROADCAST_MS = 66;

/**
 * The 52 MediaPipe FaceLandmarker blendshape categories, IN MODEL OUTPUT
 * ORDER (ARKit-style names; MediaPipe emits `_neutral` and omits ARKit's
 * `tongueOut`, which is how the set stays at exactly 52). The uint8 vector on
 * the wire — and the base64 vector on the §5 `blendshapes` bridge call — is
 * indexed by THIS array. The Godot assembler consumes the same order
 * (canonical copy of the mapping travels with the character-forge repo).
 */
export const BLENDSHAPE_NAMES = [
  '_neutral',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight',
] as const;

/** Fixed vector length of every blendshapes frame (and the §5 base64 vector). */
export const BLENDSHAPE_COUNT = 52;

/** Named indices for the desktop-first face drive (eyes + mouth — DESIGN §6:
 *  the vector MUST drive blinks/gaze/brows, not just the jaw). */
export const JAW_OPEN_INDEX = BLENDSHAPE_NAMES.indexOf('jawOpen');
export const EYE_BLINK_LEFT_INDEX = BLENDSHAPE_NAMES.indexOf('eyeBlinkLeft');
export const EYE_BLINK_RIGHT_INDEX = BLENDSHAPE_NAMES.indexOf('eyeBlinkRight');
export const EYE_LOOK_UP_LEFT_INDEX = BLENDSHAPE_NAMES.indexOf('eyeLookUpLeft');
export const EYE_LOOK_DOWN_LEFT_INDEX = BLENDSHAPE_NAMES.indexOf('eyeLookDownLeft');
export const BROW_INNER_UP_INDEX = BLENDSHAPE_NAMES.indexOf('browInnerUp');

/** A decoded, validated inbound frame. */
export type AvFrame =
  | { t: 'pose'; x: number; z: number; yaw: number; seat: number }
  | { t: 'blendshapes'; values: Uint8Array }
  | { t: 'speaking'; speaking: boolean };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** Encode a pose frame (x, z metres; yaw radians; seat -1..15). 17 bytes. */
export function encodePoseFrame(x: number, z: number, yaw: number, seat: number): ArrayBuffer {
  const buf = new ArrayBuffer(17);
  const view = new DataView(buf);
  view.setUint8(0, FRAME_POSE);
  view.setFloat32(1, x, true);
  view.setFloat32(5, z, true);
  view.setFloat32(9, yaw, true);
  view.setFloat32(13, seat, true);
  return buf;
}

/** Encode a blendshapes frame from an ALREADY-QUANTIZED 52-byte vector. */
export function encodeBlendshapesFrame(values: Uint8Array): ArrayBuffer {
  const buf = new Uint8Array(1 + BLENDSHAPE_COUNT);
  buf[0] = FRAME_BLENDSHAPES;
  buf.set(values.subarray(0, BLENDSHAPE_COUNT), 1);
  return buf.buffer;
}

/** Encode a speaking-flag frame (sent on CHANGE, not on a cadence). */
export function encodeSpeakingFrame(speaking: boolean): ArrayBuffer {
  return new Uint8Array([FRAME_SPEAKING, speaking ? 1 : 0]).buffer;
}

/**
 * Decode + validate one inbound frame. Null for anything that is not a
 * well-formed frame of a known type at its exact fixed length — the caller
 * drops it silently (no error oracle for a hostile peer). Pose numerics are
 * clamped into the same scene-sane ranges as the iframe bridge; yaw is
 * wrapped (periodic), seat is floored to an integer in -1..15.
 */
export function decodeAvFrame(data: unknown): AvFrame | null {
  if (!(data instanceof ArrayBuffer)) {
    return null;
  }
  const bytes = new Uint8Array(data);
  if (bytes.length < 1) {
    return null;
  }
  switch (bytes[0]) {
    case FRAME_POSE: {
      if (bytes.length !== 17) {
        return null;
      }
      const view = new DataView(data);
      const rawSeat = view.getFloat32(13, true);
      return {
        t: 'pose',
        x: clamp(finiteOr(view.getFloat32(1, true), 0), -MAX_POSE_COORD, MAX_POSE_COORD),
        z: clamp(finiteOr(view.getFloat32(5, true), 0), -MAX_POSE_COORD, MAX_POSE_COORD),
        yaw: Math.atan2(Math.sin(finiteOr(view.getFloat32(9, true), 0)), Math.cos(finiteOr(view.getFloat32(9, true), 0))),
        seat: Number.isFinite(rawSeat) ? clamp(Math.floor(rawSeat), MIN_SEAT, MAX_SEAT) : MIN_SEAT,
      };
    }
    case FRAME_BLENDSHAPES: {
      if (bytes.length !== 1 + BLENDSHAPE_COUNT) {
        return null;
      }
      // Copy out of the transport buffer so the frame's lifetime is ours.
      return { t: 'blendshapes', values: bytes.slice(1) };
    }
    case FRAME_SPEAKING: {
      if (bytes.length !== 2) {
        return null;
      }
      return { t: 'speaking', speaking: bytes[1] === 1 };
    }
    default:
      return null;
  }
}

/**
 * Quantize a 52-float blendshape vector (scores 0..1) into the 52-byte wire
 * vector. Out-of-range/non-finite scores clamp; a short input zero-fills the
 * tail (a hostile/truncated vector can never smear stale bytes).
 */
export function quantizeBlendshapes(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(BLENDSHAPE_COUNT);
  const n = Math.min(values.length, BLENDSHAPE_COUNT);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    out[i] = Number.isFinite(v) ? Math.round(clamp(v, 0, 1) * 255) : 0;
  }
  return out;
}

/** One quantized byte back to a 0..1 score (the openness/jaw consumer path). */
export function dequantizeBlendshape(v: number): number {
  return clamp(v, 0, 255) / 255;
}

/** The 52-byte vector as base64 for the §5 `blendshapes(userId, base64)`
 *  bridge call (the game side decodes with Godot's Marshalls). */
export function blendshapesToBase64(values: Uint8Array): string {
  let s = '';
  for (let i = 0; i < values.length; i++) {
    s += String.fromCharCode(values[i]);
  }
  return btoa(s);
}
