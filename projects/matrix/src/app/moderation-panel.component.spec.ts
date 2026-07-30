import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { ModerationPanelComponent } from './moderation-panel.component';
import { SessionService } from './session.service';
import { UserBffService } from './user-bff.service';
import { ModBffService } from './mod-bff.service';
import { expectDescribedByHelp } from './a11y-help.spec-util';

class SessionStub {
  isUser = signal(false);
  isMod = signal(false);
  isAdmin = signal(false);
}
class UserBffStub {
  blocks$ = of([]);
  list = jasmine.createSpy('list').and.returnValue(of([]));
}
class ModBffStub {
  moderation$ = of([]);
  loadModeration = jasmine.createSpy('loadModeration').and.returnValue(of([]));
}

describe('ModerationPanelComponent', () => {
  let fixture: ComponentFixture<ModerationPanelComponent>;
  let session: SessionStub;

  async function setup(user: boolean, mod: boolean, admin: boolean): Promise<void> {
    session = new SessionStub();
    session.isUser.set(user);
    session.isMod.set(mod);
    session.isAdmin.set(admin);
    await TestBed.configureTestingModule({
      imports: [ModerationPanelComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SessionService, useValue: session },
        { provide: UserBffService, useClass: UserBffStub },
        { provide: ModBffService, useClass: ModBffStub },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ModerationPanelComponent);
    fixture.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  function q(id: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
  }

  it('signed out: shows a sign-in prompt and no role-actions surface', async () => {
    await setup(false, false, false);
    expect(q('mod-panel-signedout')).toBeTruthy();
    expect(q('role-actions')).toBeNull();
  });

  it('signed in (user): embeds the inline role-actions surface', async () => {
    await setup(true, false, false);
    expect(q('mod-panel-signedout')).toBeNull();
    expect(q('role-actions')).toBeTruthy();
    expect(q('tier-user')).toBeTruthy();
    expect(q('tier-mod')).toBeNull();
  });

  it('renders a labelled page heading', async () => {
    await setup(true, false, false);
    const panel = q('moderation-panel')!;
    expect(panel.getAttribute('aria-labelledby')).toBe('mod-panel-h');
  });

  // ───────── HELP TEXT ─────────
  it('signed in (user): wires the target + instance inputs to present help', async () => {
    await setup(true, false, false);
    const el = fixture.nativeElement as HTMLElement;
    expect(expectDescribedByHelp(el, '[data-testid="mod-panel-target"]').toLowerCase())
      .toContain('matrix id');
    expect(expectDescribedByHelp(el, '[data-testid="mod-panel-instance"]').toLowerCase())
      .toContain('server');
  });
});
