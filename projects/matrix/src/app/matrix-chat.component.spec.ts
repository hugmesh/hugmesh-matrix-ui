import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, ParamMap, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { MatrixChatComponent } from './matrix-chat.component';
import { MatrixService, MatrixRoom, SyncState } from './matrix.service';

const ROOMS: MatrixRoom[] = [
  { roomId: '!a:test', name: 'Alpha' },
  { roomId: '!b:test', name: 'Beta' },
];

class MatrixServiceStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  joinedRoomsDetailed = jasmine.createSpy('joinedRoomsDetailed').and.resolveTo(ROOMS);
  // The long-poll loop awaits sync() forever in real life; returning a
  // never-settling promise parks the loop at its first await so the spec
  // observes the post-init state without the loop busy-spinning the event loop.
  sync = jasmine.createSpy('sync').and.returnValue(new Promise<SyncState>(() => undefined));
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('');
  // Used by the embedded <hug-room-view> child once a room is selected.
  roomSummary = jasmine.createSpy('roomSummary').and.resolveTo({ name: 'Alpha' });
  joinedMembers = jasmine.createSpy('joinedMembers').and.resolveTo([]);
  messages = jasmine.createSpy('messages').and.resolveTo({ events: [], start: '', end: '' });
  getRelations = jasmine.createSpy('getRelations').and.resolveTo([]);
}

describe('MatrixChatComponent (3-pane shell)', () => {
  let fixture: ComponentFixture<MatrixChatComponent>;
  let component: MatrixChatComponent;
  let matrix: MatrixServiceStub;

  beforeEach(async () => {
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [MatrixChatComponent],
      providers: [
        provideRouter([]),
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
    await component.ngOnInit();
    component.ngOnDestroy(); // stop the sync loop so the spec doesn't hang
    fixture.detectChanges();
  });

  it('resolves the signed-in user and the joined rooms', () => {
    expect(component.userId()).toBe('@me:test');
    expect(component.rooms().length).toBe(2);
  });

  it('selects the first room when no ?room= is supplied', () => {
    expect(component.current()?.roomId).toBe('!a:test');
  });

  it('labels the shell region and the section navigation', () => {
    const view = fixture.nativeElement.querySelector('[data-testid="matrix-view"]');
    expect(view.getAttribute('aria-label')).toBe('Matrix chat');
    const nav = fixture.nativeElement.querySelector('nav.nav');
    expect(nav.getAttribute('aria-label')).toBeTruthy();
  });

  it('shows the signed-in user id in the topbar', () => {
    const whoami = fixture.nativeElement.querySelector('[data-testid="matrix-whoami"]');
    expect(whoami.textContent).toContain('@me:test');
  });

  it('updates the current room on selection', () => {
    component.select(ROOMS[1]);
    expect(component.current()?.roomId).toBe('!b:test');
  });

  // ───────── HELP TEXT ─────────
  it('describes the section navigation via help wired with aria-describedby', () => {
    const nav = fixture.nativeElement.querySelector('nav.nav');
    expect(nav.getAttribute('aria-describedby')).toBe('matrix-nav-help');
    const help = fixture.nativeElement.querySelector('[data-testid="matrix-nav-help"]');
    expect(help).toBeTruthy();
    expect(help.textContent.toLowerCase()).toContain('search');
    expect(help.textContent.toLowerCase()).toContain('moderation');
  });
});

// A SyncState carrying a single m.read receipt for the shell's sync loop to fold.
function syncWithReceipt(roomId: string, eventId: string, user: string, ts: number): SyncState {
  return {
    nextBatch: `s${ts}`,
    rooms: {
      [roomId]: {
        timeline: [],
        state: [],
        ephemeral: { typing: [], receipts: { [eventId]: { 'm.read': [{ user, ts }] } } },
        unreadCount: 0,
        highlightCount: 0,
        limited: false,
      },
    },
    invites: {},
    accountData: {},
    presence: {},
  };
}

describe('MatrixChatComponent — read-receipt accumulation across syncs', () => {
  it('folds successive receipt deltas latest-wins and exposes them on currentSync', async () => {
    const matrix = new MatrixServiceStub();
    // Bob first reads $e1 (ts 10), then advances to $e2 (ts 20); after the two
    // deltas the loop parks on a never-settling sync.
    const deltas = [
      syncWithReceipt('!a:test', '$e1', '@bob:test', 10),
      syncWithReceipt('!a:test', '$e2', '@bob:test', 20),
    ];
    let n = 0;
    matrix.sync = jasmine.createSpy('sync').and.callFake(() =>
      n < deltas.length ? Promise.resolve(deltas[n++]) : new Promise<SyncState>(() => undefined),
    );

    await TestBed.configureTestingModule({
      imports: [MatrixChatComponent],
      providers: [
        provideRouter([]),
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

    const fixture = TestBed.createComponent(MatrixChatComponent);
    const component = fixture.componentInstance;
    await component.ngOnInit(); // starts the sync loop; '!a:test' is auto-selected

    // Let both resolved deltas fold through the loop before asserting.
    for (let i = 0; i < 30 && component.currentSync()?.receipts?.['@bob:test']?.eventId !== '$e2'; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    component.ngOnDestroy(); // stop the loop

    // Bob is anchored on $e2 ONLY (the later receipt won) — the fold accumulated
    // across syncs rather than replacing per delta or leaving him on $e1.
    expect(component.currentSync()?.receipts?.['@bob:test']).toEqual({ eventId: '$e2', ts: 20 });
  });
});

// ───────── REACTIVE ?room= (query-param navigation AFTER init must work) ─────────
// The shell used to read route.snapshot.queryParamMap ONCE in ngOnInit, so any
// later in-app ?room= navigation (a deep link, the call view's back-link)
// changed the URL but never the selected room.
//
// These delta/param-driven specs construct the component DIRECTLY (no fixture):
// zoneless auto change detection would otherwise run a SECOND framework-driven
// ngOnInit (a second sync loop + child <hug-room-list> reload) as soon as the
// test yields the event loop, racing the very state under assertion.
describe('MatrixChatComponent — reactive ?room= selection', () => {
  let matrix: MatrixServiceStub;
  let queryParams$: BehaviorSubject<ParamMap>;
  let component: MatrixChatComponent;

  async function setup(initialParams: Record<string, string>): Promise<void> {
    matrix = new MatrixServiceStub();
    queryParams$ = new BehaviorSubject<ParamMap>(convertToParamMap(initialParams));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap(initialParams) },
            paramMap: of(convertToParamMap({})),
            queryParamMap: queryParams$.asObservable(),
          },
        },
      ],
    });
    component = TestBed.runInInjectionContext(() => new MatrixChatComponent());
    await component.ngOnInit();
  }

  it('selects the ?room= present at init (first emission replaces the old snapshot read)', async () => {
    await setup({ room: '!b:test' });
    expect(component.current()?.roomId).toBe('!b:test');
    component.ngOnDestroy();
  });

  it('follows a LATER ?room= navigation to the matching joined room', async () => {
    await setup({});
    expect(component.current()?.roomId).toBe('!a:test'); // rooms[0] fallback
    queryParams$.next(convertToParamMap({ room: '!b:test' }));
    expect(component.current()?.roomId).toBe('!b:test');
    component.ngOnDestroy();
  });

  it('selects a synthetic {roomId,name:roomId} row for a ?room= id outside the joined list', async () => {
    await setup({});
    queryParams$.next(convertToParamMap({ room: '!elsewhere:test' }));
    expect(component.current()).toEqual({ roomId: '!elsewhere:test', name: '!elsewhere:test' });
    component.ngOnDestroy();
  });

  it('keeps the current selection when the param disappears (no param + something selected)', async () => {
    await setup({ room: '!b:test' });
    queryParams$.next(convertToParamMap({}));
    expect(component.current()?.roomId).toBe('!b:test');
    component.ngOnDestroy();
  });

  it('unsubscribes on destroy — a post-destroy emission no longer changes the selection', async () => {
    await setup({});
    component.ngOnDestroy();
    queryParams$.next(convertToParamMap({ room: '!b:test' }));
    expect(component.current()?.roomId).toBe('!a:test');
  });

  it('re-acts only when the param VALUE changes — a same-value re-emission never snaps selection back', async () => {
    // Angular re-emits queryParamMap on ANY same-route navigation: a future
    // navigation that merely carries the old ?room= along (e.g.
    // queryParamsHandling: 'merge' adding an unrelated param) re-delivers the
    // SAME value. After the user has clicked another room, re-acting on that
    // unchanged value would snap selection back to the stale param.
    await setup({ room: '!a:test' });
    expect(component.current()?.roomId).toBe('!a:test');
    component.select(ROOMS[1]); // the user clicks Beta
    queryParams$.next(convertToParamMap({ room: '!a:test', other: 'x' })); // unchanged ?room=
    expect(component.current()?.roomId).toBe('!b:test');
    component.ngOnDestroy();
  });
});

// ───────── UNREAD BADGES (sync unread counts must reach rooms()) ─────────
// sync() has always parsed unreadCount/highlightCount per room, but syncLoop
// never folded them into rooms(), leaving room-list's room-unread-<id> badge
// permanently dead markup.
describe('MatrixChatComponent — unread badge fold', () => {
  // A SyncState carrying only unread/highlight counts for the given rooms.
  function syncWithUnread(batch: string, counts: Record<string, { unread: number; highlight: number }>): SyncState {
    const rooms: SyncState['rooms'] = {};
    for (const roomId of Object.keys(counts)) {
      rooms[roomId] = {
        timeline: [], state: [],
        ephemeral: { typing: [], receipts: {} },
        unreadCount: counts[roomId].unread,
        highlightCount: counts[roomId].highlight,
        limited: false,
      };
    }
    return { nextBatch: batch, rooms, invites: {}, accountData: {}, presence: {} };
  }

  // Constructed DIRECTLY (no fixture) for the same zoneless double-ngOnInit
  // reason as the reactive ?room= describe above. `configure` lets a spec
  // reshape the stub (e.g. per-call joinedRoomsDetailed results) before init.
  async function setupWithDeltas(deltas: SyncState[], configure?: (matrix: MatrixServiceStub) => void): Promise<MatrixChatComponent> {
    const matrix = new MatrixServiceStub();
    let n = 0;
    matrix.sync = jasmine.createSpy('sync').and.callFake(() =>
      n < deltas.length ? Promise.resolve(deltas[n++]) : new Promise<SyncState>(() => undefined),
    );
    configure?.(matrix);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
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
    });
    const component = TestBed.runInInjectionContext(() => new MatrixChatComponent());
    await component.ngOnInit(); // '!a:test' auto-selected (rooms[0])
    // Let every resolved delta fold through the loop before asserting: the
    // (deltas.length + 1)-th sync call is the parked long-poll, so once it has
    // been made every real delta has been processed.
    for (let i = 0; i < 30 && (matrix.sync as jasmine.Spy).calls.count() <= deltas.length; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    component.ngOnDestroy();
    return component;
  }

  function room(component: MatrixChatComponent, roomId: string): MatrixRoom | undefined {
    return component.rooms().find((r) => r.roomId === roomId);
  }

  it('folds a delta\'s unread/highlight counts into rooms(), forcing the ON-SCREEN room to 0', async () => {
    const component = await setupWithDeltas([
      syncWithUnread('s1', { '!a:test': { unread: 3, highlight: 1 }, '!b:test': { unread: 5, highlight: 2 } }),
    ]);
    // '!b:test' (not on screen) carries its counts; '!a:test' is being read on
    // screen, so its badge is forced to 0 (no one-delta flicker).
    expect(room(component, '!b:test')?.unreadCount).toBe(5);
    expect(room(component, '!b:test')?.highlightCount).toBe(2);
    expect(room(component, '!a:test')?.unreadCount).toBe(0);
    expect(room(component, '!a:test')?.highlightCount).toBe(0);
  });

  it('keeps existing counts for rooms ABSENT from a delta', async () => {
    const component = await setupWithDeltas([
      syncWithUnread('s1', { '!b:test': { unread: 5, highlight: 0 } }),
      syncWithUnread('s2', { '!a:test': { unread: 2, highlight: 0 } }), // no '!b:test'
    ]);
    expect(room(component, '!b:test')?.unreadCount).toBe(5); // untouched by delta 2
  });

  it('select() zeroes a room\'s badge locally so clicking it clears the badge immediately', async () => {
    const component = await setupWithDeltas([
      syncWithUnread('s1', { '!b:test': { unread: 5, highlight: 2 } }),
    ]);
    expect(room(component, '!b:test')?.unreadCount).toBe(5);
    component.select(room(component, '!b:test')!);
    expect(room(component, '!b:test')?.unreadCount).toBe(0);
    expect(room(component, '!b:test')?.highlightCount).toBe(0);
  });

  it('a delta WITHOUT unread counts (no unread_notifications block) leaves the previous badge intact', async () => {
    // The CS-API allows a joined-room delta with NO unread_notifications at
    // all (purely ephemeral typing/receipt deltas; ruma-based servers
    // skip-serialize empty blocks) — sync() parses those counts as undefined,
    // and the fold must treat undefined as "unchanged", never as 0.
    const ephemeralOnly: SyncState = {
      nextBatch: 's2',
      rooms: {
        '!b:test': {
          timeline: [], state: [],
          ephemeral: { typing: ['@bob:test'], receipts: {} },
          limited: false,
        },
      },
      invites: {}, accountData: {}, presence: {},
    };
    const component = await setupWithDeltas([
      syncWithUnread('s1', { '!b:test': { unread: 5, highlight: 2 } }),
      ephemeralOnly,
    ]);
    expect(room(component, '!b:test')?.unreadCount).toBe(5);
    expect(room(component, '!b:test')?.highlightCount).toBe(2);
  });

  // ───── mergeCounts: room-list refreshes must never wipe folded badges ─────
  // joinedRoomsDetailed() rows come from state + account data and NEVER carry
  // unread counts — and later deltas only mention rooms with new activity, so
  // a badge wiped by a verbatim rooms.set(<fresh rows>) would stay gone.

  it('a refresh triggered by a BRAND-NEW room in a delta preserves folded badges', async () => {
    const component = await setupWithDeltas(
      [
        syncWithUnread('s1', { '!b:test': { unread: 5, highlight: 2 } }),
        // '!c:test' is unknown to rooms() ⇒ the loop refetches the room list.
        syncWithUnread('s2', { '!c:test': { unread: 1, highlight: 0 } }),
      ],
      (matrix) => {
        // First call feeds ngOnInit; the refresh call returns fresh rows
        // including the new room — all WITHOUT counts, like the real service.
        matrix.joinedRoomsDetailed = jasmine.createSpy('joinedRoomsDetailed').and.returnValues(
          Promise.resolve(ROOMS),
          Promise.resolve([
            { roomId: '!a:test', name: 'Alpha' },
            { roomId: '!b:test', name: 'Beta' },
            { roomId: '!c:test', name: 'Gamma' },
          ] as MatrixRoom[]),
        );
      },
    );
    expect(component.rooms().map((r) => r.roomId)).toContain('!c:test'); // the refresh DID land
    expect(room(component, '!b:test')?.unreadCount).toBe(5); // and B's badge survived it
    expect(room(component, '!b:test')?.highlightCount).toBe(2);
  });

  it('onRooms() (a room-list child refresh) preserves folded badges on the fresh rows', async () => {
    const component = await setupWithDeltas([
      syncWithUnread('s1', { '!b:test': { unread: 5, highlight: 2 } }),
    ]);
    // The child list refetches after join/leave/create and emits fresh rows.
    component.onRooms([
      { roomId: '!a:test', name: 'Alpha' },
      { roomId: '!b:test', name: 'Beta (renamed)' },
    ]);
    expect(room(component, '!b:test')?.name).toBe('Beta (renamed)'); // fresh data kept…
    expect(room(component, '!b:test')?.unreadCount).toBe(5); // …badge carried forward
    expect(room(component, '!b:test')?.highlightCount).toBe(2);
  });
});
