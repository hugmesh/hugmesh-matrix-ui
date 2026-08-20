import { Injectable, InjectionToken, inject } from '@angular/core';
import { LEGACY_MESH_EVENT_CONTENT_FIELD } from './legacy-read';

/**
 * Homeserver name (e.g. `matrix.hugmesh.net`). NOT a base URL the client
 * dials — the browser NEVER talks to the homeserver directly. It is kept only as
 * non-secret metadata for `mxc://` parsing (server-name extraction). Overridable
 * via the shared `__HUG_MATRIX_URL__` hook.
 */
export const MATRIX_BASE_URL = new InjectionToken<string>('MATRIX_BASE_URL', {
  factory: () => (globalThis as any).__HUG_MATRIX_URL__ ?? 'https://matrix.hugmesh.net',
});

/** Base URL of the user-bff-api hsproxy + AI-cloak media proxy. Same-origin by
 *  default (the fe-gateway proxies /bff/user/** to hugmesh-user-bff-api),
 *  overridable via the shared __HUG_BFF_URL__ hook the BFF datastore services
 *  already use. */
export const BFF_BASE_URL = new InjectionToken<string>('BFF_BASE_URL', {
  factory: () => (globalThis as any).__HUG_BFF_URL__ ?? '',
});

/** Path the user-bff exposes the Matrix CS-API reverse proxy (hsproxy) under. The
 *  BFF strips exactly this prefix and forwards the remaining `/_matrix/...`
 *  verbatim, INJECTING the server-held homeserver token (owner = the bff_ session
 *  subject) — so no homeserver access token is ever held client-side. */
export const MATRIX_PROXY_PREFIX = '/bff/user/matrix';

/**
 * Per-attachment AI-cloak mode the composer toggle resolves to.
 *  - `cloak` (DEFAULT): apply Glaze-style training-data hygiene before ingest.
 *  - `none`: opt out — forward the bytes straight to the homeserver unchanged.
 */
export type CloakMode = 'cloak' | 'none';

/**
 * Outcome of the server-owned `media_poison_decision`, surfaced as an HONEST
 * badge. Never claim "protected" — this is best-effort training-set hygiene that
 * a determined adversary (or an ordinary re-encode/downscale) can remove.
 *  - `pending`:   the cloak is still being applied (progress state).
 *  - `cloaked`:   the perturbation survived the homeserver round-trip → "AI-cloak applied".
 *  - `degraded`:  the cloak washed out on ingest → "protection-degraded".
 *  - `skipped`:   opted out / heavy tier absent → "not cloaked".
 *  - `failed`:    the proxy errored (the upload itself still succeeded).
 */
export type CloakStatus = 'pending' | 'cloaked' | 'degraded' | 'skipped' | 'failed';

/** Heavy-tier capability reported by the BFF capability probe (worker /health).
 *  Drives the composer's up-front "Unavailable" honesty + the expected-time copy. */
export interface CloakCapability {
  /** Poisoner backend, or `none` when the optional x86/GPU heavy tier is absent. */
  backend: 'cuda' | 'rocm' | 'cpu' | 'none';
  /** Whether default-on cloaking is actually available right now. */
  available: boolean;
  /** Rough expected processing time per image, in seconds (for the progress copy). */
  expectedSeconds?: number;
}

/** BFF poison decision for a single uploaded mxc (badge polling source of truth). */
export interface CloakDecision {
  mxcUri: string;
  mode: CloakMode;
  status: CloakStatus;
  backend?: CloakCapability['backend'];
}

/** Result of a protected upload — the mxc plus the (initial) cloak decision so
 *  the composer can render the badge without a second round-trip. */
export interface ProtectedUploadResult extends UploadResult {
  decision: CloakDecision;
}

// ───────────────────────────── Interfaces ─────────────────────────────

export interface MatrixRoom {
  roomId: string;
  name: string;
  topic?: string;
  avatarUrl?: string;
  isDirect?: boolean;
  dmUserId?: string;
  memberCount?: number;
  lastEvent?: TimelineEvent;
  unreadCount?: number;
  highlightCount?: number;
  myMembership?: 'join' | 'invite' | 'leave';
  canonicalAlias?: string;
}

export interface RoomMember {
  userId: string;
  displayName?: string;
  /**
   * ASCII screen-reader name for the member (printable U+0020..U+007E) — the
   * value ANNOUNCED at aria-labels that name the member (e.g. "Kick {name}"),
   * distinct from the visible (possibly non-ASCII) `displayName`. Sourced from
   * the optional profile fragment; absent ⇒ the UI announces the display name.
   */
  screenReaderName?: string;
  avatarUrl?: string;
  membership: 'join' | 'invite' | 'leave' | 'ban' | 'knock';
  powerLevel: number;
  presence?: 'online' | 'offline' | 'unavailable';
  lastActiveAgo?: number;
}

/**
 * Content field bridged LoRa-mesh events carry their radio provenance under
 * (attached by the Meshtastic bridge appservice, exclusive user namespace
 * `@mesh-.*`).
 */
export const MESH_EVENT_CONTENT_FIELD = 'com.hugmesh.mesh';

/**
 * Pre-rebrand events persist the old field name; read-fallback only — never
 * written (the UI never writes this field at all — the bridge appservice
 * attaches it). Events bridged before the HugMesh rebrand carry their
 * provenance under this key (spelled ONLY in `legacy-read.ts`, the
 * consolidated legacy-read list); {@link MatrixService.mapEvent} reads the
 * canonical field first and falls back to this one (canonical wins when both
 * exist), so old bridged messages keep their "via LoRa mesh" badge.
 */
export { LEGACY_MESH_EVENT_CONTENT_FIELD };

/** Matches senders inside the mesh bridge appservice's EXCLUSIVE `@mesh-.*`
 *  user namespace — only the bridge can register those users, so the sender
 *  prefix alone is a trustworthy "came over the radio" signal. */
export const MESH_SENDER_PATTERN = /^@mesh-/;

/** Canonical Meshtastic node id: `!` + exactly 8 lowercase hex digits. */
const MESH_NODE_ID_PATTERN = /^![0-9a-f]{8}$/;
/** Bridge device ids are hostname-ish tokens, capped at 64 chars. */
const MESH_DEVICE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Radio provenance of one LoRa-mesh-bridged event — the parsed
 * {@link MESH_EVENT_CONTENT_FIELD} content fragment. Drives the timeline's
 * "via LoRa mesh" badge. NOTE the node id is a radio's SELF-REPORTED identity:
 * LoRa node ids are not cryptographically authenticated.
 */
export interface MeshEventInfo {
  /** Originating radio's node id (`!` + 8 lowercase hex). */
  node: string;
  /** Bridge device that relayed the packet (`default` when unset/malformed). */
  device: string;
  /** Meshtastic channel slot the packet arrived on (0..7). */
  channel: number;
  /** Whether the node id is claimed by a platform user (bridge-asserted). */
  registered: boolean;
  /** Received signal strength in dBm, when the bridge reported one. */
  rssi?: number;
  /** Signal-to-noise ratio in dB, when the bridge reported one. */
  snr?: number;
}

/**
 * Parse a raw {@link MESH_EVENT_CONTENT_FIELD} fragment into a
 * {@link MeshEventInfo}. Tolerant/fail-soft — the fragment rides on room
 * events, so treat it as untrusted: a missing/non-canonical node id voids the
 * whole fragment (null — the node id IS the badge's identity), a junk device
 * falls back to `default`, the channel must be an integer clamped into 0..7,
 * `registered` is strict `=== true`, and rssi/snr are kept only when finite
 * (clamped into a displayable range). Pure + exported so the untrusted-input
 * handling is unit-testable in isolation.
 */
export function parseMeshEventInfo(raw: unknown): MeshEventInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const node = o['node'];
  if (typeof node !== 'string' || !MESH_NODE_ID_PATTERN.test(node)) {
    return null;
  }
  const device = typeof o['device'] === 'string' && MESH_DEVICE_PATTERN.test(o['device']) ? o['device'] : 'default';
  const channel = typeof o['channel'] === 'number' && Number.isInteger(o['channel'])
    ? Math.min(7, Math.max(0, o['channel']))
    : 0;
  const info: MeshEventInfo = { node, device, channel, registered: o['registered'] === true };
  if (typeof o['rssi'] === 'number' && Number.isFinite(o['rssi'])) {
    info.rssi = Math.min(100, Math.max(-200, o['rssi']));
  }
  if (typeof o['snr'] === 'number' && Number.isFinite(o['snr'])) {
    info.snr = Math.min(100, Math.max(-100, o['snr']));
  }
  return info;
}

export interface TimelineEvent {
  eventId: string;
  roomId: string;
  type: string;
  sender: string;
  senderDisplayName?: string;
  /**
   * ASCII screen-reader name for the sender (printable U+0020..U+007E), the
   * value ANNOUNCED at every aria-label/alt that names the author. Distinct from
   * the visible (possibly non-ASCII) `senderDisplayName`; see
   * {@link accessibleName}. Sourced from the optional profile fragment the
   * homeserver/BFF attaches (custom `com.hugmesh.screen_reader_name` content
   * field today) — absent for legacy events, in which case the UI falls back to
   * the display name.
   */
  senderScreenReaderName?: string;
  senderAvatarUrl?: string;
  originServerTs: number;
  content: any;
  msgtype?: string;
  body?: string;
  relatesTo?: {
    rel_type?: string;
    event_id?: string;
    key?: string;
    'm.in_reply_to'?: { event_id: string };
    is_falling_back?: boolean;
  };
  reactions?: Reaction[];
  edited?: boolean;
  redacted?: boolean;
  threadRootId?: string;
  threadReplyCount?: number;
  localEcho?: boolean;
  txnId?: string;
  /**
   * State key of the underlying state event, when this TimelineEvent was
   * produced from room state (see {@link MatrixService.roomState}). Absent
   * for non-state timeline events.
   */
  stateKey?: string;
  /**
   * Radio provenance of a LoRa-mesh-bridged event — the tolerantly-parsed
   * {@link MESH_EVENT_CONTENT_FIELD} content fragment (see
   * {@link parseMeshEventInfo}). Absent for ordinary events AND for a
   * malformed fragment, so callers can trust every field when present.
   */
  mesh?: MeshEventInfo;
}

/**
 * The room-state event for the FIRST of `types` that exists (state_key `''`),
 * or undefined when none does — the read side of the wire-name generation
 * chains (`net.hugmesh.*` ⇠ the two pre-rebrand generations spelled ONLY in
 * `legacy-read.ts`; see the LEGACY_*_TYPES constants beside each canonical
 * type).
 *
 * PRESENCE wins, not parseability: a newer-generation event is returned even
 * when its content no longer parses, because it is the newer word — e.g. a
 * canonical `{}` retract/clear must keep suppressing the older-generation
 * event it retired, not resurrect it. Callers pass the chain newest-first.
 */
export function firstStateEvent(
  events: readonly TimelineEvent[],
  types: readonly string[],
): TimelineEvent | undefined {
  for (const type of types) {
    const evt = events.find((e) => e.type === type && (e.stateKey ?? '') === '');
    if (evt) {
      return evt;
    }
  }
  return undefined;
}

export interface Reaction {
  key: string;
  count: number;
  senders: string[];
  myEventId?: string;
}

export interface RoomSummary {
  name: string;
  topic?: string;
  avatarUrl?: string;
  canonicalAlias?: string;
  joinRule?: string;
  powerLevels?: {
    users: Record<string, number>;
    usersDefault: number;
    events: Record<string, number>;
    eventsDefault: number;
    stateDefault: number;
    ban: number;
    kick: number;
    redact: number;
    invite: number;
  };
}

/** A room the caller has a PENDING INVITE to, parsed from /sync `rooms.invite`
 *  invite_state (name/avatar when the stripped state carries them, plus the
 *  inviting user off the m.room.member invite event). */
export interface PendingInvite {
  roomId: string;
  name: string;
  inviter?: string;
  avatarUrl?: string;
}

export interface SyncState {
  /** TRUE when the homeserver REJECTED this sync (non-2xx through the hsproxy)
   *  and the rest of this object is the empty placeholder rather than a real
   *  delta. Callers driving a long-poll loop MUST back off on it: a rejected
   *  sync returns instantly, so a loop that treats it like an ordinary empty
   *  delta re-requests with no delay and spins — one expired session then
   *  hammers the BFF continuously for as long as the tab stays open. Absent
   *  (undefined) on every successful sync. */
  failed?: boolean;
  nextBatch: string;
  rooms: Record<string, {
    timeline: TimelineEvent[];
    prevBatch?: string;
    state: TimelineEvent[];
    ephemeral: { typing: string[]; receipts: Record<string, Record<string, { user: string; ts: number }[]>> };
    /** UNDEFINED when the delta carried no unread_notifications block — the
     *  CS-API allows that for purely ephemeral (typing/receipt) deltas, and
     *  ruma-based servers skip-serialize empty blocks. Absence means "counts
     *  unchanged", NOT zero; coercing it to 0 here is what used to wipe live
     *  badges, so consumers must fold `?? previous`. */
    unreadCount?: number;
    highlightCount?: number;
    limited: boolean;
  }>;
  /** Rooms the caller is INVITED to (rooms.invite) — previously discarded, so
   *  pending invites never surfaced anywhere in the UI. */
  invites: Record<string, PendingInvite>;
  accountData: Record<string, any>;
  presence: Record<string, { presence: string; lastActiveAgo?: number }>;
}

/**
 * Latest read position per user: the newest event each member has posted an
 * `m.read` receipt on, folded across incremental /sync deltas. This is the
 * shape the "seen by" read-receipt indicator consumes — ONE entry per reader,
 * pointing at the single event their avatar anchors to.
 */
export type ReadReceiptMap = Record<string, { eventId: string; ts: number }>;

/**
 * Fold a /sync delta's parsed receipts (per-event → per-type → readers, the
 * {@link SyncState} `ephemeral.receipts` shape) into the running
 * latest-read-per-user map, keeping each user anchored on the NEWEST event they
 * have read (by receipt ts). Only the public `m.read` receipt drives the
 * indicator — `m.read.private` is delivered SOLELY to its own owner and must
 * never advertise a member's position to others. Pure + exported so the
 * receipt→render mapping is unit-testable in isolation of the sync loop.
 */
export function mergeReadReceipts(
  prev: ReadReceiptMap,
  delta: Record<string, Record<string, { user: string; ts: number }[]>>,
): ReadReceiptMap {
  const out: ReadReceiptMap = { ...prev };
  for (const eventId of Object.keys(delta)) {
    for (const { user, ts } of delta[eventId]?.['m.read'] ?? []) {
      const cur = out[user];
      // A read receipt only ever moves FORWARD — a newer ts re-anchors the
      // reader onto the later event (and off whatever event they were on).
      if (!cur || ts >= cur.ts) out[user] = { eventId, ts };
    }
  }
  return out;
}

/**
 * One room's accumulated LIVE feed: the running timeline, the current typing
 * set, and the folded latest-read-per-user map. This is the shape
 * {@code <hug-room-view>}'s `syncRoom` input carries.
 */
export interface SyncRoomFeed {
  timeline: TimelineEvent[];
  typing: string[];
  receipts: ReadReceiptMap;
}

/** How many timeline events one room's live feed retains. The feed is a LIVE
 *  tail, not the archive — back-pagination re-fetches older history on demand —
 *  so an unbounded accumulation would only grow the memory a long-lived tab
 *  holds while re-rendering the same rows. */
export const SYNC_FEED_MAX_EVENTS = 200;

/**
 * Fold ONE /sync delta for a room into that room's running live feed.
 *
 * Extracted as a pure function because there are now TWO live-feed owners and
 * they MUST fold identically: the 3-pane chat shell (which syncs every joined
 * room at once) and a room view opened on its own deep-link route
 * (`rooms/:roomId`), which the shell does not feed. Duplicating this merge was
 * how the deep-linked view ended up with no live timeline at all.
 *
 * Rules the two owners share:
 *  - timeline events APPEND, de-duped by eventId (a delta may legitimately
 *    re-deliver an event we already hold, e.g. after a `limited` gap);
 *  - typing REPLACES — `m.typing` is a full-set ephemeral event, so folding it
 *    would leave users "typing" forever;
 *  - receipts FOLD via {@link mergeReadReceipts} — a reader's position moves
 *    FORWARD across deltas and must accumulate, never be replaced per-delta.
 */
export function mergeSyncRoom(
  prev: SyncRoomFeed | null | undefined,
  delta: { timeline: TimelineEvent[]; ephemeral: { typing: string[]; receipts: Record<string, Record<string, { user: string; ts: number }[]>> } },
): SyncRoomFeed {
  const previousTimeline = prev?.timeline ?? [];
  const seen = new Set(previousTimeline.map((e) => e.eventId));
  const merged = [...previousTimeline];
  for (const e of delta.timeline) if (!seen.has(e.eventId)) merged.push(e);
  return {
    timeline: merged.slice(-SYNC_FEED_MAX_EVENTS),
    typing: delta.ephemeral.typing,
    receipts: mergeReadReceipts(prev?.receipts ?? {}, delta.ephemeral.receipts),
  };
}

export interface UploadResult {
  contentUri: string;
  mxcUri: string;
}

export interface SearchResult {
  event: TimelineEvent;
  rank: number;
  contextBefore: TimelineEvent[];
  contextAfter: TimelineEvent[];
  roomId: string;
}

export interface UserProfile {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface Paginated {
  events: TimelineEvent[];
  start: string;
  end: string;
}

/**
 * Thin Matrix client-server API wrapper. The browser NEVER talks to the
 * homeserver directly and NEVER holds a homeserver access token. Every CS-API
 * call goes through the SAME-ORIGIN user-bff hsproxy at
 * `${BFF_BASE_URL}/bff/user/matrix` ({@link MATRIX_PROXY_PREFIX}): the proxy
 * strips the prefix, forwards the native `/_matrix/...` path verbatim
 * (preserving streaming /sync long-poll + media downloads) and INJECTS the
 * server-held homeserver token whose owner is the bff_ session subject.
 *
 * Auth is the platform bff_ session: the HttpOnly `bff_` cookie carried via
 * `credentials: 'include'` on every call (see {@link hsFetch}) — the SAME
 * mechanism the other BFF calls (UserBffService/ModBffService/media-cloak) use.
 * The browser holds no bearer of any kind; the gateway's
 * BffCookieToBearerWebFilter mints the upstream bearer server-side from the
 * cookie. No homeserver access token is ever attached client-side. No separate
 * Matrix login UI.
 *
 * All endpoints are the canonical Matrix Client-Server API (v3 + v1 for
 * relations/threads/media).
 */
@Injectable({ providedIn: 'root' })
export class MatrixService {
  private readonly bffBaseUrl = inject(BFF_BASE_URL);

  /**
   * Effective base URL every CS-API request is built against — ALWAYS the
   * same-origin BFF hsproxy prefix `${BFF_BASE_URL}/bff/user/matrix`. The native
   * `/_matrix/...` path is appended verbatim by each call site; the proxy strips
   * the prefix and injects the server-held homeserver token.
   */
  private get baseUrl(): string {
    return `${this.bffBaseUrl}${MATRIX_PROXY_PREFIX}`;
  }

  /**
   * No Authorization header is ever attached — auth rides solely on the
   * HttpOnly `bff_` cookie sent by {@link hsFetch}'s `credentials: 'include'`.
   * Kept as a named call site (used throughout this service) so a future
   * non-auth default header can land in one place; today it is always empty.
   */
  private headers(): Record<string, string> {
    return {};
  }

  /**
   * Single fetch chokepoint for the CS-API. Every call goes through the BFF
   * hsproxy authenticated SOLELY by the platform bff_ session: the HttpOnly
   * `bff_` cookie via `credentials: 'include'` (so the proxy can resolve the
   * session subject and inject the upstream homeserver token). The browser
   * never attaches a bearer of its own. The verbatim passthrough preserves
   * streaming (/sync long-poll, media downloads). No homeserver access token is
   * ever sent.
   */
  private hsFetch(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, { ...init, credentials: 'include' });
  }

  private jsonHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...this.headers() };
  }

  /** Unique transaction id for /send + /redact PUTs. */
  private txn(prefix = 'm'): string {
    return `${prefix}${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  /**
   * Percent-encode a PATH SEGMENT, then restore the characters RFC 3986 permits
   * LITERALLY in a segment (pchar sub-delims + ':' + '@'). Both spellings are
   * valid URIs, but the raw-pchar one is the only spelling that survives the
   * user-bff hsproxy: its Spring WebClient hands the path to a URI-template
   * factory that RE-escapes '%', so an encoded `!r%3Atest` arrives at the
   * homeserver as `!r%253Atest` and every room-scoped call 500s
   * (M_UNKNOWN "room of unknown version"). tuwunel itself decodes either
   * spelling correctly — the proxy is the constraint. '#' (room aliases), '/',
   * '?' and '%' stay encoded: they delimit the URL itself.
   */
  private enc(s: string): string {
    return encodeURIComponent(s).replace(/%(24|26|2B|2C|3A|3B|3D|40)/gi, (m) => decodeURIComponent(m));
  }

  /** Map a raw CS-API event JSON into our TimelineEvent shape. */
  private mapEvent(e: any, roomId: string): TimelineEvent {
    const content = e.content ?? {};
    const unsigned = e.unsigned ?? {};
    const relates = content['m.relates_to'];
    const ev: TimelineEvent = {
      eventId: e.event_id,
      roomId: e.room_id ?? roomId,
      type: e.type,
      sender: e.sender,
      originServerTs: e.origin_server_ts ?? 0,
      content,
      msgtype: content.msgtype,
      body: content.body,
      // Optional ASCII screen-reader name fragment the homeserver/BFF may attach
      // to the event (custom field); absent for legacy events ⇒ undefined and
      // accessibleName() falls back to the display name.
      senderScreenReaderName: content['com.hugmesh.screen_reader_name'] ?? unsigned['com.hugmesh.screen_reader_name'],
      relatesTo: relates,
      redacted: !!unsigned.redacted_because || e.type === 'm.room.redaction',
      txnId: unsigned.transaction_id,
    };
    // Optional radio-provenance fragment the mesh bridge appservice attaches to
    // bridged events (custom field); malformed/absent ⇒ undefined and the
    // timeline renders no mesh badge off the content (the @mesh-* sender
    // namespace still marks the event as bridged). Canonical field first, then
    // the pre-rebrand legacy name (read-only) so old bridged events keep their
    // badge.
    const mesh = parseMeshEventInfo(
      content[MESH_EVENT_CONTENT_FIELD] ?? content[LEGACY_MESH_EVENT_CONTENT_FIELD],
    );
    if (mesh) {
      ev.mesh = mesh;
    }
    if (relates?.rel_type === 'm.thread') {
      ev.threadRootId = relates.event_id;
    }
    if (content['m.new_content'] || relates?.rel_type === 'm.replace') {
      ev.edited = true;
    }
    return ev;
  }

  // ─────────────────────────── Identity / sync ───────────────────────────

  /** Resolve the logged-in user_id from the Bearer token. */
  async whoami(): Promise<string | null> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/account/whoami`, { headers: this.headers() });
    if (!r.ok) return null;
    return (await r.json()).user_id ?? null;
  }

  /** Long-poll incremental sync: room list, timelines, ephemeral typing/receipts,
   *  account_data, presence. Thread next_batch into the next call. */
  async sync(since?: string, timeoutMs = 30000, filter?: string): Promise<SyncState> {
    const qs = new URLSearchParams();
    if (since) qs.set('since', since);
    qs.set('timeout', String(timeoutMs));
    if (filter) qs.set('filter', filter);
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/sync?${qs.toString()}`, { headers: this.headers() });
    const empty: SyncState = { failed: true, nextBatch: since ?? '', rooms: {}, invites: {}, accountData: {}, presence: {} };
    if (!r.ok) return empty;
    const data = await r.json();
    const out: SyncState = {
      nextBatch: data.next_batch ?? since ?? '',
      rooms: {},
      invites: {},
      accountData: {},
      presence: {},
    };
    const joined = data.rooms?.join ?? {};
    for (const roomId of Object.keys(joined)) {
      const jr = joined[roomId];
      const typing: string[] = [];
      const receipts: Record<string, Record<string, { user: string; ts: number }[]>> = {};
      for (const ev of jr.ephemeral?.events ?? []) {
        if (ev.type === 'm.typing') typing.push(...(ev.content?.user_ids ?? []));
        if (ev.type === 'm.receipt') {
          for (const evId of Object.keys(ev.content ?? {})) {
            const byType: Record<string, { user: string; ts: number }[]> = {};
            for (const rcptType of Object.keys(ev.content[evId] ?? {})) {
              const users = ev.content[evId][rcptType] ?? {};
              byType[rcptType] = Object.keys(users).map((u) => ({ user: u, ts: users[u]?.ts ?? 0 }));
            }
            receipts[evId] = byType;
          }
        }
      }
      out.rooms[roomId] = {
        timeline: (jr.timeline?.events ?? []).map((e: any) => this.mapEvent(e, roomId)),
        prevBatch: jr.timeline?.prev_batch,
        state: (jr.state?.events ?? []).map((e: any) => this.mapEvent(e, roomId)),
        ephemeral: { typing, receipts },
        // NO `?? 0` fallback: an absent unread_notifications block means the
        // counts are UNCHANGED, not zero (see the SyncState field docs) —
        // undefined lets consumers keep their previous value.
        unreadCount: jr.unread_notifications?.notification_count,
        highlightCount: jr.unread_notifications?.highlight_count,
        limited: !!jr.timeline?.limited,
      };
    }
    // rooms.invite: stripped invite_state events describe the room a pending
    // invite points at. Previously DISCARDED — an invited user's UI showed
    // nothing at all for a pending invite.
    const invited = data.rooms?.invite ?? {};
    for (const roomId of Object.keys(invited)) {
      const events: any[] = invited[roomId]?.invite_state?.events ?? [];
      const invite: PendingInvite = { roomId, name: roomId };
      for (const ev of events) {
        if (ev.type === 'm.room.name' && ev.content?.name) invite.name = ev.content.name;
        if (ev.type === 'm.room.avatar' && ev.content?.url) invite.avatarUrl = ev.content.url;
        // The invite membership event's SENDER is the inviting user.
        if (ev.type === 'm.room.member' && ev.content?.membership === 'invite' && ev.sender) {
          invite.inviter = ev.sender;
        }
      }
      out.invites[roomId] = invite;
    }
    for (const ev of data.account_data?.events ?? []) {
      out.accountData[ev.type] = ev.content;
    }
    for (const ev of data.presence?.events ?? []) {
      const uid = ev.sender;
      if (uid) out.presence[uid] = { presence: ev.content?.presence, lastActiveAgo: ev.content?.last_active_ago };
    }
    return out;
  }

  /**
   * One-shot list of the caller's PENDING room invites. The CS-API has no
   * dedicated invites endpoint — `rooms.invite` only rides /sync — so this
   * issues a single zero-timeout sync with an inline filter trimming timelines
   * to nothing, and returns the parsed invites. Fail-soft: an error resolves
   * to [] (the room list simply shows no invite section).
   */
  async pendingInvites(): Promise<PendingInvite[]> {
    try {
      const filter = JSON.stringify({ room: { timeline: { limit: 0 }, state: { lazy_load_members: true } } });
      const state = await this.sync(undefined, 0, filter);
      return Object.values(state.invites);
    } catch {
      return [];
    }
  }

  // ─────────────────────────── Room listing ───────────────────────────

  /** List joined room ids as bare MatrixRoom rows. Used by MatrixCallComponent,
   *  which only needs {roomId,name} (room-list/chat use joinedRoomsDetailed). */
  async joinedRooms(): Promise<MatrixRoom[]> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/joined_rooms`, { headers: this.headers() });
    if (!r.ok) return [];
    const ids: string[] = (await r.json()).joined_rooms ?? [];
    return ids.map((roomId) => ({ roomId, name: roomId }));
  }

  /** List joined room ids then hydrate name/topic/avatar/isDirect via state +
   *  m.direct account data. A room with NO m.room.name falls back to a
   *  heroes-style member-derived name (joined OR invited members, from the
   *  same single state fetch) rather than displaying its raw !opaque:server
   *  id. */
  async joinedRoomsDetailed(): Promise<MatrixRoom[]> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/joined_rooms`, { headers: this.headers() });
    if (!r.ok) return [];
    const ids: string[] = (await r.json()).joined_rooms ?? [];
    let directMap: Record<string, string[]> = {};
    let me: string | null = null;
    try {
      me = await this.whoami();
      if (me) {
        const md = await this.getAccountData<Record<string, string[]>>(me, 'm.direct');
        if (md) directMap = md;
      }
    } catch { /* ignore */ }
    const dmRoomToUser: Record<string, string> = {};
    for (const uid of Object.keys(directMap)) {
      for (const rid of directMap[uid] ?? []) dmRoomToUser[rid] = uid;
    }
    const rooms = await Promise.all(ids.map(async (roomId) => {
      const room: MatrixRoom = { roomId, name: roomId, myMembership: 'join' };
      try {
        // ONE state fetch per room feeds BOTH the summary and the heroes
        // fallback below — the state already carries every m.room.member
        // event, so the extra joined_members roster fetch (plus its internal
        // power-levels lookup) the old fallback made is pure waste.
        const state = await this.roomState(roomId);
        const summary = this.summaryFromState(state);
        room.name = summary.name || roomId;
        room.topic = summary.topic;
        room.avatarUrl = summary.avatarUrl;
        room.canonicalAlias = summary.canonicalAlias;
        // HEROES-STYLE fallback: a room without an m.room.name (every fresh
        // DM and most ad-hoc group rooms) used to display as its raw
        // !opaque:id. Name it after the OTHER members instead ("A, B" /
        // "A, B, C" / "A, B, C +N"). INVITED members count as heroes too,
        // matching Matrix's room-name calculation — the headline case is a
        // fresh DM whose peer hasn't accepted yet: the only other member is
        // membership=invite, and a joined-only roster would leave the raw
        // room id on screen. Fail-soft: no heroes keeps the roomId fallback
        // rather than blanking the row.
        if (!summary.name) {
          const members = state.filter((e) => e.type === 'm.room.member');
          const joinedCount = members.filter((e) => e.content?.membership === 'join').length;
          if (joinedCount) room.memberCount = joinedCount;
          const heroes = members.filter((e) =>
            (e.content?.membership === 'join' || e.content?.membership === 'invite')
            && !!e.stateKey && e.stateKey !== me);
          const names = heroes.slice(0, 3).map((e) => e.content?.displayname || this.localpart(e.stateKey!));
          if (names.length) {
            const extra = heroes.length - names.length;
            room.name = extra > 0 ? `${names.join(', ')} +${extra}` : names.join(', ');
          }
        }
      } catch { /* ignore — keep the roomId fallback */ }
      if (dmRoomToUser[roomId]) {
        room.isDirect = true;
        room.dmUserId = dmRoomToUser[roomId];
      }
      return room;
    }));
    return rooms;
  }

  /** The localpart of a Matrix user id (`@local:server` → `local`); the id
   *  itself when it doesn't parse (fail-soft — it only feeds display copy). */
  private localpart(userId: string): string {
    const m = /^@([^:]+):/.exec(userId);
    return m ? m[1] : userId;
  }

  /** Derive name/topic/avatar/canonical_alias/join_rule/power_levels from a
   *  single full-state fetch. */
  async roomSummary(roomId: string): Promise<RoomSummary> {
    return this.summaryFromState(await this.roomState(roomId));
  }

  /** Derive a {@link RoomSummary} from an ALREADY-FETCHED full room state.
   *  Split out of {@link roomSummary} so joinedRoomsDetailed can reuse ONE
   *  state fetch per room for both the summary and the heroes-style name
   *  fallback (the state also carries every m.room.member event) instead of
   *  fetching state AND the joined_members roster per unnamed room. */
  private summaryFromState(state: TimelineEvent[]): RoomSummary {
    // State events with an empty state_key carry the canonical room metadata.
    const pick = (type: string) => state.find((e) => e.type === type && (e.stateKey ?? '') === '')?.content;
    const name = pick('m.room.name');
    const topic = pick('m.room.topic');
    const avatar = pick('m.room.avatar');
    const alias = pick('m.room.canonical_alias');
    const joinRules = pick('m.room.join_rules');
    const pl = pick('m.room.power_levels');
    const summary: RoomSummary = {
      name: name?.name ?? '',
      topic: topic?.topic,
      avatarUrl: avatar?.url,
      canonicalAlias: alias?.alias,
      joinRule: joinRules?.join_rule,
    };
    if (pl) {
      summary.powerLevels = {
        users: pl.users ?? {},
        usersDefault: pl.users_default ?? 0,
        events: pl.events ?? {},
        eventsDefault: pl.events_default ?? 0,
        stateDefault: pl.state_default ?? 50,
        ban: pl.ban ?? 50,
        kick: pl.kick ?? 50,
        redact: pl.redact ?? 50,
        invite: pl.invite ?? 0,
      };
    }
    return summary;
  }

  /** Fetch the full current state of a room (array of state events). */
  async roomState(roomId: string): Promise<TimelineEvent[]> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/state`, { headers: this.headers() });
    if (!r.ok) return [];
    const arr: any[] = await r.json();
    return (arr ?? []).map((e) => {
      const ev = this.mapEvent(e, roomId);
      ev.stateKey = e.state_key;
      return ev;
    });
  }

  /** Read a single state event. Empty state_key uses the trailing-slash form. */
  async getStateEvent(roomId: string, type: string, stateKey = ''): Promise<any> {
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/state/${this.enc(type)}/${this.enc(stateKey)}`;
    const r = await this.hsFetch(url, { headers: this.headers() });
    if (!r.ok) return null;
    return r.json();
  }

  /** LIMIT: most pinned event ids {@link getPinnedEvents} returns — the room
   *  media panel renders a short pinned shelf, not an unbounded backlog. */
  static readonly MAX_PINNED_EVENTS = 24;

  /**
   * Read the room's `m.room.pinned_events` state (the `pinned` array of event
   * ids). Fail-soft `[]` on unset/denied/malformed; ids are validated against
   * the `$…` event-id shape and capped at {@link MAX_PINNED_EVENTS} — the
   * content is room-member-writable, so treat it as untrusted.
   */
  async getPinnedEvents(roomId: string): Promise<string[]> {
    try {
      const raw = await this.getStateEvent(roomId, 'm.room.pinned_events');
      const pinned: unknown[] = Array.isArray(raw?.pinned) ? raw.pinned : [];
      return pinned
        .filter((id): id is string => typeof id === 'string' && /^\$.{1,254}$/.test(id))
        .slice(0, MatrixService.MAX_PINNED_EVENTS);
    } catch {
      return [];
    }
  }

  /** Set a state event (name/topic/avatar/power_levels). Returns event_id. */
  async setStateEvent(roomId: string, type: string, content: unknown, stateKey = ''): Promise<string> {
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/state/${this.enc(type)}/${this.enc(stateKey)}`;
    const r = await this.hsFetch(url, { method: 'PUT', headers: this.jsonHeaders(), body: JSON.stringify(content) });
    if (!r.ok) throw new Error(`setStateEvent ${type} failed: ${r.status}`);
    return (await r.json()).event_id ?? '';
  }

  // ─────────────────────────── Membership ───────────────────────────

  async createRoom(opts: {
    name?: string; topic?: string;
    preset?: 'private_chat' | 'public_chat' | 'trusted_private_chat';
    visibility?: 'public' | 'private'; room_alias_name?: string;
    invite?: string[]; is_direct?: boolean;
  }): Promise<string> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/createRoom`, {
      method: 'POST', headers: this.jsonHeaders(), body: JSON.stringify(opts),
    });
    if (!r.ok) throw new Error(`createRoom failed: ${r.status}`);
    return (await r.json()).room_id;
  }

  async joinRoom(roomIdOrAlias: string): Promise<string> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/join/${this.enc(roomIdOrAlias)}`, {
      method: 'POST', headers: this.jsonHeaders(), body: '{}',
    });
    if (!r.ok) throw new Error(`joinRoom failed: ${r.status}`);
    return (await r.json()).room_id;
  }

  // Membership verbs THROW on a non-OK response (403 insufficient power level,
  // 404, homeserver 5xx) — the callers must ANNOUNCE the failure, matching the
  // repo's announced-failure honesty convention. Swallowing the status here is
  // what let room-settings claim "Invited" on a 403 and let a plain member's
  // Kick on a higher-PL member silently no-op.

  async leaveRoom(roomId: string): Promise<void> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/leave`, {
      method: 'POST', headers: this.jsonHeaders(), body: '{}',
    });
    if (!r.ok) throw new Error(`leaveRoom failed: ${r.status}`);
  }

  async invite(roomId: string, userId: string): Promise<void> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/invite`, {
      method: 'POST', headers: this.jsonHeaders(), body: JSON.stringify({ user_id: userId }),
    });
    if (!r.ok) throw new Error(`invite failed: ${r.status}`);
  }

  async kick(roomId: string, userId: string, reason?: string): Promise<void> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/kick`, {
      method: 'POST', headers: this.jsonHeaders(), body: JSON.stringify({ user_id: userId, reason }),
    });
    if (!r.ok) throw new Error(`kick failed: ${r.status}`);
  }

  /** Member list: joined members merged with optional power levels. */
  async joinedMembers(roomId: string): Promise<RoomMember[]> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/joined_members`, { headers: this.headers() });
    if (!r.ok) return [];
    const joined = (await r.json()).joined ?? {};
    let powerUsers: Record<string, number> = {};
    let usersDefault = 0;
    try {
      const pl = await this.getStateEvent(roomId, 'm.room.power_levels');
      if (pl) { powerUsers = pl.users ?? {}; usersDefault = pl.users_default ?? 0; }
    } catch { /* ignore */ }
    return Object.keys(joined).map((userId) => ({
      userId,
      displayName: joined[userId]?.display_name,
      // Optional ASCII screen-reader name fragment (custom profile field);
      // absent ⇒ undefined and accessibleName() announces the display name.
      screenReaderName: joined[userId]?.['com.hugmesh.screen_reader_name'],
      avatarUrl: joined[userId]?.avatar_url,
      membership: 'join' as const,
      powerLevel: powerUsers[userId] ?? usersDefault,
    }));
  }

  // ─────────────────────────── Timeline / events ───────────────────────────

  /** Paginate the timeline; returns chunk + start/end tokens for back-scroll.
   *  `from` is optional since Matrix v1.3 (omit = timeline end/start per dir). */
  async messages(roomId: string, opts?: { from?: string; dir?: 'b' | 'f'; limit?: number }): Promise<Paginated> {
    const dir = opts?.dir ?? 'b';
    const qs = new URLSearchParams();
    qs.set('dir', dir);
    if (opts?.from) qs.set('from', opts.from);
    qs.set('limit', String(opts?.limit ?? 50));
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/messages?${qs.toString()}`, { headers: this.headers() });
    // 401/403 is a VISIBILITY denial (signed-out or non-member deep link) that
    // callers must be able to distinguish from an empty room: throw, so
    // timeline.component renders its explicit denied notice instead of an
    // indistinguishable silently-empty log. Other failures degrade to empty.
    if (r.status === 401 || r.status === 403) throw new Error(`messages denied: ${r.status}`);
    if (!r.ok) return { events: [], start: '', end: '' };
    const data = await r.json();
    const chunk: any[] = data.chunk ?? [];
    return {
      events: chunk.map((e) => this.mapEvent(e, roomId)),
      start: data.start ?? '',
      end: data.end ?? '',
    };
  }

  async getEvent(roomId: string, eventId: string): Promise<TimelineEvent> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/event/${this.enc(eventId)}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`getEvent failed: ${r.status}`);
    return this.mapEvent(await r.json(), roomId);
  }

  /** Generalized — send any m.room.message; returns event_id. */
  async sendMessage(roomId: string, content: { msgtype: string; body: string; format?: string; formatted_body?: string }, txnId?: string): Promise<string> {
    const txn = txnId ?? this.txn();
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/send/m.room.message/${this.enc(txn)}`, {
      method: 'PUT', headers: this.jsonHeaders(), body: JSON.stringify(content),
    });
    if (!r.ok) throw new Error(`sendMessage failed: ${r.status}`);
    return (await r.json()).event_id ?? '';
  }

  /** Generic timeline event send (reactions, replies, threads, m.call.*). */
  async sendEvent(roomId: string, type: string, content: unknown, txnId?: string): Promise<string> {
    const txn = txnId ?? this.txn('c');
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/send/${this.enc(type)}/${this.enc(txn)}`, {
      method: 'PUT', headers: this.jsonHeaders(), body: JSON.stringify(content),
    });
    if (!r.ok) throw new Error(`sendEvent ${type} failed: ${r.status}`);
    return (await r.json()).event_id ?? '';
  }

  async sendReply(roomId: string, body: string, inReplyToEventId: string): Promise<string> {
    const content: any = {
      msgtype: 'm.text',
      body,
      'm.relates_to': { 'm.in_reply_to': { event_id: inReplyToEventId } },
      format: 'org.matrix.custom.html',
      formatted_body: `<mx-reply><blockquote>In reply to event ${inReplyToEventId}</blockquote></mx-reply>${this.escapeHtml(body)}`,
    };
    return this.sendMessage(roomId, content as any);
  }

  async sendThreadMessage(roomId: string, body: string, threadRootId: string, latestThreadEventId: string): Promise<string> {
    const content: any = {
      msgtype: 'm.text',
      body,
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: threadRootId,
        is_falling_back: true,
        'm.in_reply_to': { event_id: latestThreadEventId },
      },
    };
    return this.sendMessage(roomId, content as any);
  }

  async sendReaction(roomId: string, targetEventId: string, key: string): Promise<string> {
    return this.sendEvent(roomId, 'm.reaction', {
      'm.relates_to': { rel_type: 'm.annotation', event_id: targetEventId, key },
    }, this.txn('r'));
  }

  async editMessage(roomId: string, targetEventId: string, newBody: string): Promise<string> {
    const content: any = {
      msgtype: 'm.text',
      body: `* ${newBody}`,
      'm.new_content': { msgtype: 'm.text', body: newBody },
      'm.relates_to': { rel_type: 'm.replace', event_id: targetEventId },
    };
    return this.sendMessage(roomId, content as any);
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<string> {
    const txn = this.txn('x');
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/redact/${this.enc(eventId)}/${this.enc(txn)}`, {
      method: 'PUT', headers: this.jsonHeaders(), body: JSON.stringify(reason ? { reason } : {}),
    });
    if (!r.ok) throw new Error(`redactEvent failed: ${r.status}`);
    return (await r.json()).event_id ?? '';
  }

  /** Aggregate an event's relations: reactions/edits/thread replies (v1 API). */
  async getRelations(roomId: string, eventId: string, relType?: string, eventType?: string): Promise<TimelineEvent[]> {
    let url = `${this.baseUrl}/_matrix/client/v1/rooms/${this.enc(roomId)}/relations/${this.enc(eventId)}`;
    if (relType) url += `/${this.enc(relType)}`;
    if (relType && eventType) url += `/${this.enc(eventType)}`;
    const r = await this.hsFetch(url, { headers: this.headers() });
    if (!r.ok) return [];
    const chunk: any[] = (await r.json()).chunk ?? [];
    return chunk.map((e) => this.mapEvent(e, roomId));
  }

  /** List thread roots in a room (v1 API). Paginate via response.next_batch. */
  async getThreads(roomId: string, from?: string): Promise<Paginated> {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v1/rooms/${this.enc(roomId)}/threads?${qs.toString()}`, { headers: this.headers() });
    if (!r.ok) return { events: [], start: '', end: '' };
    const data = await r.json();
    const chunk: any[] = data.chunk ?? [];
    return { events: chunk.map((e) => this.mapEvent(e, roomId)), start: from ?? '', end: data.next_batch ?? '' };
  }

  // ─────────────────────────── Ephemeral / receipts ───────────────────────────

  async setTyping(roomId: string, typing: boolean, timeoutMs = 30000): Promise<void> {
    const me = await this.whoami();
    if (!me) return;
    const body: any = { typing };
    if (typing) body.timeout = timeoutMs;
    await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/typing/${this.enc(me)}`, {
      method: 'PUT', headers: this.jsonHeaders(), body: JSON.stringify(body),
    });
  }

  async sendReceipt(roomId: string, eventId: string, type: 'm.read' | 'm.read.private' = 'm.read'): Promise<void> {
    await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/receipt/${this.enc(type)}/${this.enc(eventId)}`, {
      method: 'POST', headers: this.jsonHeaders(), body: '{}',
    });
  }

  async setReadMarker(roomId: string, fullyReadEventId: string, readEventId?: string): Promise<void> {
    const body: any = { 'm.fully_read': fullyReadEventId };
    if (readEventId) body['m.read'] = readEventId;
    await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/read_markers`, {
      method: 'POST', headers: this.jsonHeaders(), body: JSON.stringify(body),
    });
  }

  // ─────────────────────────── Media ───────────────────────────

  /** Upload a file to the content repo; returns content_uri (mxc://). */
  async uploadMedia(file: File, filename?: string): Promise<UploadResult> {
    const qs = new URLSearchParams();
    qs.set('filename', filename ?? file.name);
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/media/v3/upload?${qs.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', ...this.headers() },
      body: file,
    });
    if (!r.ok) throw new Error(`uploadMedia failed: ${r.status}`);
    const uri = (await r.json()).content_uri ?? '';
    return { contentUri: uri, mxcUri: uri };
  }

  /**
   * AI-CLOAK upload path — POISON BEFORE INGEST.
   *
   * Instead of POSTing the bytes straight to `/_matrix/media/v3/upload` (which
   * would let the homeserver, its thumbnailer, and federation cache the CLEAN
   * original before any protection can run), send the file to the user-bff media
   * proxy `POST /bff/user/media/upload`. The BFF holds the bytes, calls the
   * optional poisoner worker (original + every served size) and only THEN does
   * the real homeserver upload of the cloaked bytes — returning the exact same
   * `content_uri` (mxc) the homeserver would have, so {@link sendImage} and the
   * rest of the compose path are UNTOUCHED.
   *
   * `mode:'none'` (opt-out) and non-image media are forwarded straight through
   * by the BFF, so this is safe to call for any attachment; the caller decides
   * whether to use this or {@link uploadMedia} based on the cloak toggle.
   *
   * Honest by construction: the returned {@link CloakDecision} is the server's
   * source of truth for the badge — it may come back `degraded`/`skipped`, never
   * a guarantee.
   */
  async uploadMediaProtected(file: File, mode: CloakMode, roomId: string): Promise<ProtectedUploadResult> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('platform', 'matrix');
    form.append('mode', mode);
    if (roomId) form.append('roomId', roomId);
    const r = await fetch(`${this.bffBaseUrl}/bff/user/media/upload`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!r.ok) throw new Error(`uploadMediaProtected failed: ${r.status}`);
    const data = await r.json();
    const uri = data.mxcUri ?? data.contentUri ?? data.content_uri ?? '';
    const decision: CloakDecision = {
      mxcUri: uri,
      mode,
      status: (data.status as CloakStatus) ?? (mode === 'none' ? 'skipped' : 'pending'),
      backend: data.backend,
    };
    return { contentUri: uri, mxcUri: uri, decision };
  }

  /** Ask the BFF whether the heavy-tier cloak worker is reachable right now, so
   *  the composer can render an honest `Unavailable` shield up front (and the
   *  expected-time copy) rather than only discovering it after upload. */
  async cloakCapability(): Promise<CloakCapability> {
    try {
      const r = await fetch(`${this.bffBaseUrl}/bff/user/media/capability`, { credentials: 'include' });
      if (!r.ok) return { backend: 'none', available: false };
      const data = await r.json();
      const backend: CloakCapability['backend'] = data.backend ?? 'none';
      return {
        backend,
        available: data.available ?? backend !== 'none',
        expectedSeconds: data.expectedSeconds,
      };
    } catch {
      return { backend: 'none', available: false };
    }
  }

  /** Poll the server-owned cloak decision for an uploaded mxc — the badge's
   *  source of truth (it reflects the round-trip survival gate, so it can return
   *  `degraded` after the homeserver re-encode washed the perturbation out). */
  async cloakStatus(mxcUri: string): Promise<CloakDecision> {
    const r = await fetch(`${this.bffBaseUrl}/bff/user/media/status/${this.enc(mxcUri)}`, { credentials: 'include' });
    if (!r.ok) return { mxcUri, mode: 'cloak', status: 'failed' };
    const data = await r.json();
    return {
      mxcUri,
      mode: (data.mode as CloakMode) ?? 'cloak',
      status: (data.status as CloakStatus) ?? 'pending',
      backend: data.backend,
    };
  }

  async sendImage(roomId: string, mxcUri: string, file: File, info: { w?: number; h?: number; mimetype: string; size: number }): Promise<string> {
    const content: any = {
      msgtype: 'm.image', body: file.name, url: mxcUri,
      info: { w: info.w, h: info.h, mimetype: info.mimetype, size: info.size },
    };
    return this.sendMessage(roomId, content);
  }

  async sendFile(roomId: string, mxcUri: string, file: File): Promise<string> {
    const content: any = {
      msgtype: 'm.file', body: file.name, url: mxcUri,
      info: { mimetype: file.type || 'application/octet-stream', size: file.size },
    };
    return this.sendMessage(roomId, content);
  }

  /** Convert mxc:// to an AUTHENTICATED client-v1 media URL (download or
   *  thumbnail). Because these require the Bearer header, callers should fetch
   *  as a blob and use an object URL rather than putting the URL in src. */
  mxcToHttp(mxcUri: string, opts?: { thumbnail?: boolean; w?: number; h?: number; method?: 'crop' | 'scale' }): string {
    if (!mxcUri || !mxcUri.startsWith('mxc://')) return '';
    const rest = mxcUri.slice('mxc://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return '';
    const serverName = rest.slice(0, slash);
    const mediaId = rest.slice(slash + 1);
    if (opts?.thumbnail) {
      const qs = new URLSearchParams();
      qs.set('width', String(opts.w ?? 96));
      qs.set('height', String(opts.h ?? 96));
      qs.set('method', opts.method ?? 'crop');
      return `${this.baseUrl}/_matrix/client/v1/media/thumbnail/${this.enc(serverName)}/${this.enc(mediaId)}?${qs.toString()}`;
    }
    return `${this.baseUrl}/_matrix/client/v1/media/download/${this.enc(serverName)}/${this.enc(mediaId)}`;
  }

  /** Fetch an authenticated media URL as an object URL for <img>/<a> src. */
  async fetchMediaObjectUrl(mxcUri: string, opts?: { thumbnail?: boolean; w?: number; h?: number; method?: 'crop' | 'scale' }): Promise<string> {
    const url = this.mxcToHttp(mxcUri, opts);
    if (!url) return '';
    const r = await this.hsFetch(url, { headers: this.headers() });
    if (!r.ok) return '';
    const blob = await r.blob();
    return URL.createObjectURL(blob);
  }

  /**
   * Fetch authenticated media as RAW BYTES (the 3D room's texture path: the
   * chat3d host base64-encodes these bytes into the §5 `placeMedia` envelope —
   * an object URL would be useless cross-origin, and a TRANSFERRED ArrayBuffer
   * cannot survive either, because the game JSON-serializes its inbound queue
   * before GDScript decodes it).
   * Same authenticated blob route as {@link fetchMediaObjectUrl}; fail-soft
   * null (a failed texture demotes the surface to its label plaque).
   */
  async fetchMediaBytes(mxcUri: string, opts?: { thumbnail?: boolean; w?: number; h?: number; method?: 'crop' | 'scale' }): Promise<ArrayBuffer | null> {
    const url = this.mxcToHttp(mxcUri, opts);
    if (!url) return null;
    try {
      const r = await this.hsFetch(url, { headers: this.headers() });
      if (!r.ok) return null;
      return await r.arrayBuffer();
    } catch {
      return null;
    }
  }

  // ─────────────────────────── Profile / account data ───────────────────────────

  async getProfile(userId: string): Promise<UserProfile> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/profile/${this.enc(userId)}`, { headers: this.headers() });
    if (!r.ok) return { userId };
    const data = await r.json();
    return { userId, displayName: data.displayname, avatarUrl: data.avatar_url };
  }

  async setDisplayName(userId: string, displayName: string): Promise<void> {
    await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/profile/${this.enc(userId)}/displayname`, {
      method: 'PUT', headers: this.jsonHeaders(), body: JSON.stringify({ displayname: displayName }),
    });
  }

  async setAvatarUrl(userId: string, mxcUri: string): Promise<void> {
    await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/profile/${this.enc(userId)}/avatar_url`, {
      method: 'PUT', headers: this.jsonHeaders(), body: JSON.stringify({ avatar_url: mxcUri }),
    });
  }

  async getAccountData<T>(userId: string, type: string): Promise<T | null> {
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/user/${this.enc(userId)}/account_data/${this.enc(type)}`, { headers: this.headers() });
    if (!r.ok) return null;
    return (await r.json()) as T;
  }

  async setAccountData(userId: string, type: string, content: unknown): Promise<void> {
    await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/user/${this.enc(userId)}/account_data/${this.enc(type)}`, {
      method: 'PUT', headers: this.jsonHeaders(), body: JSON.stringify(content),
    });
  }

  // ─────────────────────────── Search / presence ───────────────────────────

  /** Full-text message search. next_batch is a QUERY param (not in the body). */
  async search(term: string, opts?: { roomId?: string; beforeLimit?: number; afterLimit?: number; nextBatch?: string }): Promise<{ results: SearchResult[]; nextBatch?: string; count: number }> {
    const qs = new URLSearchParams();
    if (opts?.nextBatch) qs.set('next_batch', opts.nextBatch);
    const roomEvents: any = {
      search_term: term,
      keys: ['content.body'],
      order_by: 'recent',
      event_context: {
        before_limit: opts?.beforeLimit ?? 1,
        after_limit: opts?.afterLimit ?? 1,
        include_profile: true,
      },
    };
    if (opts?.roomId) roomEvents.filter = { rooms: [opts.roomId] };
    const body = { search_categories: { room_events: roomEvents } };
    const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/search?${qs.toString()}`, {
      method: 'POST', headers: this.jsonHeaders(), body: JSON.stringify(body),
    });
    if (!r.ok) return { results: [], count: 0 };
    const data = await r.json();
    const re = data.search_categories?.room_events ?? {};
    const results: SearchResult[] = (re.results ?? []).map((res: any) => {
      const ev = res.result;
      const roomId = ev?.room_id ?? opts?.roomId ?? '';
      return {
        event: this.mapEvent(ev, roomId),
        rank: res.rank ?? 0,
        contextBefore: (res.context?.events_before ?? []).map((e: any) => this.mapEvent(e, roomId)),
        contextAfter: (res.context?.events_after ?? []).map((e: any) => this.mapEvent(e, roomId)),
        roomId,
      };
    });
    return { results, nextBatch: re.next_batch, count: re.count ?? results.length };
  }

  /** Read a user's CURRENT presence + status message (fail-soft null). Lets the
   *  settings form preload the server truth instead of always resetting to
   *  Online — clicking "Update presence" used to silently un-Away a user. */
  async getPresence(userId: string): Promise<{ presence: 'online' | 'offline' | 'unavailable'; statusMsg?: string } | null> {
    try {
      const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/presence/${this.enc(userId)}/status`, { headers: this.headers() });
      if (!r.ok) return null;
      const data = await r.json();
      const presence = data?.presence;
      if (presence !== 'online' && presence !== 'offline' && presence !== 'unavailable') return null;
      return { presence, statusMsg: typeof data?.status_msg === 'string' ? data.status_msg : undefined };
    } catch {
      return null;
    }
  }

  async setPresence(userId: string, presence: 'online' | 'offline' | 'unavailable', statusMsg?: string): Promise<void> {
    await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/presence/${this.enc(userId)}/status`, {
      method: 'PUT', headers: this.jsonHeaders(), body: JSON.stringify({ presence, status_msg: statusMsg }),
    });
  }

  // ─────────────────────────── Call signalling ───────────────────────────

  /** All room events, optionally filtered by an event-type prefix. Used by
   *  MatrixCallComponent for m.call.* WebRTC signalling (video AND the VN
   *  voice-chat mode, which reuses the same signalling — see roomEvents()'s
   *  callers for the dialogue-box feed).
   *
   *  `origin_server_ts` is part of the contract: this is a BACK-PAGINATED
   *  window (`dir=b&limit=200`), so a caller that re-reads it — every signalling
   *  pump does, from an empty dedupe set on each join — sees historical events
   *  again and MUST be able to age them out. {@link MeshCallService} enforces
   *  the `m.call.invite` lifetime against it. */
  async roomEvents(roomId: string, typePrefix?: string): Promise<{ event_id: string; type: string; sender: string; content: any; origin_server_ts?: number }[]> {
    const r = await this.hsFetch(
      `${this.baseUrl}/_matrix/client/v3/rooms/${this.enc(roomId)}/messages?dir=b&limit=200`,
      { headers: this.headers() },
    );
    if (!r.ok) return [];
    const chunk: any[] = (await r.json()).chunk ?? [];
    return typePrefix ? chunk.filter((e) => (e.type || '').startsWith(typePrefix)) : chunk;
  }

  /**
   * VoIP TURN/STUN relay credentials for the WebRTC call ICE config — the
   * canonical Matrix endpoint `GET /_matrix/client/v3/voip/turnServer`.
   *
   * The homeserver returns short-lived, per-user TURN credentials (a shared-secret
   * derived username/password with a `ttl`); the actual coturn relay + its
   * shared-secret live server-side (homeserver config sourced from ESO/Vault), so
   * NO TURN secret is ever held in this client. We map the Matrix response shape
   *   `{ uris: string[], username: string, password: string, ttl: number }`
   * into the WebRTC `RTCIceServer[]` the {@link RTCPeerConnection} constructor
   * wants (`{ urls, username, credential }`).
   *
   * Routed exactly like every other CS-API call: through the same-origin BFF
   * hsproxy (`/bff/user/matrix/_matrix/.../voip/turnServer` wildcard passthrough
   * via {@link hsFetch}), authenticated by the platform `bff_` session
   * ({@link headers}); the proxy injects the server-held homeserver token.
   *
   * SAFE-BY-DEFAULT: any failure, a non-OK status, or an empty/absent `uris`
   * resolves to `[]` (NOT a throw). A `[]` result drives
   * `new RTCPeerConnection({ iceServers: [] })` — byte-identical to today's
   * hard-coded host-only behaviour — so when no TURN relay is configured (the
   * default, coturn ships dark/disabled) calls degrade gracefully to host/LAN-only
   * candidates rather than breaking. The credentials are returned for the caller
   * to hold for the component lifecycle only; they are never logged or persisted.
   */
  async turnServer(): Promise<RTCIceServer[]> {
    try {
      const r = await this.hsFetch(`${this.baseUrl}/_matrix/client/v3/voip/turnServer`, { headers: this.headers() });
      if (!r.ok) return [];
      const data = await r.json();
      const uris: string[] = Array.isArray(data?.uris) ? data.uris.filter((u: unknown): u is string => typeof u === 'string' && u.length > 0) : [];
      if (uris.length === 0) return [];
      const server: RTCIceServer = { urls: uris };
      // username/password are optional in the spec (a bare STUN URI needs neither).
      if (typeof data.username === 'string') server.username = data.username;
      if (typeof data.password === 'string') server.credential = data.password;
      return [server];
    } catch {
      return [];
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
