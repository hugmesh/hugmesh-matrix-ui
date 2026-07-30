import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { AppComponent } from './app.component';
import { SessionService } from './session.service';

/** Drives AppComponent's nav conditionals. Signal-backed (mirrors the real
 *  SessionService's computed()s + the SessionStub idiom used across the other
 *  HugMesh Angular hosts) so template re-checks pick up mutations. */
class SessionStub {
  loggedIn = signal(false);
  fullyRegistered = signal(false);
  isAdmin = signal(false);
  isMod = signal(false);
  isGames = signal(false);
  isGamesAdmin = signal(false);
  session = signal<{ label: string } | null>(null);
  cleared = false;
  clear(): void { this.cleared = true; }

  login(over: Partial<{ registered: boolean; admin: boolean; mod: boolean; games: boolean; gamesAdmin: boolean }> = {}): void {
    this.loggedIn.set(true);
    this.fullyRegistered.set(over.registered ?? true);
    this.isAdmin.set(over.admin ?? false);
    this.isMod.set(over.mod ?? false);
    this.isGames.set(over.games ?? false);
    this.isGamesAdmin.set(over.gamesAdmin ?? false);
    this.session.set({ label: 'alice' });
  }
}

describe('AppComponent (host) — role-conditional nav', () => {
  let fixture: ComponentFixture<AppComponent>;
  let stub: SessionStub;
  let el: HTMLElement;

  beforeEach(async () => {
    stub = new SessionStub();
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([]), { provide: SessionService, useValue: stub }],
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  function q(testid: string): HTMLElement | null {
    return el.querySelector(`[data-testid="${testid}"]`);
  }

  it('anonymous: shows Sign in, no role-gated entries at all (not even disabled ones)', () => {
    expect(q('nav-login')).toBeTruthy();
    expect(q('nav-mod')).toBeFalsy();
    expect(q('nav-games')).toBeFalsy();
    expect(q('nav-games-admin')).toBeFalsy();
  });

  describe('Moderation entry-point (ROLE_MOD)', () => {
    it('is an ENABLED link for a moderator', () => {
      stub.login({ mod: true });
      fixture.detectChanges();
      const link = q('nav-mod') as HTMLAnchorElement;
      expect(link).toBeTruthy();
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('aria-disabled')).toBeNull();
    });

    it('is a DISABLED control with helptext for a plain user (not hidden)', () => {
      stub.login();
      fixture.detectChanges();
      const span = q('nav-mod') as HTMLElement;
      expect(span).withContext('disabled control still renders, not hidden').toBeTruthy();
      expect(span.tagName).toBe('SPAN');
      expect(span.getAttribute('aria-disabled')).toBe('true');
      const helpId = span.getAttribute('aria-describedby');
      expect(helpId).toBe('nav-mod-help');
      const help = el.querySelector(`#${helpId}`);
      expect(help?.textContent).toContain('moderator');
    });

    it('admin is NOT auto a mod in the nav (sibling rule) — DISABLED for admin-only', () => {
      stub.login({ admin: true });
      fixture.detectChanges();
      const span = q('nav-mod') as HTMLElement;
      expect(span.getAttribute('aria-disabled')).toBe('true');
    });
  });

  describe('Games entry-point (ROLE_GAMES)', () => {
    it('is an ENABLED link for a games member', () => {
      stub.login({ games: true });
      fixture.detectChanges();
      const link = q('nav-games') as HTMLAnchorElement;
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('aria-disabled')).toBeNull();
    });

    it('is a DISABLED control with helptext for a plain user', () => {
      stub.login();
      fixture.detectChanges();
      const span = q('nav-games') as HTMLElement;
      expect(span.tagName).toBe('SPAN');
      expect(span.getAttribute('aria-disabled')).toBe('true');
      const help = el.querySelector(`#${span.getAttribute('aria-describedby')}`);
      expect(help?.textContent).toContain('games member');
    });
  });

  describe('Games Admin console (DERIVED ROLE_GAMES_ADMIN)', () => {
    it('is an ENABLED link for the derived games-admin tier', () => {
      stub.login({ games: true, admin: true, gamesAdmin: true });
      fixture.detectChanges();
      const link = q('nav-games-admin') as HTMLAnchorElement;
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('aria-disabled')).toBeNull();
    });

    it('is DISABLED for a bare games member (e2e-gamesonly)', () => {
      stub.login({ games: true });
      fixture.detectChanges();
      const span = q('nav-games-admin') as HTMLElement;
      expect(span.getAttribute('aria-disabled')).toBe('true');
    });

    it('is DISABLED for a bare admin WITHOUT games (e2e-adminonly)', () => {
      stub.login({ admin: true });
      fixture.detectChanges();
      const span = q('nav-games-admin') as HTMLElement;
      expect(span.getAttribute('aria-disabled')).toBe('true');
      const help = el.querySelector(`#${span.getAttribute('aria-describedby')}`);
      expect(help?.textContent).toContain('games admin');
    });
  });
});
