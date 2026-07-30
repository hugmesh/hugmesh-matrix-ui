import {
  AV_CHANNEL_LABEL, BLENDSHAPE_COUNT, BLENDSHAPE_NAMES, EYE_BLINK_LEFT_INDEX,
  EYE_BLINK_RIGHT_INDEX, EYE_LOOK_DOWN_LEFT_INDEX, EYE_LOOK_UP_LEFT_INDEX,
  BROW_INNER_UP_INDEX, FRAME_BLENDSHAPES, FRAME_POSE, FRAME_SPEAKING,
  JAW_OPEN_INDEX, blendshapesToBase64, decodeAvFrame, dequantizeBlendshape,
  encodeBlendshapesFrame, encodePoseFrame, encodeSpeakingFrame, quantizeBlendshapes,
} from './av-channel';
import { MAX_POSE_COORD } from './chat3d-bridge';

describe('av-channel — chat3d RTCDataChannel wire format (untrusted peer input)', () => {
  it('locks the channel label and the 52-entry blendshape order the game consumes', () => {
    expect(AV_CHANNEL_LABEL).toBe('chat3d');
    expect(BLENDSHAPE_NAMES.length).toBe(BLENDSHAPE_COUNT);
    expect(BLENDSHAPE_COUNT).toBe(52);
    // The desktop-first face drive needs eyes + brows + jaw addressable by
    // index — a broken index here silently blinds every avatar's face.
    expect(BLENDSHAPE_NAMES[JAW_OPEN_INDEX]).toBe('jawOpen');
    expect(BLENDSHAPE_NAMES[EYE_BLINK_LEFT_INDEX]).toBe('eyeBlinkLeft');
    expect(BLENDSHAPE_NAMES[EYE_BLINK_RIGHT_INDEX]).toBe('eyeBlinkRight');
    expect(BLENDSHAPE_NAMES[EYE_LOOK_UP_LEFT_INDEX]).toBe('eyeLookUpLeft');
    expect(BLENDSHAPE_NAMES[EYE_LOOK_DOWN_LEFT_INDEX]).toBe('eyeLookDownLeft');
    expect(BLENDSHAPE_NAMES[BROW_INNER_UP_INDEX]).toBe('browInnerUp');
    // No duplicates — every wire byte maps to exactly one shape.
    expect(new Set(BLENDSHAPE_NAMES).size).toBe(BLENDSHAPE_COUNT);
  });

  it('round-trips a pose frame at 17 bytes', () => {
    const buf = encodePoseFrame(1.5, -2.25, 0.5, 7);
    expect(buf.byteLength).toBe(17);
    expect(new Uint8Array(buf)[0]).toBe(FRAME_POSE);
    const frame = decodeAvFrame(buf);
    expect(frame).toEqual({
      t: 'pose',
      x: 1.5, z: -2.25,
      yaw: jasmine.any(Number),
      seat: 7,
    });
    expect((frame as { yaw: number }).yaw).toBeCloseTo(0.5, 5);
  });

  it('clamps out-of-range pose coordinates and floors the seat (peer-crafted frames cannot inject runaway floats)', () => {
    const frame = decodeAvFrame(encodePoseFrame(1e9, -1e9, 0, 99));
    expect(frame).toEqual(jasmine.objectContaining({
      t: 'pose', x: MAX_POSE_COORD, z: -MAX_POSE_COORD, seat: 15,
    }));
    const below = decodeAvFrame(encodePoseFrame(0, 0, 0, -42));
    expect((below as { seat: number }).seat).toBe(-1);
  });

  it('wraps yaw into (-π..π] instead of clamping (periodic angle)', () => {
    const frame = decodeAvFrame(encodePoseFrame(0, 0, Math.PI * 5, 0)) as { yaw: number };
    expect(frame.yaw).toBeCloseTo(Math.PI, 3);
    const nan = decodeAvFrame(encodePoseFrame(NaN, NaN, NaN, NaN)) as { x: number; z: number; yaw: number; seat: number };
    expect(nan.x).toBe(0);
    expect(nan.z).toBe(0);
    expect(nan.yaw).toBeCloseTo(0, 5);
    expect(nan.seat).toBe(-1);
  });

  it('round-trips a blendshapes frame at 53 bytes and COPIES out of the transport buffer', () => {
    const values = new Uint8Array(52).fill(9);
    values[JAW_OPEN_INDEX] = 200;
    const buf = encodeBlendshapesFrame(values);
    expect(buf.byteLength).toBe(53);
    expect(new Uint8Array(buf)[0]).toBe(FRAME_BLENDSHAPES);
    const frame = decodeAvFrame(buf) as { t: string; values: Uint8Array };
    expect(frame.t).toBe('blendshapes');
    expect(frame.values.length).toBe(52);
    expect(frame.values[JAW_OPEN_INDEX]).toBe(200);
    // Mutating the transport buffer after decode must not reach the consumer.
    new Uint8Array(buf).fill(0);
    expect(frame.values[JAW_OPEN_INDEX]).toBe(200);
  });

  it('round-trips the speaking flag', () => {
    expect(decodeAvFrame(encodeSpeakingFrame(true))).toEqual({ t: 'speaking', speaking: true });
    expect(decodeAvFrame(encodeSpeakingFrame(false))).toEqual({ t: 'speaking', speaking: false });
  });

  it('REJECTS junk: wrong lengths, unknown tags, non-buffer data', () => {
    expect(decodeAvFrame('hello')).toBeNull();
    expect(decodeAvFrame(null)).toBeNull();
    expect(decodeAvFrame(new ArrayBuffer(0))).toBeNull();
    expect(decodeAvFrame(new Uint8Array([0x7f, 1]).buffer)).toBeNull();          // unknown tag
    expect(decodeAvFrame(new Uint8Array([FRAME_POSE, 1, 2]).buffer)).toBeNull(); // short pose
    expect(decodeAvFrame(new Uint8Array(54).fill(FRAME_BLENDSHAPES).buffer)).toBeNull(); // long blendshapes
    expect(decodeAvFrame(new Uint8Array([FRAME_SPEAKING]).buffer)).toBeNull();   // short speaking
    // A speaking byte that is not exactly 1 is NOT speaking (strict flag).
    expect(decodeAvFrame(new Uint8Array([FRAME_SPEAKING, 2]).buffer)).toEqual({ t: 'speaking', speaking: false });
  });

  it('quantizes 0..1 scores to bytes with clamping, zero-fill and NaN-to-0', () => {
    const q = quantizeBlendshapes([0, 0.5, 1, 2, -1, NaN]);
    expect(q.length).toBe(52);
    expect(q[0]).toBe(0);
    expect(q[1]).toBe(128);
    expect(q[2]).toBe(255);
    expect(q[3]).toBe(255); // clamped high
    expect(q[4]).toBe(0);   // clamped low
    expect(q[5]).toBe(0);   // NaN
    expect(q[51]).toBe(0);  // zero-filled tail
    expect(dequantizeBlendshape(q[2])).toBe(1);
    expect(dequantizeBlendshape(q[1])).toBeCloseTo(0.5, 2);
    expect(dequantizeBlendshape(999)).toBe(1); // out-of-range byte clamps
  });

  it('base64-encodes the exact 52 wire bytes for the §5 bridge call', () => {
    const values = new Uint8Array(52);
    values[0] = 65; values[1] = 66; values[JAW_OPEN_INDEX] = 255;
    const b64 = blendshapesToBase64(values);
    const decoded = atob(b64);
    expect(decoded.length).toBe(52);
    expect(decoded.charCodeAt(0)).toBe(65);
    expect(decoded.charCodeAt(JAW_OPEN_INDEX)).toBe(255);
  });
});
