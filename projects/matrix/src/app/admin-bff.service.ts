import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { ModBffService, ModerationRequest } from './mod-bff.service';

/** Same-origin by default — the fe-gateway proxies /bff/admin/** to
 *  hugmesh-admin-bff-api. Override hook mirrors admin-ui's __HUG_BFF_URL__. */
const BFF_BASE: string = (globalThis as any).__HUG_BFF_URL__ ?? '';

/**
 * ADMIN-tier datastore service for the moderation decide→apply chain.
 *
 * Shown to ADMIN only (session.isAdmin). Wraps hugmesh-admin-bff-api's
 * {@code POST /bff/admin/moderation/{id}/decide?approve=<bool>}, which itself
 * proxies to hugmesh-federation-api's {@code POST
 * /api/federation/moderation/{id}/decide} (bearer-forwarded, so federation-api
 * authorises + domain-scopes the decision against the ORIGINAL admin's JWT, not a
 * service identity). An approved {@code user-removal} is auto-applied downstream
 * as an active kill-switch override; a denied re-decision rearms it. This client
 * makes NO promise beyond what the response reports — a non-2xx/error surfaces to
 * the caller untouched, never swallowed into a fake success.
 *
 * HTTP transport is Angular {@link HttpClient} to the same-origin
 * {@code /bff/admin/**} paths, authenticated by the HttpOnly {@code bff_} session
 * cookie ({@code withCredentials: true}, attached explicitly per call — identical
 * convention to {@link ModBffService} / user-bff.service after the HttpOnly-session
 * cutover; there is no longer a bffToken Bearer header).
 */
@Injectable({ providedIn: 'root' })
export class AdminBffService {
  private readonly http = inject(HttpClient);
  private readonly modBff = inject(ModBffService);
  private readonly base = `${BFF_BASE}/bff/admin`;

  /**
   * POST /bff/admin/moderation/{id}/decide?approve=<bool> — approve or deny a
   * referred moderation request. Refreshes the (mod-tier-shared) moderation queue
   * on success so the row's new status is reflected everywhere it is rendered;
   * a failure leaves the queue untouched and propagates to the caller.
   */
  decide(id: number, approve: boolean): Observable<ModerationRequest> {
    return this.http
      .post<ModerationRequest>(
        `${this.base}/moderation/${id}/decide?approve=${approve}`,
        {},
        { withCredentials: true },
      )
      .pipe(tap(() => this.modBff.loadModeration().subscribe()));
  }
}
