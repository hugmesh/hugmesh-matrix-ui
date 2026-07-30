/**
 * TypeScript model for the character-studio asset library — v2 (SVG-driven).
 * Parts are inline SVG; each recolorable region is a `<path>`/`<g>` carrying a
 * stable CSS class ({@link TintRegion.svgClass}) recolored by a CSS custom
 * property — replacing the v1 PNG + R-channel mask. Validated by
 * `assets/vn/schema/vn-part-manifest-v2.schema.json` (`npm run validate:assets`).
 *
 * VENDORED (Path A, B2) from hugmesh-character-studio-ui
 * `src/app/character-studio/models/vn-manifest.ts` — native-federation forbids a
 * shared cross-remote runtime import, so the matrix remote ships its OWN copy of
 * the SVG-compositor model set. Byte-faithful to the studio source; only this
 * provenance note is added.
 */

/** Normalised 0..1 anchor relative to the pack canvas. */
export interface Anchor {
  x: number;
  y: number;
}

/** Pixel offset from a slot's anchor at compose time. */
export interface Offset {
  x: number;
  y: number;
}

/**
 * A recolourable region of a part. {@link svgClass} is the CSS class on the
 * region's element(s) inside the part SVG; the compositor sets a CSS custom
 * property `--<svgClass>` from `palette[region]`, so `.region-fur{fill:var(--region-fur)}`
 * recolors true — and multiple regions recolor independently (the v1 single-region
 * limitation is gone).
 */
export interface TintRegion {
  region: string;
  svgClass: string;
  defaultPalette: string;
}

/** Part category — drives picker grouping + the head↔feature compatibility model. */
export type PartCategory =
  | 'base'
  | 'head'
  | 'eyes'
  | 'hair'
  | 'clothing'
  | 'feature'
  | 'accessory';

/** A single selectable part within a slot (one body, one pair of eyes, ...). */
export interface PartDef {
  id: string;
  displayName: string;
  /** Path to the part SVG, relative to the pack root. */
  file: string;
  tintRegions?: TintRegion[];
  anchorOverride?: Anchor | null;
  offset?: Offset;
  // --- taxonomy / head↔feature compatibility (v2) ---
  category?: PartCategory;
  /** For base/head parts: the head archetype (canid, felid, avian, synth, ...). */
  headArchetype?: string;
  /** For feature parts: head archetypes this feature may attach to ('*' = any). */
  compatibleHeads?: string[];
  /** partIds/slot constraints that must hold for this part to apply. */
  requires?: string[];
  /** Provenance — pack-authored vs user-drawn (audited; user SVG is sanitized). */
  origin?: 'pack' | 'user-drawn';
}

/** One z-ordered layer slot (body, head, eyes, ...) and its candidate parts. */
export interface SlotDef {
  slot: string;
  /** Lower renders behind. */
  zOrder: number;
  required: boolean;
  anchor: Anchor;
  parts: PartDef[];
}

/**
 * A loaded expression preset (the studio's parsed `expressions/<id>.json`). Names
 * the partId to swap into each expression slot (eyes/brows/mouth) at compose —
 * PREVIEW-ONLY, so the base character's chosen parts are never mutated. Palette/
 * tint is preserved because the override parts carry the same tint regions.
 *
 * Matrix-ui carries the preset INLINE on the {@link PartManifest} (vs the studio's
 * `ExpressionRef` + lazy `expressions/<id>.json` fetch): the live-render panel
 * already holds the whole drawable manifest in memory, so an extra per-expression
 * round trip would only add a fetch the `<img>` render does not need. The studio's
 * preset SHAPE ({@link slots} = expression-slot → partId override) is mirrored
 * exactly, so the same compositor consumes both. The {@link id} is a canonical
 * VN expression label (`neutral`/`happy`/…), letting the panel map the live
 * expression straight to its slot overrides.
 */
export interface ExpressionPreset {
  /** Canonical VN expression label (also the MSC2545 sticker shortcode). */
  id: string;
  displayName?: string;
  /** expression slot → partId override (must exist as a part in that slot). */
  slots: Record<string, string>;
}

/** A coherent art set — the parsed `pack.json`. */
export interface PartManifest {
  packId: string;
  version: string;
  displayName: string;
  licenseSpdx?: string;
  canvas: { width: number; height: number };
  slots: SlotDef[];
  /**
   * OPTIONAL — slots an expression may override (e.g. `["eyes","brows","mouth"]`).
   * Mirrors the studio pack model; an expression swap is scoped to these slots.
   * Packs without expressions omit this (the drawable renders unchanged).
   */
  expressionSlots?: string[];
  /**
   * OPTIONAL — the pack's expression presets (slot→partId overrides per canonical
   * expression label). The compositor reads the active expression's {@link
   * ExpressionPreset.slots} to swap the drawable's eyes/brows/mouth per expression.
   * Packs without expressions omit this (the drawable renders the neutral base).
   */
  expressions?: ExpressionPreset[];
}

/** One entry in the top-level `manifest.json` pack index. */
export interface PackIndexEntry {
  packId: string;
  /** Path to the pack's `pack.json`, relative to the `assets/vn/` root. */
  path: string;
  enabled: boolean;
}

/** The parsed top-level `assets/vn/manifest.json`. */
export interface PackIndex {
  schemaVersion: number;
  packs: PackIndexEntry[];
}
