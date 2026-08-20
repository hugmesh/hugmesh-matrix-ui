/**
 * LEGACY READ-FALLBACK WIRE NAMES — the ONE place in this repo that may spell
 * a pre-rebrand Matrix wire identifier.
 *
 * These are wire identifiers persisted on IMMUTABLE events in existing rooms
 * and accounts. Two pre-canonical generations are real data on live meshes:
 * `systems.hugmesh.*` (every post-squash build before the .net domain move)
 * and the original pre-HugMesh-rebrand `systems.snapdragon.*` names. Deleting
 * a spelling from this file makes that generation's stickers, VN scenes,
 * 3D-room state, bridge settings, and chat themes invisible in every room and
 * account that still carries them — the historical events cannot be rewritten.
 *
 * READ-FALLBACK ONLY — never written. Each feature service owns its canonical
 * `net.hugmesh.*` / `com.hugmesh.*` constant, mints ONLY that name on every
 * write, and walks its read chain canonical-first with the newest present
 * generation winning; the first post-rebrand write migrates the room/account
 * forward. Every list below is ordered newest generation first.
 *
 * Do NOT add the old brand's spelling anywhere else (comments included) —
 * reference this module instead, so the whole legacy surface stays auditable
 * in one file.
 */

/** Pre-rebrand generations of `net.hugmesh.chat3d` (room state; see Chat3dStateService). */
export const LEGACY_CHAT3D_STATE_TYPES: readonly string[] = [
  'systems.hugmesh.chat3d', 'systems.snapdragon.chat3d',
];

/** Pre-rebrand generations of `net.hugmesh.chat3d.scene` (room state; see Chat3dSceneService). */
export const LEGACY_CHAT3D_SCENE_TYPES: readonly string[] = [
  'systems.hugmesh.chat3d.scene', 'systems.snapdragon.chat3d.scene',
];

/** Pre-rebrand generations of `net.hugmesh.chat3d.avatar` (room state, per-mxid state_key; see Chat3dAvatarService). */
export const LEGACY_CHAT3D_AVATAR_TYPES: readonly string[] = [
  'systems.hugmesh.chat3d.avatar', 'systems.snapdragon.chat3d.avatar',
];

/** Pre-rebrand generations of `net.hugmesh.chat3d.stage` (room state; see Chat3dStageService). */
export const LEGACY_CHAT3D_STAGE_TYPES: readonly string[] = [
  'systems.hugmesh.chat3d.stage', 'systems.snapdragon.chat3d.stage',
];

/** Pre-rebrand generations of `net.hugmesh.mesh.bridge` (room state; see MeshBridgeStateService). */
export const LEGACY_MESH_BRIDGE_STATE_TYPES: readonly string[] = [
  'systems.hugmesh.mesh.bridge', 'systems.snapdragon.mesh.bridge',
];

/** Pre-rebrand generations of `net.hugmesh.vn.scene` (room state; see VnSceneStateService). */
export const LEGACY_VN_SCENE_STATE_TYPES: readonly string[] = [
  'systems.hugmesh.vn.scene', 'systems.snapdragon.vn.scene',
];

/** Pre-rebrand generations of `net.hugmesh.chat_theme` (per-user ACCOUNT DATA; see ChatThemeService). */
export const LEGACY_CHAT_THEME_ACCOUNT_DATA_TYPES: readonly string[] = [
  'systems.hugmesh.chat_theme', 'systems.snapdragon.chat_theme',
];

/**
 * Pre-rebrand spelling of the `com.hugmesh.mesh` CONTENT FIELD bridged
 * LoRa-mesh events carry their radio provenance under (attached by the bridge
 * appservice — the UI never writes this field at all). Events bridged before
 * the rebrand keep it forever; `MatrixService.mapEvent` reads the canonical
 * field first and falls back to this one, so old bridged messages keep their
 * "via LoRa mesh" badge.
 */
export const LEGACY_MESH_EVENT_CONTENT_FIELD = 'com.snapdragon.mesh';

/**
 * Pre-rebrand generations of the `net.hugmesh.vn` sticker-content org ext
 * (rides on `m.sticker` TIMELINE events — immutable, so old stickers carry
 * these forever; see HugStickerPickerComponent.send). No reader exists in
 * this repo yet: a future reader of the VN expression must accept the
 * canonical field plus BOTH of these, newest first.
 */
export const LEGACY_VN_STICKER_CONTENT_FIELDS: readonly string[] = [
  'systems.hugmesh.vn', 'systems.snapdragon.vn',
];
