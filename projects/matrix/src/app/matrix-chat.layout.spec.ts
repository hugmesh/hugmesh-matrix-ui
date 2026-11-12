import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { MatrixChatComponent } from './matrix-chat.component';
import { MatrixService, MatrixRoom, SyncState } from './matrix.service';
import { expectReadableOnDarkPanels } from './dark-panel-contrast.spec-util';
import { Frame, frameAt } from './layout-frame.spec-util';

/**
 * GUI-19 LAYOUT + SECONDARY-TEXT regression for the /social/matrix chat shell.
 *
 * What the live retest measured on main (shell on the compose door, 2026-11-11):
 *  - the topbar never wrapped, so the title and links broke MID-WORD: "Matri/x"
 *    at 1280px; "Ma/tri/x", "Searc/h", "Setti/ngs" at 390px;
 *  - at 390px the room list and the room pane stayed side by side (a 160px list
 *    beside a pane that overflowed the viewport by 212px);
 *  - the People/Rooms headings (#888) read at 3.75:1 and the selected room's
 *    name (light text on a #e2ecff fill) at 1.03:1.
 *
 * Breakpoints answer to the VIEWPORT, so the rendered shell is cloned, with every
 * stylesheet the page has (component styles + styles.scss, whose html/body
 * `overflow-wrap:anywhere` is what lets a squeezed flex item break mid-word),
 * into a same-origin iframe of the width under test and measured there.
 */

// Shaped like the live personas' ids (a UUID localpart): a long unbroken token,
// which is what squeezes the row.
const USER = '@00000000-1111-2222-3333-444444444444:localhost';
const ROOMS: MatrixRoom[] = [
  { roomId: '!a:test', name: 'Alpha' },
  // Longer than a phone is wide: a room name must truncate, not widen the page.
  { roomId: '!b:test', name: 'Beta: the room for everything that does not fit anywhere else on this mesh' },
];

class MatrixServiceStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo(USER);
  joinedRoomsDetailed = jasmine.createSpy('joinedRoomsDetailed').and.resolveTo(ROOMS);
  sync = jasmine.createSpy('sync').and.returnValue(new Promise<SyncState>(() => undefined));
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('');
  // A real-length room name: the phone header used to squeeze it to a few glyphs.
  roomSummary = jasmine.createSpy('roomSummary').and.resolveTo({
    name: 'General chat for everyone',
    // Longer than a phone is wide: a one-line topic must truncate, not widen the page.
    topic: 'Anything goes here: introductions, links, questions about the mesh, and the weekly meetup plan',
  });
  joinedMembers = jasmine.createSpy('joinedMembers').and.resolveTo([]);
  messages = jasmine.createSpy('messages').and.resolveTo({ events: [], start: '', end: '' });
  getRelations = jasmine.createSpy('getRelations').and.resolveTo([]);
}

describe('MatrixChatComponent — GUI-19 narrow-viewport layout and secondary text', () => {
  let fixture: ComponentFixture<MatrixChatComponent>;
  let host: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MatrixChatComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: new MatrixServiceStub() },
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
    const component = fixture.componentInstance;
    await component.ngOnInit();
    component.ngOnDestroy(); // park the sync loop
    fixture.detectChanges();
    // the embedded room view chains whoami -> roomSummary; let every turn settle
    for (let i = 0; i < 4; i++) {
      await fixture.whenStable();
      fixture.detectChanges();
    }
    host = fixture.nativeElement as HTMLElement;
  });

  function expectWholeWords(f: Frame, width: number): void {
    const topbar = f.root.querySelector('.topbar')!;
    const words = [topbar.querySelector('h2')!, ...Array.from(topbar.querySelectorAll('nav a'))];
    expect(f.win.getComputedStyle(words[0]).overflowWrap)
      .withContext('harness reproduces the inherited overflow-wrap:anywhere')
      .toBe('anywhere');
    expect(words.length).withContext('title + four section links').toBe(5);
    for (const w of words) {
      expect(f.lineBoxes(w))
        .withContext(`"${(w.textContent ?? '').trim()}" at ${width}px must be ONE line (no mid-word break)`)
        .toBe(1);
    }
  }

  // 480px: a phone in landscape. The header is wide enough to fit the avatar, the
  // count and every action on ONE line with only a sliver left for the room name,
  // which is exactly where a zero-basis title used to break mid-word.
  for (const width of [320, 390, 480]) {
    it(`at ${width}px: whole-word topbar, room list STACKED above a full-width room pane, no sideways scroll`, async () => {
      const f = await frameAt(host, width, 844);
      try {
        expect(f.win.matchMedia('(max-width: 600px)').matches).withContext('the phone breakpoint is in effect').toBeTrue();
        expectWholeWords(f, width);

        const shell = f.box('[data-testid="matrix-shell"]');
        const list = f.box('hug-room-list');
        const pane = f.box('hug-room-view');
        expect(list.bottom).withContext('room list sits ABOVE the room pane').toBeLessThanOrEqual(pane.top + 1);
        expect(list.width).withContext('room list spans the shell').toBeGreaterThanOrEqual(shell.width - 2);
        // The visible list, not just its host element, drops its column width. It is
        // measured against the host's client width: the capped host scrolls, and a
        // classic scrollbar (headless Chrome) takes its own strip.
        const listHost = f.root.querySelector('hug-room-list') as HTMLElement;
        expect(f.box('[data-testid="room-list"]').width).withContext('the list itself fills its host, not a 160px column')
          .toBeGreaterThanOrEqual(listHost.clientWidth - 2);
        expect(pane.width).withContext('room pane spans the shell').toBeGreaterThanOrEqual(shell.width - 2);
        expect(list.height).withContext('stacked room list is capped (40vh) so the pane starts on screen')
          .toBeLessThanOrEqual(0.4 * 844 + 1);
        expect(f.doc.documentElement.scrollWidth - f.doc.documentElement.clientWidth)
          .withContext('no horizontal overflow at phone width').toBeLessThanOrEqual(0);

        // The composer keeps its controls on shared rows inside the pane: it must not
        // pick up the host's Bootstrap grid (full-width controls, -12px gutters).
        const send = f.box('[data-testid="matrix-send"]');
        expect(send.width).withContext('Send button is a button, not a full-width grid cell').toBeLessThan(pane.width / 2);
        expect(f.box('hug-composer').right).withContext('composer stays inside the room pane').toBeLessThanOrEqual(pane.right + 0.5);
        const row = f.root.querySelector('hug-composer [data-testid="matrix-send"]')!.parentElement!.getBoundingClientRect();
        expect(row.right).withContext('composer controls row stays inside the room pane').toBeLessThanOrEqual(pane.right + 0.5);

        // The room pane's own header wraps its actions under the title rather than
        // squeezing the room name until it breaks mid-word.
        const roomName = f.root.querySelector('[data-testid="room-name"]');
        expect(roomName?.textContent?.trim()).withContext('room header rendered').toBe('General chat for everyone');
        expect(f.lineBoxes(roomName!)).withContext(`room name at ${width}px must be ONE line`).toBe(1);
      } finally {
        f.remove();
      }
    });
  }

  it('at 1280px: whole-word topbar, list and pane stay SIDE BY SIDE (desktop unchanged)', async () => {
    const f = await frameAt(host, 1280, 800);
    try {
      expect(f.win.matchMedia('(max-width: 600px)').matches).toBeFalse();
      expectWholeWords(f, 1280);
      const shell = f.box('[data-testid="matrix-shell"]');
      const list = f.box('hug-room-list');
      const pane = f.box('hug-room-view');
      expect(list.right).withContext('list is the left column').toBeLessThanOrEqual(pane.left + 1);
      expect(Math.abs(list.top - pane.top)).withContext('same row').toBeLessThanOrEqual(1);
      expect(list.width).withContext('list stays a column, not full width').toBeLessThan(shell.width / 2);
      expect(f.box('[data-testid="matrix-send"]').width)
        .withContext('Send button is a button, not a full-width grid cell').toBeLessThan(pane.width / 4);
    } finally {
      f.remove();
    }
  });

  for (const width of [320, 390, 1280]) {
    it(`at ${width}px: the signed-in line and the help sentence get real rows, never a squeezed column`, async () => {
      const f = await frameAt(host, width, width < 600 ? 844 : 800);
      try {
        const topbar = f.box('.topbar');
        const title = f.box('.topbar h2');
        const nav = f.box('nav.nav');
        const whoami = f.box('[data-testid="matrix-whoami"]');
        const help = f.box('[data-testid="matrix-nav-help"]');
        expect(help.top).withContext('help sentence starts below the title row').toBeGreaterThanOrEqual(title.bottom - 1);
        expect(help.top).withContext('help sentence starts below the links').toBeGreaterThanOrEqual(nav.bottom - 1);
        expect(help.width).withContext('help takes the full row').toBeGreaterThan(topbar.width * 0.9);
        // Without wrapping, the row squeezed the signed-in line to a column a few
        // glyphs wide, broken mid-word, beside the title and the links.
        expect(whoami.width).withContext('signed-in line is not squeezed into a column')
          .toBeGreaterThan(Math.min(topbar.width * 0.6, 280));
      } finally {
        f.remove();
      }
    });
  }

  it('People/Rooms headings and the SELECTED room name read at >= 4.5:1 on the dark panel', () => {
    expectReadableOnDarkPanels(host, 'hug-room-list h4');
    expectReadableOnDarkPanels(host, 'hug-room-list .room.active .name');
    expectReadableOnDarkPanels(host, 'hug-room-list .room:not(.active) .name');
  });
});
