import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { RoleActionsComponent } from './role-actions.component';
import { SessionService } from './session.service';
import { UserBffService } from './user-bff.service';
import { ModBffService, ModerationRequest } from './mod-bff.service';
import { AdminBffService } from './admin-bff.service';
import { expectDescribedByHelp } from './a11y-help.spec-util';

/** Configurable SessionService stub: drives the role-tier signals. */
class SessionStub {
  isUser = signal(false);
  isMod = signal(false);
  isAdmin = signal(false);
  setTier(user: boolean, mod: boolean, admin: boolean): void {
    this.isUser.set(user);
    this.isMod.set(mod);
    this.isAdmin.set(admin);
  }
}

class UserBffStub {
  blocks$ = of([]);
  list = jasmine.createSpy('list').and.returnValue(of([]));
  block = jasmine.createSpy('block').and.returnValue(of({ block: {}, pushed: true, external: 'stubbed' }));
  unblock = jasmine.createSpy('unblock').and.returnValue(of(undefined));
  recommendInstanceBlock = jasmine.createSpy('recommendInstanceBlock')
    .and.returnValue(of({ recommended: true, instance: 'evil.test', federation: {} }));
}

const QUEUE_ROW: ModerationRequest = {
  id: 9, requester: 'google:alice', kind: 'instance-block', target: 'evil.test',
  reason: 'spam', status: 'recommended', modReferrer: null, adminDecider: null, ts: '',
};

class ModBffStub {
  moderation$ = of([QUEUE_ROW]);
  loadModeration = jasmine.createSpy('loadModeration').and.returnValue(of([QUEUE_ROW]));
  block = jasmine.createSpy('block').and.returnValue(of({ blocked: {}, external: 'stubbed', note: 'STUBBED' }));
  refer = jasmine.createSpy('refer').and.returnValue(of({ ...QUEUE_ROW, status: 'referred' }));
}

class AdminBffStub {
  decide = jasmine.createSpy('decide').and.returnValue(of({ ...QUEUE_ROW, status: 'approved' }));
}

describe('RoleActionsComponent', () => {
  let fixture: ComponentFixture<RoleActionsComponent>;
  let component: RoleActionsComponent;
  let session: SessionStub;
  let userBff: UserBffStub;
  let modBff: ModBffStub;
  let adminBff: AdminBffStub;

  async function setup(user: boolean, mod: boolean, admin: boolean, openMenu = true): Promise<void> {
    session = new SessionStub();
    session.setTier(user, mod, admin);
    userBff = new UserBffStub();
    modBff = new ModBffStub();
    adminBff = new AdminBffStub();
    await TestBed.configureTestingModule({
      imports: [RoleActionsComponent],
      providers: [
        { provide: SessionService, useValue: session },
        { provide: UserBffService, useValue: userBff },
        { provide: ModBffService, useValue: modBff },
        { provide: AdminBffService, useValue: adminBff },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(RoleActionsComponent);
    component = fixture.componentInstance;
    component.target = '@spam:evil.test';
    fixture.detectChanges();
    if (openMenu) {
      component.toggle();
      fixture.detectChanges();
    }
  }

  afterEach(() => TestBed.resetTestingModule());

  function q(testid: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testid}"]`);
  }

  // ───────────────────────── TIER INVARIANT ─────────────────────────

  it('USER tier: shows the user tier, hides MOD and ADMIN tiers', async () => {
    await setup(true, false, false);
    expect(q('tier-user')).toBeTruthy();
    expect(q('tier-mod')).toBeNull();
    expect(q('tier-admin')).toBeNull();
  });

  it('MOD tier: shows USER + MOD tiers, but NEVER the ADMIN tier', async () => {
    await setup(true, true, false);
    expect(q('tier-user')).toBeTruthy();
    expect(q('tier-mod')).toBeTruthy();
    expect(q('tier-admin')).toBeNull();
    expect(q('admin-stub-note')).toBeNull();
  });

  it('ADMIN tier: shows all three tiers including the admin approve/deny controls', async () => {
    await setup(true, true, true);
    expect(q('tier-user')).toBeTruthy();
    expect(q('tier-mod')).toBeTruthy();
    expect(q('tier-admin')).toBeTruthy();
    expect(q('admin-stub-note')).toBeTruthy();
  });

  it('logged-out: renders nothing at all', async () => {
    await setup(false, false, false, false);
    expect(q('role-actions')).toBeNull();
  });

  // ───────────────────────── HELP TEXT ─────────────────────────

  it('USER tier: wires the block-scope + recommend controls to present help', async () => {
    await setup(true, false, false);
    const el = fixture.nativeElement as HTMLElement;
    expect(expectDescribedByHelp(el, '[data-testid="ra-block-platform"]').toLowerCase())
      .toContain('your own view');
    expect(expectDescribedByHelp(el, '[data-testid="ra-recommend"]').toLowerCase())
      .toContain('moderators');
    // a sighted section hint exists too
    expect(q('ra-user-help')?.textContent?.toLowerCase()).toContain('affect only you');
  });

  it('MOD tier: wires the server-wide block + queue controls to present help', async () => {
    await setup(true, true, false);
    const el = fixture.nativeElement as HTMLElement;
    expect(expectDescribedByHelp(el, '[data-testid="ra-mod-block"]').toLowerCase())
      .toContain('every account');
    expect(expectDescribedByHelp(el, '[data-testid="ra-load-queue"]').toLowerCase())
      .toContain('escalate');
  });

  // ───────────────────────── USER tier behaviour ─────────────────────────

  it('blocks the target on matrix and announces the result in role=status', async () => {
    await setup(true, false, false);
    component.blockPlatform = 'matrix';
    component.blockTarget();
    fixture.detectChanges();
    expect(userBff.block).toHaveBeenCalledWith('@spam:evil.test', 'matrix');
    const status = q('role-actions-status');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toContain('Blocked @spam:evil.test');
  });

  it('supports an internal-only self-block', async () => {
    await setup(true, false, false);
    component.blockPlatform = 'internal';
    component.blockTarget();
    expect(userBff.block).toHaveBeenCalledWith('@spam:evil.test', 'internal');
  });

  it('recommends an instance block using the derived domain', async () => {
    await setup(true, false, false);
    component.recommendReason = 'spam farm';
    component.recommendInstanceBlock();
    expect(userBff.recommendInstanceBlock).toHaveBeenCalledWith('evil.test', 'spam farm');
  });

  it('hides the self-block control when isSelf is set', async () => {
    await setup(true, false, false, false);
    component.isSelf = true;
    component.toggle();
    fixture.detectChanges();
    expect(q('ra-block-user')).toBeNull();
    // recommend still available
    expect(q('ra-recommend')).toBeTruthy();
  });

  // ───────────────────────── MOD tier behaviour ─────────────────────────

  it('mod server-wide block sends platform=matrix with the chosen scope', async () => {
    await setup(true, true, false);
    component.modScope = 'instance';
    component.modReason = 'abuse';
    component.modBlock();
    expect(modBff.block).toHaveBeenCalledWith({
      platform: 'matrix', scope: 'instance', target: 'evil.test', reason: 'abuse',
    });
  });

  it('mod refer escalates a queue row to admin', async () => {
    await setup(true, true, false);
    component.refer(QUEUE_ROW);
    expect(modBff.refer).toHaveBeenCalledWith(9);
  });

  // ───────────────────────── ADMIN tier behaviour ─────────────────────────

  it('admin approve calls AdminBffService.decide(id, true) and announces the applied status', async () => {
    await setup(true, true, true);
    component.adminDecide(QUEUE_ROW, true);
    fixture.detectChanges();
    expect(adminBff.decide).toHaveBeenCalledWith(9, true);
    const status = q('role-actions-status');
    expect(status?.textContent).toContain('Approved');
    expect(status?.textContent).toContain('approved');
  });

  it('admin deny calls AdminBffService.decide(id, false)', async () => {
    await setup(true, true, true);
    component.adminDecide(QUEUE_ROW, false);
    expect(adminBff.decide).toHaveBeenCalledWith(9, false);
  });

  it('a failed decide surfaces an alert and NEVER claims the request was applied', async () => {
    await setup(true, true, true);
    adminBff.decide.and.returnValue(
      { subscribe: (o: { error: (e: unknown) => void }) => o.error(new Error('boom')) } as never,
    );
    component.adminDecide(QUEUE_ROW, true);
    fixture.detectChanges();
    const err = q('role-actions-error');
    expect(err?.getAttribute('role')).toBe('alert');
    expect(err?.textContent).toContain('NOT applied');
    expect(q('role-actions-status')?.textContent ?? '').not.toContain('Approved');
  });

  it('marks the row mid-flight (buttons disabled) while a decide call is outstanding', async () => {
    await setup(true, true, true);
    let resolve!: (v: ModerationRequest) => void;
    adminBff.decide.and.returnValue({
      subscribe: (o: { next: (v: ModerationRequest) => void }) => { resolve = o.next.bind(o); },
    } as never);
    component.adminDecide(QUEUE_ROW, true);
    expect(component.decidingIds().has(9)).toBeTrue();
    resolve({ ...QUEUE_ROW, status: 'approved' });
    expect(component.decidingIds().has(9)).toBeFalse();
  });

  // ───────────────────────── a11y ─────────────────────────

  it('trigger exposes aria-expanded reflecting the open state', async () => {
    await setup(true, false, false, false);
    const trigger = q('role-actions-trigger')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    component.toggle();
    fixture.detectChanges();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('Escape closes the open menu', async () => {
    await setup(true, false, false);
    expect(component.open()).toBeTrue();
    component.onKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(component.open()).toBeFalse();
  });

  it('Escape restores focus to the trigger that opened the menu', async () => {
    await setup(true, false, false);
    const trigger = q('role-actions-trigger') as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    component.onKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    // menu closed AND focus is back on the trigger (not stranded on a removed node)
    expect(component.open()).toBeFalse();
    expect(document.activeElement).toBe(trigger);
  });

  it('error results render in a role=alert live region', async () => {
    await setup(true, true, false);
    modBff.block.and.returnValue({ subscribe: (o: { error: (e: unknown) => void }) => o.error(new Error('x')) } as never);
    component.modBlock();
    fixture.detectChanges();
    const err = q('role-actions-error');
    expect(err?.getAttribute('role')).toBe('alert');
  });
});
