import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SimpleChanges, WritableSignal, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { RoomViewComponent } from './room-view.component';
import { HugCharacterPanelComponent } from './vn/hug-character-panel.component';
import { MatrixService, RoomMember, RoomSummary, TimelineEvent } from './matrix.service';

type SyncRoom = { timeline: TimelineEvent[]; typing: string[] } | null;

class MatrixServiceStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  roomSummary = jasmine.createSpy('roomSummary').and.resolveTo({ name: 'General', topic: 'Welcome' } as RoomSummary);
  joinedMembers = jasmine.createSpy('joinedMembers').and.resolveTo([{ userId: '@me:test', membership: 'join', powerLevel: 0 }]);
  messages = jasmine.createSpy('messages').and.resolveTo({ events: [], start: '', end: '' });
  getRelations = jasmine.createSpy('getRelations').and.resolveTo([]);
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('');
  sendReceipt = jasmine.createSpy('sendReceipt').and.resolveTo(undefined);
  setReadMarker = jasmine.createSpy('setReadMarker').and.resolveTo(undefined);
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('');
  // Chat3dStateService reads the net.hugmesh.chat3d room state through
  // this; null = unset ⇒ the 3D-room button stays hidden by default.
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
}

describe('RoomViewComponent', () => {
  let fixture: ComponentFixture<RoomViewComponent>;
  let component: RoomViewComponent;
  let matrix: MatrixServiceStub;
  // A writable syncRoom signal bound as the input BEFORE first change detection,
  // so the component's typingUsers/liveEvents computeds track it; tests drive it
  // via .set() (matching how the host shell feeds a single live signal in).
  let syncRoom: WritableSignal<SyncRoom>;

  beforeEach(async () => {
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [RoomViewComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ roomId: '!r:test' })), snapshot: { queryParamMap: convertToParamMap({}) } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RoomViewComponent);
    component = fixture.componentInstance;
    syncRoom = signal<SyncRoom>(null);
    component.syncRoom = syncRoom;
    fixture.detectChanges();
    // ngOnInit chains whoami -> paramMap -> load() -> roomSummary + joinedMembers;
    // flush a few turns so every chained promise settles before assertions.
    for (let i = 0; i < 4; i++) {
      await fixture.whenStable();
    }
    fixture.detectChanges();
  });

  it('loads the room summary + member count from the route param', () => {
    expect(component.roomId()).toBe('!r:test');
    expect(component.summary()?.name).toBe('General');
    expect(component.memberCount()).toBe(1);
  });

  it('renders the header icon links with aria-labels (not emoji-only names)', () => {
    const members = fixture.nativeElement.querySelector('[data-testid="btn-member-list"]');
    const search = fixture.nativeElement.querySelector('[data-testid="btn-room-search"]');
    const settings = fixture.nativeElement.querySelector('[data-testid="btn-room-settings"]');
    expect(members.getAttribute('aria-label')).toBe('Members');
    expect(search.getAttribute('aria-label')).toBe('Search this room');
    expect(settings.getAttribute('aria-label')).toBe('Room settings');
    // The glyph is decorative.
    expect(members.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('renders the call-entry links carrying the room id + mode to the /call route', () => {
    const vn: HTMLAnchorElement = fixture.nativeElement.querySelector('[data-testid="btn-call-vn-voice"]');
    const video: HTMLAnchorElement = fixture.nativeElement.querySelector('[data-testid="btn-call-video"]');
    expect(vn).toBeTruthy();
    expect(video).toBeTruthy();
    expect(vn.getAttribute('aria-label')).toBe('Voice chat (VN)');
    expect(video.getAttribute('aria-label')).toBe('Video call');
    // routerLink '/call' + queryParams { room, mode } — the call view reads
    // ?room= for the target room and ?mode= for the render mode.
    expect(vn.getAttribute('href')).toContain('/call');
    expect(vn.getAttribute('href')).toContain('mode=vn-voice');
    // decodeURIComponent-tolerant: the serializer may or may not escape !/:.
    expect(decodeURIComponent(vn.getAttribute('href') ?? '')).toContain('room=!r:test');
    expect(video.getAttribute('href')).toContain('/call');
    expect(video.getAttribute('href')).toContain('mode=video');
    // The glyphs are decorative.
    expect(vn.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(video.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('FAIL-SOFT: a rejected whoami still resolves the room from the route (the view never blanks)', async () => {
    // Regression pin: the whoami await used to sit UNGUARDED before the
    // paramMap subscription, so a BFF outage (or a proxy answering HTML to a
    // JSON fetch) blanked the entire room view — header, timeline, composer.
    matrix.whoami.and.rejectWith(new Error('bff down'));
    const fx = TestBed.createComponent(RoomViewComponent);
    fx.componentInstance.syncRoom = signal<SyncRoom>(null);
    fx.detectChanges();
    for (let i = 0; i < 4; i++) {
      await fx.whenStable();
    }
    fx.detectChanges();
    expect(fx.componentInstance.roomId()).toBe('!r:test'); // route still resolved
    expect(fx.componentInstance.me()).toBeNull(); // identity degraded, not fatal
    expect(fx.nativeElement.querySelector('[data-testid="room-header"]')).toBeTruthy();
  });

  it('hides the 3D-room button while the chat3d state is unset (no dangling door)', () => {
    // The default stub resolves null (state unset) — the button must not render.
    expect(component.chat3dEnabled()).toBeFalse();
    expect(fixture.nativeElement.querySelector('[data-testid="btn-chat3d"]')).toBeNull();
  });

  it('shows the 3D-room button ONLY when the room chat3d state parses ENABLED (strict === true)', async () => {
    matrix.getStateEvent.and.resolveTo({ enabled: true, style: 'noir', maxParticipants: 8, allowMedia: true, stageModOnly: true });
    const fx = TestBed.createComponent(RoomViewComponent);
    fx.componentInstance.syncRoom = signal<SyncRoom>(null);
    fx.detectChanges();
    for (let i = 0; i < 4; i++) {
      await fx.whenStable();
    }
    fx.detectChanges();
    expect(fx.componentInstance.chat3dEnabled()).toBeTrue();
    const btn: HTMLAnchorElement = fx.nativeElement.querySelector('[data-testid="btn-chat3d"]');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toBe('3D room (Shadows of the Net)');
    expect(decodeURIComponent(btn.getAttribute('href') ?? '')).toContain('/rooms/!r:test/chat3d');
    // The glyph is decorative.
    expect(btn.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('keeps the 3D-room button hidden for a truthy-but-not-true enabled (hostile state event)', async () => {
    matrix.getStateEvent.and.resolveTo({ enabled: 'true' });
    const fx = TestBed.createComponent(RoomViewComponent);
    fx.componentInstance.syncRoom = signal<SyncRoom>(null);
    fx.detectChanges();
    for (let i = 0; i < 4; i++) {
      await fx.whenStable();
    }
    fx.detectChanges();
    expect(fx.componentInstance.chat3dEnabled()).toBeFalse();
    expect(fx.nativeElement.querySelector('[data-testid="btn-chat3d"]')).toBeNull();
  });

  it('groups the header actions in a labelled navigation', () => {
    const nav = fixture.nativeElement.querySelector('.header-actions');
    expect(nav.tagName.toLowerCase()).toBe('nav');
    expect(nav.getAttribute('aria-label')).toBe('Room actions');
  });

  it('exposes the typing indicator as a polite live region when someone types', () => {
    syncRoom.set({ timeline: [], typing: ['@alice:test'] });
    fixture.detectChanges();
    const typing = fixture.nativeElement.querySelector('[data-testid="typing-indicator"]');
    expect(typing).toBeTruthy();
    expect(typing.getAttribute('aria-live')).toBe('polite');
    expect(typing.textContent).toContain('@alice:test');
  });

  it('filters my own id out of the typing users', () => {
    syncRoom.set({ timeline: [], typing: ['@me:test', '@bob:test'] });
    expect(component.typingUsers()).toEqual(['@bob:test']);
  });

  it('wires the character panel with the latest message body as speakText + the room id (Wave B payoff)', () => {
    // Feed a live m.room.message so latestMessage() has a body; the panel must
    // receive it as speakText and the room id as roomId — otherwise BOTH the
    // Speak and Record controls stay permanently disabled.
    syncRoom.set({
      timeline: [
        { eventId: '$m', type: 'm.room.message', sender: '@alice:test', body: 'well hello there' } as TimelineEvent,
      ],
      typing: [],
    });
    fixture.detectChanges();

    const panelDe = fixture.debugElement.query(By.directive(HugCharacterPanelComponent));
    expect(panelDe).toBeTruthy();
    const panel = panelDe.componentInstance as HugCharacterPanelComponent;
    expect(panel.speakText).toBe('well hello there');
    expect(panel.roomId).toBe('!r:test');
  });

  it('advances the read receipt + marker to the latest event after sending', async () => {
    matrix.messages.and.resolveTo({ events: [{ eventId: '$latest' } as TimelineEvent], start: '', end: '' });
    await component.onSent();
    expect(matrix.sendReceipt).toHaveBeenCalledWith('!r:test', '$latest');
    expect(matrix.setReadMarker).toHaveBeenCalledWith('!r:test', '$latest', '$latest');
  });

  // ───────── LIVE MEMBER ROSTER: joiners after load(id) must appear ─────────
  // members/memberCount load once in load(id); before the roster-refresh
  // effect anyone joining after the room was opened never appeared — the
  // header count and the roster the timeline names senders from went stale.
  describe('live roster refresh on m.room.member events', () => {
    function memberEvent(eventId: string, sender: string): TimelineEvent {
      return { eventId, type: 'm.room.member', sender, content: { membership: 'join' } } as TimelineEvent;
    }

    it('re-fetches the joined roster when a live m.room.member event arrives (late joiner appears)', async () => {
      matrix.joinedMembers.calls.reset();
      matrix.joinedMembers.and.resolveTo([
        { userId: '@me:test', membership: 'join', powerLevel: 0 },
        { userId: '@late:test', displayName: 'Late Joiner', membership: 'join', powerLevel: 0 },
      ]);
      syncRoom.set({ timeline: [memberEvent('$j1', '@late:test')], typing: [] });
      fixture.detectChanges();
      await fixture.whenStable();
      expect(matrix.joinedMembers).toHaveBeenCalledWith('!r:test');
      expect(component.memberCount()).toBe(2);
      expect(component.members().map((m) => m.userId)).toContain('@late:test');
    });

    it('refetches ONCE per member event id — a re-emitted feed or a plain message never refetches', async () => {
      const joined = memberEvent('$j1', '@late:test');
      syncRoom.set({ timeline: [joined], typing: [] });
      fixture.detectChanges();
      await fixture.whenStable();
      matrix.joinedMembers.calls.reset();
      // The live feed re-emits the WHOLE array on every delta: the same member
      // event plus an ordinary message must not trigger another refetch.
      syncRoom.set({
        timeline: [joined, { eventId: '$m1', type: 'm.room.message', sender: '@late:test', body: 'hi' } as TimelineEvent],
        typing: [],
      });
      fixture.detectChanges();
      await fixture.whenStable();
      expect(matrix.joinedMembers).not.toHaveBeenCalled();
    });

    it('FAIL-SOFT: a rejected roster refetch keeps the last known roster (never blanks it)', async () => {
      matrix.joinedMembers.and.rejectWith(new Error('roster fetch down'));
      syncRoom.set({ timeline: [memberEvent('$j2', '@x:test')], typing: [] });
      fixture.detectChanges();
      await fixture.whenStable();
      // The initial load(id) roster (just @me:test) survives the failure.
      expect(component.memberCount()).toBe(1);
      expect(component.members().map((m) => m.userId)).toEqual(['@me:test']);
    });
  });

  // ───────── STALE-ROOM GUARD: late resolutions must never cross rooms ─────────
  // refreshMembers() and load() await HTTP then write members/memberCount (and
  // summary in load); before the guard, a slow response for the PREVIOUS room
  // landed after the user had switched and overwrote the CURRENT room's state.
  // The timeline resolves every sender name/avatar from members(), so room B
  // would caption its messages with room A's identities.
  describe('stale-room guard on late resolutions after a room switch', () => {
    it('discards a late roster refresh for the previous room (refreshMembers race)', async () => {
      // Room A's ('!r:test', loaded in beforeEach) roster refetch hangs on a
      // manually-resolved promise; room B's resolves immediately.
      let resolveA!: (members: RoomMember[]) => void;
      matrix.joinedMembers.and.callFake((roomId: string) => roomId === '!r:test'
        ? new Promise<RoomMember[]>((res) => { resolveA = res; })
        : Promise.resolve([{ userId: '@b:test', membership: 'join', powerLevel: 0 } as RoomMember]));
      // A live membership event triggers refreshMembers('!r:test') → parked.
      syncRoom.set({
        timeline: [{ eventId: '$j9', type: 'm.room.member', sender: '@x:test', content: { membership: 'join' } } as TimelineEvent],
        typing: [],
      });
      fixture.detectChanges();
      await fixture.whenStable();
      // The user switches to room B (host-input path) and its load completes.
      component.roomIdInput = '!b:test';
      component.ngOnChanges({ roomIdInput: {} } as unknown as SimpleChanges);
      for (let i = 0; i < 4; i++) {
        await fixture.whenStable();
      }
      expect(component.members().map((m) => m.userId)).toEqual(['@b:test']);
      // Room A's roster FINALLY arrives — and must be discarded, not written.
      resolveA([{ userId: '@stale-a:test', membership: 'join', powerLevel: 0 } as RoomMember]);
      for (let i = 0; i < 4; i++) {
        await fixture.whenStable();
      }
      expect(component.members().map((m) => m.userId)).toEqual(['@b:test']);
      expect(component.memberCount()).toBe(1);
    });

    it('discards a superseded load()\'s late summary after a rapid A→B switch', async () => {
      // load('!a:test') parks on its summary fetch; load('!b:test') then runs
      // to completion. A's late summary must not clobber B's (every load()
      // write is guarded after its own await).
      let resolveASummary!: (s: RoomSummary) => void;
      matrix.roomSummary.and.callFake((roomId: string) => roomId === '!a:test'
        ? new Promise<RoomSummary>((res) => { resolveASummary = res; })
        : Promise.resolve({ name: 'Bravo' } as RoomSummary));
      component.roomIdInput = '!a:test';
      component.ngOnChanges({ roomIdInput: {} } as unknown as SimpleChanges);
      component.roomIdInput = '!b:test';
      component.ngOnChanges({ roomIdInput: {} } as unknown as SimpleChanges);
      for (let i = 0; i < 4; i++) {
        await fixture.whenStable();
      }
      expect(component.summary()?.name).toBe('Bravo');
      resolveASummary({ name: 'Stale Alpha' } as RoomSummary);
      for (let i = 0; i < 4; i++) {
        await fixture.whenStable();
      }
      expect(component.summary()?.name).toBe('Bravo');
    });
  });
});
