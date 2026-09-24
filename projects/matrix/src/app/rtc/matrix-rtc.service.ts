import { Injectable, inject } from '@angular/core';
import type { RoomEvent } from 'livekit-client';
import { BFF_BASE_URL, MATRIX_PROXY_PREFIX, MatrixService } from '../matrix.service';
import {
  CALL_MEMBER_EVENT_TYPE, LK_JWT_SFU_GET_PATH, LivekitFocus, MATRIX_RTC_ENABLED,
  MATRIX_RTC_WELLKNOWN_URL, OpenIdToken, SfuToken, buildCallMembership, callMemberStateKey,
  parseLivekitFoci, rawPcharSegment, userIdFromIdentity,
} from './matrix-rtc';

/**
 * The LiveKit event names this service subscribes to. Each is pinned to the
 * SDK's own `RoomEvent` enum at COMPILE time (a type-only import — the SDK is
 * never loaded until a call actually routes to the SFU): if a livekit-client
 * upgrade renames one, `tsc` fails here instead of the listener silently
 * never firing.
 */
const EV_TRACK_SUBSCRIBED: `${RoomEvent.TrackSubscribed}` = 'trackSubscribed';
const EV_PARTICIPANT_DISCONNECTED: `${RoomEvent.ParticipantDisconnected}` = 'participantDisconnected';
const EV_DATA_RECEIVED: `${RoomEvent.DataReceived}` = 'dataReceived';
const EV_DISCONNECTED: `${RoomEvent.Disconnected}` = 'disconnected';

/** LIMIT: largest data frame accepted from the SFU. The chat3d wire frames are
 *  17 (pose), 53 (blendshapes) and 2 (speaking) bytes; anything bigger is not
 *  ours and is dropped before it is copied. */
export const MAX_RTC_DATA_FRAME_BYTES = 256;

/** The narrowed LiveKit remote participant surface (fakeable). */
export interface RtcParticipantLike {
  identity: string;
}

/** The narrowed LiveKit remote track surface (fakeable). */
export interface RtcTrackLike {
  kind: string;
  mediaStreamTrack: MediaStreamTrack;
}

/** The narrowed LiveKit `Room` surface this service drives (fakeable). */
export interface RtcRoomLike {
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  localParticipant: {
    publishTrack(track: MediaStreamTrack): Promise<unknown>;
    publishData(data: Uint8Array, opts: { reliable: boolean }): Promise<void>;
  };
}

/**
 * One joined MatrixRTC group call, as the chat3d voice mesh consumes it.
 * Remote identities are already mapped to Matrix user ids (the VERIFIED half
 * of the LiveKit identity); filtering them against the room's roster is the
 * consumer's job, because only it knows the roster.
 */
export interface RtcGroupSession {
  readonly focus: LivekitFocus;
  /** A remote participant's audio arrived (one stream per subscribed track). */
  onPeerAudio: ((userId: string, stream: MediaStream) => void) | null;
  /** A remote participant left the SFU room. */
  onPeerLeft: ((userId: string) => void) | null;
  /** A data frame (chat3d av-channel bytes) arrived from a participant. */
  onData: ((userId: string, frame: ArrayBuffer) => void) | null;
  /** The SFU connection dropped without us leaving. */
  onDisconnected: (() => void) | null;
  /** Publish the (already captured) local mic track — no second capture. */
  publishMic(track: MediaStreamTrack): Promise<void>;
  /** Send one frame to everyone, lossy (motion data is better lost than late). */
  sendData(frame: ArrayBuffer): void;
  /** Disconnect AND clear our call-membership state event. Idempotent. */
  leave(): Promise<void>;
}

/** The outcome of {@link MatrixRtcService.join}. */
export type RtcJoinResult =
  | { ok: true; session: RtcGroupSession; membershipPublished: boolean }
  | { ok: false; step: 'openid' | 'token' | 'connect' };

/** The session implementation over a (real or fake) LiveKit room. */
class LivekitGroupSession implements RtcGroupSession {
  onPeerAudio: ((userId: string, stream: MediaStream) => void) | null = null;
  onPeerLeft: ((userId: string) => void) | null = null;
  onData: ((userId: string, frame: ArrayBuffer) => void) | null = null;
  onDisconnected: (() => void) | null = null;
  private left = false;

  constructor(
    private readonly room: RtcRoomLike,
    readonly focus: LivekitFocus,
    private readonly streamFromTrack: (track: MediaStreamTrack) => MediaStream,
    private readonly clearMembership: () => Promise<void>,
  ) {
    room.on(EV_TRACK_SUBSCRIBED, (track: RtcTrackLike, _publication: unknown, participant: RtcParticipantLike) => {
      const userId = userIdFromIdentity(participant?.identity);
      if (!userId || track?.kind !== 'audio' || !track.mediaStreamTrack) {
        return;
      }
      this.onPeerAudio?.(userId, this.streamFromTrack(track.mediaStreamTrack));
    });
    room.on(EV_PARTICIPANT_DISCONNECTED, (participant: RtcParticipantLike) => {
      const userId = userIdFromIdentity(participant?.identity);
      if (userId) {
        this.onPeerLeft?.(userId);
      }
    });
    room.on(EV_DATA_RECEIVED, (payload: unknown, participant?: RtcParticipantLike) => {
      // A frame with no participant came from the SERVER API, not a member.
      const userId = userIdFromIdentity(participant?.identity);
      if (!userId || !(payload instanceof Uint8Array) || payload.byteLength > MAX_RTC_DATA_FRAME_BYTES) {
        return;
      }
      // Copy out: the av-channel decoder takes an ArrayBuffer and must not see
      // bytes outside this view of a possibly larger receive buffer.
      this.onData?.(userId, payload.slice().buffer);
    });
    room.on(EV_DISCONNECTED, () => {
      if (!this.left) {
        this.onDisconnected?.();
      }
    });
  }

  async publishMic(track: MediaStreamTrack): Promise<void> {
    await this.room.localParticipant.publishTrack(track);
  }

  sendData(frame: ArrayBuffer): void {
    if (this.left) {
      return;
    }
    void this.room.localParticipant.publishData(new Uint8Array(frame), { reliable: false }).catch(() => undefined);
  }

  async leave(): Promise<void> {
    if (this.left) {
      return;
    }
    this.left = true;
    await Promise.allSettled([this.room.disconnect(), this.clearMembership()]);
  }
}

/**
 * MatrixRTC group calls over a LiveKit SFU (decision 102a = A; slice 1 of
 * hugmesh-admin-bff-api#98). The sequence, each step fail-soft:
 *
 *  1. DISCOVER the focus from the client well-known
 *     (`org.matrix.msc4143.rtc_foci`, https only) — see {@link discoverFocus};
 *  2. an OpenID token for me from the homeserver, through the user-bff hsproxy
 *     like every other CS-API call (the proxy injects the server-held token);
 *  3. a LiveKit JWT from that focus's lk-jwt-service (`POST /sfu/get`) — the
 *     FIRST request this client makes to a host other than its own origin and
 *     the homeserver proxy, which is why it never carries our cookies;
 *  4. CONNECT with livekit-client, loaded lazily so the flag-off bundle never
 *     pays for it;
 *  5. PUBLISH my `org.matrix.msc3401.call.member` state event; {@link
 *     RtcGroupSession.leave} clears it with `{}`.
 *
 * With {@link MATRIX_RTC_ENABLED} off (the default) {@link discoverFocus}
 * returns null without a request, and nothing else here is reachable.
 *
 * DEVICE ID: the browser holds no Matrix device of its own (the BFF holds the
 * homeserver token), so each join mints a synthetic per-session device id. It
 * keys the membership state event and the LiveKit identity only; it is the
 * "claimed" half lk-jwt-service does not verify, and two tabs of one user get
 * two ids instead of kicking each other out of the SFU room.
 */
@Injectable({ providedIn: 'root' })
export class MatrixRtcService {
  private readonly matrix = inject(MatrixService);
  private readonly bffBaseUrl = inject(BFF_BASE_URL);
  private readonly wellKnownUrl = inject(MATRIX_RTC_WELLKNOWN_URL);
  /** The dark flag, resolved once. */
  readonly enabled = inject(MATRIX_RTC_ENABLED);

  // ── Injection seams (specs assign fakes; defaults are the real APIs) ──

  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init);
  /** Builds the LiveKit room — the SDK is imported here, on first use only. */
  roomFactory: () => Promise<RtcRoomLike> = async () => {
    const lk = await import('livekit-client');
    return new lk.Room() as unknown as RtcRoomLike;
  };
  streamFromTrack: (track: MediaStreamTrack) => MediaStream = (track) => new MediaStream([track]);
  deviceIdFactory: () => string = () => `HUGRTC${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  /**
   * The first usable LiveKit focus the homeserver advertises, or null when
   * the flag is off, the document is missing/unparseable, or it names none.
   * Null is the honest "no media server" state the caller reports; it is
   * never an error.
   */
  async discoverFocus(): Promise<LivekitFocus | null> {
    if (!this.enabled) {
      return null;
    }
    try {
      const r = await this.fetchFn(this.wellKnownUrl, { credentials: 'same-origin' });
      if (!r.ok) {
        return null;
      }
      return parseLivekitFoci(await r.json())[0] ?? null;
    } catch {
      return null;
    }
  }

  /** `POST /_matrix/client/v3/user/{userId}/openid/request_token` via the hsproxy. */
  async requestOpenIdToken(userId: string): Promise<OpenIdToken | null> {
    const url = `${this.bffBaseUrl}${MATRIX_PROXY_PREFIX}/_matrix/client/v3/user/${rawPcharSegment(userId)}/openid/request_token`;
    try {
      const r = await this.fetchFn(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) {
        return null;
      }
      const d = await r.json();
      if (typeof d?.access_token !== 'string' || !d.access_token
        || typeof d.matrix_server_name !== 'string' || !d.matrix_server_name) {
        return null;
      }
      return {
        access_token: d.access_token,
        token_type: typeof d.token_type === 'string' ? d.token_type : 'Bearer',
        matrix_server_name: d.matrix_server_name,
        expires_in: typeof d.expires_in === 'number' ? d.expires_in : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * lk-jwt-service `POST {livekit_service_url}/sfu/get` →
   * `{ url, jwt }`. `credentials: 'omit'`: this is another origin, and our
   * session cookie is none of its business. The LiveKit URL it returns must be
   * `wss:` — media signalling in clear text would expose the join JWT.
   */
  async requestSfuToken(focus: LivekitFocus, roomId: string, openid: OpenIdToken, deviceId: string): Promise<SfuToken | null> {
    try {
      const r = await this.fetchFn(`${focus.livekit_service_url}${LK_JWT_SFU_GET_PATH}`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomId, openid_token: openid, device_id: deviceId }),
      });
      if (!r.ok) {
        return null;
      }
      const d = await r.json();
      if (typeof d?.jwt !== 'string' || !d.jwt || typeof d.url !== 'string') {
        return null;
      }
      let lkUrl: URL;
      try {
        lkUrl = new URL(d.url);
      } catch {
        return null;
      }
      return lkUrl.protocol === 'wss:' ? { url: d.url, jwt: d.jwt } : null;
    } catch {
      return null;
    }
  }

  /**
   * Join the room's MatrixRTC call on `focus`. The membership event is
   * published only AFTER the SFU connect succeeded (never advertise a call we
   * are not in); a refused publish — most rooms give `state_default: 50`, and
   * nothing grants members `org.matrix.msc3401.call.member` yet — keeps the
   * call (the SFU room works without it) and reports `membershipPublished:
   * false` so the caller can say why other Matrix call apps will not list us.
   */
  async join(roomId: string, userId: string, focus: LivekitFocus): Promise<RtcJoinResult> {
    const openid = await this.requestOpenIdToken(userId);
    if (!openid) {
      return { ok: false, step: 'openid' };
    }
    const deviceId = this.deviceIdFactory();
    const sfu = await this.requestSfuToken(focus, roomId, openid, deviceId);
    if (!sfu) {
      return { ok: false, step: 'token' };
    }
    let room: RtcRoomLike | null = null;
    try {
      room = await this.roomFactory();
    } catch {
      return { ok: false, step: 'connect' };
    }
    const stateKey = callMemberStateKey(userId, deviceId);
    let published = false;
    const session = new LivekitGroupSession(room, focus, this.streamFromTrack, async () => {
      if (published) {
        await this.matrix.setStateEvent(roomId, CALL_MEMBER_EVENT_TYPE, {}, stateKey).catch(() => '');
      }
    });
    try {
      await room.connect(sfu.url, sfu.jwt);
    } catch {
      await room.disconnect().catch(() => undefined);
      return { ok: false, step: 'connect' };
    }
    try {
      await this.matrix.setStateEvent(
        roomId, CALL_MEMBER_EVENT_TYPE, buildCallMembership(userId, deviceId, roomId, focus), stateKey);
      published = true;
    } catch {
      published = false;
    }
    return { ok: true, session, membershipPublished: published };
  }
}
