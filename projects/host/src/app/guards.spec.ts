import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';

import { adminGuard } from './admin.guard';
import { registeredGuard } from './registration.guard';
import { modGuard } from './mod.guard';
import { gamesGuard } from './games.guard';
import { gamesAdminGuard } from './games-admin.guard';
import { SessionService } from './session.service';

/** Minimal SessionService double exposing the role/registration signals the
 *  guards read. Drives the boolean flags per-case and asserts allow vs the
 *  exact /login redirect (a UrlTree) — real guard behaviour, not creation. */
class SessionStub {
  admin = false;
  mod = false;
  games = false;
  gamesAdmin = false;
  registered = false;
  isAdmin = () => this.admin;
  isMod = () => this.mod;
  isGames = () => this.games;
  isGamesAdmin = () => this.gamesAdmin;
  fullyRegistered = () => this.registered;
}

function run(guard: typeof adminGuard): boolean | UrlTree {
  return TestBed.runInInjectionContext(() => guard({} as never, {} as never)) as
    | boolean
    | UrlTree;
}

describe('host federation route guards', () => {
  let session: SessionStub;
  let router: Router;

  beforeEach(() => {
    session = new SessionStub();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: SessionService, useValue: session },
      ],
    });
    router = TestBed.inject(Router);
  });

  describe('adminGuard', () => {
    it('allows when the session has the admin role', () => {
      session.admin = true;
      expect(run(adminGuard)).toBeTrue();
    });

    it('redirects non-admins to /login', () => {
      expect(run(adminGuard)).toEqual(router.parseUrl('/login'));
    });
  });

  describe('registeredGuard', () => {
    it('allows a fully-registered user', () => {
      session.registered = true;
      expect(run(registeredGuard)).toBeTrue();
    });

    it('redirects an unregistered user to /login', () => {
      expect(run(registeredGuard)).toEqual(router.parseUrl('/login'));
    });
  });

  describe('modGuard (mirrors session.isMod: mod ONLY — sibling rule)', () => {
    it('ALLOWS a moderator', () => {
      session.mod = true;
      expect(run(modGuard)).toBeTrue();
    });

    it('DENIES a bare admin (sibling rule: admin is NOT auto a mod)', () => {
      session.admin = true;
      expect(run(modGuard)).toEqual(router.parseUrl('/login'));
    });

    it('DENIES a plain user (redirect to /login)', () => {
      expect(run(modGuard)).toEqual(router.parseUrl('/login'));
    });
  });

  describe('gamesGuard (games entry-point at /games)', () => {
    it('ALLOWS a games member', () => {
      session.games = true;
      expect(run(gamesGuard)).toBeTrue();
    });

    it('ALLOWS an administrator (even without ROLE_GAMES)', () => {
      session.admin = true;
      expect(run(gamesGuard)).toBeTrue();
    });

    it('DENIES a plain user WITHOUT ROLE_GAMES (redirect to /login)', () => {
      expect(run(gamesGuard)).toEqual(router.parseUrl('/login'));
    });

    it('DENIES a bare moderator WITHOUT ROLE_GAMES (redirect to /login)', () => {
      session.mod = true;
      expect(run(gamesGuard)).toEqual(router.parseUrl('/login'));
    });
  });

  describe('gamesAdminGuard (DERIVED ROLE_GAMES_ADMIN mount at /games/admin)', () => {
    it('ALLOWS the derived games-admin (e2e-gamesadmin: games + admin)', () => {
      session.gamesAdmin = true;
      expect(run(gamesAdminGuard)).toBeTrue();
    });

    it('DENIES a bare games member (e2e-gamesonly: ROLE_GAMES alone)', () => {
      session.games = true;
      expect(run(gamesAdminGuard)).toEqual(router.parseUrl('/login'));
    });

    it('DENIES a bare admin WITHOUT games (e2e-adminonly)', () => {
      session.admin = true;
      expect(run(gamesAdminGuard)).toEqual(router.parseUrl('/login'));
    });

    it('DENIES an anonymous visitor (redirect to /login)', () => {
      expect(run(gamesAdminGuard)).toEqual(router.parseUrl('/login'));
    });
  });
});
