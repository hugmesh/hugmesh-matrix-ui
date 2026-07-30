import { TestBed } from '@angular/core/testing';
import { SessionService, HugSession } from './session.service';

/** Build a HugSession fixture with the given roles. */
function sessionWith(roles: string[]): HugSession {
  return {
    id: 'google:alice@gmail.com',
    label: 'alice',
    provider: 'google',
    roles,
    registrationComplete: true,
  };
}

describe('SessionService (matrix remote, role tiers)', () => {
  let svc: SessionService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(SessionService);
  });

  afterEach(() => localStorage.clear());

  it('starts logged out with every tier flag false', () => {
    expect(svc.loggedIn()).toBeFalse();
    expect(svc.isUser()).toBeFalse();
    expect(svc.isMod()).toBeFalse();
    expect(svc.isAdmin()).toBeFalse();
  });

  it('USER role: isUser true, isMod + isAdmin false (no MOD/ADMIN tiers)', () => {
    svc.set(sessionWith(['user']));
    expect(svc.isUser()).toBeTrue();
    expect(svc.isMod()).toBeFalse();
    expect(svc.isAdmin()).toBeFalse();
  });

  it('MOD role: isUser + isMod true, isAdmin false (mod never sees ADMIN tier)', () => {
    svc.set(sessionWith(['user', 'mod']));
    expect(svc.isUser()).toBeTrue();
    expect(svc.isMod()).toBeTrue();
    expect(svc.isAdmin()).toBeFalse();
  });

  it('ADMIN role: all tiers true (admin also uses the MOD bff)', () => {
    svc.set(sessionWith(['user', 'admin']));
    expect(svc.isUser()).toBeTrue();
    expect(svc.isMod()).toBeTrue();
    expect(svc.isAdmin()).toBeTrue();
  });

  it('never persists a bearer token (auth rides the HttpOnly bff_ cookie)', () => {
    svc.set(sessionWith(['user']));
    const raw = localStorage.getItem('hug.session') ?? '';
    expect(raw).not.toContain('bffToken');
    expect(raw).not.toContain('token');
  });

  it('clear() drops back to logged-out / all-tiers-false', () => {
    svc.set(sessionWith(['admin']));
    svc.clear();
    expect(svc.loggedIn()).toBeFalse();
    expect(svc.isAdmin()).toBeFalse();
  });

  it('re-reads on the hug-session-change broadcast', () => {
    localStorage.setItem('hug.session', JSON.stringify(sessionWith(['mod'])));
    window.dispatchEvent(new Event('hug-session-change'));
    expect(svc.isMod()).toBeTrue();
    expect(svc.isAdmin()).toBeFalse();
  });

  // ───────── SOCIAL LOCAL-ONLY — matrix domain-lock marker ─────────
  describe('isMatrixDomainLocked (SOCIAL LOCAL-ONLY marker)', () => {
    it('is false for an ordinary (un-locked) user', () => {
      svc.set(sessionWith(['user']));
      expect(svc.isMatrixDomainLocked()).toBeFalse();
    });

    it('is true when roles[] carries the lowercase matrix_domainlocked marker the bff folds in', () => {
      // Shape matches admin-bff AuthController#domainlockRoles → ROLE_MATRIX_DOMAINLOCKED
      // surfaces as the lowercase 'matrix_domainlocked' string appended to roles[].
      svc.set(sessionWith(['user', 'matrix_domainlocked']));
      expect(svc.isMatrixDomainLocked()).toBeTrue();
    });

    it('is a RESTRICTION flag, not a tier: it never raises isMod/isAdmin', () => {
      svc.set(sessionWith(['user', 'matrix_domainlocked']));
      expect(svc.isUser()).toBeTrue();
      expect(svc.isMod()).toBeFalse();
      expect(svc.isAdmin()).toBeFalse();
    });

    it('does NOT trip on the mastodon-only domain-lock marker (per-service markers are distinct)', () => {
      svc.set(sessionWith(['user', 'mastodon_domainlocked']));
      expect(svc.isMatrixDomainLocked()).toBeFalse();
    });

    it('clear() drops the domain-lock flag back to false', () => {
      svc.set(sessionWith(['user', 'matrix_domainlocked']));
      svc.clear();
      expect(svc.isMatrixDomainLocked()).toBeFalse();
    });
  });
});
