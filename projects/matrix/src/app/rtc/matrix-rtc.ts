import { InjectionToken } from '@angular/core';

/**
 * MatrixRTC (MSC4143 "session" membership + a LiveKit focus) — the wire shapes
 * and pure decisions, kept free of Angular services so the specs can pin every
 * literal the homeserver, lk-jwt-service and other MatrixRTC clients read.
 *
 * SLICE 1 of hugmesh-admin-bff-api#98 (decision 102a = A, Matrix-native group
 * calls). The CLIENT half only: the server half — a LiveKit SFU plus
 * lk-jwt-service as a default-off optional service, its key/secret in the
 * ESO/Vault pattern, and tuwunel advertising it via
 * `[[global.well_known.rtc_transports]]` — is a separate generator lane and is
 * NOT deployed anywhere yet. Until it is, discovery finds no focus and every
 * call stays on the peer-to-peer path exactly as before.
 *
 * Sources the shapes below were read from (2026-09-23), not recalled:
 *  - matrix-org/matrix-js-sdk src/matrixrtc/membershipData/session.ts
 *    (SessionMembershipData) and MembershipManager.ts (makeMembershipStateKey,
 *    makeMyMembership, the `{}` leave event);
 *  - element-hq/lk-jwt-service src/requests.rs (LegacySfuRequest, SfuResponse)
 *    and src/handler.rs (process_legacy_sfu_request: identity =
 *    `${verified mxid}:${device_id}`);
 *  - matrix-construct/tuwunel docs/calls/matrix_rtc.md (the
 *    `org.matrix.msc4143.rtc_foci` client well-known key).
 */

/**
 * The DARK flag for MatrixRTC group calls. DEFAULT FALSE: with it off nothing
 * in this directory makes a request, and the chat3d voice mesh and the 1:1
 * call screen behave exactly as they did before this slice. Overridable via
 * the shared `__HUG_MATRIX_RTC__` global hook (the `__HUG_VOICE_TTS__`
 * precedent) or by re-providing the token in tests.
 */
export const MATRIX_RTC_ENABLED = new InjectionToken<boolean>('matrix.rtc.enabled', {
  factory: () => (globalThis as any).__HUG_MATRIX_RTC__ === true,
});

/**
 * Where the client autodiscovery document is read. Same-origin by default:
 * the fe-gateway's `matrix-wellknown` route serves the homeserver's own
 * `/.well-known/matrix/client` at the front door (generator
 * specs/cluster/apps/20-gateway-fe.yaml). Overridable via
 * `__HUG_MATRIX_RTC_WELLKNOWN_URL__` for a deployment that serves it elsewhere.
 */
export const MATRIX_RTC_WELLKNOWN_URL = new InjectionToken<string>('matrix.rtc.wellknown', {
  factory: () => (globalThis as any).__HUG_MATRIX_RTC_WELLKNOWN_URL__ ?? '/.well-known/matrix/client',
});

/** The client well-known key a homeserver advertises its LiveKit foci under. */
export const RTC_FOCI_WELLKNOWN_KEY = 'org.matrix.msc4143.rtc_foci';

/** The (legacy, state-event) MatrixRTC call membership event type. */
export const CALL_MEMBER_EVENT_TYPE = 'org.matrix.msc3401.call.member';

/** How long a published membership stays valid if we never clear it (a
 *  crashed tab) — matrix-js-sdk's DEFAULT_EXPIRE_DURATION, 4 hours. */
export const CALL_MEMBERSHIP_EXPIRES_MS = 4 * 60 * 60 * 1000;

/** lk-jwt-service's legacy token endpoint, relative to `livekit_service_url`.
 *  Legacy because it is the one whose LiveKit identity (`mxid:device`) matches
 *  the `membershipID` a session-format membership declares. */
export const LK_JWT_SFU_GET_PATH = '/sfu/get';

/** LIMIT: foci read from one well-known document (the field is the server's,
 *  but a document is still untrusted input to a parser). */
export const MAX_FOCI = 8;

/** One advertised LiveKit focus. */
export interface LivekitFocus {
  type: 'livekit';
  /** Base URL of lk-jwt-service, https only, no trailing slash. */
  livekit_service_url: string;
}

/** The OpenID token `POST /user/{userId}/openid/request_token` returns. */
export interface OpenIdToken {
  access_token: string;
  token_type: string;
  matrix_server_name: string;
  expires_in: number;
}

/** What lk-jwt-service answers: the LiveKit websocket URL and a join JWT. */
export interface SfuToken {
  url: string;
  jwt: string;
}

/**
 * The LiveKit foci a client well-known document advertises, in order. Only
 * `type: "livekit"` entries with an `https:` `livekit_service_url` survive:
 * the OpenID token we hand that service proves who we are, so it must never
 * cross the network in clear text, and the page CSP would refuse a mixed-
 * content fetch anyway. Anything unparseable yields `[]` (= no focus), which
 * is the honest degraded state, never an error.
 */
export function parseLivekitFoci(wellKnown: unknown): LivekitFocus[] {
  if (!wellKnown || typeof wellKnown !== 'object') {
    return [];
  }
  const raw = (wellKnown as Record<string, unknown>)[RTC_FOCI_WELLKNOWN_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: LivekitFocus[] = [];
  for (const entry of raw.slice(0, MAX_FOCI)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const url = e['livekit_service_url'];
    if (e['type'] !== 'livekit' || typeof url !== 'string') {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      continue;
    }
    out.push({ type: 'livekit', livekit_service_url: url.replace(/\/+$/, '') });
  }
  return out;
}

/**
 * The membership state key: `_${userId}_${deviceId}_m.call`. The leading `_`
 * is what matrix-js-sdk sends on a room version without MSC3757/MSC3779
 * (every room tuwunel creates today): a bare `@user…` key would be refused,
 * because only the user named at the START of a state key may write it.
 */
export function callMemberStateKey(userId: string, deviceId: string): string {
  return `_${userId}_${deviceId}_m.call`;
}

/**
 * The session-format membership content (matrix-js-sdk makeMyMembership for
 * the room-scoped `m.call` slot): `call_id: ""` is the room-wide call,
 * `membershipID` is the LiveKit identity lk-jwt-service's legacy endpoint
 * mints, and `focus_active` / `foci_preferred` point at the SAME focus we
 * fetched our JWT from, so another MatrixRTC client lands in the same SFU room.
 */
export function buildCallMembership(
  userId: string,
  deviceId: string,
  roomId: string,
  focus: LivekitFocus,
): Record<string, unknown> {
  return {
    'application': 'm.call',
    'call_id': '',
    'scope': 'm.room',
    'device_id': deviceId,
    'membershipID': livekitIdentity(userId, deviceId),
    'expires': CALL_MEMBERSHIP_EXPIRES_MS,
    'm.call.intent': 'audio',
    'focus_active': { type: 'livekit', focus_selection: 'oldest_membership' },
    'foci_preferred': [{ type: 'livekit', livekit_service_url: focus.livekit_service_url, livekit_alias: roomId }],
  };
}

/** The LiveKit participant identity lk-jwt-service mints on /sfu/get. */
export function livekitIdentity(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

/**
 * The Matrix user behind a LiveKit identity (`@local:server:DEVICE`), or null.
 * The mxid half is the one lk-jwt-service VERIFIED through the homeserver's
 * OpenID userinfo; only the device half is claimed. A server name may carry a
 * port, so the split is at the LAST colon and the remainder must still look
 * like an mxid.
 */
export function userIdFromIdentity(identity: unknown): string | null {
  if (typeof identity !== 'string') {
    return null;
  }
  const cut = identity.lastIndexOf(':');
  if (cut <= 0) {
    return null;
  }
  const userId = identity.slice(0, cut);
  return /^@[^:\s]+:[^\s]+$/.test(userId) ? userId : null;
}

/**
 * Percent-encode a path segment, then restore the characters RFC 3986 allows
 * literally (MatrixService.enc's rule): the user-bff hsproxy re-escapes `%`,
 * so an encoded `%40`/`%3A` mxid reaches the homeserver double-encoded.
 */
export function rawPcharSegment(s: string): string {
  return encodeURIComponent(s).replace(/%(24|26|2B|2C|3A|3B|3D|40)/gi, (m) => decodeURIComponent(m));
}

/** Which transport a chat3d room's voice should use, and why. */
export type GroupCallRoute =
  | { transport: 'p2p'; reason: 'flag-off' | 'within-cap' | 'no-focus' }
  | { transport: 'sfu'; focus: LivekitFocus };

/**
 * The routing rule (decision 102a): above the peer-to-peer cap AND with the
 * flag on AND a focus advertised, the group call goes to the SFU. Everything
 * else stays peer-to-peer. `rosterSize` counts me; the cap is the room's
 * `maxParticipants` (2..16, default 8).
 */
export function chooseGroupCallRoute(opts: {
  enabled: boolean;
  focus: LivekitFocus | null;
  rosterSize: number;
  p2pCap: number;
}): GroupCallRoute {
  if (!opts.enabled) {
    return { transport: 'p2p', reason: 'flag-off' };
  }
  if (opts.rosterSize <= opts.p2pCap) {
    return { transport: 'p2p', reason: 'within-cap' };
  }
  if (!opts.focus) {
    return { transport: 'p2p', reason: 'no-focus' };
  }
  return { transport: 'sfu', focus: opts.focus };
}
