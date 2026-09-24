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
const EV_TRACK_UNSUBSCRIBED: `${RoomEvent.TrackUnsubscribed}` = 'trackUnsubscribed';
const EV_PARTICIPANT_DISCONNECTED: `${RoomEvent.ParticipantDisconnected}` = 'participantDisconnected';
const EV_DATA_RECEIVED: `${RoomEvent.DataReceived}` = 'dataReceived';
const EV_DISCONNECTED: `${RoomEvent.Disconnected}` = 'disconnected';

/** LIMIT: largest data frame accepted from the SFU. The chat3d wire frames are
 *  17 (pose), 53 (blendshapes) and 2 (speaking) bytes; anything bigger is not
 *  ours and is dropped before it is copied. */
export const MAX_RTC_DATA_FRAME_BYTES = 256;

/**
 * LIMIT: device-id slots per browser profile. Every join publishes its
 * membership under a state key that embeds the device id, and a state key,
 * once written, stays in the room's state for good (leave only blanks it to
 * `{}`) — while every chat3d client re-reads the FULL room state at 1Hz. So
 * the id must be REUSED across joins: a stable per-browser base (localStorage)
 * plus the lowest free slot, claimed with a Web Lock held for the call's
 * lifetime so two open tabs of one user never share an id (a shared LiveKit
 * identity would kick the other tab out of the SFU room). That bounds the keys
 * one user leaves in a room to this many per browser profile; only a fifth
 * simultaneous tab (or a browser with no storage / no Web Locks) falls back
 * to a one-off id.
 */
export const MAX_RTC_DEVICE_SLOTS = 4;

/** localStorage key holding this browser's stable device-id base. */
export const RTC_DEVICE_BASE_STORAGE_KEY = 'hug.matrixRtc.deviceBase';

/** Web Lock name prefix for a device-id slot (suffix = slot index). */
export const RTC_DEVICE_SLOT_LOCK_PREFIX = 'hug-matrix-rtc-device-slot-';

/** The shape a generated device id (and so a stored base) must have. */
const DEVICE_BASE_RE = /^HUGRTC[A-Z0-9]{4,12}$/;

/** A claimed device id; `release` frees its slot (idempotent). */
export interface RtcDeviceClaim {
  id: string;
  release: () => void;
}

/** The narrowed Web Locks surface the slot claim uses (fakeable). */
export interface RtcLockManagerLike {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | undefined): Promise<unknown>;
}

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
  /**
   * The newest subscribed remote audio stream for `userId`, or null. LiveKit
   * fires TrackSubscribed ONCE per subscription, so a stream that arrives
   * before the consumer can place it (its handler not yet installed, or the
   * sender not yet on the 3D roster) would otherwise be lost for good and the
   * sender permanently silent. The session RETAINS it until the track is
   * unsubscribed or its participant leaves, and the consumer attaches it
   * whenever it (re)creates that peer.
   */
  remoteAudio(userId: string): MediaStream | null;
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
  /** LiveKit identity → its newest subscribed audio (see remoteAudio). */
  private readonly audio = new Map<string, { userId: string; track: MediaStreamTrack; stream: MediaStream; seq: number }>();
  private audioSeq = 0;

  constructor(
    private readonly room: RtcRoomLike,
    readonly focus: LivekitFocus,
    private readonly streamFromTrack: (track: MediaStreamTrack) => MediaStream,
    private readonly clearMembership: () => Promise<void>,
    private readonly releaseDevice: () => void = () => undefined,
  ) {
    room.on(EV_TRACK_SUBSCRIBED, (track: RtcTrackLike, _publication: unknown, participant: RtcParticipantLike) => {
      const userId = userIdFromIdentity(participant?.identity);
      if (this.left || !userId || track?.kind !== 'audio' || !track.mediaStreamTrack) {
        return;
      }
      const stream = this.streamFromTrack(track.mediaStreamTrack);
      // Retain FIRST: this event is never re-delivered (see remoteAudio).
      this.audio.set(String(participant.identity), { userId, track: track.mediaStreamTrack, stream, seq: ++this.audioSeq });
      this.onPeerAudio?.(userId, stream);
    });
    room.on(EV_TRACK_UNSUBSCRIBED, (track: RtcTrackLike, _publication: unknown, participant: RtcParticipantLike) => {
      const key = typeof participant?.identity === 'string' ? participant.identity : '';
      if (this.audio.get(key)?.track === track?.mediaStreamTrack) {
        this.audio.delete(key);
      }
    });
    room.on(EV_PARTICIPANT_DISCONNECTED, (participant: RtcParticipantLike) => {
      if (typeof participant?.identity === 'string') {
        this.audio.delete(participant.identity);
      }
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

  remoteAudio(userId: string): MediaStream | null {
    let best: { stream: MediaStream; seq: number } | null = null;
    for (const a of this.audio.values()) {
      if (a.userId === userId && (!best || a.seq > best.seq)) {
        best = a;
      }
    }
    return best?.stream ?? null;
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
    this.audio.clear();
    try {
      await Promise.allSettled([this.room.disconnect(), this.clearMembership()]);
    } finally {
      this.releaseDevice();
    }
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
 * homeserver token), so a synthetic device id keys the membership state event
 * and the LiveKit identity. It is the "claimed" half lk-jwt-service does not
 * verify. It is REUSED across joins — a stable per-browser base plus a slot
 * claimed with a Web Lock ({@link claimDeviceId}, {@link MAX_RTC_DEVICE_SLOTS})
 * — because each distinct id leaves a permanent state key in the room; two
 * open tabs of one user still hold two slots, so they never kick each other
 * out of the SFU room.
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
  /** A fresh random id — the stored base's seed, and the no-slot fallback. */
  deviceIdFactory: () => string = () => `HUGRTC${Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, '0')}`;
  /** The per-browser store for the device-id base (null = none usable). */
  storageFn: () => Pick<Storage, 'getItem' | 'setItem'> | null = () => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  /** The Web Locks manager for slot claims (null = unsupported). */
  locksFn: () => RtcLockManagerLike | null = () => {
    try {
      return ((globalThis.navigator as unknown as { locks?: RtcLockManagerLike } | undefined)?.locks) ?? null;
    } catch {
      return null;
    }
  };

  /**
   * The device id for one join: `${stable base}${lowest free slot}`, the slot
   * held (Web Lock) until `release()` — see {@link MAX_RTC_DEVICE_SLOTS}. With
   * no usable storage, no Web Locks, or every slot held by other tabs, a
   * one-off random id (the old per-join behaviour) with a no-op release.
   */
  async claimDeviceId(): Promise<RtcDeviceClaim> {
    const base = this.deviceBase();
    const locks = base ? this.locksFn() : null;
    if (base && locks) {
      for (let slot = 0; slot < MAX_RTC_DEVICE_SLOTS; slot++) {
        const release = await this.tryLock(locks, `${RTC_DEVICE_SLOT_LOCK_PREFIX}${slot}`);
        if (release) {
          return { id: `${base}${slot}`, release };
        }
      }
    }
    return { id: this.deviceIdFactory(), release: () => undefined };
  }

  /** The stored base, seeded on first use; null when storage is unusable. */
  private deviceBase(): string | null {
    try {
      const store = this.storageFn();
      if (!store) {
        return null;
      }
      const stored = store.getItem(RTC_DEVICE_BASE_STORAGE_KEY);
      if (stored && DEVICE_BASE_RE.test(stored)) {
        return stored;
      }
      const fresh = this.deviceIdFactory();
      if (!DEVICE_BASE_RE.test(fresh)) {
        return null;
      }
      store.setItem(RTC_DEVICE_BASE_STORAGE_KEY, fresh);
      // Read back: a store that silently drops writes must not hand out a
      // "stable" base that is new on every join.
      return store.getItem(RTC_DEVICE_BASE_STORAGE_KEY) === fresh ? fresh : null;
    } catch {
      return null;
    }
  }

  /** Try to take the named lock without waiting; resolves its release, or null. */
  private tryLock(locks: RtcLockManagerLike, name: string): Promise<(() => void) | null> {
    return new Promise((resolve) => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        resolve(release);
        return held; // the lock is held until release() settles this
      }).catch(() => resolve(null));
    });
  }

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
    const claim = await this.claimDeviceId();
    const deviceId = claim.id;
    const sfu = await this.requestSfuToken(focus, roomId, openid, deviceId);
    if (!sfu) {
      claim.release();
      return { ok: false, step: 'token' };
    }
    let room: RtcRoomLike | null = null;
    try {
      room = await this.roomFactory();
    } catch {
      claim.release();
      return { ok: false, step: 'connect' };
    }
    const stateKey = callMemberStateKey(userId, deviceId);
    let published = false;
    const session = new LivekitGroupSession(room, focus, this.streamFromTrack, async () => {
      if (published) {
        await this.matrix.setStateEvent(roomId, CALL_MEMBER_EVENT_TYPE, {}, stateKey).catch(() => '');
      }
    }, claim.release);
    try {
      await room.connect(sfu.url, sfu.jwt);
    } catch {
      await room.disconnect().catch(() => undefined);
      claim.release();
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
