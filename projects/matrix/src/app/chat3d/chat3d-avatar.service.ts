import { Injectable, inject } from '@angular/core';
import { MatrixService, TimelineEvent } from '../matrix.service';
import { Char3dConfig, parseChar3dConfig } from './char3d-config';

/**
 * The room STATE event type carrying each participant's 3D avatar snapshot.
 * The state_key is the OWNER'S FULL MXID — the Matrix auth rules only let a
 * user write a state event whose state_key is their own user id, so each
 * member can publish exactly their own avatar and nobody else's. Published on
 * joining the 3D room; read by every participant to dress the roster.
 */
export const CHAT3D_AVATAR_TYPE = 'systems.hugmesh.chat3d.avatar';

/** LIMIT: serialized avatar-event content byte cap (≤8KB — a Char3DConfig is
 *  ~1-2KB; anything bigger is hostile padding, not a character). */
export const MAX_AVATAR_EVENT_BYTES = 8_192;
/** LIMIT: longest sticker mxc URL carried in billboard mode. */
export const MAX_AVATAR_STICKER_URL_LENGTH = 512;
/** LIMIT: longest display name carried (mirrors the config name cap). */
export const MAX_AVATAR_NAME_LENGTH = 120;

/** The membership state event the roster is bound against. */
export const ROOM_MEMBER_TYPE = 'm.room.member';

/**
 * The mxids CURRENTLY JOINED to the room, read from the `m.room.member` rows of
 * a room-state array (`state_key` = the member, `content.membership` = their
 * current membership — Matrix keeps the row after a leave/kick/ban with the
 * membership flipped, which is exactly what this must exclude).
 *
 * Pure + exported so the roster's membership bind is unit-testable on its own.
 */
export function joinedMembersFrom(events: readonly TimelineEvent[]): Set<string> {
  const joined = new Set<string>();
  for (const evt of events) {
    if (evt.type !== ROOM_MEMBER_TYPE) {
      continue;
    }
    const member = evt.stateKey ?? '';
    if (member.startsWith('@') && (evt.content as { membership?: unknown } | null)?.membership === 'join') {
      joined.add(member);
    }
  }
  return joined;
}

/** How the participant chose to appear. */
export const AVATAR_MODES = ['forge', 'billboard', 'guest'] as const;
export type Chat3dAvatarMode = (typeof AVATAR_MODES)[number];

/** One participant's published 3D-room appearance. */
export interface Chat3dAvatarState {
  /** `forge` = character-forge config, `guest` = seeded random config,
   *  `billboard` = flat VN sticker sprite (no 3D character). */
  mode: Chat3dAvatarMode;
  /** The parametric character (forge/guest modes; null in billboard mode). */
  config: Char3dConfig | null;
  /** The neutral-frame sticker mxc (billboard mode; null otherwise). */
  sticker: string | null;
  /** Display name shown on the name tag ('' when unset). */
  name: string;
}

/**
 * Parse a raw `systems.hugmesh.chat3d.avatar` state-event content into a
 * {@link Chat3dAvatarState}. STRICT where the §3 BFF validation is strict —
 * this content is OTHER members' input straight into every participant's Godot
 * scene:
 *
 *   - not an object / unknown top-level keys / wrong `v` ⇒ null;
 *   - serialized content over {@link MAX_AVATAR_EVENT_BYTES} ⇒ null;
 *   - `forge`/`guest` need a config passing the full Char3DConfig mirror
 *     validation ({@link parseChar3dConfig}) ⇒ else null;
 *   - `billboard` needs an `mxc://` sticker URL ⇒ else null.
 *
 * A null avatar simply renders the fallback silhouette — never a throw. Pure +
 * exported so the untrusted-input handling is unit-testable in isolation.
 */
export function parseChat3dAvatarState(raw: unknown): Chat3dAvatarState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (!Object.keys(obj).every((k) => ['v', 'mode', 'config', 'sticker', 'name'].includes(k))) {
    return null;
  }
  if (obj['v'] !== 1) {
    return null;
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(obj)).length > MAX_AVATAR_EVENT_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  const mode = obj['mode'];
  if (typeof mode !== 'string' || !(AVATAR_MODES as readonly string[]).includes(mode)) {
    return null;
  }
  const name = typeof obj['name'] === 'string' ? obj['name'].slice(0, MAX_AVATAR_NAME_LENGTH) : '';
  if (mode === 'billboard') {
    const sticker = obj['sticker'];
    if (typeof sticker !== 'string' || !sticker.startsWith('mxc://')
        || sticker.length > MAX_AVATAR_STICKER_URL_LENGTH) {
      return null;
    }
    return { mode, config: null, sticker, name };
  }
  const config = parseChar3dConfig(obj['config']);
  if (!config) {
    return null;
  }
  return { mode: mode as Chat3dAvatarMode, config, sticker: null, name };
}

/**
 * Publishes/reads the per-participant 3D avatar snapshots as
 * {@link CHAT3D_AVATAR_TYPE} room state (state_key = the OWNER'S mxid) via the
 * thin CS-API wrappers. The receive path re-validates everything through
 * {@link parseChat3dAvatarState} AND enforces two binds:
 *
 *   - IDENTITY: state_key === sender (defence-in-depth on top of the
 *     homeserver's own auth rule — a room where that rule somehow failed must
 *     not let one member wear another's name);
 *   - MEMBERSHIP: the owner must be a CURRENTLY JOINED member. Matrix keeps
 *     non-membership state after a leave/kick/ban, and nothing ever retracts
 *     someone else's avatar, so without this a departed or BANNED user stays a
 *     permanent participant: their character and display name keep rendering
 *     in every scene, every client keeps addressing m.call.* signalling to
 *     them, and — because the A/V admitted set is the lexicographically first
 *     `maxParticipants` mxids — they permanently consume an admission seat
 *     that no UI anywhere can free.
 *
 * FAIL-SOFT: unreadable/malformed rows are skipped; a denied/failed publish
 * resolves to `false` — never a throw.
 */
@Injectable({ providedIn: 'root' })
export class Chat3dAvatarService {
  private readonly matrix = inject(MatrixService);

  /**
   * Publish MY avatar snapshot into the room (state_key = `myUserId`).
   * Normalized through the same strict parse every receiver mirrors, so we
   * never publish an event our peers would reject. False when the state is
   * invalid or the PUT fails — never a throw.
   */
  async publishMyAvatar(roomId: string, myUserId: string, state: Chat3dAvatarState): Promise<boolean> {
    if (!roomId || !myUserId) {
      return false;
    }
    const normalized = parseChat3dAvatarState({
      v: 1, mode: state.mode, config: state.config, sticker: state.sticker, name: state.name,
    });
    if (!normalized) {
      return false;
    }
    const content = {
      v: 1,
      mode: normalized.mode,
      config: normalized.config,
      sticker: normalized.sticker,
      name: normalized.name,
    };
    try {
      await this.matrix.setStateEvent(roomId, CHAT3D_AVATAR_TYPE, content, myUserId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * RETRACT my avatar state (empty content) so I stop being a 3D participant
   * the moment I leave the view. Every receiver runs the same strict parse, and
   * `{}` fails it (no `v`), so the row is skipped exactly like a never-published
   * one — Matrix has no state-event deletion, an empty content IS the retract.
   *
   * Called from the host's teardown; fail-soft (`false`, never a throw) because
   * a failed retract only leaves a ghost until my membership changes, which the
   * receive-side membership bind then clears anyway.
   */
  async retractMyAvatar(roomId: string, myUserId: string): Promise<boolean> {
    if (!roomId || !myUserId) {
      return false;
    }
    try {
      await this.matrix.setStateEvent(roomId, CHAT3D_AVATAR_TYPE, {}, myUserId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * All published avatars in the room, keyed by owner mxid. Reads the room's
   * full state once (or an already-fetched `stateEvents` array from the
   * caller's poll). Rows failing the strict parse, the state_key === sender
   * identity bind, OR the JOINED-membership bind are skipped — a partial roster
   * is normal, never a throw.
   *
   * FAIL-CLOSED on membership: a state array carrying no `m.room.member` rows
   * at all yields an EMPTY roster rather than an unverified one. A real
   * `/rooms/{id}/state` response always carries the membership rows (they are
   * what makes the room readable in the first place), so the only way to hit
   * this is a truncated/filtered array — in which case admitting everybody is
   * strictly worse than admitting nobody.
   */
  async getAvatarStates(
    roomId: string,
    stateEvents?: TimelineEvent[],
  ): Promise<Record<string, Chat3dAvatarState>> {
    if (!roomId) {
      return {};
    }
    let events = stateEvents;
    if (!events) {
      try {
        events = await this.matrix.roomState(roomId);
      } catch {
        return {};
      }
    }
    const joined = joinedMembersFrom(events);
    const out: Record<string, Chat3dAvatarState> = {};
    for (const evt of events) {
      if (evt.type !== CHAT3D_AVATAR_TYPE) {
        continue;
      }
      const owner = evt.stateKey ?? '';
      // IDENTITY BIND: the avatar belongs to the mxid in the state_key, and
      // only that user may have sent it. The homeserver enforces this for
      // @-prefixed state keys; we re-check so a misbehaving server / any
      // non-mxid state key can never dress a different member.
      if (!owner.startsWith('@') || owner !== evt.sender) {
        continue;
      }
      // MEMBERSHIP BIND: nothing ever retracts a DEPARTED member's avatar for
      // them, and Matrix keeps the state event after a leave/kick/ban — so
      // without this a ghost renders in every scene forever, keeps receiving
      // m.call.* signalling, and permanently occupies one of the room's
      // `maxParticipants` admission seats (the admitted set is the
      // lexicographically first N mxids, with no UI anywhere to free one).
      if (!joined.has(owner)) {
        continue;
      }
      const parsed = parseChat3dAvatarState(evt.content);
      if (parsed) {
        out[owner] = parsed;
      }
    }
    return out;
  }
}
