import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';

import { MatrixChatComponent } from './matrix-chat.component';
import { RoomViewComponent } from './room-view.component';
import { MemberListComponent } from './member-list.component';
import { RoomSettingsComponent } from './room-settings.component';
import {
  BFF_BASE_URL, MATRIX_BASE_URL, MATRIX_ROOM_JOINED_EVENT, MatrixForbiddenError, MatrixService, RoomPreview,
  RoomSummary, SyncState,
} from './matrix.service';
import { expectDescribedByHelp } from './a11y-help.spec-util';

/**
 * GUI-16: a 403 used to render as an ordinary EMPTY state.
 *
 *  1. ACCOUNT refused (no matrix role → the role gate's empty-body 403 on
 *     whoami / joined_rooms / sync): the client showed "Select a room to start
 *     chatting" with no explanation, and the sync loop retried the 403 every 2s
 *     for the life of the tab.
 *  2. ROOM refused (a non-member opening a public room → the homeserver's
 *     M_FORBIDDEN on /state and /joined_members): an empty timeline,
 *     "0 members" / "Members (0)", no way to join, and room settings with
 *     editable name/topic fields over blank values.
 *
 * Both are pinned here, at the component level (what the user sees) and at the
 * service level (the 403 must survive the trip out of MatrixService).
 */

const ROOM = '!pub:test';
const ACCESS_COPY = 'Your account does not have Matrix access — ask an administrator';

/** The role gate's refusal: a 403 with NO Matrix errcode. */
const roleGate = (endpoint: string) => new MatrixForbiddenError(endpoint, null);
/** The homeserver's refusal of one room to a non-member. */
const notMember = (endpoint: string) => new MatrixForbiddenError(endpoint, 'M_FORBIDDEN');

function forbiddenSync(): SyncState {
  return {
    failed: true, status: 403, forbidden: roleGate('sync'),
    nextBatch: '', rooms: {}, invites: {}, accountData: {}, presence: {},
  };
}

const PUBLIC_PREVIEW: RoomPreview = {
  roomId: ROOM, name: 'E2E Public Room X', canonicalAlias: '#x:test', joinRule: 'public', numJoinedMembers: 2,
};

/** Drain queued promise continuations (the sync loops chain several awaits). */
async function microtasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Advance the (installed) fake clock through `windows` sync back-off windows,
 *  letting the loop run between them. */
async function backoffWindows(windows: number): Promise<void> {
  for (let i = 0; i < windows; i++) {
    jasmine.clock().tick(2001);
    await microtasks();
  }
}

// ───────────────────────────── chat shell (/social/matrix) ─────────────────────────────

class ChatStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  whoamiAccess = jasmine.createSpy('whoamiAccess').and.resolveTo({ userId: '@me:test', forbidden: null });
  joinedRoomsDetailed = jasmine.createSpy('joinedRoomsDetailed').and.resolveTo([]);
  sync = jasmine.createSpy('sync').and.callFake(() => Promise.resolve(forbiddenSync()));
  pendingInvites = jasmine.createSpy('pendingInvites').and.resolveTo([]);
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('');
}

describe('GUI-16 — chat shell when Matrix is refused to the ACCOUNT (403)', () => {
  let fixture: ComponentFixture<MatrixChatComponent>;
  let component: MatrixChatComponent;
  let matrix: ChatStub;

  beforeEach(async () => {
    matrix = new ChatStub();
    await TestBed.configureTestingModule({
      imports: [MatrixChatComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MatrixService, useValue: matrix },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap({}) },
            paramMap: of(convertToParamMap({})),
            queryParamMap: of(convertToParamMap({})),
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MatrixChatComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => component.ngOnDestroy());

  it('a 403 whoami renders the no-access explanation instead of an empty client — no room list, no sync', async () => {
    matrix.whoami.and.resolveTo(null);
    matrix.whoamiAccess.and.resolveTo({ userId: null, forbidden: roleGate('whoami') });

    await component.ngOnInit();
    await microtasks();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const notice = el.querySelector('[data-testid="matrix-access-denied"]');
    expect(notice).withContext('no-access notice').toBeTruthy();
    expect(notice!.textContent).toContain(ACCESS_COPY);
    expect(notice!.getAttribute('role')).toBe('alert');
    // Not the old empty client:
    expect(el.textContent).not.toContain('Select a room to start chatting');
    expect(el.querySelector('hug-room-list')).withContext('room list never mounts').toBeNull();
    // Nothing that can only be refused again is even attempted.
    expect(matrix.sync).not.toHaveBeenCalled();
    expect(matrix.joinedRoomsDetailed).not.toHaveBeenCalled();
  });

  it('a 403 sync STOPS the loop — no retry across several back-off windows — and explains why', async () => {
    jasmine.clock().install();
    try {
      await component.ngOnInit();
      await microtasks();
      expect(matrix.sync).toHaveBeenCalledTimes(1);

      await backoffWindows(4);

      // Before the fix: one more /sync per 2s window, for as long as the tab is open.
      expect(matrix.sync).toHaveBeenCalledTimes(1);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="matrix-access-denied"]')?.textContent).toContain(ACCESS_COPY);
      expect(el.querySelector('hug-room-list')).toBeNull();
      expect(el.textContent).not.toContain('Select a room to start chatting');
    } finally {
      component.ngOnDestroy();
      jasmine.clock().uninstall();
    }
  });

  it('a NON-403 failed sync (502) still backs off and retries — only a 403 is terminal', async () => {
    matrix.sync.and.callFake(() => Promise.resolve({
      failed: true, status: 502, nextBatch: '', rooms: {}, invites: {}, accountData: {}, presence: {},
    } as SyncState));
    jasmine.clock().install();
    try {
      await component.ngOnInit();
      await microtasks();
      await backoffWindows(3);
      expect(matrix.sync).toHaveBeenCalledTimes(4);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="matrix-access-denied"]')).toBeNull();
    } finally {
      component.ngOnDestroy();
      jasmine.clock().uninstall();
    }
  });
});

// ─────────────────────────── room view (/rooms/:roomId) ───────────────────────────

class RoomStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  roomSummary = jasmine.createSpy('roomSummary').and.rejectWith(notMember('state'));
  joinedMembers = jasmine.createSpy('joinedMembers').and.rejectWith(notMember('joined_members'));
  roomPreview = jasmine.createSpy('roomPreview').and.resolveTo(PUBLIC_PREVIEW);
  joinRoom = jasmine.createSpy('joinRoom').and.resolveTo(ROOM);
  messages = jasmine.createSpy('messages').and.resolveTo({ events: [], start: '', end: '' });
  getRelations = jasmine.createSpy('getRelations').and.resolveTo([]);
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('');
  sendReceipt = jasmine.createSpy('sendReceipt').and.resolveTo(undefined);
  setReadMarker = jasmine.createSpy('setReadMarker').and.resolveTo(undefined);
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('');
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
  // The deep-link route runs its own sync loop; park it by default.
  sync = jasmine.createSpy('sync').and.returnValue(new Promise<SyncState>(() => undefined));
}

describe('GUI-16 — room view when the room or the account is refused (403)', () => {
  let fixture: ComponentFixture<RoomViewComponent>;
  let component: RoomViewComponent;
  let matrix: RoomStub;

  async function settle(turns = 6): Promise<void> {
    for (let i = 0; i < turns; i++) await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    matrix = new RoomStub();
    await TestBed.configureTestingModule({
      imports: [RoomViewComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ roomId: ROOM })), snapshot: { queryParamMap: convertToParamMap({}) } },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(RoomViewComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => fixture.destroy());

  it('a NON-MEMBER of a public room is told so and offered Join — not an empty timeline with "0 members"', async () => {
    fixture.detectChanges();
    await settle();

    const el: HTMLElement = fixture.nativeElement;
    const notice = el.querySelector('[data-testid="room-not-member"]');
    expect(notice).withContext('not-member notice').toBeTruthy();
    expect(notice!.textContent).toContain('You are not a member of this room');
    expect(el.querySelector('[data-testid="btn-join-room"]')).withContext('Join offered for a public room').toBeTruthy();
    expectDescribedByHelp(el, '[data-testid="btn-join-room"]');
    // The room is named from what a non-member may see, and the count is the real one.
    expect(el.querySelector('[data-testid="room-name"]')!.textContent).toContain('E2E Public Room X');
    expect(el.querySelector('[data-testid="room-header"]')!.textContent).not.toContain('0 members');
    expect(el.querySelector('[data-testid="room-member-count"]')!.textContent).toContain('2 members');
    // No timeline to fail and no composer to type into a room we cannot post to.
    expect(el.querySelector('hug-timeline')).toBeNull();
    expect(el.querySelector('hug-composer')).toBeNull();
    expect(matrix.roomPreview).toHaveBeenCalledWith(ROOM);
  });

  it('Join joins the room, announces it to sibling panes, then loads it as a member', async () => {
    fixture.detectChanges();
    await settle();
    const joined: string[] = [];
    const onJoined = (e: Event) => joined.push((e as CustomEvent<{ roomId: string }>).detail.roomId);
    window.addEventListener(MATRIX_ROOM_JOINED_EVENT, onJoined);
    try {
      // From here on the homeserver lets us in.
      matrix.roomSummary.and.resolveTo({ name: 'E2E Public Room X' } as RoomSummary);
      matrix.joinedMembers.and.resolveTo([{ userId: '@me:test', membership: 'join', powerLevel: 0 }]);

      (fixture.nativeElement.querySelector('[data-testid="btn-join-room"]') as HTMLButtonElement).click();
      await settle();

      expect(matrix.joinRoom).toHaveBeenCalledWith(ROOM);
      expect(joined).toEqual([ROOM]);
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="room-not-member"]')).toBeNull();
      expect(el.querySelector('hug-composer')).toBeTruthy();
      expect(el.querySelector('[data-testid="room-member-count"]')!.textContent).toContain('1 members');
    } finally {
      window.removeEventListener(MATRIX_ROOM_JOINED_EVENT, onJoined);
    }
  });

  it('a refused Join is ANNOUNCED and the prompt stays', async () => {
    matrix.joinRoom.and.rejectWith(new Error('joinRoom failed: 403'));
    fixture.detectChanges();
    await settle();
    (fixture.nativeElement.querySelector('[data-testid="btn-join-room"]') as HTMLButtonElement).click();
    await settle();
    const status = fixture.nativeElement.querySelector('[data-testid="room-join-status"]');
    expect(status?.textContent).toContain('joinRoom failed: 403');
    expect(fixture.nativeElement.querySelector('[data-testid="room-not-member"]')).toBeTruthy();
  });

  it('offers NO Join button for a room that is not public (or whose summary is refused)', async () => {
    matrix.roomPreview.and.resolveTo(null);
    fixture.detectChanges();
    await settle();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="room-not-member"]')!.textContent).toContain('You are not a member of this room');
    expect(el.querySelector('[data-testid="btn-join-room"]')).toBeNull();
    expect(el.querySelector('[data-testid="room-invite-help"]')!.textContent).toContain('invite');
    expect(el.querySelector('[data-testid="room-member-count"]')).withContext('no false "0 members"').toBeNull();
  });

  it('an ACCOUNT-level refusal (role gate, no errcode) says "no Matrix access", offers no Join, and stops its own sync loop', async () => {
    matrix.roomSummary.and.rejectWith(roleGate('state'));
    matrix.joinedMembers.and.rejectWith(roleGate('joined_members'));
    matrix.sync.and.callFake(() => Promise.resolve(forbiddenSync()));
    jasmine.clock().install();
    try {
      fixture.detectChanges();
      await microtasks(40);
      await backoffWindows(4);
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="matrix-access-denied"]')?.textContent).toContain(ACCESS_COPY);
      expect(el.querySelector('[data-testid="btn-join-room"]')).toBeNull();
      expect(el.querySelector('[data-testid="room-not-member"]')).toBeNull();
      expect(matrix.roomPreview).not.toHaveBeenCalled();
      // Before the fix: one /sync per 2s back-off window, forever.
      expect(matrix.sync.calls.count()).toBeLessThanOrEqual(1);
    } finally {
      fixture.destroy();
      jasmine.clock().uninstall();
    }
  });

  it('its own sync loop stops on a 403 sync by itself — even while the room\'s state has not answered yet', async () => {
    matrix.roomSummary.and.returnValue(new Promise<RoomSummary>(() => undefined));
    matrix.sync.and.callFake(() => Promise.resolve(forbiddenSync()));
    jasmine.clock().install();
    try {
      fixture.detectChanges();
      await microtasks(40);
      await backoffWindows(4);
      fixture.detectChanges();

      expect(matrix.sync).toHaveBeenCalledTimes(1);
      expect(fixture.nativeElement.querySelector('[data-testid="matrix-access-denied"]')?.textContent).toContain(ACCESS_COPY);
    } finally {
      fixture.destroy();
      jasmine.clock().uninstall();
    }
  });
});

// ─────────────────────── member list (/rooms/:roomId/members) ───────────────────────

class MembersStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  joinedMembers = jasmine.createSpy('joinedMembers').and.rejectWith(notMember('joined_members'));
  invite = jasmine.createSpy('invite').and.resolveTo(undefined);
  kick = jasmine.createSpy('kick').and.resolveTo(undefined);
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('');
}

describe('GUI-16 — member list when the roster is refused (403)', () => {
  let fixture: ComponentFixture<MemberListComponent>;
  let matrix: MembersStub;

  async function create(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(MemberListComponent);
    fixture.detectChanges();
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  beforeEach(async () => {
    matrix = new MembersStub();
    await TestBed.configureTestingModule({
      imports: [MemberListComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MatrixService, useValue: matrix },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ roomId: ROOM })) } },
      ],
    }).compileComponents();
  });

  afterEach(() => fixture?.destroy());

  it('a non-member sees "not a member", never "Members (0)" beside a live invite box', async () => {
    const el = await create();
    expect(el.querySelector('[data-testid="member-list-not-member"]')?.textContent).toContain('You are not a member of this room');
    expect(el.querySelector('h3')!.textContent).not.toContain('(0)');
    expect(el.querySelector('[data-testid="input-invite-user"]')).toBeNull();
    expect(el.querySelector('[data-testid="btn-invite"]')).toBeNull();
  });

  it('re-reads the roster when the room view announces it joined this room', async () => {
    const el = await create();
    matrix.joinedMembers.and.resolveTo([{ userId: '@me:test', membership: 'join', powerLevel: 0 }]);
    window.dispatchEvent(new CustomEvent(MATRIX_ROOM_JOINED_EVENT, { detail: { roomId: ROOM } }));
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="member-list-not-member"]')).toBeNull();
    expect(el.querySelector('h3')!.textContent).toContain('Members (1)');
  });

  it('an account-level refusal says "no Matrix access"', async () => {
    matrix.joinedMembers.and.rejectWith(roleGate('joined_members'));
    const el = await create();
    expect(el.querySelector('[data-testid="matrix-access-denied"]')?.textContent).toContain(ACCESS_COPY);
    expect(el.querySelector('[data-testid="member-list-not-member"]')).toBeNull();
  });
});

// ───────────────────── room settings (/rooms/:roomId/settings) ─────────────────────

class SettingsStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  roomSummary = jasmine.createSpy('roomSummary').and.rejectWith(notMember('state'));
  roomPreview = jasmine.createSpy('roomPreview').and.resolveTo({ ...PUBLIC_PREVIEW, topic: 'Public chatter' });
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$state');
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
  invite = jasmine.createSpy('invite').and.resolveTo(undefined);
  leaveRoom = jasmine.createSpy('leaveRoom').and.resolveTo(undefined);
  uploadMedia = jasmine.createSpy('uploadMedia').and.resolveTo({ contentUri: 'mxc://x', mxcUri: 'mxc://x' });
}

describe('GUI-16 — room settings when the room or the account is refused (403)', () => {
  let fixture: ComponentFixture<RoomSettingsComponent>;
  let component: RoomSettingsComponent;
  let matrix: SettingsStub;

  async function create(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(RoomSettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement;
  }

  beforeEach(async () => {
    localStorage.clear();
    matrix = new SettingsStub();
    await TestBed.configureTestingModule({
      imports: [RoomSettingsComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ roomId: ROOM })) } },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    localStorage.clear();
  });

  it('a non-member gets READ-ONLY settings — every control disabled and described, the room\'s real name shown', async () => {
    const el = await create();
    expect(el.querySelector('[data-testid="room-settings-not-member"]')?.textContent).toContain('You are not a member of this room');
    for (const sel of [
      '[data-testid="input-room-name"]', '[data-testid="input-room-topic"]', '[data-testid="input-room-avatar"]',
      '[data-testid="btn-save-room"]', '[data-testid="input-invite"]', '[data-testid="btn-room-invite"]',
      '[data-testid="btn-leave-room"]', '[data-testid="input-mesh-enabled"]', '[data-testid="btn-save-chat3d"]',
    ]) {
      const ctl = el.querySelector(sel) as HTMLInputElement | HTMLButtonElement;
      expect(ctl).withContext(sel).toBeTruthy();
      expect(ctl.disabled).withContext(`${sel} disabled`).toBeTrue();
      // Never a bare disabled control: each one says WHY.
      expect(expectDescribedByHelp(el, sel)).withContext(sel).toContain('not a member');
    }
    // Not blank values posing as editable ones: what a non-member may see.
    expect((el.querySelector('[data-testid="input-room-name"]') as HTMLInputElement).value).toBe('E2E Public Room X');
    expect((el.querySelector('[data-testid="input-room-topic"]') as HTMLInputElement).value).toBe('Public chatter');
  });

  it('the verbs refuse too (defence in depth) — no state write, invite or leave for a non-member', async () => {
    await create();
    component.inviteUser = '@bob:test';
    await component.save();
    await component.doInvite();
    await component.leave();
    expect(matrix.setStateEvent).not.toHaveBeenCalled();
    expect(matrix.invite).not.toHaveBeenCalled();
    expect(matrix.leaveRoom).not.toHaveBeenCalled();
    expect(component.status()).toContain('not a member');
  });

  it('an account-level refusal says "no Matrix access" and shows no form at all', async () => {
    matrix.roomSummary.and.rejectWith(roleGate('state'));
    const el = await create();
    expect(el.querySelector('[data-testid="matrix-access-denied"]')?.textContent).toContain(ACCESS_COPY);
    expect(el.querySelector('[data-testid="input-room-name"]')).toBeNull();
    expect(el.querySelector('[data-testid="btn-leave-room"]')).toBeNull();
  });
});

// ─────────────────────────── the service keeps the 403 ───────────────────────────

/** Minimal fetch Response stub; `body` undefined = an EMPTY body (the role gate). */
function response(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

describe('GUI-16 — MatrixService surfaces the 403 instead of swallowing it', () => {
  let service: MatrixService;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MATRIX_BASE_URL, useValue: 'https://matrix.test' },
        { provide: BFF_BASE_URL, useValue: 'https://bff.test' },
        MatrixService,
      ],
    });
    service = TestBed.inject(MatrixService);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  it('whoamiAccess(): the role gate\'s EMPTY-body 403 is an account refusal (and never trips over .json())', async () => {
    fetchSpy.and.resolveTo(response(403));
    const r = await service.whoamiAccess();
    expect(r.userId).toBeNull();
    expect(r.forbidden).toEqual(jasmine.any(MatrixForbiddenError));
    expect(r.forbidden!.accountLevel).toBeTrue();
    // whoami() keeps its fail-soft null contract for every other caller.
    expect(await service.whoami()).toBeNull();
  });

  it('whoamiAccess(): a 401 / 502 is NOT an access refusal', async () => {
    fetchSpy.and.resolveTo(response(401));
    expect((await service.whoamiAccess()).forbidden).toBeNull();
    fetchSpy.and.resolveTo(response(502));
    expect((await service.whoamiAccess()).forbidden).toBeNull();
  });

  it('sync(): a 403 is marked forbidden (terminal); a 502 is only failed (retry)', async () => {
    fetchSpy.and.resolveTo(response(403));
    const denied = await service.sync('s1', 0);
    expect(denied.failed).toBeTrue();
    expect(denied.status).toBe(403);
    expect(denied.forbidden).toEqual(jasmine.any(MatrixForbiddenError));

    fetchSpy.and.resolveTo(response(502));
    const flaky = await service.sync('s1', 0);
    expect(flaky.failed).toBeTrue();
    expect(flaky.forbidden).toBeUndefined();
  });

  it('roomSummary() / joinedMembers() THROW the homeserver\'s M_FORBIDDEN as a ROOM refusal', async () => {
    fetchSpy.and.resolveTo(response(403, { errcode: 'M_FORBIDDEN', error: 'You aren\'t a member of the room.' }));
    await expectAsync(service.roomSummary(ROOM)).toBeRejectedWith(jasmine.objectContaining({ errcode: 'M_FORBIDDEN', accountLevel: false }));
    await expectAsync(service.joinedMembers(ROOM)).toBeRejectedWith(jasmine.objectContaining({ errcode: 'M_FORBIDDEN', accountLevel: false }));
  });

  it('roomState() keeps its fail-soft [] for the chat3d / VN callers', async () => {
    fetchSpy.and.resolveTo(response(403, { errcode: 'M_FORBIDDEN' }));
    expect(await service.roomState(ROOM)).toEqual([]);
  });

  it('roomPreview(): an absent join_rule means PUBLIC (spec default; tuwunel omits it)', async () => {
    fetchSpy.and.resolveTo(response(200, {
      room_id: ROOM, name: 'E2E Public Room X', num_joined_members: 2, world_readable: false, guest_can_join: false,
      membership: 'leave',
    }));
    const p = await service.roomPreview(ROOM);
    expect(String(fetchSpy.calls.mostRecent().args[0])).toContain('/_matrix/client/v1/room_summary/');
    expect(p).toEqual(jasmine.objectContaining({ roomId: ROOM, name: 'E2E Public Room X', joinRule: 'public', numJoinedMembers: 2 }));
  });

  it('roomPreview(): keeps an explicit join_rule, falls back to the MSC3266 path on a 404, and is null when refused', async () => {
    fetchSpy.and.resolveTo(response(200, { room_id: ROOM, join_rule: 'knock', num_joined_members: 1 }));
    expect((await service.roomPreview(ROOM))?.joinRule).toBe('knock');

    fetchSpy.and.returnValues(
      Promise.resolve(response(404, { errcode: 'M_UNRECOGNIZED' })),
      Promise.resolve(response(200, { room_id: ROOM, num_joined_members: 3 })),
    );
    expect((await service.roomPreview(ROOM))?.numJoinedMembers).toBe(3);
    expect(String(fetchSpy.calls.mostRecent().args[0])).toContain('/unstable/im.nheko.summary/rooms/');

    fetchSpy.and.resolveTo(response(403, { errcode: 'M_FORBIDDEN' }));
    expect(await service.roomPreview(ROOM)).toBeNull();
  });
});
