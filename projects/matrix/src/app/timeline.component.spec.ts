import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TimelineComponent } from './timeline.component';
import { MatrixService, ReadReceiptMap, RoomMember, TimelineEvent } from './matrix.service';
import { SessionService, HugSession } from './session.service';

/** Build a HugSession fixture carrying the given roles (drives the mod-gated
 *  redact affordance the timeline reads via SessionService.isMod). */
function sessionWith(roles: string[]): HugSession {
  return {
    id: 'google:viewer@tenant-a.test', label: 'viewer', provider: 'google', roles,
    registrationComplete: true,
  };
}

class MatrixServiceStub {
  messages = jasmine.createSpy('messages').and.resolveTo({ events: [], start: '', end: '' });
  getRelations = jasmine.createSpy('getRelations').and.resolveTo([]);
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('blob:x');
  redactEvent = jasmine.createSpy('redactEvent').and.resolveTo('$r');
  sendReaction = jasmine.createSpy('sendReaction').and.resolveTo('$rx');
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('https://m/x');
}

function msg(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId: '$e1',
    roomId: '!r:test',
    type: 'm.room.message',
    sender: '@alice:test',
    originServerTs: 1000,
    content: { msgtype: 'm.text', body: 'hi' },
    msgtype: 'm.text',
    body: 'hi',
    ...over,
  } as TimelineEvent;
}

describe('TimelineComponent', () => {
  let fixture: ComponentFixture<TimelineComponent>;
  let component: TimelineComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TimelineComponent],
      providers: [provideRouter([]), { provide: MatrixService, useValue: new MatrixServiceStub() }],
    }).compileComponents();

    fixture = TestBed.createComponent(TimelineComponent);
    component = fixture.componentInstance;
    component.me = '@me:test';
  });

  afterEach(() => {
    // SessionService persists to the real (karma) localStorage — clear so a
    // mod session seeded by one test never leaks into the next.
    TestBed.inject(SessionService).clear();
  });

  async function withEvents(events: TimelineEvent[]): Promise<void> {
    component.liveEvents = events;
    await component.ngOnChanges({ liveEvents: { currentValue: events, previousValue: null, firstChange: true, isFirstChange: () => true } });
    fixture.detectChanges();
  }

  async function withReceipts(
    events: TimelineEvent[],
    receipts: ReadReceiptMap,
    members: RoomMember[] = [],
  ): Promise<void> {
    component.liveEvents = events;
    component.receipts = receipts;
    component.members = members;
    await component.ngOnChanges({
      liveEvents: { currentValue: events, previousValue: null, firstChange: true, isFirstChange: () => true },
      receipts: { currentValue: receipts, previousValue: {}, firstChange: true, isFirstChange: () => true },
      members: { currentValue: members, previousValue: [], firstChange: true, isFirstChange: () => true },
    });
    fixture.detectChanges();
  }

  function member(over: Partial<RoomMember> & { userId: string }): RoomMember {
    return { membership: 'join', powerLevel: 0, ...over } as RoomMember;
  }

  it('renders the timeline list with the matrix-log testid and a polite live region', async () => {
    await withEvents([msg()]);
    const log = fixture.nativeElement.querySelector('[data-testid="matrix-log"]');
    expect(log.tagName.toLowerCase()).toBe('ul');
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.getAttribute('aria-label')).toBeTruthy();
  });

  it('marks the decorative sender avatar as aria-hidden', async () => {
    await withEvents([msg()]);
    const avatar = fixture.nativeElement.querySelector('[data-testid="event-avatar"]');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
  });

  it('groups each message\'s actions and exposes the react button\'s expanded state', async () => {
    await withEvents([msg()]);
    const group = fixture.nativeElement.querySelector('.actions');
    expect(group.getAttribute('role')).toBe('group');
    const react = fixture.nativeElement.querySelector('[data-testid="btn-react-$e1"]');
    expect(react.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the reaction picker from the React button and reflects aria-expanded', async () => {
    await withEvents([msg()]);
    const react: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="btn-react-$e1"]');
    react.click();
    fixture.detectChanges();
    expect(component.pickerFor()).toBe('$e1');
    expect(react.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector('[data-testid="reaction-picker"]')).toBeTruthy();
  });

  it('Escape-dismiss from the picker closes it AND restores focus to the React trigger', async () => {
    await withEvents([msg()]);
    const react: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="btn-react-$e1"]');
    react.click();
    fixture.detectChanges();
    expect(component.pickerFor()).toBe('$e1');
    expect(fixture.nativeElement.querySelector('[data-testid="reaction-picker"]')).toBeTruthy();

    // Spy the trigger's focus() so we assert the focus-restoration contract
    // deterministically (headless Chrome won't move document.activeElement for a
    // dynamically-mounted nested node, but the .focus() CALL is what matters).
    const focusSpy = spyOn(react, 'focus').and.callThrough();

    // simulate the picker's (dismissed) output (its own spec covers Escape→emit)
    component.dismissPicker('$e1');
    fixture.detectChanges();
    await Promise.resolve(); // run the deferred focus-restore microtask

    // picker is closed AND focus was explicitly returned to the React trigger,
    // not left stranded on the removed picker (APG Escape→button contract).
    expect(component.pickerFor()).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="reaction-picker"]')).toBeNull();
    expect(focusSpy).toHaveBeenCalled();
  });

  it('renders reaction pills with aria-pressed reflecting my own reaction', async () => {
    const e = msg({ reactions: [{ key: '👍', count: 2, senders: ['@me:test'], myEventId: '$mine' }] });
    await withEvents([e]);
    const pill = fixture.nativeElement.querySelector('[data-testid="reaction-pill-👍"]');
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    expect(pill.getAttribute('aria-label')).toContain('👍');
  });

  it('gives a posted image a descriptive alt (sender + body), never just "image"', async () => {
    const e = msg({ eventId: '$img', msgtype: 'm.image', body: 'cat.png', content: { msgtype: 'm.image', url: 'mxc://m/cat' } });
    component.imageUrls['$img'] = 'blob:cat';
    await withEvents([e]);
    const img: HTMLImageElement = fixture.nativeElement.querySelector('img.media');
    expect(img.alt).toContain('cat.png');
    expect(img.alt).toContain('@alice:test');
    expect(img.alt).not.toBe('image');
  });

  // ───────── REGRESSION: MSC2545 m.sticker events must RENDER ─────────
  // The picker ships the send-half (type 'm.sticker'); before the fix rows()
  // filtered to m.room.message only, so a sent sticker rendered NOWHERE — for
  // the sender or any member ("I clicked a sticker and nothing happened").
  describe('REGRESSION — m.sticker rendering (send-half had no render-half)', () => {
    function sticker(over: Partial<TimelineEvent> = {}): TimelineEvent {
      return {
        eventId: '$s1',
        roomId: '!r:test',
        type: 'm.sticker',
        sender: '@alice:test',
        originServerTs: 1500,
        content: { body: 'smug', url: 'mxc://m/sticker', info: { mimetype: 'image/png', w: 256, h: 256 } },
        body: 'smug',
        ...over,
      } as TimelineEvent;
    }

    it('keeps an m.sticker event in rows() beside m.room.message (never filtered out)', async () => {
      await withEvents([msg(), sticker()]);
      expect(component.rows().map((r) => r.event.eventId)).toEqual(['$e1', '$s1']);
      expect(fixture.nativeElement.querySelector('[data-testid="event-$s1"]')).toBeTruthy();
    });

    it('renders the sticker image from its hydrated authenticated blob with a descriptive alt and no duplicate text row', async () => {
      await withEvents([sticker()]);
      const img: HTMLImageElement | null = fixture.nativeElement.querySelector('[data-testid="sticker-$s1"]');
      expect(img).toBeTruthy();
      // The stub's fetchMediaObjectUrl resolves 'blob:x' — hydrateMedia must
      // have fetched the sticker mxc as a thumbnail blob.
      expect(img!.getAttribute('src')).toBe('blob:x');
      expect(img!.alt).toContain('smug');
      expect(img!.alt).toContain('@alice:test');
      // The body is the image's accessible name — no duplicate .text row.
      const row = fixture.nativeElement.querySelector('[data-testid="event-$s1"]');
      expect(row.querySelector('.text')).toBeNull();
    });

    it('hydrates the sticker via the authenticated media fetch (mxc thumbnail)', async () => {
      const stub = TestBed.inject(MatrixService) as unknown as { fetchMediaObjectUrl: jasmine.Spy };
      await withEvents([sticker()]);
      expect(stub.fetchMediaObjectUrl).toHaveBeenCalledWith('mxc://m/sticker', jasmine.objectContaining({ thumbnail: true }));
    });

    it('shows the redacted placeholder (never the image) for a redacted sticker', async () => {
      await withEvents([sticker({ redacted: true })]);
      const row = fixture.nativeElement.querySelector('[data-testid="event-$s1"]');
      expect(row.querySelector('[data-testid="redacted-marker"]')).toBeTruthy();
      expect(row.querySelector('[data-testid="sticker-$s1"]')).toBeNull();
    });
  });

  // ───────── SENDER ATTRIBUTION: roster-resolved names/avatars ─────────
  // Timeline events never carry sender profile data (mapEvent doesn't set
  // senderDisplayName/senderAvatarUrl), so before the roster lookup a group
  // room showed raw @user:server mxids and blank avatars for every message.
  describe('sender attribution via the joined roster (members input)', () => {
    it('renders the roster display name for a sender the events carry no profile for', async () => {
      const e = msg({ eventId: '$b1', sender: '@bob:hs' });
      await withReceipts([e], {}, [member({ userId: '@bob:hs', displayName: 'Bob' })]);
      const sender = fixture.nativeElement.querySelector('[data-testid="event-$b1"] [data-testid="event-sender"]');
      expect(sender.textContent.trim()).toBe('Bob');
    });

    it('falls back to the bare mxid when the sender is not in the roster (unknown/departed member)', async () => {
      const e = msg({ eventId: '$g1', sender: '@ghost:hs' });
      await withReceipts([e], {}, [member({ userId: '@bob:hs', displayName: 'Bob' })]);
      const sender = fixture.nativeElement.querySelector('[data-testid="event-$g1"] [data-testid="event-sender"]');
      expect(sender.textContent.trim()).toBe('@ghost:hs');
    });

    it('prefers the event\'s own senderDisplayName over the roster name when a caller populated it', async () => {
      const e = msg({ eventId: '$b2', sender: '@bob:hs', senderDisplayName: 'Bobby (event)' });
      await withReceipts([e], {}, [member({ userId: '@bob:hs', displayName: 'Bob' })]);
      expect(component.senderName(e)).toBe('Bobby (event)');
    });

    it('announces the roster\'s ASCII screenReaderName while showing the roster\'s UTF-8 display name', async () => {
      const e = msg({ eventId: '$y1', sender: '@yamada:hs' });
      await withReceipts([e], {}, [member({ userId: '@yamada:hs', displayName: '山田太郎', screenReaderName: 'Yamada Taro' })]);
      const sender = fixture.nativeElement.querySelector('[data-testid="event-$y1"] [data-testid="event-sender"]');
      expect(sender.textContent.trim()).toBe('山田太郎');
      const group = fixture.nativeElement.querySelector('[data-testid="event-$y1"] .actions');
      expect(group.getAttribute('aria-label')).toBe('Actions for message from Yamada Taro');
    });

    it('keeps the "via LoRa mesh" suffix on the announced roster-resolved name', async () => {
      const e = msg({ eventId: '$m9', sender: '@mesh-a1b2c3d4:hs' });
      await withReceipts([e], {}, [member({ userId: '@mesh-a1b2c3d4:hs', displayName: 'Trail Radio' })]);
      expect(component.senderAriaName(e)).toBe('Trail Radio via LoRa mesh');
    });

    it('paints the avatar from the roster avatarUrl (28px thumbnail) and blanks it for an unknown sender', async () => {
      const stub = TestBed.inject(MatrixService) as unknown as MatrixServiceStub;
      const e = msg({ eventId: '$b3', sender: '@bob:hs' });
      await withReceipts([e], {}, [member({ userId: '@bob:hs', displayName: 'Bob', avatarUrl: 'mxc://hs/bob' })]);
      expect(component.avatarBg(e)).toBe('url(https://m/x)');
      expect(stub.mxcToHttp).toHaveBeenCalledWith('mxc://hs/bob', { thumbnail: true, w: 28, h: 28 });
      expect(component.avatarBg(msg({ sender: '@ghost:hs' }))).toBe('');
    });
  });

  // ───────── USER-SITUATIONAL: screenReaderName on the author alt/aria-label ─────────
  describe('USER-SITUATIONAL — screenReaderName at name aria-label/alt', () => {
    it('announces the ASCII screenReaderName in the image alt while keeping the visible name UTF-8', async () => {
      const e = msg({
        eventId: '$img', msgtype: 'm.image', body: 'cat.png',
        sender: '@yamada:test', senderDisplayName: '山田太郎', senderScreenReaderName: 'Yamada Taro',
        content: { msgtype: 'm.image', url: 'mxc://m/cat' },
      });
      component.imageUrls['$img'] = 'blob:cat';
      await withEvents([e]);

      const img: HTMLImageElement = fixture.nativeElement.querySelector('img.media');
      // alt announces the ASCII screen-reader name, not the raw UTF-8 display name.
      expect(img.alt).toContain('Yamada Taro');
      expect(img.alt).not.toContain('山田太郎');
      // The visible sender label keeps the raw UTF-8 display name.
      const sender = fixture.nativeElement.querySelector('[data-testid="event-sender"]');
      expect(sender.textContent.trim()).toBe('山田太郎');
    });

    it('labels the per-message actions group with the announced (ASCII) author name', async () => {
      const e = msg({ senderDisplayName: '山田太郎', senderScreenReaderName: 'Yamada Taro' });
      await withEvents([e]);
      const group = fixture.nativeElement.querySelector('.actions');
      expect(group.getAttribute('aria-label')).toBe('Actions for message from Yamada Taro');
    });

    it('falls back to the display name when no screenReaderName is present', () => {
      expect(component.senderAriaName(msg({ senderDisplayName: 'Alex' }))).toBe('Alex');
      expect(component.senderAriaName(msg({ sender: '@bob:test' }))).toBe('@bob:test');
    });
  });

  it('shows the explicit DENIED notice (not a silently-empty log) when the history fetch is rejected', async () => {
    const matrix = TestBed.inject(MatrixService) as unknown as MatrixServiceStub;
    matrix.messages.and.rejectWith(new Error('messages failed: 403'));
    component.roomId = '!secret:test';
    await component.ngOnChanges({ roomId: { currentValue: '!secret:test', previousValue: '', firstChange: true, isFirstChange: () => true } });
    fixture.detectChanges();
    const denied = fixture.nativeElement.querySelector('[data-testid="timeline-denied"]');
    expect(denied).toBeTruthy();
    expect(denied.getAttribute('role')).toBe('status');
    expect(denied.textContent).toContain("can't view this room's history");
    // No message rows and no pagination affordance are offered.
    expect(fixture.nativeElement.querySelectorAll('[data-testid^="event-"]').length).toBe(0);
    expect(fixture.nativeElement.querySelector('[data-testid="btn-paginate-back"]')).toBeNull();
  });

  it('stops offering pagination (no crash) when a back-scroll fetch is rejected mid-session', async () => {
    const matrix = TestBed.inject(MatrixService) as unknown as MatrixServiceStub;
    matrix.messages.and.rejectWith(new Error('messages denied: 403'));
    component.canPaginate.set(true);
    await component.paginateBack();
    expect(component.canPaginate()).toBeFalse();
  });

  it('strips the edit "* " prefix when displaying a body', () => {
    const e = msg({ edited: true, content: { 'm.new_content': { body: 'fixed' } } as any });
    expect(component.displayBody(e)).toBe('fixed');
  });

  it('recognises my own messages for the edit/delete affordances', () => {
    expect(component.isMine(msg({ sender: '@me:test' }))).toBeTrue();
    expect(component.isMine(msg({ sender: '@alice:test' }))).toBeFalse();
  });

  // ───────── USER-SITUATIONAL: role/ownership-gated redact (Delete) ─────────
  describe('USER-SITUATIONAL — mod-gated redact affordance (canRedact)', () => {
    it('DENIES a plain user the Delete control on another member\'s message', async () => {
      TestBed.inject(SessionService).set(sessionWith(['user']));
      await withEvents([msg({ sender: '@alice:test' })]);
      expect(component.canRedact(msg({ sender: '@alice:test' }))).toBeFalse();
      expect(fixture.nativeElement.querySelector('[data-testid="btn-delete-$e1"]')).toBeNull();
    });

    it('ALLOWS a MOD the Delete control on another member\'s message, with a moderator aria-label', async () => {
      TestBed.inject(SessionService).set(sessionWith(['user', 'mod']));
      await withEvents([msg({ sender: '@alice:test' })]);
      const del = fixture.nativeElement.querySelector('[data-testid="btn-delete-$e1"]');
      expect(del).toBeTruthy();
      expect(del.getAttribute('aria-label')).toContain('moderator');
    });

    it('ALLOWS an ADMIN (additive isMod) the Delete control on another member\'s message', async () => {
      TestBed.inject(SessionService).set(sessionWith(['user', 'admin']));
      await withEvents([msg({ sender: '@alice:test' })]);
      expect(fixture.nativeElement.querySelector('[data-testid="btn-delete-$e1"]')).toBeTruthy();
    });

    it('always ALLOWS the author to Delete their own message (self-redact), even without a mod role', async () => {
      TestBed.inject(SessionService).set(sessionWith(['user']));
      await withEvents([msg({ sender: '@me:test' })]);
      const del = fixture.nativeElement.querySelector('[data-testid="btn-delete-$e1"]');
      expect(del).toBeTruthy();
      // Own-message delete keeps the plain (non-moderator) announcement. The
      // control is icon-only, so that announcement now HAS to be an aria-label
      // (there is no button text left to name it) — what matters is that it
      // does not claim a moderator action against another member.
      expect(del.getAttribute('aria-label')).toBe('Delete your message');
    });

    it('redacts via MatrixService and swaps the body for the redacted placeholder', async () => {
      TestBed.inject(SessionService).set(sessionWith(['user', 'mod']));
      const e = msg({ sender: '@alice:test' });
      await withEvents([e]);
      const matrix = TestBed.inject(MatrixService) as unknown as MatrixServiceStub;
      await component.del(e);
      fixture.detectChanges();
      expect(matrix.redactEvent).toHaveBeenCalledWith('', '$e1');
      expect(fixture.nativeElement.querySelector('[data-testid="redacted-marker"]')).toBeTruthy();
    });
  });

  // ───────── LoRa-mesh provenance badge ─────────
  describe('"via LoRa mesh" badge', () => {
    it('renders the badge with the node id for an event carrying a valid mesh fragment, tooltip carrying RSSI/SNR + the caution', async () => {
      const e = msg({
        eventId: '$m1', sender: '@mesh-a1b2c3d4:test',
        mesh: { node: '!a1b2c3d4', device: 'default', channel: 2, registered: true, rssi: -87, snr: 6.5 },
      });
      await withEvents([e]);
      const badge = fixture.nativeElement.querySelector('[data-testid="mesh-badge-$m1"]');
      expect(badge).toBeTruthy();
      expect(badge.textContent).toContain('via LoRa mesh · !a1b2c3d4');
      const title = badge.getAttribute('title');
      expect(title).toContain('node !a1b2c3d4 (registered)');
      expect(title).toContain('RSSI -87 dBm');
      expect(title).toContain('SNR 6.5 dB');
      expect(title.toLowerCase()).toContain('not cryptographically authenticated');
    });

    it('renders a bare badge for an @mesh-* sender without a parsable fragment (no node id, no RSSI/SNR)', async () => {
      const e = msg({ eventId: '$m2', sender: '@mesh-a1b2c3d4:test' });
      await withEvents([e]);
      const badge = fixture.nativeElement.querySelector('[data-testid="mesh-badge-$m2"]');
      expect(badge.textContent.trim()).toBe('via LoRa mesh');
      expect(badge.getAttribute('title')).not.toContain('RSSI');
      expect(badge.getAttribute('title').toLowerCase()).toContain('not cryptographically authenticated');
    });

    it('does NOT render a badge on an ordinary message', async () => {
      await withEvents([msg()]);
      expect(fixture.nativeElement.querySelector('[data-testid="mesh-badge-$e1"]')).toBeNull();
    });

    it('threads the mesh provenance into the ANNOUNCED author name (actions group / alt), like senderScreenReaderName', async () => {
      const e = msg({
        eventId: '$m3', sender: '@mesh-a1b2c3d4:test', senderDisplayName: 'Trail Radio',
        mesh: { node: '!a1b2c3d4', device: 'default', channel: 0, registered: false },
      });
      await withEvents([e]);
      const group = fixture.nativeElement.querySelector('.actions');
      expect(group.getAttribute('aria-label')).toBe('Actions for message from Trail Radio via LoRa mesh');
      // Ordinary messages keep the unsuffixed announcement.
      expect(component.senderAriaName(msg({ senderDisplayName: 'Alex' }))).toBe('Alex');
    });
  });

  // ───────── HELP TEXT ─────────
  it('describes the per-message action buttons via help wired to the action group', async () => {
    await withEvents([msg()]);
    const group = fixture.nativeElement.querySelector('.actions[role="group"]');
    expect(group.getAttribute('aria-describedby')).toBe('timeline-actions-help');
    const help = fixture.nativeElement.querySelector('#timeline-actions-help');
    expect(help).toBeTruthy();
    expect(help.textContent.toLowerCase()).toContain('delete removes it for everyone');
  });

  // ───────── READ RECEIPTS: "seen by" render mapping ─────────
  describe('read-receipt "seen by" indicator', () => {
    const e1 = msg({ eventId: '$e1', originServerTs: 1000 });
    const e2 = msg({ eventId: '$e2', originServerTs: 2000 });

    it('anchors a member\'s receipt on the event they read (N), not the next one (N+1)', async () => {
      await withReceipts([e1, e2], { '@bob:test': { eventId: '$e1', ts: 5 } }, [member({ userId: '@bob:test', displayName: 'Bob' })]);

      const onE1 = fixture.nativeElement.querySelector('[data-testid="event-$e1"] [data-testid="read-receipt-@bob:test"]');
      const onE2 = fixture.nativeElement.querySelector('[data-testid="event-$e2"] [data-testid="read-receipt-@bob:test"]');
      // Bob read $e1: his chip renders on $e1's row and NOWHERE on $e2's row —
      // the exact "shows on N, not N+1" invariant.
      expect(onE1).toBeTruthy();
      expect(onE2).toBeNull();
    });

    it('moves the chip forward to the later event when the receipt advances', async () => {
      await withReceipts([e1, e2], { '@bob:test': { eventId: '$e2', ts: 9 } }, [member({ userId: '@bob:test', displayName: 'Bob' })]);
      expect(fixture.nativeElement.querySelector('[data-testid="event-$e1"] [data-testid="read-receipt-@bob:test"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="event-$e2"] [data-testid="read-receipt-@bob:test"]')).toBeTruthy();
    });

    it('never renders MY OWN read receipt (only who ELSE has caught up)', async () => {
      await withReceipts(
        [e1],
        { '@me:test': { eventId: '$e1', ts: 5 }, '@bob:test': { eventId: '$e1', ts: 6 } },
        [member({ userId: '@bob:test', displayName: 'Bob' })],
      );
      expect(fixture.nativeElement.querySelector('[data-testid="read-receipt-@me:test"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="read-receipt-@bob:test"]')).toBeTruthy();
    });

    it('labels each receipt chip as an image "Read by <name>" using the member display name', async () => {
      await withReceipts([e1], { '@bob:test': { eventId: '$e1', ts: 5 } }, [member({ userId: '@bob:test', displayName: 'Bob' })]);
      const chip = fixture.nativeElement.querySelector('[data-testid="read-receipt-@bob:test"]');
      expect(chip.getAttribute('role')).toBe('img');
      expect(chip.getAttribute('aria-label')).toBe('Read by Bob');
      // No avatar url ⇒ the initial fallback glyph is shown.
      expect(chip.textContent.trim()).toBe('B');
    });

    it('announces the ASCII screenReaderName in the aria-label while keeping the visible title UTF-8', async () => {
      await withReceipts(
        [e1],
        { '@yamada:test': { eventId: '$e1', ts: 5 } },
        [member({ userId: '@yamada:test', displayName: '山田太郎', screenReaderName: 'Yamada Taro' })],
      );
      const chip = fixture.nativeElement.querySelector('[data-testid="read-receipt-@yamada:test"]');
      expect(chip.getAttribute('aria-label')).toBe('Read by Yamada Taro');
      expect(chip.getAttribute('aria-label')).not.toContain('山田太郎');
      expect(chip.getAttribute('title')).toBe('山田太郎');
    });

    it('falls back to the bare user id when the reader is not in the roster', async () => {
      await withReceipts([e1], { '@ghost:test': { eventId: '$e1', ts: 5 } }, []);
      const chip = fixture.nativeElement.querySelector('[data-testid="read-receipt-@ghost:test"]');
      expect(chip).toBeTruthy();
      expect(chip.getAttribute('aria-label')).toBe('Read by @ghost:test');
    });

    it('renders no receipt group on a message no one (else) has read', async () => {
      await withReceipts([e1, e2], { '@bob:test': { eventId: '$e1', ts: 5 } }, [member({ userId: '@bob:test', displayName: 'Bob' })]);
      expect(fixture.nativeElement.querySelector('[data-testid="read-receipts-$e2"]')).toBeNull();
    });
  });
});
