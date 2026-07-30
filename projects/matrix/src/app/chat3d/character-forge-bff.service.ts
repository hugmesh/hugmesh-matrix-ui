import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Char3dConfig, parseChar3dConfig } from './char3d-config';

/** Override hook mirroring the other BFF datastore services (__HUG_BFF_URL__ —
 *  the SAME hook user-bff/admin-bff/mod-bff/matrix.service read; no `__SNAP_*`
 *  hook is produced anywhere in this fleet, so reading one would pin this
 *  service to same-origin in every split-origin deployment);
 *  same-origin by default (the fe-gateway proxies /bff/character-forge/** to
 *  the character-forge BFF). */
const BFF_BASE: string = (globalThis as any).__HUG_BFF_URL__ ?? '';

/** The caller's ACTIVE character-forge character, ready for the 3D room. */
export interface ActiveForgeCharacter {
  /** Display name of the character. */
  name: string;
  /** The validated Char3DConfig definition. */
  definition: Char3dConfig;
}

/**
 * THIN client for the character-forge BFF's single join-menu need: "what is my
 * active 3D character?". The full CRUD surface (list/create/save/map) belongs
 * to the character-forge remote — the matrix remote only reads the active
 * character to offer it as the 3D-room join source.
 *
 * Endpoint (hugmesh-character-forge-bff-api, ROLE_USER floor, owner ALWAYS
 * the JWT subject):
 *   GET /bff/character-forge/characters/active → {name, definition} | 404
 *
 * Transport is Angular {@link HttpClient} to the same-origin
 * `/bff/character-forge/**` path, authenticated by the HttpOnly `bff_` session
 * cookie (`withCredentials: true` — the matrix remote has no global auth
 * interceptor, the UserBffService convention). FAIL-SOFT: a 404 (no active
 * character), a denied call, a dark/absent BFF (the character-forge slug is an
 * OPTIONAL service), or a definition failing the Char3DConfig mirror
 * validation ALL resolve to `null` — callers grey the option with
 * WHY-helptext, never a throw.
 */
@Injectable({ providedIn: 'root' })
export class CharacterForgeBffService {
  private readonly http = inject(HttpClient);
  private readonly base = `${BFF_BASE}/bff/character-forge`;

  /** My active character, or null (none / BFF dark / invalid definition). */
  async getActiveCharacter(): Promise<ActiveForgeCharacter | null> {
    let raw: unknown;
    try {
      raw = await firstValueFrom(
        this.http.get<unknown>(`${this.base}/characters/active`, { withCredentials: true }),
      );
    } catch {
      return null; // 404 = no active character; anything else = BFF dark/denied
    }
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const obj = raw as Record<string, unknown>;
    // The definition crosses into the Godot scene — run the SAME mirror
    // validation every other config source passes through.
    const definition = parseChar3dConfig(obj['definition']);
    if (!definition) {
      return null;
    }
    const name = typeof obj['name'] === 'string' && obj['name'].length > 0 ? obj['name'] : definition.name;
    return { name, definition };
  }
}
