import { TestBed } from '@angular/core/testing';
import { SessionService } from '../session.service';
import { StandaloneSessionService } from './standalone-session.service';

describe('StandaloneSessionService', () => {
  let svc: StandaloneSessionService;
  let session: SessionService;
  let realFetch: typeof fetch;

  const reply = (status: number, body?: unknown) =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));
  const signedIn = { id: '@alice:example.org', label: 'Alice', provider: 'matrix', roles: ['user'], registrationComplete: true };

  beforeEach(() => {
    localStorage.clear();
    delete (globalThis as any).__HUG_MATRIX_URL__;
    TestBed.configureTestingModule({});
    svc = TestBed.inject(StandaloneSessionService);
    session = TestBed.inject(SessionService);
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    delete (globalThis as any).__HUG_MATRIX_URL__;
  });

  it('starts loading', () => {
    expect(svc.state()).toBe('loading');
  });

  it('a 200 fills the session and tells the UI which homeserver the mxc links belong to', async () => {
    globalThis.fetch = (() => reply(200, signedIn)) as typeof fetch;
    await svc.init();
    expect(svc.state()).toBe('signed-in');
    expect(session.loggedIn()).toBeTrue();
    expect((globalThis as any).__HUG_MATRIX_URL__).toBe('https://example.org');
  });

  it('a 401 is signed out and clears any stale session', async () => {
    session.set({ ...signedIn, provider: 'matrix' } as any);
    globalThis.fetch = (() => reply(401)) as typeof fetch;
    await svc.init();
    expect(svc.state()).toBe('signed-out');
    expect(session.loggedIn()).toBeFalse();
  });

  it('any other status, or no answer, is an error and never a signed-in state', async () => {
    globalThis.fetch = (() => reply(502)) as typeof fetch;
    await svc.init();
    expect(svc.state()).toBe('error');
    globalThis.fetch = (() => Promise.reject(new TypeError('network'))) as typeof fetch;
    await svc.init();
    expect(svc.state()).toBe('error');
    expect(session.loggedIn()).toBeFalse();
  });

  it('login posts the credentials as JSON with the cookie, then reads the session', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url === '/bff/login' ? reply(204) : reply(200, signedIn);
    }) as typeof fetch;
    const ok = await svc.login('  alice ', 'a-password');
    expect(ok).toBeTrue();
    expect(calls[0].url).toBe('/bff/login');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.credentials).toBe('include');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ username: 'alice', password: 'a-password' });
    expect(svc.state()).toBe('signed-in');
    expect(svc.problem()).toBeNull();
  });

  it('login names the problem: wrong credentials, too many attempts, server trouble', async () => {
    globalThis.fetch = (() => reply(401)) as typeof fetch;
    expect(await svc.login('alice', 'nope')).toBeFalse();
    expect(svc.problem()).toBe('wrong-credentials');
    globalThis.fetch = (() => reply(429)) as typeof fetch;
    expect(await svc.login('alice', 'nope')).toBeFalse();
    expect(svc.problem()).toBe('too-many-attempts');
    globalThis.fetch = (() => reply(502)) as typeof fetch;
    expect(await svc.login('alice', 'x')).toBeFalse();
    expect(svc.problem()).toBe('unavailable');
    globalThis.fetch = (() => Promise.reject(new TypeError('offline'))) as typeof fetch;
    expect(await svc.login('alice', 'x')).toBeFalse();
    expect(svc.problem()).toBe('unavailable');
    expect(svc.busy()).toBeFalse();
  });

  it('login with an empty field never reaches the server', async () => {
    let called = false;
    globalThis.fetch = (() => { called = true; return reply(204); }) as typeof fetch;
    expect(await svc.login('', 'x')).toBeFalse();
    expect(await svc.login('alice', '')).toBeFalse();
    expect(called).toBeFalse();
  });

  it('serverName reads the part of a Matrix user id after the colon', () => {
    expect(StandaloneSessionService.serverName('@alice:example.org')).toBe('example.org');
    expect(StandaloneSessionService.serverName('@bob:abc.onion')).toBe('abc.onion');
    expect(StandaloneSessionService.serverName('alice')).toBe('');
    expect(StandaloneSessionService.serverName('')).toBe('');
  });

  it('sign-out posts to the server and clears the session either way', async () => {
    session.set(signedIn as any);
    let seen: { url: string; method?: string } | undefined;
    globalThis.fetch = ((u: string, i?: RequestInit) => {
      seen = { url: u, method: i?.method };
      return Promise.reject(new TypeError('offline'));
    }) as typeof fetch;
    await svc.signOut();
    expect(seen).toEqual({ url: '/bff/logout', method: 'POST' });
    expect(svc.state()).toBe('signed-out');
    expect(session.loggedIn()).toBeFalse();
  });
});
