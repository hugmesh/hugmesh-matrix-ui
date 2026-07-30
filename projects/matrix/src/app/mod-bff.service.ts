import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import { map, tap } from 'rxjs/operators';

/** Same-origin by default — the fe-gateway proxies /bff/mod/** to
 *  hugmesh-mod-bff-api. Override hook mirrors admin-ui's __HUG_BFF_URL__. */
const BFF_BASE: string = (globalThis as any).__HUG_BFF_URL__ ?? '';

/**
 * Wire shape of a federation moderation-queue row — matched field-for-field to
 * hugmesh-mod-bff-api's {@code ModerationRequestDto}.
 *  - kind:   'instance-block' | 'user-removal'
 *  - status: 'recommended' | 'referred' | 'approved' | 'denied'
 */
export interface ModerationRequest {
  id: number;
  requester: string;
  kind: string;
  target: string;
  reason: string | null;
  status: string;
  modReferrer: string | null;
  adminDecider: string | null;
  ts: string;
}

/** Body for POST /bff/mod/block. */
export interface ModBlockRequest {
  platform: 'matrix' | 'mastodon';
  scope: 'user' | 'instance';
  target: string;
  reason?: string;
}

/** Wire shape of a local mod-action audit row (mod-bff-api {@code ModAction}). */
export interface ModAction {
  id: string;
  actor: string;
  action: string;
  platform: string;
  target: string;
  reason: string | null;
  result: string;
  ts: string;
}

/** Response from POST /bff/mod/block: { blocked, external, note? }. The external
 *  homeserver-admin call is STUBBED server-side; `external`/`note` disclose that
 *  honestly and the UI surfaces it. */
export interface ModBlockResult {
  blocked: ModAction;
  external: string;
  note?: string;
}

/**
 * MOD-tier datastore service for the moderation queue + server-wide block.
 *
 * Shown to MOD or ADMIN (the bff gates every method @PreAuthorize
 * hasAnyRole('MOD','ADMIN'), so admins use these too). RxJS
 * {@link BehaviorSubject}-backed: the moderation queue is cached in
 * {@link moderation$} so a refer/block mutation can refresh it without each view
 * re-fetching. HTTP transport is Angular {@link HttpClient} to the same-origin
 * {@code /bff/mod/**} paths, authenticated by the HttpOnly `bff_` session cookie
 * (`withCredentials: true`, attached explicitly per call — this remote has no
 * global auth interceptor). The gateway mints the upstream bearer server-side.
 *
 * Endpoints (hugmesh-mod-bff-api ModController @ /bff/mod):
 *   POST /bff/mod/block {platform,scope,target,reason?} → block()
 *   GET  /bff/mod/moderation[?status=]                  → loadModeration()
 *   POST /bff/mod/moderation/{id}/refer                 → refer()
 */
@Injectable({ providedIn: 'root' })
export class ModBffService {
  private readonly http = inject(HttpClient);
  private readonly base = `${BFF_BASE}/bff/mod`;

  private readonly moderationSubject = new BehaviorSubject<ModerationRequest[]>([]);
  /** The cached moderation queue, observable by any MOD view. */
  readonly moderation$: Observable<ModerationRequest[]> = this.moderationSubject.asObservable();

  /** GET /bff/mod/moderation — load the queue and push onto {@link moderation$}. */
  loadModeration(status?: string): Observable<ModerationRequest[]> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.http
      .get<{ requests: ModerationRequest[] }>(`${this.base}/moderation${q}`, { withCredentials: true })
      .pipe(
        map((r) => r?.requests ?? []),
        tap((requests) => this.moderationSubject.next(requests)),
      );
  }

  /** POST /bff/mod/moderation/{id}/refer — escalate a request UP to an admin (the
   *  ONLY mod path; a mod never decides/removes directly). Refreshes the queue. */
  refer(id: number): Observable<ModerationRequest> {
    return this.http
      .post<{ request: ModerationRequest }>(`${this.base}/moderation/${id}/refer`, {}, { withCredentials: true })
      .pipe(
        tap(() => this.loadModeration().subscribe()),
        map((r) => r.request),
      );
  }

  /** POST /bff/mod/block — block a user/instance server-wide. The external
   *  homeserver-admin call is STUBBED server-side; the result's external/note
   *  disclose that, and the action is always recorded in the local audit table. */
  block(req: ModBlockRequest): Observable<ModBlockResult> {
    return this.http.post<ModBlockResult>(`${this.base}/block`, req, { withCredentials: true });
  }
}
