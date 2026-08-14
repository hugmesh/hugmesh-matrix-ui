import { TestBed } from '@angular/core/testing';

import { BFF_BASE_URL } from '../matrix.service';
import { ClientConnectService } from './client-connect.service';

/**
 * These specs encode the ONE rule that matters here: a URL is rendered only
 * against evidence that the homeserver answered a real client handshake.
 *
 * The trap being defended against is real and was shipped once: the fe-gateway
 * serves this SPA's index.html for every unrouted path, so a probe that only
 * checked `response.ok` saw HTTP 200 on /_matrix/client/versions and concluded
 * the homeserver was reachable. It was the Angular app answering. Verified live
 * on the local stack 2026-08-14 — front door returns
 * `content-type: text/html` + `<!doctype html>` for that path, while tuwunel
 * itself returns the JSON version list on its own port.
 */
describe('ClientConnectService', () => {
  let service: ClientConnectService;
  const originalFetch = globalThis.fetch;

  /** Route each probe path to a caller-supplied Response. */
  function routeFetch(routes: Record<string, () => Promise<Response>>): void {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      for (const path of Object.keys(routes)) {
        if (url.endsWith(path)) return routes[path]();
      }
      return Promise.reject(new Error(`unrouted probe: ${url}`));
    }) as typeof fetch;
  }

  function json(body: unknown, status = 200): Promise<Response> {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  }

  /** The SPA fallback: HTTP 200, but it is index.html, not the homeserver. */
  function spaFallback(): Promise<Response> {
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);
  }

  const GRANTED = () => json([], 200);
  const DENIED = () => json({ error: 'forbidden' }, 403);

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [{ provide: BFF_BASE_URL, useValue: '' }] });
    service = TestBed.inject(ClientConnectService);
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it('renders NOTHING for a caller without the external-client grant (403)', async () => {
    routeFetch({ '/bff/user/connected-clients': DENIED });

    await service.check();

    expect(service.state()).toEqual({ status: 'not-granted' });
  });

  it('does not even probe the homeserver when the grant is absent', async () => {
    let probes = 0;
    routeFetch({
      '/bff/user/connected-clients': DENIED,
      '/_matrix/client/versions': () => { probes++; return json({ versions: ['v1.1'] }); },
    });

    await service.check();

    expect(probes).toBe(0);
  });

  it('REFUSES to publish a URL when /_matrix/client/versions is the SPA fallback', async () => {
    routeFetch({
      '/bff/user/connected-clients': GRANTED,
      '/_matrix/client/versions': spaFallback,
    });

    await service.check();

    const state = service.state();
    expect(state.status).toBe('unavailable');
    if (state.status !== 'unavailable') return;
    // The reason must name the actual observation, not a generic failure.
    expect(state.reason).toContain('text/html');
    expect(state.reason).toContain('not the homeserver');
    expect(state.needed).toContain('/_matrix/**');
    // And crucially: no URL anywhere in the payload the banner renders.
    expect(Object.keys(state)).not.toContain('homeserverUrl');
  });

  it('REFUSES to publish a URL when the JSON has no versions list', async () => {
    routeFetch({
      '/bff/user/connected-clients': GRANTED,
      '/_matrix/client/versions': () => json({ hello: 'world' }),
    });

    await service.check();

    expect(service.state().status).toBe('unavailable');
  });

  it('REFUSES to publish a URL on a non-2xx from the versions endpoint', async () => {
    routeFetch({
      '/bff/user/connected-clients': GRANTED,
      '/_matrix/client/versions': () => json({ errcode: 'M_NOT_FOUND' }, 404),
    });

    await service.check();

    const state = service.state();
    expect(state.status).toBe('unavailable');
    if (state.status !== 'unavailable') return;
    expect(state.reason).toContain('404');
  });

  it('publishes the origin ONLY after a real CS-API version list comes back', async () => {
    routeFetch({
      '/bff/user/connected-clients': GRANTED,
      // The exact shape tuwunel v1.7.0 returns on this stack.
      '/_matrix/client/versions': () => json({ versions: ['r0.6.1', 'v1.1', 'v1.15'] }),
      '/.well-known/matrix/client': () => json({ 'm.homeserver': { base_url: window.location.origin } }),
    });

    await service.check();

    expect(service.state()).toEqual({
      status: 'available',
      homeserverUrl: window.location.origin,
      versions: ['r0.6.1', 'v1.1', 'v1.15'],
      wellKnown: true,
    });
  });

  it('reports autodiscovery separately: usable URL, but well-known is the SPA', async () => {
    // tuwunel 404s /.well-known/matrix/client and the front door answers it with
    // the SPA — so a client given only the DOMAIN cannot find the server even
    // when the full base URL works. The banner has to say so.
    routeFetch({
      '/bff/user/connected-clients': GRANTED,
      '/_matrix/client/versions': () => json({ versions: ['v1.15'] }),
      '/.well-known/matrix/client': spaFallback,
    });

    await service.check();

    const state = service.state();
    expect(state.status).toBe('available');
    if (state.status !== 'available') return;
    expect(state.wellKnown).toBeFalse();
  });

  it('fails CLOSED when the grant probe itself errors (never shows a URL)', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('network down'))) as typeof fetch;

    await service.check();

    expect(service.state()).toEqual({ status: 'not-granted' });
  });
});
