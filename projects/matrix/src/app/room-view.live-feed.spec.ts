import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WritableSignal, signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { RoomViewComponent } from './room-view.component';
import { MatrixService, RoomSummary, SyncState, TimelineEvent, mergeSyncRoom } from './matrix.service';
import { VIEW_RELOAD_EVENT } from './shell-events';

/**
 * The LIVE-TIMELINE path — the one the operator reported as "msgs are sending
 * but not loading live after sending".
 *
 * Two independent defects sat on it, and these specs pin both:
 *
 *  1. The deep-link route `rooms/:roomId` (which room-list links straight to)
 *     renders RoomViewComponent with NOTHING bound to `syncRoom`, so no sync
 *     loop was feeding it — the timeline froze on its initial history page for
 *     the whole visit.
 *  2. `liveEvents` was a computed reading a PLAIN `@Input()` property. Evaluated
 *     once before the host assigned the real feed, it cached `null` against the
 *     never-changing default signal and stopped recomputing for good.
 */

function messageEvent(eventId: string, body: string): TimelineEvent {
  return {
    eventId,
    roomId: '!r:test',
    type: 'm.room.message',
    sender: '@me:test',
    originServerTs: 1000,
    content: { msgtype: 'm.text', body },
    msgtype: 'm.text',
    body,
  } as TimelineEvent;
}

/** A /sync response carrying one room delta. */
function syncWith(events: TimelineEvent[], nextBatch: string): SyncState {
  return {
    nextBatch,
    rooms: {
      '!r:test': {
        timeline: events,
        state: [],
        ephemeral: { typing: [], receipts: {} },
        limited: false,
      },
    },
    invites: {},
    accountData: {},
    presence: {},
  };
}

class MatrixServiceStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  roomSummary = jasmine.createSpy('roomSummary').and.resolveTo({ name: 'General' } as RoomSummary);
  joinedMembers = jasmine.createSpy('joinedMembers').and.resolveTo([]);
  messages = jasmine.createSpy('messages').and.resolveTo({ events: [], start: '', end: '' });
  getRelations = jasmine.createSpy('getRelations').and.resolveTo([]);
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('');
  sendReceipt = jasmine.createSpy('sendReceipt').and.resolveTo(undefined);
  setReadMarker = jasmine.createSpy('setReadMarker').and.resolveTo(undefined);
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('');
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
  sync = jasmine.createSpy('sync').and.returnValue(new Promise<SyncState>(() => { /* park */ }));
}

describe('RoomViewComponent — live feed', () => {
  let fixture: ComponentFixture<RoomViewComponent>;
  let component: RoomViewComponent;
  let matrix: MatrixServiceStub;

  async function settle(turns = 5): Promise<void> {
    for (let i = 0; i < turns; i++) await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [RoomViewComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ roomId: '!r:test' })),
            snapshot: { queryParamMap: convertToParamMap({}) },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RoomViewComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    // Tears the own-sync loop down; a leaked loop would keep polling across
    // specs and eventually exhaust the runner.
    fixture.destroy();
  });

  describe('deep-link route (nothing bound to syncRoom)', () => {
    it('REGRESSION: drives its OWN sync loop so the timeline updates live', async () => {
      // First sync delivers a message; the second parks so the loop idles.
      let call = 0;
      matrix.sync.and.callFake(() => {
        call++;
        if (call === 1) return Promise.resolve(syncWith([messageEvent('$m1', 'hello')], 's1'));
        return new Promise<SyncState>(() => { /* park */ });
      });

      fixture.detectChanges();
      await settle();

      expect(matrix.sync).toHaveBeenCalled();
      expect(component.liveEvents()?.map((e) => e.eventId)).toEqual(['$m1']);
    });

    it('threads next_batch so the second poll is INCREMENTAL, not a re-sync', async () => {
      let call = 0;
      matrix.sync.and.callFake(() => {
        call++;
        if (call === 1) return Promise.resolve(syncWith([messageEvent('$m1', 'one')], 's1'));
        if (call === 2) return Promise.resolve(syncWith([messageEvent('$m2', 'two')], 's2'));
        return new Promise<SyncState>(() => { /* park */ });
      });

      fixture.detectChanges();
      await settle(8);

      expect(matrix.sync.calls.argsFor(0)[0]).toBeUndefined();
      expect(matrix.sync.calls.argsFor(1)[0]).toBe('s1');
      // Events ACCUMULATE across deltas — a delta only carries what is new.
      expect(component.liveEvents()?.map((e) => e.eventId)).toEqual(['$m1', '$m2']);
    });

    it('BACKS OFF on a rejected sync instead of spinning', async () => {
      // A failed sync resolves INSTANTLY, so a loop that treats it as an
      // ordinary empty delta re-requests with zero delay and pins a core.
      matrix.sync.and.returnValue(Promise.resolve({
        failed: true, nextBatch: '', rooms: {}, invites: {}, accountData: {}, presence: {},
      } as SyncState));

      fixture.detectChanges();
      await settle(6);

      // With no back-off this would be hundreds of calls in the same window.
      expect(matrix.sync.calls.count()).toBeLessThan(5);
    });
  });

  describe('embedded under the chat shell (host binds syncRoom)', () => {
    it('does NOT start its own loop — the shell already syncs every room', async () => {
      component.syncRoom = signal(null);

      fixture.detectChanges();
      await settle();

      expect(matrix.sync).not.toHaveBeenCalled();
    });

    it('REGRESSION: liveEvents tracks a feed bound AFTER the computed was read', async () => {
      // Read the computed FIRST, while syncRoom is still the default. The old
      // code cached null against the default (never-changing) signal here and
      // never recomputed, so every later delta was invisible.
      expect(component.liveEvents()).toBeNull();

      const feed: WritableSignal<{ timeline: TimelineEvent[]; typing: string[] } | null> = signal(null);
      component.syncRoom = feed;
      fixture.detectChanges();
      await settle();

      feed.set({ timeline: [messageEvent('$m9', 'appeared')], typing: [] });

      expect(component.liveEvents()?.map((e) => e.eventId)).toEqual(['$m9']);
    });

    it('typing + receipts follow the same late-bound feed', async () => {
      expect(component.typingUsers()).toEqual([]);

      const feed = signal<{ timeline: TimelineEvent[]; typing: string[]; receipts?: Record<string, { eventId: string; ts: number }> } | null>(null);
      component.syncRoom = feed;
      fixture.detectChanges();
      await settle();

      feed.set({ timeline: [], typing: ['@bob:test'], receipts: { '@bob:test': { eventId: '$m1', ts: 5 } } });

      expect(component.typingUsers()).toEqual(['@bob:test']);
      expect(component.readReceipts()['@bob:test']).toEqual({ eventId: '$m1', ts: 5 });
    });
  });

  it('re-reads the room on the shell RELOAD broadcast', async () => {
    component.syncRoom = signal(null);
    fixture.detectChanges();
    await settle();
    const before = matrix.roomSummary.calls.count();

    window.dispatchEvent(new CustomEvent(VIEW_RELOAD_EVENT));
    await settle();

    expect(matrix.roomSummary.calls.count()).toBeGreaterThan(before);
  });
});

describe('mergeSyncRoom', () => {
  it('APPENDS new events and de-dupes by eventId', () => {
    const first = mergeSyncRoom(null, {
      timeline: [messageEvent('$a', 'a')],
      ephemeral: { typing: [], receipts: {} },
    });
    const second = mergeSyncRoom(first, {
      // $a re-delivered (legal after a `limited` gap) plus one genuinely new.
      timeline: [messageEvent('$a', 'a'), messageEvent('$b', 'b')],
      ephemeral: { typing: [], receipts: {} },
    });

    expect(second.timeline.map((e) => e.eventId)).toEqual(['$a', '$b']);
  });

  it('REPLACES typing (m.typing is a full set, not a delta)', () => {
    const first = mergeSyncRoom(null, {
      timeline: [],
      ephemeral: { typing: ['@alice:test'], receipts: {} },
    });
    const second = mergeSyncRoom(first, {
      timeline: [],
      ephemeral: { typing: [], receipts: {} },
    });

    // Folding instead of replacing would leave alice "typing…" forever.
    expect(second.typing).toEqual([]);
  });

  it('ACCUMULATES receipts, keeping each reader on their newest event', () => {
    const first = mergeSyncRoom(null, {
      timeline: [],
      ephemeral: { typing: [], receipts: { $a: { 'm.read': [{ user: '@bob:test', ts: 1 }] } } },
    });
    const second = mergeSyncRoom(first, {
      timeline: [],
      ephemeral: { typing: [], receipts: { $b: { 'm.read': [{ user: '@bob:test', ts: 2 }] } } },
    });

    expect(second.receipts['@bob:test']).toEqual({ eventId: '$b', ts: 2 });
  });

  it('caps the live tail so a long-lived tab does not grow without bound', () => {
    const many = Array.from({ length: 260 }, (_, i) => messageEvent(`$e${i}`, `m${i}`));
    const feed = mergeSyncRoom(null, { timeline: many, ephemeral: { typing: [], receipts: {} } });

    expect(feed.timeline.length).toBe(200);
    // The tail that is kept is the NEWEST end.
    expect(feed.timeline[feed.timeline.length - 1].eventId).toBe('$e259');
  });
});
