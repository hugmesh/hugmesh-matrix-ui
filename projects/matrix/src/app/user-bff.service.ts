import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import { map, tap } from 'rxjs/operators';

/** Override hook mirroring admin-ui's __HUG_BFF_URL__; same-origin by default
 *  (the fe-gateway proxies /bff/user/** to hugmesh-user-bff-api). */
const BFF_BASE: string = (globalThis as any).__HUG_BFF_URL__ ?? '';

/**
 * One self-block belonging to the caller — matched field-for-field to the
 * user-bff-api {@code UserBlock} record. {@code platform} is
 * {@code matrix|mastodon|internal}; {@code userId} is server-set (owner = JWT
 * subject) and never sent from the client.
 */
export interface UserBlock {
  id: string;
  userId?: string;
  target: string;
  platform: BlockPlatform;
  ts?: string;
}

export type BlockPlatform = 'matrix' | 'mastodon' | 'internal';

/** POST /bff/user/blocks acknowledgement ({ block, pushed, external }). */
export interface BlockAck {
  block: UserBlock;
  pushed: boolean;
  external: string;
}

/** POST /bff/user/recommend-instance-block acknowledgement. */
export interface RecommendAck {
  recommended: boolean;
  instance: string;
  federation: unknown;
}

// ── Mesh devices (Meshtastic LoRa radios claimed by the caller) ──

/** Who may see a mesh device's status: only the owner, their friends, or the
 *  members of the mesh-enabled rooms the radio participates in. */
export type MeshDeviceVisibility = 'private' | 'friends' | 'channels';
export const MESH_DEVICE_VISIBILITIES: readonly MeshDeviceVisibility[] = ['private', 'friends', 'channels'];

/** Whether `value` is one of the three visibility levels (untrusted-input guard). */
export function isMeshDeviceVisibility(value: unknown): value is MeshDeviceVisibility {
  return (MESH_DEVICE_VISIBILITIES as readonly unknown[]).includes(value);
}

/** LIMIT: longest device label accepted (matches the API's column cap). */
export const MAX_MESH_LABEL_LENGTH = 64;

/**
 * One Meshtastic radio claimed by the caller — matched to the user-bff-api
 * mesh-device record. {@code nodeId} is the canonical {@code "!"+8 lowercase
 * hex} form; the status fields ({@code lastSeenAt}/{@code batteryPct}/
 * {@code snr}/{@code hopsAway}/{@code viaDevice}) are RADIO-REPORTED telemetry
 * relayed by the bridge — best-effort, often absent, and never authenticated.
 * A {@code revoked} device stays listed (with the reason when the server gave
 * one) but no longer folds radio messages onto the owner's name.
 */
export interface MeshDevice {
  id: string;
  nodeId: string;
  label: string | null;
  createdAt: string;
  visibility: MeshDeviceVisibility;
  state: 'active' | 'revoked';
  revokeReason: string | null;
  lastSeenAt: string | null;
  batteryPct: number | null;
  snr: number | null;
  hopsAway: number | null;
  viaDevice: string | null;
}

/**
 * Normalize a user-typed Meshtastic node id to the canonical
 * {@code "!"+8 lowercase hex} form: an optional leading {@code !} is
 * stripped, surrounding whitespace trimmed, hex case folded. Anything that is
 * not EXACTLY 8 hex digits after that is rejected as {@code null} — never a
 * guess. Pure + exported so the claim form's input handling is unit-testable
 * in isolation.
 */
export function normalizeMeshNodeId(input: string): string | null {
  const trimmed = (input ?? '').trim();
  const bare = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]{8}$/.test(bare)) {
    return null;
  }
  return `!${bare.toLowerCase()}`;
}

/** LIMIT: longest revoke reason surfaced (guards a hostile/buggy row). */
const MAX_REVOKE_REASON_LENGTH = 200;
/** Battery cap: 0..100 are percentages; 101 is the API's "on external power" marker. */
const MAX_BATTERY_PCT = 101;
/** Bridge device ids are hostname-ish tokens, capped at 64 chars. */
const MESH_VIA_DEVICE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A non-blank string capped at {@code max} chars, else null (fail-soft). */
const stringOrNull = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;

/**
 * Parse one raw mesh-device row into a {@link MeshDevice}. Tolerant/fail-soft —
 * the rows carry radio-reported telemetry, so treat every field as untrusted:
 * a row without a usable id or canonical-izable node id is dropped (null);
 * an unknown visibility falls back to {@code private} (the least revealing);
 * any state other than {@code revoked} renders as {@code active};
 * {@code batteryPct} is clamped into 0..101 (101 = powered), {@code snr} and
 * {@code hopsAway} into sane ranges; malformed timestamps/labels become null.
 * Pure + exported so the untrusted-input handling is unit-testable.
 */
export function parseMeshDevice(raw: unknown): MeshDevice | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' && o['id'].length > 0 ? o['id'] : null;
  const nodeId = typeof o['nodeId'] === 'string' ? normalizeMeshNodeId(o['nodeId']) : null;
  if (!id || !nodeId) {
    return null;
  }
  const battery = o['batteryPct'];
  const snr = o['snr'];
  const hops = o['hopsAway'];
  const lastSeen = o['lastSeenAt'];
  const via = o['viaDevice'];
  return {
    id,
    nodeId,
    label: stringOrNull(o['label'], MAX_MESH_LABEL_LENGTH),
    createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'] : '',
    visibility: isMeshDeviceVisibility(o['visibility']) ? o['visibility'] : 'private',
    state: o['state'] === 'revoked' ? 'revoked' : 'active',
    revokeReason: stringOrNull(o['revokeReason'], MAX_REVOKE_REASON_LENGTH),
    lastSeenAt: typeof lastSeen === 'string' && Number.isFinite(Date.parse(lastSeen)) ? lastSeen : null,
    batteryPct: typeof battery === 'number' && Number.isFinite(battery)
      ? Math.round(clampNum(battery, 0, MAX_BATTERY_PCT))
      : null,
    snr: typeof snr === 'number' && Number.isFinite(snr) ? clampNum(snr, -100, 100) : null,
    hopsAway: typeof hops === 'number' && Number.isInteger(hops) ? clampNum(hops, 0, 64) : null,
    viaDevice: typeof via === 'string' && MESH_VIA_DEVICE_PATTERN.test(via) ? via : null,
  };
}

/**
 * USER-tier datastore service for the caller's OWN self-blocks + the
 * instance-block recommendation that starts the USER→MOD→ADMIN chain.
 *
 * RxJS {@link BehaviorSubject}-backed (the datastore mandate): the self-block
 * list is cached in {@link blocks$} so multiple views share one source of truth
 * and a create/delete refreshes the list without each view re-fetching. The HTTP
 * transport is Angular {@link HttpClient} to the same-origin {@code /bff/user/**}
 * paths, authenticated by the HttpOnly `bff_` session cookie (`withCredentials:
 * true` — the matrix remote provides no global auth interceptor, so we attach it
 * explicitly per call, the same convention MatrixService's hsFetch follows). The
 * gateway's BffCookieToBearerWebFilter mints the upstream bearer server-side; the
 * browser never holds or attaches a bearer of its own.
 *
 * Endpoints (hugmesh-user-bff-api BlockController @ /bff/user,
 * @PreAuthorize hasRole('USER') — owner forced to the JWT subject):
 *   GET    /bff/user/blocks                   → list()
 *   POST   /bff/user/blocks {target,platform} → block()
 *   DELETE /bff/user/blocks/{id}              → unblock()
 *   POST   /bff/user/recommend-instance-block → recommendInstanceBlock()
 *
 * Mesh-device endpoints (same controller conventions, owner = JWT subject):
 *   GET    /bff/user/mesh-devices                       → listMeshDevices()
 *   POST   /bff/user/mesh-devices {nodeId,label?}       → claimMeshDevice()
 *                                  (409 = node id already claimed by someone)
 *   PUT    /bff/user/mesh-devices/{id}/visibility {visibility}
 *                                  → setMeshDeviceVisibility()
 *                                  (400 invalid, 404 not mine, 409/422 revoked)
 *   DELETE /bff/user/mesh-devices/{id}                  → releaseMeshDevice()
 */
@Injectable({ providedIn: 'root' })
export class UserBffService {
  private readonly http = inject(HttpClient);
  private readonly base = `${BFF_BASE}/bff/user`;

  private readonly blocksSubject = new BehaviorSubject<UserBlock[]>([]);
  /** The caller's own self-blocks (latest list loaded). */
  readonly blocks$: Observable<UserBlock[]> = this.blocksSubject.asObservable();

  /** List my self-blocks and push onto {@link blocks$}. */
  list(): Observable<UserBlock[]> {
    return this.http
      .get<UserBlock[]>(`${this.base}/blocks`, { withCredentials: true })
      .pipe(tap((blocks) => this.blocksSubject.next(blocks ?? [])));
  }

  /** Create a self-block (internal-only or external matrix/mastodon push).
   *  Refreshes the cached list on success. */
  block(target: string, platform: BlockPlatform): Observable<BlockAck> {
    return this.http
      .post<BlockAck>(`${this.base}/blocks`, { target, platform }, { withCredentials: true })
      .pipe(tap(() => this.list().subscribe()));
  }

  /** Remove one of my self-blocks by id. Refreshes the cached list. */
  unblock(id: string): Observable<void> {
    return this.http
      .delete<void>(`${this.base}/blocks/${encodeURIComponent(id)}`, { withCredentials: true })
      .pipe(tap(() => this.list().subscribe()));
  }

  /** Recommend an instance block to the moderators (USER→MOD→ADMIN chain via
   *  federation-api). */
  recommendInstanceBlock(instance: string, reason: string): Observable<RecommendAck> {
    return this.http.post<RecommendAck>(
      `${this.base}/recommend-instance-block`,
      { instance, reason },
      { withCredentials: true },
    );
  }

  // ── Mesh devices ──

  private readonly meshDevicesSubject = new BehaviorSubject<MeshDevice[]>([]);
  /** The caller's own claimed mesh devices (latest list loaded). */
  readonly meshDevices$: Observable<MeshDevice[]> = this.meshDevicesSubject.asObservable();

  /** List my claimed mesh devices and push onto {@link meshDevices$}. Every row
   *  is run through the tolerant {@link parseMeshDevice} (radio-reported
   *  telemetry is untrusted) — malformed rows are dropped, never thrown on. */
  listMeshDevices(): Observable<MeshDevice[]> {
    return this.http
      .get<unknown[]>(`${this.base}/mesh-devices`, { withCredentials: true })
      .pipe(
        map((rows) => (Array.isArray(rows) ? rows : [])
          .map(parseMeshDevice)
          .filter((d): d is MeshDevice => d !== null)),
        tap((devices) => this.meshDevicesSubject.next(devices)),
      );
  }

  /** Claim a Meshtastic node id for my account ({@code label} optional). The
   *  API answers 409 when the node id is already claimed — callers surface
   *  that as "already registered". Refreshes the cached list on success. */
  claimMeshDevice(nodeId: string, label?: string): Observable<MeshDevice> {
    const body: { nodeId: string; label?: string } = label ? { nodeId, label } : { nodeId };
    return this.http
      .post<MeshDevice>(`${this.base}/mesh-devices`, body, { withCredentials: true })
      .pipe(tap(() => this.listMeshDevices().subscribe()));
  }

  /** Change who may see one of my devices' status (400 invalid visibility,
   *  404 not mine, 409/422 when the row is revoked). Refreshes the cached
   *  list on success so every view converges on the server's truth. */
  setMeshDeviceVisibility(id: string, visibility: MeshDeviceVisibility): Observable<void> {
    return this.http
      .put<void>(`${this.base}/mesh-devices/${encodeURIComponent(id)}/visibility`, { visibility }, { withCredentials: true })
      .pipe(tap(() => this.listMeshDevices().subscribe()));
  }

  /** Release (delete) one of my claimed mesh devices by id. Refreshes the
   *  cached list. */
  releaseMeshDevice(id: string): Observable<void> {
    return this.http
      .delete<void>(`${this.base}/mesh-devices/${encodeURIComponent(id)}`, { withCredentials: true })
      .pipe(tap(() => this.listMeshDevices().subscribe()));
  }
}
