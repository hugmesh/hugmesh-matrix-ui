import { Injectable, signal } from '@angular/core';
import { resolveAssetsBase } from '../assets-base';

/**
 * LIMIT MAX_MANIFEST_ENTRIES=64 (per list): most scenes/props parsed from the
 * manifest. The manifest is app-shipped (8 scenes / 10 props today), but the
 * picker renders one tile per entry, so a corrupted/oversized manifest must
 * not flood the UI. 64 leaves 6–8x growth headroom.
 */
const MAX_MANIFEST_ENTRIES = 64;

/** One scene background in the `assets/vn/scenes/scenes.json` manifest. */
export interface VnSceneDef {
  /** Stable id (e.g. `vn_scene_cafe`) — the value shared room state carries. */
  id: string;
  /** Human-readable name for pickers ("Café"). */
  displayName: string;
  /** SVG filename relative to the scenes assets base. */
  file: string;
  /** Free-form filter tags (`indoor`, `night`, …). */
  tags: string[];
}

/** One placeable prop in the manifest. */
export interface VnPropDef {
  /** Stable id (e.g. `vn_prop_lamp`) — the value shared room state carries. */
  id: string;
  /** Human-readable name for the prop palette ("Floor Lamp"). */
  displayName: string;
  /** SVG filename relative to the scenes assets base. */
  file: string;
  /** Sensible starting scale when the prop is first placed (1 = 25% stage width). */
  defaultScale: number;
}

/** The parsed top-level `assets/vn/scenes/scenes.json`. */
export interface VnScenesManifest {
  schemaVersion: number;
  scenes: VnSceneDef[];
  props: VnPropDef[];
}

/**
 * Loads + caches the VN scene/prop manifest (`assets/vn/scenes/scenes.json`)
 * and resolves scene/prop asset URLs. Same MODULE-ANCHORED assets-base
 * convention as {@link SvgRigService} (`assets/vn/`, see {@link
 * resolveAssetsBase}): the SVGs are static, pack-authored flat-vector art served
 * with the app — NOT user content — so putting the resolved URL straight into an
 * `<img src>` is safe (no mxc, no auth, no sanitize pass needed).
 *
 * FAIL-SOFT by construction: a fetch/parse error resolves to EMPTY scene/prop
 * lists (and unknown ids resolve to `null` URLs) so a missing manifest renders
 * a plain stage instead of crashing; the failed load is NOT cached, so a later
 * call retries.
 */
@Injectable({ providedIn: 'root' })
export class SceneService {
  /** ABSOLUTE assets base — same convention as SvgRigService's `assets/vn/`,
   *  anchored on this module's chunk URL (see {@link resolveAssetsBase}): a bare
   *  `'assets/vn/scenes/'` resolves against the SHELL document under federation
   *  and 404s at the shell root. */
  private readonly assetsBase = resolveAssetsBase('assets/vn/scenes/');

  /** In-flight/settled manifest load (cleared on failure so a retry can run). */
  private loadPromise: Promise<void> | null = null;

  private readonly _scenes = signal<VnSceneDef[]>([]);
  private readonly _props = signal<VnPropDef[]>([]);
  private readonly _loaded = signal(false);

  /** Available scene backgrounds (empty until {@link load} resolves). */
  readonly scenes = this._scenes.asReadonly();
  /** Available props (empty until {@link load} resolves). */
  readonly props = this._props.asReadonly();
  /** True once a manifest load SUCCEEDED (stays false on fail-soft empty). */
  readonly loaded = this._loaded.asReadonly();

  /**
   * Load + cache the manifest. Idempotent: concurrent/subsequent calls share
   * one fetch; only a FAILED load is retried on the next call. Never throws.
   */
  load(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = this.fetchManifest()
      .then((manifest) => {
        this._scenes.set(manifest.scenes);
        this._props.set(manifest.props);
        this._loaded.set(true);
      })
      .catch(() => {
        // Fail-soft: empty lists, and clear the cached promise so a later call
        // can retry (e.g. a transient network blip on first paint).
        this._scenes.set([]);
        this._props.set([]);
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  /** The scene definition for `id`, or null when unknown / not yet loaded. */
  sceneById(id: string | null | undefined): VnSceneDef | null {
    if (!id) {
      return null;
    }
    return this._scenes().find((s) => s.id === id) ?? null;
  }

  /** The prop definition for `id`, or null when unknown / not yet loaded. */
  propById(id: string | null | undefined): VnPropDef | null {
    if (!id) {
      return null;
    }
    return this._props().find((p) => p.id === id) ?? null;
  }

  /**
   * Resolve a scene id to its relative SVG URL (for an `<img src>`), or null
   * when the id is unknown. Reads the {@link scenes} signal, so a `computed()`
   * caller re-resolves once the manifest lands.
   */
  sceneUrl(id: string | null | undefined): string | null {
    const def = this.sceneById(id);
    return def ? `${this.assetsBase}${def.file}` : null;
  }

  /** Resolve a prop id to its relative SVG URL, or null when unknown. */
  propUrl(id: string | null | undefined): string | null {
    const def = this.propById(id);
    return def ? `${this.assetsBase}${def.file}` : null;
  }

  /** Fetch + strictly parse the manifest, dropping malformed rows. */
  private async fetchManifest(): Promise<VnScenesManifest> {
    const r = await fetch(`${this.assetsBase}scenes.json`, { cache: 'force-cache' });
    if (!r.ok) {
      throw new Error(`scenes manifest fetch failed: ${r.status}`);
    }
    const raw: unknown = await r.json();
    return this.parse(raw);
  }

  /** Tolerant manifest parse: malformed scene/prop rows are dropped, never thrown on. */
  private parse(raw: unknown): VnScenesManifest {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const scenes: VnSceneDef[] = [];
    for (const row of Array.isArray(obj['scenes']) ? (obj['scenes'] as unknown[]) : []) {
      if (scenes.length >= MAX_MANIFEST_ENTRIES) {
        break;
      }
      const s = row as Record<string, unknown>;
      if (typeof s?.['id'] !== 'string' || typeof s?.['file'] !== 'string') {
        continue;
      }
      scenes.push({
        id: s['id'],
        displayName: typeof s['displayName'] === 'string' ? s['displayName'] : s['id'],
        file: s['file'],
        tags: Array.isArray(s['tags']) ? (s['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : [],
      });
    }
    const props: VnPropDef[] = [];
    for (const row of Array.isArray(obj['props']) ? (obj['props'] as unknown[]) : []) {
      if (props.length >= MAX_MANIFEST_ENTRIES) {
        break;
      }
      const p = row as Record<string, unknown>;
      if (typeof p?.['id'] !== 'string' || typeof p?.['file'] !== 'string') {
        continue;
      }
      const scale = p['defaultScale'];
      props.push({
        id: p['id'],
        displayName: typeof p['displayName'] === 'string' ? p['displayName'] : p['id'],
        file: p['file'],
        defaultScale: typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1,
      });
    }
    return {
      schemaVersion: typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1,
      scenes,
      props,
    };
  }
}
