import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { RoomListComponent } from './room-list.component';
import { MatrixService, MatrixRoom } from './matrix.service';
import { SessionService, HugSession } from './session.service';
import { expectDescribedByHelp } from './a11y-help.spec-util';

/** Build a HugSession fixture carrying the given roles (drives the
 *  matrix_domainlocked marker the room list reads). */
function sessionWith(roles: string[]): HugSession {
  return {
    id: 'google:dana@tenant-a.test', label: 'dana@tenant-a.test', provider: 'google', roles,
    registrationComplete: true,
  };
}

class MatrixServiceStub {
  joinedRoomsDetailed = jasmine.createSpy('joinedRoomsDetailed').and.resolveTo([]);
  createRoom = jasmine.createSpy('createRoom').and.resolveTo('!new:test');
  joinRoom = jasmine.createSpy('joinRoom').and.resolveTo('!joined:test');
  leaveRoom = jasmine.createSpy('leaveRoom').and.resolveTo(undefined);
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('https://m/x');
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  getAccountData = jasmine.createSpy('getAccountData').and.resolveTo({});
  setAccountData = jasmine.createSpy('setAccountData').and.resolveTo(undefined);
  // Pending invites (rooms.invite) — default: none.
  pendingInvites = jasmine.createSpy('pendingInvites').and.resolveTo([]);
}

const ROOMS: MatrixRoom[] = [
  { roomId: '!grp:test', name: 'General' },
  { roomId: '!dm:test', name: 'Alice', isDirect: true, unreadCount: 3 },
];

describe('RoomListComponent', () => {
  let fixture: ComponentFixture<RoomListComponent>;
  let component: RoomListComponent;
  let matrix: MatrixServiceStub;

  beforeEach(async () => {
    localStorage.clear(); // default to a non-locked session state
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [RoomListComponent],
      providers: [provideRouter([]), { provide: MatrixService, useValue: matrix }],
    }).compileComponents();

    fixture = TestBed.createComponent(RoomListComponent);
    component = fixture.componentInstance;
    component.rooms = signal(ROOMS);
    component.selectedRoomId = '!grp:test';
    fixture.detectChanges();
  });

  it('renders as a labelled navigation landmark', () => {
    const nav = fixture.nativeElement.querySelector('[data-testid="room-list"]');
    expect(nav.tagName.toLowerCase()).toBe('nav');
    expect(nav.getAttribute('aria-label')).toBeTruthy();
  });

  it('splits rooms into People (DMs) and group Rooms', () => {
    expect(component.people().map((r) => r.roomId)).toEqual(['!dm:test']);
    expect(component.groups().map((r) => r.roomId)).toEqual(['!grp:test']);
  });

  // ───────── PENDING INVITES (the invitee's side — rooms.invite) ─────────
  describe('pending invites', () => {
    const INVITE = { roomId: '!inv:test', name: 'Secret plans', inviter: '@alice:test' };

    async function renderWithInvite(): Promise<void> {
      matrix.pendingInvites.and.resolveTo([INVITE]);
      fixture = TestBed.createComponent(RoomListComponent);
      component = fixture.componentInstance;
      component.rooms = signal(ROOMS);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('hides the Invites section entirely when there are none', async () => {
      await fixture.whenStable();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="invite-list"]')).toBeNull();
    });

    it('renders a pending invite row with the room name, the inviter and Accept/Decline controls', async () => {
      await renderWithInvite();
      const row = fixture.nativeElement.querySelector('[data-testid="invite-item-!inv:test"]');
      expect(row).toBeTruthy();
      expect(row.textContent).toContain('Secret plans');
      expect(row.textContent).toContain('invited by @alice:test');
      expect(row.querySelector('[data-testid="btn-accept-invite-!inv:test"]')).toBeTruthy();
      expect(row.querySelector('[data-testid="btn-decline-invite-!inv:test"]')).toBeTruthy();
    });

    it('Accept joins the invited room and drops the row', async () => {
      await renderWithInvite();
      await component.acceptInvite(INVITE);
      fixture.detectChanges();
      expect(matrix.joinRoom).toHaveBeenCalledWith('!inv:test');
      expect(fixture.nativeElement.querySelector('[data-testid="invite-item-!inv:test"]')).toBeNull();
    });

    it('Decline leaves the invited room (Matrix decline) and drops the row', async () => {
      await renderWithInvite();
      await component.declineInvite(INVITE);
      fixture.detectChanges();
      expect(matrix.leaveRoom).toHaveBeenCalledWith('!inv:test');
      expect(fixture.nativeElement.querySelector('[data-testid="invite-item-!inv:test"]')).toBeNull();
    });

    it('a REJECTED accept keeps the row and announces the failure as a role=alert', async () => {
      await renderWithInvite();
      matrix.joinRoom.and.rejectWith(new Error('joinRoom failed: 403'));
      await component.acceptInvite(INVITE);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="invite-item-!inv:test"]')).toBeTruthy();
      const err = fixture.nativeElement.querySelector('[data-testid="rl-invite-error"]');
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toContain('Could not accept the invite');
    });
  });

  it('reflects the create/DM toggles via aria-expanded', () => {
    const createBtn = fixture.nativeElement.querySelector('[data-testid="btn-create-room"]');
    expect(createBtn.getAttribute('aria-expanded')).toBe('false');
    createBtn.click();
    fixture.detectChanges();
    expect(createBtn.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector('[data-testid="dialog-create-room"]')).toBeTruthy();
  });

  it('marks the selected room with aria-current=page', () => {
    const active = fixture.nativeElement.querySelector('[data-testid="room-item-!grp:test"]');
    const other = fixture.nativeElement.querySelector('[data-testid="room-item-!dm:test"]');
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(other.getAttribute('aria-current')).toBeNull();
  });

  it('gives the unread badge a descriptive aria-label and hides the avatar', () => {
    const badge = fixture.nativeElement.querySelector('[data-testid="room-unread-!dm:test"]');
    expect(badge.getAttribute('aria-label')).toBe('3 unread messages');
    const avatar = fixture.nativeElement.querySelector('[data-testid="room-item-!dm:test"] .avatar');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
  });

  it('labels the join-by-alias input', () => {
    const input = fixture.nativeElement.querySelector('[data-testid="input-join-alias"]');
    const label = fixture.nativeElement.querySelector('label[for="join-alias"]');
    expect(input.id).toBe('join-alias');
    expect(label).toBeTruthy();
  });

  it('shows a role=alert error and does not create a room when the name is blank', async () => {
    component.showCreate.set(true);
    component.newName = '   ';
    fixture.detectChanges();
    await component.create(new Event('submit'));
    fixture.detectChanges();
    expect(matrix.createRoom).not.toHaveBeenCalled();
    const err = fixture.nativeElement.querySelector('[data-testid="create-room-error"]');
    expect(err).toBeTruthy();
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.getAttribute('aria-live')).toBe('assertive');
    const input = fixture.nativeElement.querySelector('#create-name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('creates a room when a valid name is supplied', async () => {
    component.showCreate.set(true);
    component.newName = 'Project X';
    await component.create(new Event('submit'));
    expect(matrix.createRoom).toHaveBeenCalled();
    expect(matrix.createRoom.calls.mostRecent().args[0].name).toBe('Project X');
  });

  // ───────── INVITE-AT-CREATION + announced create failures ─────────
  // The create dialog had no way to invite anyone (group creation was two
  // disconnected steps) and create() had no try/catch, so a server rejection
  // silently swallowed the dialog state.
  describe('create-room invites + announced create errors', () => {
    it('renders the optional invite input with help explaining comma-separated Matrix ids', () => {
      component.showCreate.set(true);
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector('[data-testid="input-create-invites"]');
      expect(input).toBeTruthy();
      expect(input.getAttribute('placeholder')).toBe('@user:server, @other:server');
      expect(expectDescribedByHelp(fixture.nativeElement, '[data-testid="input-create-invites"]')).toContain('comma');
    });

    it('passes the parsed invite array to createRoom (commas/whitespace split, empties dropped)', async () => {
      component.showCreate.set(true);
      component.newName = 'Group';
      component.newInvites = ' @a:test,, @b:test  @c:test , ';
      await component.create(new Event('submit'));
      expect(matrix.createRoom.calls.mostRecent().args[0].invite).toEqual(['@a:test', '@b:test', '@c:test']);
    });

    it('omits the invite field entirely when the input is blank', async () => {
      component.showCreate.set(true);
      component.newName = 'Solo';
      component.newInvites = '   ';
      await component.create(new Event('submit'));
      expect(matrix.createRoom.calls.mostRecent().args[0].invite).toBeUndefined();
    });

    it('REJECTS a malformed invitee with an announced error NAMING the bad entry, never calling createRoom', async () => {
      component.showCreate.set(true);
      component.newName = 'Group';
      component.newInvites = '@ok:test, bogus:test';
      fixture.detectChanges();
      await component.create(new Event('submit'));
      fixture.detectChanges();
      expect(matrix.createRoom).not.toHaveBeenCalled();
      const err = fixture.nativeElement.querySelector('[data-testid="rl-create-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.getAttribute('aria-live')).toBe('assertive');
      expect(err.textContent).toContain('bogus:test');
    });

    it('announces a server-REJECTED create as a role=alert and keeps the dialog open with its state', async () => {
      matrix.createRoom.and.rejectWith(new Error('createRoom failed: 403'));
      component.showCreate.set(true);
      component.newName = 'Group';
      component.newInvites = '@a:test';
      fixture.detectChanges();
      await component.create(new Event('submit'));
      fixture.detectChanges();
      const err = fixture.nativeElement.querySelector('[data-testid="rl-create-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toContain('Could not create the room');
      expect(err.textContent).toContain('403');
      // The dialog and its state survive so the user can correct and retry.
      expect(component.showCreate()).toBeTrue();
      expect(component.newName).toBe('Group');
      expect(component.newInvites).toBe('@a:test');
    });

    it('clears the inputs (invites included) and closes the dialog only on SUCCESS', async () => {
      component.showCreate.set(true);
      component.newName = 'Group';
      component.newInvites = '@a:test';
      await component.create(new Event('submit'));
      expect(component.newInvites).toBe('');
      expect(component.newName).toBe('');
      expect(component.showCreate()).toBeFalse();
      expect(component.createError()).toBe('');
    });

    it('domain-locked: REJECTS a provably cross-domain invitee with the lock why-notice, never creating', async () => {
      TestBed.inject(SessionService).set(sessionWith(['user', 'matrix_domainlocked']));
      matrix.whoami.and.resolveTo('@dana:tenant-a.test');
      component.showCreate.set(true);
      component.newName = 'Group';
      component.newInvites = '@local:tenant-a.test, @remote:tenant-b.test';
      fixture.detectChanges();
      await component.create(new Event('submit'));
      fixture.detectChanges();
      expect(matrix.createRoom).not.toHaveBeenCalled();
      const err = fixture.nativeElement.querySelector('[data-testid="rl-create-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toContain('@remote:tenant-b.test');
      expect(err.textContent).toContain('another server');
      expect(err.textContent).toContain('domain-locked');
      TestBed.inject(SessionService).clear();
    });

    it('domain-locked: never blocks LOCAL invitees (same-server ids go through)', async () => {
      TestBed.inject(SessionService).set(sessionWith(['user', 'matrix_domainlocked']));
      matrix.whoami.and.resolveTo('@dana:tenant-a.test');
      component.showCreate.set(true);
      component.newName = 'Group';
      component.newInvites = '@bob:tenant-a.test';
      await component.create(new Event('submit'));
      expect(matrix.createRoom).toHaveBeenCalled();
      expect(matrix.createRoom.calls.mostRecent().args[0].invite).toEqual(['@bob:tenant-a.test']);
      expect(component.createError()).toBe('');
      TestBed.inject(SessionService).clear();
    });
  });

  // ───────── HELP TEXT: sighted hint + screen-reader association ─────────
  describe('help text wiring', () => {
    it('wires the create / DM / join controls to visible, present help via aria-describedby', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(expectDescribedByHelp(el, '[data-testid="btn-create-room"]')).toContain('create');
      expect(expectDescribedByHelp(el, '[data-testid="btn-start-dm"]')).toContain('one-to-one');
      expect(expectDescribedByHelp(el, '[data-testid="input-join-alias"]')).toContain('alias');
      expect(expectDescribedByHelp(el, '[data-testid="btn-join-alias"]')).toBeTruthy();
    });

    it('explains the room-privacy preset choices in help wired to the select', () => {
      component.showCreate.set(true);
      fixture.detectChanges();
      const help = expectDescribedByHelp(fixture.nativeElement, '#create-preset');
      expect(help.toLowerCase()).toContain('private');
      expect(help.toLowerCase()).toContain('public');
    });
  });

  // ───────── join failures are ANNOUNCED, never silently swallowed ─────────
  it('announces a rejected join in a role=alert notice (server-side DENY surfaced)', async () => {
    matrix.joinRoom.and.rejectWith(new Error('joinRoom failed: 403'));
    component.joinAlias = '#room:tenant-a.test';
    await component.joinByAlias();
    fixture.detectChanges();
    const err = fixture.nativeElement.querySelector('[data-testid="rl-join-error"]');
    expect(err).toBeTruthy();
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain('Could not join');
    expect(err.textContent).toContain('403');
  });

  // ───────── SOCIAL LOCAL-ONLY (matrix_domainlocked) enforcement ─────────
  describe('domain-locked (matrix_domainlocked) federation steering', () => {
    beforeEach(() => {
      TestBed.inject(SessionService).set(sessionWith(['user', 'matrix_domainlocked']));
      fixture.detectChanges();
    });

    afterEach(() => TestBed.inject(SessionService).clear());

    it('augments the join help with the local-only WHY-note (aria-describedby wired)', () => {
      const note = fixture.nativeElement.querySelector('[data-testid="rl-join-lock-note"]');
      expect(note).toBeTruthy();
      expect(note.textContent).toContain('domain-locked');
      // The note lives INSIDE the rl-join-help target already wired to the input.
      expect(expectDescribedByHelp(fixture.nativeElement, '[data-testid="input-join-alias"]')).toContain('domain-locked');
    });

    it('augments the DM help with the local-only WHY-note', () => {
      const note = fixture.nativeElement.querySelector('[data-testid="rl-dm-lock-note"]');
      expect(note).toBeTruthy();
      expect(note.textContent).toContain('domain-locked');
    });

    it('REJECTS a provably cross-domain join with an announced notice and never calls joinRoom', async () => {
      matrix.whoami.and.resolveTo('@dana:tenant-a.test');
      component.joinAlias = '#room:evil.test';
      await component.joinByAlias();
      fixture.detectChanges();
      expect(matrix.joinRoom).not.toHaveBeenCalled();
      const err = fixture.nativeElement.querySelector('[data-testid="rl-join-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toContain('another server');
      expect(err.textContent).toContain('domain-locked');
    });

    it('never blocks a LOCAL join (same-server alias goes through)', async () => {
      matrix.whoami.and.resolveTo('@dana:tenant-a.test');
      component.joinAlias = '#lounge:tenant-a.test';
      await component.joinByAlias();
      expect(matrix.joinRoom).toHaveBeenCalledWith('#lounge:tenant-a.test');
      expect(component.joinError()).toBe('');
    });

    it('REJECTS a provably cross-domain DM with an announced notice and never creates the room', async () => {
      matrix.whoami.and.resolveTo('@dana:tenant-a.test');
      component.showDm.set(true);
      component.dmUser = '@user:tenant-b.test';
      fixture.detectChanges();
      await component.startDm(new Event('submit'));
      fixture.detectChanges();
      expect(matrix.createRoom).not.toHaveBeenCalled();
      const err = fixture.nativeElement.querySelector('[data-testid="rl-dm-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toContain('another server');
      expect(err.textContent).toContain('domain-locked');
    });

    it('never blocks a LOCAL DM (same-server target goes through)', async () => {
      matrix.whoami.and.resolveTo('@dana:tenant-a.test');
      component.showDm.set(true);
      component.dmUser = '@bob:tenant-a.test';
      await component.startDm(new Event('submit'));
      expect(matrix.createRoom).toHaveBeenCalled();
      expect(component.dmError()).toBe('');
    });

    it('explains a server-side join rejection with the domain-lock WHY when the target is not provably cross-domain', async () => {
      // whoami unavailable (e.g. proxy down) ⇒ the defence-in-depth gate cannot
      // prove cross-domain and MUST attempt the join; the homeserver rejection
      // is then announced WITH the lock explanation.
      matrix.whoami.and.rejectWith(new Error('whoami failed'));
      matrix.joinRoom.and.rejectWith(new Error('joinRoom failed: 403'));
      component.joinAlias = '#room:evil.test';
      await component.joinByAlias();
      fixture.detectChanges();
      const err = fixture.nativeElement.querySelector('[data-testid="rl-join-error"]');
      expect(err.textContent).toContain('Could not join');
      expect(err.textContent).toContain('domain-locked');
    });
  });
});
