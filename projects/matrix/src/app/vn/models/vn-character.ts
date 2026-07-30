import { PartManifest, TintRegion } from './vn-manifest';

/**
 * VENDORED (Path A, B2) from hugmesh-character-studio-ui
 * `src/app/character-studio/models/vn-character.ts` — native-federation forbids a
 * shared cross-remote runtime import, so the matrix remote ships its OWN copy.
 * Byte-faithful to the studio source; only this provenance note is added.
 *
 * A user-drawn part overriding a slot (B0 drawable, v2 §2). `svgInline` is the
 * (client-sanitized) SVG markup — NOT a pack file. On persist it is re-sanitized
 * server-side and stored; in-session it renders directly.
 */
export interface UserPart {
  svgInline: string;
  tintRegions: TintRegion[];
}

/**
 * The canonical, replayable description of a character (v2). Persisted as
 * `vn_character.definition` (user-bff) later; here it drives the SVG-DOM rig.
 */
export interface VnCharacter {
  schemaVersion: number;
  packId: string;
  name: string;
  /** slot → chosen partId (or null for an empty slot). */
  slots: Record<string, string | null>;
  /** tint region → hex colour. */
  palette: Record<string, string>;
  transform: { scale: number; offsetX: number; offsetY: number };
  defaultExpression: string;
  /** slot → user-drawn override (takes precedence over the pack part). */
  userParts?: Record<string, UserPart>;
}

/**
 * Build a sensible default character from a pack: the first part of every slot,
 * each tint region seeded with its part's `defaultPalette`.
 */
export function buildDefaultCharacter(pack: PartManifest): VnCharacter {
  const slots: Record<string, string | null> = {};
  const palette: Record<string, string> = {};
  for (const s of pack.slots) {
    const first = s.parts[0];
    slots[s.slot] = first ? first.id : null;
    for (const tr of first?.tintRegions ?? []) {
      if (!(tr.region in palette)) {
        palette[tr.region] = tr.defaultPalette;
      }
    }
  }
  return {
    schemaVersion: 1,
    packId: pack.packId,
    name: 'Untitled',
    slots,
    palette,
    transform: { scale: 1, offsetX: 0, offsetY: 0 },
    defaultExpression: 'neutral',
  };
}
