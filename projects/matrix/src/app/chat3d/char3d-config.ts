import { DEFAULT_EXPRESSION, Expression, isExpression } from '../vn/expression';

/**
 * VENDORED MIRROR of the platform Char3DConfig v1 schema — the CANONICAL copy
 * lives in hugmesh-character-forge-bff-api (the `/bff/character-forge`
 * validation + `godot/character-forge/char3d_config.gd`); native-federation
 * forbids a shared cross-remote runtime import, so the matrix remote ships its
 * OWN copy of the model + the server's validation rules (XR-chat DESIGN §2/§3).
 *
 * Char3DConfig is the small, replayable parametric description of a 3D
 * character: it maps the STABLE VN parameterization (packId/partId/
 * headArchetype/palette regions — never SVG geometry) onto a procedural 3D rig.
 * It crosses trust boundaries twice in this remote:
 *
 *   - PUBLISHED by us as the `net.hugmesh.chat3d.avatar` room state
 *     snapshot when joining a 3D room, and
 *   - RECEIVED from OTHER room members via the same state events,
 *
 * so {@link parseChar3dConfig} mirrors the BFF's server-side validation
 * (reject unknown keys, clamp numerics, regex hexes, enum-check
 * families/styles, byte-cap the JSON) — a hostile member's event can never
 * push out-of-range values into the Godot scene.
 */

/**
 * Every head family the assembler can build — the 28 menagerie-v1
 * headArchetypes plus `humanoid` (anime-v1 kemonomimi / srd bases map there).
 * Kept in the pack's stable order; the SAME list gates `body.archetype`.
 */
export const HEAD_FAMILIES = [
  'canid', 'felid', 'avian', 'reptile', 'dragon', 'dino', 'kobold', 'gryphon',
  'equine', 'cervine', 'bovine', 'caprine', 'suid', 'hyena', 'lapine', 'rodent',
  'macropod', 'moth', 'insect', 'bat', 'ursine', 'mustelid', 'procyonid',
  'amphibian', 'aquatic', 'slime', 'robot', 'synth', 'humanoid',
] as const;
export type HeadFamily = (typeof HEAD_FAMILIES)[number];

/** The three 3D render styles (anime-v1 → anime, srd-taxonomy → classic, else toon). */
export const CHAR3D_STYLES = ['anime', 'toon', 'classic'] as const;
export type Char3dStyle = (typeof CHAR3D_STYLES)[number];

/** The attachment-part slots the rig exposes (partId passthrough from the VN slots). */
export const CHAR3D_PART_SLOTS = ['tail', 'wings', 'ears', 'feature', 'accessory', 'markings', 'hair'] as const;
export type Char3dPartSlot = (typeof CHAR3D_PART_SLOTS)[number];

/** The material regions — 1:1 with the SVG tint-region names (menagerie:
 *  fur/accent/detail/line/iris; anime adds skin/hair). */
export const CHAR3D_MATERIAL_REGIONS = ['fur', 'accent', 'detail', 'line', 'iris', 'skin', 'hair'] as const;
export type Char3dMaterialRegion = (typeof CHAR3D_MATERIAL_REGIONS)[number];

/**
 * The four EXTENDED coat-block regions the kemono uplift added on top of the
 * seven base ones — twin of `Char3DConfigValidator.EXTENDED_MATERIAL_KEYS` and
 * `char3d_config.gd`'s `EXTENDED_MATERIAL_REGIONS`.
 *
 * They are OPTIONAL ON THE WIRE and deliberately NOT defaulted here: an ABSENT
 * region means "derive it" (innerMuzzle ← fur lightened, socks ← accent,
 * innerEar ← skin, tailTip ← accent), which is exactly the appearance a config
 * written before these regions existed produces. Filling a default in would
 * freeze that derivation into every character that never asked for one.
 *
 * This mirror does not render, so it neither derives nor drops them: it carries
 * a supplied region through UNCHANGED so the Godot room (which DOES derive) sees
 * what the author set. Before this list existed the unknown-key rejection below
 * hard-rejected any kemono character outright — the whole definition, not just
 * the region — so such a member rendered as a silhouette in every 3D room.
 */
export const CHAR3D_EXTENDED_MATERIAL_REGIONS = ['innerMuzzle', 'socks', 'innerEar', 'tailTip'] as const;
export type Char3dExtendedMaterialRegion = (typeof CHAR3D_EXTENDED_MATERIAL_REGIONS)[number];

/** Every admissible `materials` key: the seven canonical + the four extended. */
export const CHAR3D_ALL_MATERIAL_REGIONS: readonly string[] = [
  ...CHAR3D_MATERIAL_REGIONS, ...CHAR3D_EXTENDED_MATERIAL_REGIONS,
];

/** LIMIT: longest character name carried (matches the BFF column cap). */
export const MAX_CHAR3D_NAME_LENGTH = 120;
/** LIMIT: serialized Char3DConfig JSON byte cap — the BFF rejects larger (§3). */
export const MAX_CHAR3D_JSON_BYTES = 16_384;

// ── The server's bounded-value literals (Char3DConfigValidator) ──────────────
// Copied CHARACTER-FOR-CHARACTER from the validator whose behaviour this file
// claims to mirror. This mirror used to accept ANY string in these slots (a
// bare `slice()` truncation), which is strictly more permissive than the
// service that produced the data — so a config this client happily rendered
// could never have come from the BFF, and a config the BFF would 400 sailed
// straight into the Godot scene as a part id / variant token.

/** SAFE_HEX twin: the only colour syntax accepted anywhere (#rgb..#rrggbbaa). */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
/** Bounded part/slot id — `Char3DConfigValidator.PART_ID_PATTERN`. */
export const PART_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Bounded short descriptor (head.variant/earStyle/hornStyle) — `SHORT_STR_PATTERN`. */
export const SHORT_STR_PATTERN = /^[A-Za-z0-9 _-]{1,40}$/;
/** Bounded lower-slug key (source slot / palette region names) — `KEY_PATTERN`. */
export const KEY_PATTERN = /^[a-z0-9_-]{1,40}$/;

/**
 * Code points no display name may carry — the twin of the server's
 * `isForbiddenNameCodePoint`: C0/C1 controls (Cc), every Unicode FORMAT code
 * point (Cf — U+202E RIGHT-TO-LEFT OVERRIDE, the U+2066..U+2069 isolates,
 * U+200B..U+200F, U+FEFF, the tag block, …) and the line/paragraph separators
 * (Zl/Zp).
 *
 * The attack this closes is specific to a SHARED room: a name is drawn on a
 * floating nametag next to everybody else's, so one member's U+202E visually
 * reverses a NEIGHBOUR'S handle, and there is no takedown path in a 3D scene.
 */
export const FORBIDDEN_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A display name safe to draw in a shared scene: forbidden code points removed,
 * then capped. STRIPS rather than rejects — the server rejects at write time, so
 * by the time a name reaches a room the only way to carry one of these is an
 * event the homeserver accepted anyway (a hand-rolled client, a foreign
 * homeserver); dropping the whole avatar over a zero-width space would demote an
 * honest member to a silhouette, while dropping the code point removes the
 * spoof and keeps them visible. Non-strings normalize to ''.
 */
export function sanitizeDisplayName(raw: unknown, max: number = MAX_CHAR3D_NAME_LENGTH): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.replace(FORBIDDEN_NAME_CHARS, '').slice(0, max);
}

/** Optional echo of the VN character a config was mapped from (§2 `source`). */
export interface Char3dSource {
  packId: string;
  /** slot → chosen partId (or null for an empty slot) — VnCharacter.slots echo. */
  slots: Record<string, string | null>;
  /** tint region → hex colour — VnCharacter.palette echo. */
  palette: Record<string, string>;
  defaultExpression: Expression;
}

/** The §2 Char3DConfig v1 shape (all fields present after a successful parse). */
export interface Char3dConfig {
  schemaVersion: 1;
  name: string;
  source: Char3dSource | null;
  body: {
    archetype: HeadFamily;
    /** Slim..broad body build. */
    build: number; // 0..1
    /** Height multiplier around the 1.0 default. */
    height: number; // 0.5..1.5
  };
  head: {
    family: HeadFamily;
    variant: string;
    snoutLength: number; // 0..1
    earStyle: string | null;
    hornStyle: string | null;
  };
  parts: Record<Char3dPartSlot, string | null>;
  /** The seven canonical regions, plus any of the four EXTENDED coat blocks the
   *  author actually set (absent = the renderer derives it — never defaulted). */
  materials: Record<Char3dMaterialRegion, string> & Partial<Record<Char3dExtendedMaterialRegion, string>>;
  style: Char3dStyle;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A finite number clamped into lo..hi, else the fallback. */
const numberIn = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

/**
 * The server's `optionalShortStr` twin for head.variant / earStyle / hornStyle:
 * absent, null OR BLANK ⇒ `null` (unset — every shipped client encodes "no
 * variant" as `''`); a non-blank value MUST match {@link SHORT_STR_PATTERN}.
 * `undefined` = REJECT (the server 400s), which the caller turns into a null
 * config — kept distinct from the `null` that means "legitimately unset".
 */
const shortStrOrNull = (v: unknown): string | null | undefined => {
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v !== 'string') {
    return undefined;
  }
  const s = v.trim();
  if (s === '') {
    return null;
  }
  return SHORT_STR_PATTERN.test(s) ? s : undefined;
};

/** True when `raw` is a plain object whose keys are all in `allowed` (§3:
 *  unknown keys are REJECTED, not ignored — a config smuggling extra payload
 *  fails validation outright). */
const objectWithOnly = (raw: unknown, allowed: readonly string[]): raw is Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  return Object.keys(raw as Record<string, unknown>).every((k) => (allowed as readonly string[]).includes(k));
};

/**
 * The ONE canonical palette for a region a definition never set (a stored
 * definition legitimately carries `null` for an unset region, and every surface
 * resolves that against its own copy of this table).
 *
 * AUTHORITY: `Char3DConfigValidator.DEFAULT_MATERIALS` in
 * hugmesh-character-forge-bff-api. There are FIVE copies of this table across
 * the fleet (the validator, the Angular editor, the Godot maker, this XR-room
 * mirror and the games room's assembler) and they must be BYTE-IDENTICAL: this
 * copy used to be a neutral grey ramp of its own invention, so the same
 * character rendered brown in the editor and grey in the 3D room. Do not
 * "improve" these values here — change the validator, then all five.
 */
export const DEFAULT_MATERIALS: Record<Char3dMaterialRegion, string> = {
  fur: '#8b5a2b',
  accent: '#d2b48c',
  detail: '#4a3728',
  line: '#2f2f2f',
  iris: '#00bcd4',
  skin: '#ffdbac',
  hair: '#563d2d',
};

/** Caps on the optional `source` echo maps (the studio caps slots/pack ≤24). */
const MAX_SOURCE_SLOTS = 24;
const MAX_SOURCE_PALETTE = 16;

/**
 * Parse the optional §2 `source` echo. Malformed ⇒ null (the echo is advisory
 * — dropping it never invalidates the config itself).
 *
 * DELIBERATE DEVIATION from the validator, kept from the original mirror: the
 * server 400s the WHOLE definition on a bad slot key / part id / palette entry,
 * this drops the offending ENTRY (as it always did for a non-hex palette
 * colour). The bound is what matters — the echo is advisory data forwarded into
 * the scene, and an unbounded key there is exactly the payload-smuggling the
 * unknown-key rejection exists to stop — so the server's
 * {@link KEY_PATTERN}/{@link PART_ID_PATTERN} literals now gate it either way.
 */
function parseSource(raw: unknown): Char3dSource | null {
  if (!objectWithOnly(raw, ['packId', 'slots', 'palette', 'defaultExpression'])) {
    return null;
  }
  const rawPackId = raw['packId'];
  const packId = typeof rawPackId === 'string' && PART_ID_PATTERN.test(rawPackId) ? rawPackId : null;
  if (!packId) {
    return null;
  }
  const slots: Record<string, string | null> = {};
  if (raw['slots'] && typeof raw['slots'] === 'object' && !Array.isArray(raw['slots'])) {
    for (const [slot, part] of Object.entries(raw['slots'] as Record<string, unknown>)) {
      if (Object.keys(slots).length >= MAX_SOURCE_SLOTS) {
        break;
      }
      if (!KEY_PATTERN.test(slot)) {
        continue;
      }
      if (part === null) {
        slots[slot] = null;
      } else if (typeof part === 'string' && PART_ID_PATTERN.test(part)) {
        slots[slot] = part;
      }
    }
  }
  const palette: Record<string, string> = {};
  if (raw['palette'] && typeof raw['palette'] === 'object' && !Array.isArray(raw['palette'])) {
    for (const [region, hex] of Object.entries(raw['palette'] as Record<string, unknown>)) {
      if (Object.keys(palette).length >= MAX_SOURCE_PALETTE) {
        break;
      }
      if (KEY_PATTERN.test(region) && typeof hex === 'string' && HEX_COLOR_PATTERN.test(hex)) {
        palette[region] = hex;
      }
    }
  }
  return {
    packId,
    slots,
    palette,
    defaultExpression: isExpression(raw['defaultExpression']) ? raw['defaultExpression'] : DEFAULT_EXPRESSION,
  };
}

/**
 * Parse a raw Char3DConfig into the validated §2 shape — the client-side MIRROR
 * of the BFF's server-side validation (§3). Tolerant where tolerance is safe,
 * REJECTING (null) where the BFF rejects:
 *
 *   - not an object / unknown TOP-LEVEL keys / wrong schemaVersion ⇒ null
 *     (unknown keys are how a hostile config smuggles payload — reject, don't
 *     ignore, exactly as the server does);
 *   - `head.family` / `body.archetype` / `style` outside their enums ⇒ null
 *     (an unknown family cannot be built — there is no safe fallback mesh);
 *   - a part id outside {@link PART_ID_PATTERN} or a non-blank variant/earStyle/
 *     hornStyle outside {@link SHORT_STR_PATTERN} ⇒ null (the server 400s them);
 *   - serialized JSON over {@link MAX_CHAR3D_JSON_BYTES} ⇒ null;
 *   - numerics clamped into range, hexes regex-checked (an invalid CANONICAL
 *     region falls back to {@link DEFAULT_MATERIALS}, an invalid EXTENDED one is
 *     omitted so the renderer derives it), display names stripped of forbidden
 *     code points and capped.
 *
 * Pure + exported so the untrusted-input handling is unit-testable in
 * isolation (mesh-bridge/vn-scene parse precedent).
 */
export function parseChar3dConfig(raw: unknown): Char3dConfig | null {
  if (!objectWithOnly(raw, ['schemaVersion', 'name', 'source', 'body', 'head', 'parts', 'materials', 'style'])) {
    return null;
  }
  if (raw['schemaVersion'] !== 1) {
    return null;
  }
  // Byte-cap BEFORE detailed parsing: the serialized form is what room state /
  // the BFF carries, so an oversized config is rejected outright (§3 16KB).
  try {
    if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_CHAR3D_JSON_BYTES) {
      return null;
    }
  } catch {
    return null; // circular / unserializable — never valid config
  }

  const style = raw['style'];
  if (typeof style !== 'string' || !(CHAR3D_STYLES as readonly string[]).includes(style)) {
    return null;
  }

  const rawBody = raw['body'];
  if (!objectWithOnly(rawBody, ['archetype', 'build', 'height'])) {
    return null;
  }
  const archetype = rawBody['archetype'];
  if (typeof archetype !== 'string' || !(HEAD_FAMILIES as readonly string[]).includes(archetype)) {
    return null;
  }

  const rawHead = raw['head'];
  if (!objectWithOnly(rawHead, ['family', 'variant', 'snoutLength', 'earStyle', 'hornStyle'])) {
    return null;
  }
  const family = rawHead['family'];
  if (typeof family !== 'string' || !(HEAD_FAMILIES as readonly string[]).includes(family)) {
    return null;
  }

  // head.variant / earStyle / hornStyle: the server's bounded SHORT_STR — a
  // non-blank value outside the pattern 400s there, so it is rejected here too.
  const variant = shortStrOrNull(rawHead['variant']);
  const earStyle = shortStrOrNull(rawHead['earStyle']);
  const hornStyle = shortStrOrNull(rawHead['hornStyle']);
  if (variant === undefined || earStyle === undefined || hornStyle === undefined) {
    return null;
  }

  const parts = {} as Record<Char3dPartSlot, string | null>;
  const rawParts = raw['parts'];
  if (!objectWithOnly(rawParts, CHAR3D_PART_SLOTS)) {
    return null;
  }
  for (const slot of CHAR3D_PART_SLOTS) {
    const part = rawParts[slot];
    if (part === undefined || part === null) {
      parts[slot] = null;
      continue;
    }
    // The server rejects (400) a part id outside PART_ID_PATTERN rather than
    // truncating it — a 200-character "part id" is a payload, not a long name,
    // and truncating it invents an id that names a DIFFERENT asset.
    if (typeof part !== 'string' || !PART_ID_PATTERN.test(part)) {
      return null;
    }
    parts[slot] = part;
  }

  const materials = {} as Record<Char3dMaterialRegion, string> & Partial<Record<Char3dExtendedMaterialRegion, string>>;
  const rawMaterials = raw['materials'];
  // The four EXTENDED coat blocks are ADMISSIBLE keys — rejecting them here is
  // what hard-rejected every kemono character in the room.
  if (!objectWithOnly(rawMaterials, CHAR3D_ALL_MATERIAL_REGIONS)) {
    return null;
  }
  for (const region of CHAR3D_MATERIAL_REGIONS) {
    const hex = rawMaterials[region];
    materials[region] =
      typeof hex === 'string' && HEX_COLOR_PATTERN.test(hex) ? hex : DEFAULT_MATERIALS[region];
  }
  for (const region of CHAR3D_EXTENDED_MATERIAL_REGIONS) {
    const hex = rawMaterials[region];
    // Absent / null / unusable ⇒ OMITTED, never defaulted: absence is the wire
    // encoding for "let the renderer derive it" (§EXTENDED_MATERIAL_KEYS), and
    // a default here would freeze one derivation into every character.
    if (typeof hex === 'string' && HEX_COLOR_PATTERN.test(hex)) {
      materials[region] = hex;
    }
  }

  return {
    schemaVersion: 1,
    name: sanitizeDisplayName(raw['name']),
    source: parseSource(raw['source']),
    body: {
      archetype: archetype as HeadFamily,
      build: numberIn(rawBody['build'], 0, 1, 0.5),
      height: numberIn(rawBody['height'], 0.5, 1.5, 1),
    },
    head: {
      family: family as HeadFamily,
      variant: variant ?? '',
      snoutLength: numberIn(rawHead['snoutLength'], 0, 1, 0.5),
      earStyle,
      hornStyle,
    },
    parts,
    materials,
    style: style as Char3dStyle,
  };
}

// ───────────────────────── Seeded guest randomizer ─────────────────────────

/** Curated guest palette (a slice of the studio's 27-colour seed set) — every
 *  entry passes {@link HEX_COLOR_PATTERN} so a random guest always validates. */
const GUEST_PALETTE = [
  '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9',
  '#8e44ad', '#e84393', '#6d4c41', '#95a5a6', '#2c3e50', '#ecf0f1',
] as const;

/** mulberry32 — tiny deterministic PRNG so a guest seed always yields the SAME
 *  character (shareable, testable), no crypto claims. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fold an arbitrary seed string into a 32-bit PRNG seed (FNV-1a). */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Build a DETERMINISTIC random guest Char3DConfig from a seed string — the
 * join menu's "seeded guest" character source (no BFF character, no sticker
 * pack needed). The same seed always yields the same character, and the result
 * ALWAYS round-trips {@link parseChar3dConfig} (guest configs go out as our
 * own avatar state event, so they must satisfy the same validation every
 * receiver mirrors).
 */
export function randomChar3dConfig(seed: string): Char3dConfig {
  const rnd = mulberry32(hashSeed(seed));
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
  const family = pick(HEAD_FAMILIES);
  const config: Char3dConfig = {
    schemaVersion: 1,
    // The seed is free user text from the join menu, so the guest name goes
    // through the SAME display-name gate every received name does — otherwise
    // our own published avatar would carry what we reject from everyone else.
    name: sanitizeDisplayName(`Guest ${seed}`),
    source: null,
    body: {
      archetype: family,
      build: Math.round(rnd() * 100) / 100,
      height: Math.round((0.5 + rnd()) * 100) / 100,
    },
    head: {
      family,
      variant: '',
      snoutLength: Math.round(rnd() * 100) / 100,
      earStyle: null,
      hornStyle: null,
    },
    parts: {
      tail: null, wings: null, ears: null, feature: null,
      accessory: null, markings: null, hair: null,
    },
    // Randomized coat, but line/skin come from the ONE canonical palette rather
    // than a second set of hardcoded hexes (the divergence this pass closes).
    materials: {
      fur: pick(GUEST_PALETTE),
      accent: pick(GUEST_PALETTE),
      detail: pick(GUEST_PALETTE),
      line: DEFAULT_MATERIALS.line,
      iris: pick(GUEST_PALETTE),
      skin: DEFAULT_MATERIALS.skin,
      hair: pick(GUEST_PALETTE),
    },
    style: pick(CHAR3D_STYLES),
  };
  return config;
}
