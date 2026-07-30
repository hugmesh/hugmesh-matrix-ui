import { TestBed } from '@angular/core/testing';
import { SessionService, HugSession } from './session.service';

function makeSession(overrides: Partial<HugSession> = {}): HugSession {
  return {
    id: 'google:alice@gmail.com',
    label: 'alice@gmail.com',
    provider: 'google',
    roles: ['user'],
    registrationComplete: false,
    ...overrides,
  };
}

describe('SessionService (host)', () => {
  let service: SessionService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(SessionService);
  });

  afterEach(() => localStorage.clear());

  it('reads the canonical hug.session localStorage key', () => {
    expect(service.loggedIn()).toBeFalse();
    service.set(makeSession());
    expect(localStorage.getItem('hug.session')).withContext('writes the canonical key').not.toBeNull();
    expect(service.loggedIn()).toBeTrue();
  });

  it('derives isAdmin from the lowercase admin role string', () => {
    service.set(makeSession({ roles: ['user'] }));
    expect(service.isAdmin()).toBeFalse();
    service.set(makeSession({ roles: ['user', 'admin'] }));
    expect(service.isAdmin()).toBeTrue();
  });

  describe('isMod() — Casdoor mod ONLY (sibling rule)', () => {
    it('is true for the mod role', () => {
      service.set(makeSession({ roles: ['user', 'mod'] }));
      expect(service.isMod()).toBeTrue();
    });

    it('is FALSE for a bare admin (sibling rule: admin is NOT auto a mod)', () => {
      service.set(makeSession({ roles: ['user', 'admin'] }));
      expect(service.isMod()).toBeFalse();
    });

    it('is false for a plain user', () => {
      service.set(makeSession({ roles: ['user'] }));
      expect(service.isMod()).toBeFalse();
    });
  });

  it('derives isGames from the lowercase games role string', () => {
    service.set(makeSession({ roles: ['user'] }));
    expect(service.isGames()).toBeFalse();
    service.set(makeSession({ roles: ['user', 'games'] }));
    expect(service.isGames()).toBeTrue();
  });

  describe('isGamesAdmin() — DERIVED ROLE_GAMES ∩ (ROLE_ADMIN ∪ ROLE_MOD)', () => {
    it('is false for a bare games member (e2e-gamesonly: ROLE_GAMES alone)', () => {
      service.set(makeSession({ roles: ['user', 'games'] }));
      expect(service.isGamesAdmin()).toBeFalse();
    });

    it('is false for a bare admin WITHOUT games (e2e-adminonly)', () => {
      service.set(makeSession({ roles: ['user', 'admin'] }));
      expect(service.isGamesAdmin()).toBeFalse();
    });

    it('is true for games + admin (e2e-gamesadmin earns the derived role)', () => {
      service.set(makeSession({ roles: ['user', 'games', 'admin'] }));
      expect(service.isGamesAdmin()).toBeTrue();
    });

    it('is true for games + mod (the ROLE_ADMIN ∪ ROLE_MOD half of the intersection)', () => {
      service.set(makeSession({ roles: ['user', 'games', 'mod'] }));
      expect(service.isGamesAdmin()).toBeTrue();
    });

    it('is false for a plain user with neither games nor admin/mod', () => {
      service.set(makeSession({ roles: ['user'] }));
      expect(service.isGamesAdmin()).toBeFalse();
    });
  });

  it('derives fullyRegistered from registrationComplete', () => {
    service.set(makeSession({ registrationComplete: false }));
    expect(service.fullyRegistered()).toBeFalse();
    service.set(makeSession({ registrationComplete: true }));
    expect(service.fullyRegistered()).toBeTrue();
  });

  it('clear() logs the session out', () => {
    service.set(makeSession());
    expect(service.loggedIn()).toBeTrue();
    service.clear();
    expect(service.loggedIn()).toBeFalse();
    expect(localStorage.getItem('hug.session')).toBeNull();
  });

  // NATIVE-LOGIN cookie mode: the host holds only the httpOnly bff_ cookie and hydrates
  // the session from GET /bff/session — nothing is read from or written to localStorage.
  describe('native cookie-session mode (hydrate from GET /bff/session)', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    afterEach(() => { delete g['__HUG_SESSION_COOKIE_MODE__']; });

    function stubSessionResponse(body: Partial<HugSession> | null, ok = true): jasmine.Spy {
      return spyOn(globalThis, 'fetch').and.resolveTo(
        { ok, json: async () => body } as unknown as Response,
      );
    }

    it('hydrate() reads roles + registrationComplete from /bff/session, never localStorage', async () => {
      g['__HUG_SESSION_COOKIE_MODE__'] = true;
      const fetchSpy = stubSessionResponse({
        id: 'e2e-user', label: 'e2e-user', provider: 'password',
        roles: ['user', 'admin'], registrationComplete: true,
      });
      await service.hydrate();
      expect(fetchSpy).toHaveBeenCalledWith('/bff/session', jasmine.objectContaining({ credentials: 'include' }));
      expect(service.loggedIn()).toBeTrue();
      expect(service.isAdmin()).toBeTrue();
      expect(service.fullyRegistered()).toBeTrue();
      expect(localStorage.getItem('hug.session')).withContext('cookie mode persists NOTHING').toBeNull();
    });

    it('a non-OK /bff/session leaves the host logged out', async () => {
      g['__HUG_SESSION_COOKIE_MODE__'] = true;
      stubSessionResponse(null, false);
      await service.hydrate();
      expect(service.loggedIn()).toBeFalse();
    });

    it('hydrate() is a no-op when cookie mode is off (legacy localStorage path)', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch');
      await service.hydrate();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
