import { Injectable, inject, signal } from '@angular/core';
import { BFF_BASE_URL } from '../matrix.service';

/**
 * What the client-connect banner is allowed to tell the user, and nothing more.
 *
 * The states are deliberately asymmetric: `available` is the ONLY one that
 * carries a URL, and it is only ever reached after a probe has SEEN the
 * homeserver answer a real client-protocol request. Everything else carries a
 * `reason` instead, because a URL that will fail is worse than no URL — the user
 * pastes it into Element, gets "Invalid homeserver discovery response", and has
 * no way to tell whether they mistyped it or we lied.
 */
export type ClientConnectState =
  /** The probe has not finished. */
  | { status: 'checking' }
  /** The caller does not hold ROLE_MATRIX_EXTERNAL_CLIENT — no banner. */
  | { status: 'not-granted' }
  /** Granted, but the endpoint does NOT speak the client protocol. `reason` is
   *  what we actually observed; `needed` is the concrete thing that must exist. */
  | { status: 'unavailable'; reason: string; needed: string }
  /** Granted AND proven: `homeserverUrl` answered /_matrix/client/versions with
   *  a real version list. `wellKnown` records whether AUTODISCOVERY also works,
   *  because a client that only accepts a domain (rather than a full base URL)
   *  needs that too. */
  | { status: 'available'; homeserverUrl: string; versions: string[]; wellKnown: boolean };

/**
 * Proves — or refuses to claim — that this deployment can host a user's OWN
 * Matrix client.
 *
 * A previous pass shipped a connect URL on the strength of a 200 from the front
 * door. That 200 was the Angular SPA fallback: the gateway serves index.html for
 * every unrouted path, so `/_matrix/client/versions` returned `text/html` with a
 * 200 and looked healthy to anything that only checked the status code. This
 * service therefore requires THREE things before it will render a URL:
 *
 *   1. a 2xx,
 *   2. a JSON content-type (an HTML body is the SPA fallback, by definition),
 *   3. a body that parses to the CS-API shape — a non-empty `versions` array.
 *
 * Any of those failing yields `unavailable` WITH the observed reason, so the
 * banner explains the gap instead of handing over a URL that cannot work.
 */
@Injectable({ providedIn: 'root' })
export class ClientConnectService {
  /** The owner-scoped surface whose @PreAuthorize is exactly the external-client
   *  grant (`hasRole('MATRIX_EXTERNAL_CLIENT') or hasRole('MASTODON_EXTERNAL_CLIENT')`),
   *  so its 200-vs-403 IS the grant check. We deliberately do NOT read the grant
   *  off the session `roles[]`: admin-bff folds only the *_DOMAINLOCKED marker
   *  roles into the session, so *_EXTERNAL_CLIENT is simply not there, and a
   *  client-side role check would be permanently false. */
  private static readonly GRANT_PROBE_PATH = '/bff/user/connected-clients';

  /** The CS-API handshake every Matrix client performs first. */
  private static readonly VERSIONS_PATH = '/_matrix/client/versions';

  /** Client-server autodiscovery (MSC1929 / spec §Server Discovery). Optional:
   *  a client given a full base URL never needs it, but one given only a domain
   *  does — so we report it rather than requiring it. */
  private static readonly WELL_KNOWN_PATH = '/.well-known/matrix/client';

  private readonly bffBaseUrl = inject(BFF_BASE_URL);

  readonly state = signal<ClientConnectState>({ status: 'checking' });

  /** Run the whole check: grant first (cheap, and a denial means we never even
   *  probe), then the protocol proof. Never throws — an unexpected failure
   *  resolves to `unavailable` with the error text, never to `available`. */
  async check(): Promise<void> {
    this.state.set({ status: 'checking' });
    try {
      if (!(await this.hasGrant())) {
        this.state.set({ status: 'not-granted' });
        return;
      }
      this.state.set(await this.probeHomeserver());
    } catch (err) {
      this.state.set({
        status: 'unavailable',
        reason: `The connectivity check itself failed: ${String(err)}`,
        needed: ClientConnectService.VERSIONS_PATH,
      });
    }
  }

  /** 200 ⇒ the caller holds an external-client role; 403 ⇒ they do not. Any
   *  other outcome (401 session gone, 503, network) is treated as NO grant:
   *  fail-closed, because the cost of guessing wrong is showing a capability the
   *  user does not have. */
  private async hasGrant(): Promise<boolean> {
    try {
      const r = await fetch(`${this.bffBaseUrl}${ClientConnectService.GRANT_PROBE_PATH}`, {
        credentials: 'include',
      });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * The honest part. Probes THIS deployment's origin — which is what a user
   * would type into their client — for a real CS-API response.
   *
   * The URL is built from `location.origin`, not a relative path: under the host
   * shell a relative fetch resolves against the SHELL's document URL, and the
   * answer we need is about the ORIGIN a client would dial anyway.
   */
  private async probeHomeserver(): Promise<ClientConnectState> {
    const origin = this.origin();
    if (!origin) {
      return {
        status: 'unavailable',
        reason: 'No browser origin is available to probe.',
        needed: ClientConnectService.VERSIONS_PATH,
      };
    }

    let response: Response;
    try {
      response = await fetch(`${origin}${ClientConnectService.VERSIONS_PATH}`, {
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      return {
        status: 'unavailable',
        reason: `${origin}${ClientConnectService.VERSIONS_PATH} could not be reached (${String(err)}).`,
        needed: `A gateway route for /_matrix/** pointing at the homeserver.`,
      };
    }

    if (!response.ok) {
      return {
        status: 'unavailable',
        reason: `${origin}${ClientConnectService.VERSIONS_PATH} answered HTTP ${response.status}.`,
        needed: `A gateway route for /_matrix/** pointing at the homeserver.`,
      };
    }

    // THE SPA-FALLBACK TRAP: the gateway serves index.html for every unrouted
    // path, so an unrouted /_matrix/** is a 200 text/html that passes a naive
    // status check. The content-type is what distinguishes "the homeserver
    // answered" from "the SPA answered".
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      return {
        status: 'unavailable',
        reason: `${origin}${ClientConnectService.VERSIONS_PATH} answered HTTP 200 with `
          + `content-type "${contentType || 'none'}" — that is this app's HTML, not the `
          + `homeserver. The path is not routed to Matrix.`,
        needed: `A gateway route for /_matrix/** pointing at the homeserver.`,
      };
    }

    let versions: unknown;
    try {
      versions = (await response.json())?.versions;
    } catch (err) {
      return {
        status: 'unavailable',
        reason: `${origin}${ClientConnectService.VERSIONS_PATH} returned JSON that could not be parsed (${String(err)}).`,
        needed: `A gateway route for /_matrix/** pointing at the homeserver.`,
      };
    }

    if (!Array.isArray(versions) || versions.length === 0) {
      return {
        status: 'unavailable',
        reason: `${origin}${ClientConnectService.VERSIONS_PATH} returned JSON with no "versions" list — `
          + `it is not the Matrix client-server API.`,
        needed: `A gateway route for /_matrix/** pointing at the homeserver.`,
      };
    }

    return {
      status: 'available',
      homeserverUrl: origin,
      versions: versions.map(String),
      wellKnown: await this.probeWellKnown(origin),
    };
  }

  /** Whether autodiscovery works, i.e. whether a client can be given the bare
   *  domain instead of the full base URL. Same JSON-not-HTML rule; a failure is
   *  reported (the banner tells the user to enter the full URL), never fatal. */
  private async probeWellKnown(origin: string): Promise<boolean> {
    try {
      const r = await fetch(`${origin}${ClientConnectService.WELL_KNOWN_PATH}`, {
        headers: { Accept: 'application/json' },
      });
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return false;
      return typeof (await r.json())?.['m.homeserver']?.base_url === 'string';
    } catch {
      return false;
    }
  }

  /** The browser origin, or '' in a non-browser context. */
  private origin(): string {
    return typeof window === 'undefined' ? '' : window.location.origin;
  }
}
