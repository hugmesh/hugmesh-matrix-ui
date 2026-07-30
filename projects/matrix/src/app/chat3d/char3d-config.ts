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
 *   - PUBLISHED by us as the `systems.hugmesh.chat3d.avatar` room state
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

/** LIMIT: longest character name carried (matches the BFF column cap). */
export const MAX_CHAR3D_NAME_LENGTH = 120;
/** LIMIT: longest free-string variant/style token (head.variant/earStyle/hornStyle). */
export const MAX_CHAR3D_TOKEN_LENGTH = 40;
/** LIMIT: longest part/pack id carried (the studio caps part ids at 64). */
export const MAX_CHAR3D_ID_LENGTH = 64;
/** LIMIT: serialized Char3DConfig JSON byte cap — the BFF rejects larger (§3). */
export const MAX_CHAR3D_JSON_BYTES = 16_384;
/** SAFE_HEX twin: the only colour syntax accepted anywhere (#rgb..#rrggbbaa). */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;

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
  materials: Record<Char3dMaterialRegion, string>;
  style: Char3dStyle;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A finite number clamped into lo..hi, else the fallback. */
const numberIn = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

/** A non-empty string truncated at `max`, else null. */
const tokenOrNull = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;

/** True when `raw` is a plain object whose keys are all in `allowed` (§3:
 *  unknown keys are REJECTED, not ignored — a config smuggling extra payload
 *  fails validation outright). */
const objectWithOnly = (raw: unknown, allowed: readonly string[]): raw is Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  return Object.keys(raw as Record<string, unknown>).every((k) => (allowed as readonly string[]).includes(k));
};

/** Default material hexes when a region is absent/invalid (neutral grey ramp). */
const DEFAULT_MATERIALS: Record<Char3dMaterialRegion, string> = {
  fur: '#8a8a8a',
  accent: '#c2c2c2',
  detail: '#5a5a5a',
  line: '#2b2b2b',
  iris: '#3a6ea5',
  skin: '#d9b8a2',
  hair: '#4a3b2f',
};

/** Caps on the optional `source` echo maps (the studio caps slots/pack ≤24). */
const MAX_SOURCE_SLOTS = 24;
const MAX_SOURCE_PALETTE = 16;

/** Parse the optional §2 `source` echo. Malformed ⇒ null (the echo is advisory
 *  — dropping it never invalidates the config itself). */
function parseSource(raw: unknown): Char3dSource | null {
  if (!objectWithOnly(raw, ['packId', 'slots', 'palette', 'defaultExpression'])) {
    return null;
  }
  const packId = tokenOrNull(raw['packId'], MAX_CHAR3D_ID_LENGTH);
  if (!packId) {
    return null;
  }
  const slots: Record<string, string | null> = {};
  if (raw['slots'] && typeof raw['slots'] === 'object' && !Array.isArray(raw['slots'])) {
    for (const [slot, part] of Object.entries(raw['slots'] as Record<string, unknown>)) {
      if (Object.keys(slots).length >= MAX_SOURCE_SLOTS) {
        break;
      }
      if (part === null) {
        slots[slot.slice(0, MAX_CHAR3D_ID_LENGTH)] = null;
      } else if (typeof part === 'string' && part.length > 0) {
        slots[slot.slice(0, MAX_CHAR3D_ID_LENGTH)] = part.slice(0, MAX_CHAR3D_ID_LENGTH);
      }
    }
  }
  const palette: Record<string, string> = {};
  if (raw['palette'] && typeof raw['palette'] === 'object' && !Array.isArray(raw['palette'])) {
    for (const [region, hex] of Object.entries(raw['palette'] as Record<string, unknown>)) {
      if (Object.keys(palette).length >= MAX_SOURCE_PALETTE) {
        break;
      }
      if (typeof hex === 'string' && HEX_COLOR_PATTERN.test(hex)) {
        palette[region.slice(0, MAX_CHAR3D_ID_LENGTH)] = hex;
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
 *   - serialized JSON over {@link MAX_CHAR3D_JSON_BYTES} ⇒ null;
 *   - numerics clamped into range, hexes regex-checked (invalid region falls
 *     back to a neutral default), strings truncated, part ids tokenized.
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

  const parts = {} as Record<Char3dPartSlot, string | null>;
  const rawParts = raw['parts'];
  if (!objectWithOnly(rawParts, CHAR3D_PART_SLOTS)) {
    return null;
  }
  for (const slot of CHAR3D_PART_SLOTS) {
    parts[slot] = tokenOrNull(rawParts[slot], MAX_CHAR3D_ID_LENGTH);
  }

  const materials = {} as Record<Char3dMaterialRegion, string>;
  const rawMaterials = raw['materials'];
  if (!objectWithOnly(rawMaterials, CHAR3D_MATERIAL_REGIONS)) {
    return null;
  }
  for (const region of CHAR3D_MATERIAL_REGIONS) {
    const hex = rawMaterials[region];
    materials[region] =
      typeof hex === 'string' && HEX_COLOR_PATTERN.test(hex) ? hex : DEFAULT_MATERIALS[region];
  }

  return {
    schemaVersion: 1,
    name: typeof raw['name'] === 'string' ? raw['name'].slice(0, MAX_CHAR3D_NAME_LENGTH) : '',
    source: parseSource(raw['source']),
    body: {
      archetype: archetype as HeadFamily,
      build: numberIn(rawBody['build'], 0, 1, 0.5),
      height: numberIn(rawBody['height'], 0.5, 1.5, 1),
    },
    head: {
      family: family as HeadFamily,
      variant: tokenOrNull(rawHead['variant'], MAX_CHAR3D_TOKEN_LENGTH) ?? '',
      snoutLength: numberIn(rawHead['snoutLength'], 0, 1, 0.5),
      earStyle: tokenOrNull(rawHead['earStyle'], MAX_CHAR3D_TOKEN_LENGTH),
      hornStyle: tokenOrNull(rawHead['hornStyle'], MAX_CHAR3D_TOKEN_LENGTH),
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
    name: `Guest ${seed}`.slice(0, MAX_CHAR3D_NAME_LENGTH),
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
    materials: {
      fur: pick(GUEST_PALETTE),
      accent: pick(GUEST_PALETTE),
      detail: pick(GUEST_PALETTE),
      line: '#2b2b2b',
      iris: pick(GUEST_PALETTE),
      skin: '#d9b8a2',
      hair: pick(GUEST_PALETTE),
    },
    style: pick(CHAR3D_STYLES),
  };
  return config;
}
