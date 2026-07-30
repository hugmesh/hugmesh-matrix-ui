import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
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
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) }, paramMap: of(convertToParamMap({})) },
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
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) }, paramMap: of(convertToParamMap({})) },
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
