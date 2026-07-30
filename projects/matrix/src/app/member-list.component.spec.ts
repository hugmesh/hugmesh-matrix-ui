import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { MemberListComponent } from './member-list.component';
import { MatrixService, RoomMember } from './matrix.service';
import { expectAccessibleName, expectDescribedByHelp } from './a11y-help.spec-util';

class MatrixServiceStub {
  joinedMembers = jasmine.createSpy('joinedMembers').and.resolveTo([
    { userId: '@admin:test', displayName: 'Admin', membership: 'join', powerLevel: 100, presence: 'online' },
    { userId: '@bob:test', membership: 'join', powerLevel: 0, presence: 'offline' },
  ] as RoomMember[]);
  whoami = jasmine.createSpy('whoami').and.resolveTo('@admin:test');
  invite = jasmine.createSpy('invite').and.resolveTo(undefined);
  kick = jasmine.createSpy('kick').and.resolveTo(undefined);
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('');
}

describe('MemberListComponent', () => {
  let fixture: ComponentFixture<MemberListComponent>;
  let component: MemberListComponent;
  let matrix: MatrixServiceStub;

  beforeEach(async () => {
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [MemberListComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MatrixService, useValue: matrix },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ roomId: '!r:test' })) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MemberListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('loads and power-sorts the members for the route\'s room', () => {
    expect(matrix.joinedMembers).toHaveBeenCalledWith('!r:test');
    expect(component.members().map((m) => m.userId)).toEqual(['@admin:test', '@bob:test']);
  });

  it('renders the member list as a labelled region', () => {
    const section = fixture.nativeElement.querySelector('[data-testid="member-list"]');
    expect(section.getAttribute('aria-label')).toBeTruthy();
  });

  it('exposes each presence dot as an image with a textual label', () => {
    const dot = fixture.nativeElement.querySelector('[data-testid="member-presence-@admin:test"]');
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toContain('online');
  });

  it('labels the kick button with the member it acts on', () => {
    const kick = fixture.nativeElement.querySelector('[data-testid="btn-kick-@admin:test"]');
    expect(kick.getAttribute('aria-label')).toBe('Kick Admin');
  });

  // ───────── MULTIUSER-SITUATIONAL: a mod kicks a member named in non-ASCII ─────────
  describe('MULTIUSER-SITUATIONAL — screenReaderName on the kick aria-label', () => {
    it('announces the ASCII screenReaderName (not the raw UTF-8 display name) for the kick target', async () => {
      matrix.joinedMembers.and.resolveTo([
        { userId: '@yamada:test', displayName: '山田太郎', screenReaderName: 'Yamada Taro', membership: 'join', powerLevel: 0, presence: 'online' },
      ] as RoomMember[]);
      const f = TestBed.createComponent(MemberListComponent);
      f.detectChanges();
      await f.whenStable();
      f.detectChanges();

      const kick = f.nativeElement.querySelector('[data-testid="btn-kick-@yamada:test"]');
      // Announced name = ASCII screenReaderName …
      expect(kick.getAttribute('aria-label')).toBe('Kick Yamada Taro');
      // … while the VISIBLE name stays the raw UTF-8 display name.
      const name = f.nativeElement.querySelector('[data-testid="member-@yamada:test"] .name');
      expect(name.textContent.trim()).toBe('山田太郎');
    });

    it('falls back to the display name in the aria-label when no screenReaderName is set', () => {
      // The default ASCII member ("Admin") has no screenReaderName.
      expect(component.ariaName(component.members().find((m) => m.userId === '@admin:test')!)).toBe('Admin');
    });
  });

  it('associates the invite input with a label', () => {
    const input = fixture.nativeElement.querySelector('[data-testid="input-invite-user"]');
    const label = fixture.nativeElement.querySelector('label[for="member-invite"]');
    expect(input.id).toBe('member-invite');
    expect(label).toBeTruthy();
  });

  it('maps power levels to human labels', () => {
    expect(component.powerLabel(100)).toBe('Admin');
    expect(component.powerLabel(50)).toBe('Moderator');
    expect(component.powerLabel(0)).toBe('Default');
  });

  it('invites a trimmed user id then reloads', async () => {
    component.inviteUser = '  @carol:test  ';
    await component.doInvite();
    expect(matrix.invite).toHaveBeenCalledWith('!r:test', '@carol:test');
    expect(component.inviteUser).toBe('');
  });

  // ───────── ANNOUNCED-FAILURE HONESTY: invite/kick rejections never no-op ─────────
  describe('announced membership-verb failures', () => {
    it('a REJECTED invite (403) is announced and keeps the typed target for retry', async () => {
      matrix.invite.and.rejectWith(new Error('invite failed: 403'));
      component.inviteUser = '@carol:test';
      await component.doInvite();
      fixture.detectChanges();
      expect(component.inviteUser).toBe('@carol:test'); // NOT cleared on failure
      const status = fixture.nativeElement.querySelector('[data-testid="member-list-status"]');
      expect(status).toBeTruthy();
      expect(status.getAttribute('role')).toBe('status');
      expect(status.textContent).toContain('Invite failed');
      expect(status.textContent).toContain('403');
    });

    it('a REJECTED kick (insufficient power level, 403) is announced — never a silent refresh', async () => {
      matrix.kick.and.rejectWith(new Error('kick failed: 403'));
      const target = component.members().find((m) => m.userId === '@admin:test')!;
      await component.doKick(target);
      fixture.detectChanges();
      const status = fixture.nativeElement.querySelector('[data-testid="member-list-status"]');
      expect(status).toBeTruthy();
      expect(status.textContent).toContain('Kick failed');
      expect(status.textContent).toContain('403');
      // The target row is still rendered — the kick did NOT apply.
      expect(fixture.nativeElement.querySelector('[data-testid="member-@admin:test"]')).toBeTruthy();
    });

    it('a server-ACCEPTED invite announces success and clears the input', async () => {
      component.inviteUser = '@carol:test';
      await component.doInvite();
      fixture.detectChanges();
      expect(component.inviteUser).toBe('');
      const status = fixture.nativeElement.querySelector('[data-testid="member-list-status"]');
      expect(status.textContent).toContain('Invited @carol:test');
    });
  });

  // ───────── HELP TEXT ─────────
  describe('help text wiring', () => {
    it('wires the invite input + button to present help', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(expectDescribedByHelp(el, '[data-testid="input-invite-user"]')).toContain('Matrix id');
      expectDescribedByHelp(el, '[data-testid="btn-invite"]');
    });

    it('describes the (destructive) kick action via help wired to every kick button', () => {
      const help = expectDescribedByHelp(fixture.nativeElement, '[data-testid="btn-kick-@admin:test"]');
      expect(help.toLowerCase()).toContain('removes a member');
      // and the kick button keeps a per-target accessible name
      expect(expectAccessibleName(fixture.nativeElement, '[data-testid="btn-kick-@admin:test"]'))
        .toContain('Kick');
    });
  });
});
