/**
 * LEGACY READ-FALLBACK WIRE NAMES — the ONE place in this repo that builds a
 * pre-canonical Matrix wire identifier.
 *
 * These are wire identifiers persisted on IMMUTABLE events in existing rooms
 * and accounts. Two pre-canonical generations can be real data on a live mesh:
 *
 *  1. `systems.hugmesh.*` — every post-squash build before the .net domain
 *     move. Public, so it is spelled here directly.
 *  2. The ORIGINAL pre-HugMesh brand's names, `systems.<brand>.*` (and the
 *     `com.<brand>.mesh` content field). Only meshes that ran that brand carry
 *     them, and the brand stem is deployment-private, so it is NEVER written
 *     in this repo: a deployment that still has such rooms injects the stem at
 *     runtime through the {@link LEGACY_BRANDS_GLOBAL} hook (the same
 *     `__HUG_*__` global convention as `__HUG_GAMES_URL__`, `__HUG_BFF_URL__`).
 *     The hook must be set before this remote's code loads — the host page
 *     sets it in its bootstrap script, exactly like every other `__HUG_*__`
 *     hook. Unset ⇒ only the public generations are read.
 *
 * Removing a generation makes that generation's stickers, VN scenes, 3D-room
 * state, bridge settings and chat themes invisible in every room and account
 * that still carries them — the historical events cannot be rewritten.
 *
 * READ-FALLBACK ONLY — never written. Each feature service owns its canonical
 * `net.hugmesh.*` / `com.hugmesh.*` constant, mints ONLY that name on every
 * write, and walks its read chain canonical-first with the newest present
 * generation winning; the first post-rebrand write migrates the room/account
 * forward. Every list below is ordered newest generation first.
 *
 * Do NOT spell a legacy brand anywhere in this repo (comments, specs and
 * fixtures included; specs use the placeholder `exampleorg`) —
 * `scripts/check-neutrality.mjs` (`npm run check:neutrality`) fails the build
 * if one appears.
 */

/**
 * Name of the runtime global a deployment sets to the pre-rebrand brand
 * stem(s) its rooms may still carry, newest first, e.g.
 * `globalThis.__HUG_LEGACY_EVENT_BRANDS__ = ['exampleorg']` makes every read
 * chain also try `systems.exampleorg.<x>` (and the content field
 * `com.exampleorg.mesh`) after `systems.hugmesh.<x>`.
 */
export const LEGACY_BRANDS_GLOBAL = '__HUG_LEGACY_EVENT_BRANDS__';

/** A brand stem is ONE lower-case DNS label: it is pasted into reverse-DNS
 *  event type names, so anything else (dots, spaces, upper case) is refused. */
const BRAND_STEM = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** At most this many legacy brands: every one adds a GET per read chain. */
const MAX_LEGACY_BRANDS = 4;

/**
 * Validate the injected value. Accepts an array of strings (or one string);
 * keeps only well-formed, distinct stems that are not the current brand, in
 * the given order, capped at {@link MAX_LEGACY_BRANDS}. Anything malformed is
 * dropped silently — a bad deploy value must never break the canonical reads.
 */
export function parseLegacyBrands(raw: unknown): readonly string[] {
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const stem = item.trim();
    if (!BRAND_STEM.test(stem) || stem === 'hugmesh' || out.includes(stem)) continue;
    out.push(stem);
    if (out.length >= MAX_LEGACY_BRANDS) break;
  }
  return out;
}

/** The legacy read lists, built from the public generation plus the injected brands. */
export interface LegacyReadLists {
  chat3dState: readonly string[];
  chat3dScene: readonly string[];
  chat3dAvatar: readonly string[];
  chat3dStage: readonly string[];
  meshBridgeState: readonly string[];
  vnSceneState: readonly string[];
  chatThemeAccountData: readonly string[];
  meshEventContentFields: readonly string[];
  vnStickerContentFields: readonly string[];
}

/** Pure builder (exported for its spec): `brands` must already be parsed. */
export function buildLegacyReadLists(brands: readonly string[]): LegacyReadLists {
  const chain = (suffix: string): readonly string[] =>
    ['hugmesh', ...brands].map((b) => `systems.${b}.${suffix}`);
  return {
    chat3dState: chain('chat3d'),
    chat3dScene: chain('chat3d.scene'),
    chat3dAvatar: chain('chat3d.avatar'),
    chat3dStage: chain('chat3d.stage'),
    meshBridgeState: chain('mesh.bridge'),
    vnSceneState: chain('vn.scene'),
    chatThemeAccountData: chain('chat_theme'),
    // `com.hugmesh.mesh` IS the canonical content field, so only the injected
    // brands form its legacy chain (empty when none is configured).
    meshEventContentFields: brands.map((b) => `com.${b}.mesh`),
    vnStickerContentFields: chain('vn'),
  };
}

const LISTS = buildLegacyReadLists(
  parseLegacyBrands((globalThis as Record<string, unknown>)[LEGACY_BRANDS_GLOBAL]),
);

/** Pre-canonical generations of `net.hugmesh.chat3d` (room state; see Chat3dStateService). */
export const LEGACY_CHAT3D_STATE_TYPES: readonly string[] = LISTS.chat3dState;

/** Pre-canonical generations of `net.hugmesh.chat3d.scene` (room state; see Chat3dSceneService). */
export const LEGACY_CHAT3D_SCENE_TYPES: readonly string[] = LISTS.chat3dScene;

/** Pre-canonical generations of `net.hugmesh.chat3d.avatar` (room state, per-mxid state_key; see Chat3dAvatarService). */
export const LEGACY_CHAT3D_AVATAR_TYPES: readonly string[] = LISTS.chat3dAvatar;

/** Pre-canonical generations of `net.hugmesh.chat3d.stage` (room state; see Chat3dStageService). */
export const LEGACY_CHAT3D_STAGE_TYPES: readonly string[] = LISTS.chat3dStage;

/** Pre-canonical generations of `net.hugmesh.mesh.bridge` (room state; see MeshBridgeStateService). */
export const LEGACY_MESH_BRIDGE_STATE_TYPES: readonly string[] = LISTS.meshBridgeState;

/** Pre-canonical generations of `net.hugmesh.vn.scene` (room state; see VnSceneStateService). */
export const LEGACY_VN_SCENE_STATE_TYPES: readonly string[] = LISTS.vnSceneState;

/** Pre-canonical generations of `net.hugmesh.chat_theme` (per-user ACCOUNT DATA; see ChatThemeService). */
export const LEGACY_CHAT_THEME_ACCOUNT_DATA_TYPES: readonly string[] = LISTS.chatThemeAccountData;

/**
 * Pre-rebrand spellings of the `com.hugmesh.mesh` CONTENT FIELD bridged
 * LoRa-mesh events carry their radio provenance under (attached by the bridge
 * appservice — the UI never writes this field at all). Events bridged before
 * the rebrand keep it forever; `MatrixService.mapEvent` reads the canonical
 * field first and then each of these, so old bridged messages keep their
 * "via LoRa mesh" badge. Empty unless a legacy brand is injected.
 */
export const LEGACY_MESH_EVENT_CONTENT_FIELDS: readonly string[] = LISTS.meshEventContentFields;

/**
 * Pre-canonical generations of the `net.hugmesh.vn` sticker-content org ext
 * (rides on `m.sticker` TIMELINE events — immutable, so old stickers carry
 * these forever; see HugStickerPickerComponent.send). No reader exists in
 * this repo yet: a future reader of the VN expression must accept the
 * canonical field plus every entry here, newest first.
 */
export const LEGACY_VN_STICKER_CONTENT_FIELDS: readonly string[] = LISTS.vnStickerContentFields;
