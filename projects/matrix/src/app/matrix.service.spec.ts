import { TestBed } from '@angular/core/testing';
import {
  MatrixService, MATRIX_BASE_URL, BFF_BASE_URL, LEGACY_MESH_EVENT_CONTENT_FIELD, MESH_EVENT_CONTENT_FIELD,
  ReadReceiptMap, mergeReadReceipts, parseMeshEventInfo,
} from './matrix.service';

/** Minimal fetch Response stub. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    blob: async () => new Blob([JSON.stringify(body)]),
  } as unknown as Response;
}

// Post-cutover: the browser NEVER holds a homeserver access token, NOR any
// browser-held bff_ bearer of its own. Every CS-API call goes through the
// SAME-ORIGIN user-bff hsproxy at `/bff/user/matrix` (the proxy injects the
// server-held homeserver token, owner = bff_ subject), authenticated SOLELY by
// the platform bff_ session: the HttpOnly bff_ cookie via `credentials:
// 'include'`. The gateway mints the upstream bearer server-side from the cookie.
describe('MatrixService (hsproxy — no homeserver token in the browser)', () => {
  const BASE = 'https://matrix.test';
  const BFF = 'https://bff.test';
  let service: MatrixService;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MATRIX_BASE_URL, useValue: BASE },
        { provide: BFF_BASE_URL, useValue: BFF },
        MatrixService,
      ],
    });
    service = TestBed.inject(MatrixService);
    localStorage.clear();
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => localStorage.clear());

  function lastUrl(): string {
    return String(fetchSpy.calls.mostRecent().args[0]);
  }
  function lastInit(): RequestInit {
    return (fetchSpy.calls.mostRecent().args[1] ?? {}) as RequestInit;
  }
  function header(name: string): string | undefined {
    return (lastInit().headers as Record<string, string>)?.[name];
  }

  // ─────────────────────────── Routing through the hsproxy ───────────────────────────

  it('routes every CS-API call to the same-origin /bff/user/matrix prefix, keeping the native /_matrix path verbatim', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ joined_rooms: [] }));
    await service.joinedRooms();
    expect(lastUrl()).toBe(`${BFF}/bff/user/matrix/_matrix/client/v3/joined_rooms`);
  });

  it('long-poll /sync streams through the proxy prefix with query preserved', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ next_batch: 's2', rooms: {} }));
    await service.sync('s1', 30000);
    const url = lastUrl();
    expect(url).toContain(`${BFF}/bff/user/matrix/_matrix/client/v3/sync`);
    expect(url).toContain('since=s1');
    expect(url).toContain('timeout=30000');
  });

  // ─────────────────────────── Auth: bff_ cookie only, NEVER a bearer of any kind ───────────────────────────

  it('carries the HttpOnly bff_ cookie via credentials:"include" on every CS-API call', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ joined_rooms: [] }));
    await service.joinedRooms();
    expect(lastInit().credentials).toBe('include');
  });

  it('NEVER attaches an Authorization header, even if a stray bffToken lingers in localStorage', async () => {
    // A stale `bffToken` (pre-cutover shape) left in storage must be ignored:
    // the service reads nothing from localStorage — auth is cookie-only now.
    localStorage.setItem('hug.session', JSON.stringify({ bffToken: 'bff-sess-1' }));
    fetchSpy.and.resolveTo(jsonResponse({ joined_rooms: [] }));
    await service.joinedRooms();
    expect(header('Authorization')).toBeUndefined();
    expect(lastInit().credentials).toBe('include');
  });

  it('NEVER attaches a homeserver access token even if one lingers in the session', async () => {
    // A stale `matrix.token` left in storage must be ignored: the browser holds
    // no homeserver token and the proxy injects the upstream one server-side.
    localStorage.setItem('hug.session', JSON.stringify({ matrix: { token: 'hs-tok' } }));
    fetchSpy.and.resolveTo(jsonResponse({ joined_rooms: [] }));
    await service.joinedRooms();
    expect(header('Authorization')).toBeUndefined();
    // The cookie still rides along so the proxy can resolve the session.
    expect(lastInit().credentials).toBe('include');
  });

  it('sends no Authorization header when there is no session at all (cookie still carried)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ joined_rooms: [] }));
    await service.joinedRooms();
    expect(header('Authorization')).toBeUndefined();
    expect(lastInit().credentials).toBe('include');
  });

  it('tolerates a malformed hug.session without throwing (localStorage is not even read for auth)', async () => {
    localStorage.setItem('hug.session', '{not valid json');
    fetchSpy.and.resolveTo(jsonResponse({ joined_rooms: [] }));
    await expectAsync(service.joinedRooms()).toBeResolved();
    expect(header('Authorization')).toBeUndefined();
  });

  it('does not expose a setAccessToken() escape hatch (no client-held homeserver token)', () => {
    expect((service as any).setAccessToken).toBeUndefined();
  });

  // ─────────────────────────── Error fallbacks vs throws ───────────────────────────

  it('returns an empty list (no throw) when joined_rooms fails', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 500 }));
    expect(await service.joinedRooms()).toEqual([]);
  });

  it('resolves whoami to null on a non-OK response', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 401 }));
    expect(await service.whoami()).toBeNull();
  });

  it('throws when createRoom fails', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 403 }));
    await expectAsync(service.createRoom({ name: 'x' })).toBeRejectedWithError(/createRoom failed: 403/);
  });

  // ─────────────── Membership verbs THROW on rejection (announced-failure honesty) ───────────────
  // Regression: these three used to swallow the response entirely, so a 403
  // (insufficient power level) invite/kick/leave silently no-op'd — and
  // room-settings even announced "Invited" on the failure.
  it('invite() THROWS on a non-OK response (e.g. 403 insufficient power level)', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 403 }));
    await expectAsync(service.invite('!r:test', '@bob:test')).toBeRejectedWithError(/invite failed: 403/);
  });

  it('kick() THROWS on a non-OK response instead of silently no-opping', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 403 }));
    await expectAsync(service.kick('!r:test', '@admin:test')).toBeRejectedWithError(/kick failed: 403/);
  });

  it('leaveRoom() THROWS on a non-OK response instead of silently no-opping', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 500 }));
    await expectAsync(service.leaveRoom('!r:test')).toBeRejectedWithError(/leaveRoom failed: 500/);
  });

  // ─────────────── Presence read (settings preload) ───────────────

  it('getPresence() maps presence + status_msg, and resolves null on a non-OK / unknown state', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ presence: 'unavailable', status_msg: 'in a meeting' }));
    expect(await service.getPresence('@me:test')).toEqual({ presence: 'unavailable', statusMsg: 'in a meeting' });
    // Raw-pchar spelling (enc() restores ':'/'@'): the encoded form is
    // re-escaped by the hsproxy's URI-template factory and 500s upstream.
    expect(lastUrl()).toContain('/_matrix/client/v3/presence/@me:test/status');
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 404 }));
    expect(await service.getPresence('@me:test')).toBeNull();
    fetchSpy.and.resolveTo(jsonResponse({ presence: 'lurking' }));
    expect(await service.getPresence('@me:test')).toBeNull();
  });

  // ─────────────────────────── Request construction ───────────────────────────

  it('maps joined room ids into bare MatrixRoom rows', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ joined_rooms: ['!a:test', '!b:test'] }));
    const rooms = await service.joinedRooms();
    expect(rooms).toEqual([
      { roomId: '!a:test', name: '!a:test' },
      { roomId: '!b:test', name: '!b:test' },
    ]);
  });

  it('messages() THROWS on a 401/403 visibility denial so callers can render an explicit denied state', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 403 }));
    await expectAsync(service.messages('!secret:test')).toBeRejectedWithError(/denied: 403/);
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 401 }));
    await expectAsync(service.messages('!secret:test')).toBeRejectedWithError(/denied: 401/);
  });

  it('messages() degrades a non-auth failure (5xx) to an empty page rather than throwing', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 502 }));
    await expectAsync(service.messages('!r:test')).toBeResolvedTo({ events: [], start: '', end: '' });
  });

  it('PUTs a JSON m.room.message through the proxy with the txn id and returns event_id', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ event_id: '$evt1' }));
    const id = await service.sendMessage('!r:test', { msgtype: 'm.text', body: 'hi' }, 'txn-9');
    const init = lastInit();
    expect(init.method).toBe('PUT');
    expect(header('Content-Type')).toBe('application/json');
    // Raw-pchar room id (see enc()): '!r:test' is a valid segment as-is, and
    // the one spelling the user-bff hsproxy forwards without re-escaping.
    expect(lastUrl()).toBe(`${BFF}/bff/user/matrix/_matrix/client/v3/rooms/!r:test/send/m.room.message/txn-9`);
    expect(JSON.parse(String(init.body))).toEqual({ msgtype: 'm.text', body: 'hi' });
    expect(id).toBe('$evt1');
  });

  it('does not attach a double-submit CSRF header (the hsproxy disables CSRF for the cookie session)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ event_id: '$e' }));
    await service.sendMessage('!r:test', { msgtype: 'm.text', body: 'hi' }, 'txn-1');
    expect(header('X-CSRF')).toBeUndefined();
    expect(header('X-CSRF-TOKEN')).toBeUndefined();
  });

  it('encodes the annotation relation when sending a reaction', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ event_id: '$react1' }));
    await service.sendReaction('!r:test', '$target', '👍');
    const body = JSON.parse(String(lastInit().body));
    expect(body['m.relates_to']).toEqual({ rel_type: 'm.annotation', event_id: '$target', key: '👍' });
    expect(lastUrl()).toContain('/send/m.reaction/');
  });

  it('builds an m.replace edit with m.new_content and a "* " fallback body', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ event_id: '$edit1' }));
    await service.editMessage('!r:test', '$orig', 'fixed');
    const body = JSON.parse(String(lastInit().body));
    expect(body.body).toBe('* fixed');
    expect(body['m.new_content']).toEqual({ msgtype: 'm.text', body: 'fixed' });
    expect(body['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$orig' });
  });

  // ─────────────────────────── Sync mapping ───────────────────────────

  it('threads next_batch and maps joined-room timelines, typing and unread counts from sync', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's2',
      rooms: {
        join: {
          '!r:test': {
            timeline: { events: [{ event_id: '$e1', type: 'm.room.message', sender: '@a:test', origin_server_ts: 5, content: { msgtype: 'm.text', body: 'hey' } }], limited: false },
            ephemeral: { events: [
              { type: 'm.typing', content: { user_ids: ['@b:test'] } },
              { type: 'm.receipt', content: { '$e1': { 'm.read': { '@b:test': { ts: 42 } } } } },
            ] },
            unread_notifications: { notification_count: 3, highlight_count: 1 },
          },
        },
      },
    }));
    const state = await service.sync('s1', 0);
    expect(lastUrl()).toContain('since=s1');
    expect(state.nextBatch).toBe('s2');
    const room = state.rooms['!r:test'];
    expect(room.timeline.length).toBe(1);
    expect(room.timeline[0].body).toBe('hey');
    expect(room.ephemeral.typing).toEqual(['@b:test']);
    // The m.receipt event is parsed into the per-event → per-type → readers shape.
    expect(room.ephemeral.receipts['$e1']['m.read']).toEqual([{ user: '@b:test', ts: 42 }]);
    expect(room.unreadCount).toBe(3);
    expect(room.highlightCount).toBe(1);
  });

  it('leaves unread counts UNDEFINED for a delta without an unread_notifications block (absent ≠ zero)', async () => {
    // Purely ephemeral deltas (typing/receipts only) may omit the block
    // entirely — ruma-based servers skip-serialize empty blocks. Parsing that
    // absence as 0 is what used to wipe a live badge on the next fold, so the
    // parser must surface undefined ("unchanged"), never a fabricated 0.
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's2',
      rooms: { join: { '!r:test': { ephemeral: { events: [{ type: 'm.typing', content: { user_ids: ['@b:test'] } }] } } } },
    }));
    const state = await service.sync('s1', 0);
    expect(state.rooms['!r:test'].unreadCount).toBeUndefined();
    expect(state.rooms['!r:test'].highlightCount).toBeUndefined();
  });

  it('parses rooms.invite into pending invites (name + inviter off the stripped invite_state)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's2',
      rooms: {
        invite: {
          '!inv:test': {
            invite_state: { events: [
              { type: 'm.room.name', sender: '@alice:test', content: { name: 'Secret plans' } },
              { type: 'm.room.member', sender: '@alice:test', state_key: '@me:test', content: { membership: 'invite' } },
            ] },
          },
        },
      },
    }));
    const state = await service.sync('s1', 0);
    expect(state.invites['!inv:test']).toEqual({ roomId: '!inv:test', name: 'Secret plans', inviter: '@alice:test' });
  });

  it('falls back to the room id as the invite name when the stripped state has no m.room.name', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's2',
      rooms: { invite: { '!bare:test': { invite_state: { events: [] } } } },
    }));
    const state = await service.sync(undefined, 0);
    expect(state.invites['!bare:test'].name).toBe('!bare:test');
  });

  it('pendingInvites() issues ONE zero-timeout filtered sync and returns the parsed invites (fail-soft [])', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's1',
      rooms: { invite: { '!inv:test': { invite_state: { events: [{ type: 'm.room.name', content: { name: 'Club' } }] } } } },
    }));
    const invites = await service.pendingInvites();
    expect(invites.length).toBe(1);
    expect(invites[0]).toEqual(jasmine.objectContaining({ roomId: '!inv:test', name: 'Club' }));
    const url = lastUrl();
    expect(url).toContain('/sync');
    expect(url).toContain('timeout=0');
    expect(url).toContain('filter=');
    // Fail-soft: a dead endpoint resolves to [] (sync itself absorbs non-OK).
    fetchSpy.and.rejectWith(new Error('network down'));
    expect(await service.pendingInvites()).toEqual([]);
  });

  // ─────────────────────────── Read-receipt fold (mergeReadReceipts) ───────────────────────────
  describe('mergeReadReceipts — latest-read-per-user fold', () => {
    it('anchors each reader on the event their m.read receipt points at (N, not N+1)', () => {
      const out = mergeReadReceipts({}, {
        '$eN': { 'm.read': [{ user: '@bob:test', ts: 10 }] },
        '$eN1': { 'm.read': [{ user: '@carol:test', ts: 12 }] },
      });
      expect(out['@bob:test']).toEqual({ eventId: '$eN', ts: 10 });
      expect(out['@carol:test']).toEqual({ eventId: '$eN1', ts: 12 });
    });

    it('moves a reader FORWARD onto a newer event across successive syncs (off the older one)', () => {
      const first = mergeReadReceipts({}, { '$eN': { 'm.read': [{ user: '@bob:test', ts: 10 }] } });
      expect(first['@bob:test'].eventId).toBe('$eN');
      const second = mergeReadReceipts(first, { '$eN1': { 'm.read': [{ user: '@bob:test', ts: 20 }] } });
      // Bob is now on $eN1 only — a later fold never leaves him double-anchored.
      expect(second['@bob:test']).toEqual({ eventId: '$eN1', ts: 20 });
    });

    it('never regresses a reader onto an older event when a stale (lower-ts) receipt arrives', () => {
      const prev: ReadReceiptMap = { '@bob:test': { eventId: '$eN1', ts: 20 } };
      const out = mergeReadReceipts(prev, { '$eN': { 'm.read': [{ user: '@bob:test', ts: 5 }] } });
      expect(out['@bob:test']).toEqual({ eventId: '$eN1', ts: 20 });
    });

    it('ignores m.read.private (owner-only) receipts — they never advertise a position to others', () => {
      const out = mergeReadReceipts({}, { '$eN': { 'm.read.private': [{ user: '@bob:test', ts: 10 }] } });
      expect(out['@bob:test']).toBeUndefined();
    });
  });

  it('returns an empty sync state (no throw) when sync responds non-OK', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 502 }));
    const state = await service.sync('s1', 0);
    expect(state.nextBatch).toBe('s1');
    expect(state.rooms).toEqual({});
  });

  // ─────────────── screenReaderName fragment mapping (a11y aria-labels) ───────────────

  it('maps the optional ASCII screen-reader-name fragment off an event content field', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's2',
      rooms: {
        join: {
          '!r:test': {
            timeline: { events: [{
              event_id: '$e1', type: 'm.room.message', sender: '@yamada:test', origin_server_ts: 5,
              content: { msgtype: 'm.text', body: 'hi', 'com.hugmesh.screen_reader_name': 'Yamada Taro' },
            }], limited: false },
          },
        },
      },
    }));
    const state = await service.sync('s1', 0);
    expect(state.rooms['!r:test'].timeline[0].senderScreenReaderName).toBe('Yamada Taro');
  });

  it('leaves senderScreenReaderName undefined for a legacy event without the fragment', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's2',
      rooms: { join: { '!r:test': { timeline: { events: [{
        event_id: '$e1', type: 'm.room.message', sender: '@a:test', origin_server_ts: 5, content: { msgtype: 'm.text', body: 'hey' },
      }], limited: false } } } },
    }));
    const state = await service.sync('s1', 0);
    expect(state.rooms['!r:test'].timeline[0].senderScreenReaderName).toBeUndefined();
  });

  it('maps the screen-reader name off the joined_members profile fragment', async () => {
    fetchSpy.and.callFake((url: any) =>
      Promise.resolve(String(url).includes('/joined_members')
        ? jsonResponse({ joined: { '@yamada:test': { display_name: '山田太郎', 'com.hugmesh.screen_reader_name': 'Yamada Taro' } } })
        : jsonResponse(null, { ok: false, status: 404 }))); // no power_levels
    const members = await service.joinedMembers('!r:test');
    expect(members[0].displayName).toBe('山田太郎');
    expect(members[0].screenReaderName).toBe('Yamada Taro');
  });

  // ─────────────── HEROES-STYLE room names (no m.room.name ⇒ member-derived) ───────────────
  // A room without an m.room.name state event (every fresh DM, most ad-hoc
  // groups) used to display as its raw !opaque:id in the room list. Heroes are
  // derived from the SAME single /state fetch the summary comes from —
  // joined AND invited members (matching Matrix's room-name calculation), so
  // a fresh DM whose peer hasn't accepted yet is named after the invitee, and
  // no /joined_members request is ever made.
  describe('joinedRoomsDetailed — heroes-style fallback naming', () => {
    /** Route the whole joinedRoomsDetailed call graph by URL; `state` is the
     *  room-state array (default: no m.room.name), or 'reject' for a dead
     *  state endpoint. /joined_members stays routed ONLY so the
     *  zero-extra-fetch assertions can count calls to it — the heroes
     *  refactor must never make one. Everything else 404s fail-soft. */
    function routeCalls(opts: { state?: any[] | 'reject' }): void {
      fetchSpy.and.callFake((url: any) => {
        const u = String(url);
        if (u.includes('/joined_rooms')) return Promise.resolve(jsonResponse({ joined_rooms: ['!anon:test'] }));
        if (u.includes('/account/whoami')) return Promise.resolve(jsonResponse({ user_id: '@me:test' }));
        if (u.includes('/joined_members')) return Promise.resolve(jsonResponse({ joined: {} }));
        if (u.endsWith('/state')) {
          return opts.state === 'reject'
            ? Promise.reject(new Error('state fetch down'))
            : Promise.resolve(jsonResponse(opts.state ?? []));
        }
        return Promise.resolve(jsonResponse(null, { ok: false, status: 404 })); // m.direct, …
      });
    }

    /** A raw m.room.member state event as the /state endpoint returns it. */
    function memberEvent(userId: string, membership: 'join' | 'invite', displayname?: string): any {
      return {
        event_id: `$m-${userId}`, type: 'm.room.member', state_key: userId, sender: userId,
        content: displayname === undefined ? { membership } : { membership, displayname },
      };
    }

    function joinedMembersFetchCount(): number {
      return fetchSpy.calls.allArgs().filter((a) => String(a[0]).includes('/joined_members')).length;
    }

    it('names an unnamed room after the other members ("A, B") excluding the caller, and sets memberCount', async () => {
      routeCalls({ state: [
        memberEvent('@me:test', 'join', 'Me'),
        memberEvent('@alice:test', 'join', 'Alice'),
        memberEvent('@bob:test', 'join', 'Bob'),
      ] });
      const rooms = await service.joinedRoomsDetailed();
      expect(rooms[0].name).toBe('Alice, Bob');
      expect(rooms[0].memberCount).toBe(3);
    });

    it('falls back to the LOCALPART for a member with no display name and appends +N beyond three', async () => {
      routeCalls({ state: [
        memberEvent('@me:test', 'join', 'Me'),
        memberEvent('@alice:test', 'join', 'Alice'),
        memberEvent('@bob:test', 'join'), // no display name ⇒ localpart 'bob'
        memberEvent('@cara:test', 'join', 'Cara'),
        memberEvent('@dave:test', 'join', 'Dave'),
        memberEvent('@eve:test', 'join', 'Eve'),
      ] });
      const rooms = await service.joinedRoomsDetailed();
      // 5 others: first three named, the remaining 2 folded into +N.
      expect(rooms[0].name).toBe('Alice, bob, Cara +2');
      expect(rooms[0].memberCount).toBe(6);
    });

    it('names a fresh DM after its INVITED (not-yet-joined) peer — the headline heroes case', async () => {
      // Matrix's room-name calculation counts INVITED members as heroes: a DM
      // whose peer hasn't accepted yet has one joined member (me) plus one
      // invitee, and a joined-only roster left the raw !roomId on screen.
      routeCalls({ state: [
        memberEvent('@me:test', 'join', 'Me'),
        memberEvent('@peer:test', 'invite', 'Peer'),
      ] });
      const rooms = await service.joinedRoomsDetailed();
      expect(rooms[0].name).toBe('Peer');
      expect(rooms[0].memberCount).toBe(1); // joined members only
      expect(joinedMembersFetchCount()).toBe(0); // heroes rode the SAME state fetch
    });

    it('keeps the roomId fallback when the state fetch fails (fail-soft)', async () => {
      routeCalls({ state: 'reject' });
      const rooms = await service.joinedRoomsDetailed();
      expect(rooms[0].name).toBe('!anon:test');
    });

    it('keeps the roomId fallback for an empty roster (only me, or nobody)', async () => {
      routeCalls({ state: [memberEvent('@me:test', 'join', 'Me')] });
      const rooms = await service.joinedRoomsDetailed();
      expect(rooms[0].name).toBe('!anon:test');
    });

    it('NEVER overrides an explicit m.room.name — and never fetches joined_members at all', async () => {
      routeCalls({ state: [
        { event_id: '$n', type: 'm.room.name', state_key: '', sender: '@a:test', content: { name: 'Proper Name' } },
        memberEvent('@me:test', 'join', 'Me'),
        memberEvent('@alice:test', 'join', 'Alice'),
      ] });
      const rooms = await service.joinedRoomsDetailed();
      expect(rooms[0].name).toBe('Proper Name');
      expect(joinedMembersFetchCount()).toBe(0);
    });
  });

  // ─────────────── mesh provenance fragment mapping (via-LoRa badge) ───────────────

  describe('parseMeshEventInfo — com.hugmesh.mesh (untrusted bridged content)', () => {
    it('parses a well-formed fragment', () => {
      expect(parseMeshEventInfo({ node: '!a1b2c3d4', device: 'lora-1', channel: 3, registered: true, rssi: -87, snr: 6.5 }))
        .toEqual({ node: '!a1b2c3d4', device: 'lora-1', channel: 3, registered: true, rssi: -87, snr: 6.5 });
    });

    it('null / non-object content parses to null', () => {
      expect(parseMeshEventInfo(null)).toBeNull();
      expect(parseMeshEventInfo(undefined)).toBeNull();
      expect(parseMeshEventInfo('!a1b2c3d4')).toBeNull();
      expect(parseMeshEventInfo(42)).toBeNull();
    });

    it('a missing/non-canonical node id VOIDS the fragment (the node id is the badge identity)', () => {
      expect(parseMeshEventInfo({ device: 'd', channel: 0 })).toBeNull();
      expect(parseMeshEventInfo({ node: 'a1b2c3d4' })).toBeNull();       // no leading !
      expect(parseMeshEventInfo({ node: '!A1B2C3D4' })).toBeNull();      // uppercase (non-canonical)
      expect(parseMeshEventInfo({ node: '!a1b2c3d' })).toBeNull();       // 7 digits
      expect(parseMeshEventInfo({ node: '!a1b2c3d4e' })).toBeNull();     // 9 digits
      expect(parseMeshEventInfo({ node: '!' + 'a'.repeat(4096) })).toBeNull(); // hostile blob
      expect(parseMeshEventInfo({ node: 7 })).toBeNull();
    });

    it('a junk device falls back to "default"; channel must be an integer clamped 0..7', () => {
      const base = { node: '!a1b2c3d4' };
      expect(parseMeshEventInfo({ ...base, device: 'no spaces!' })!.device).toBe('default');
      expect(parseMeshEventInfo({ ...base, device: 'a'.repeat(65) })!.device).toBe('default');
      expect(parseMeshEventInfo({ ...base, device: 7 })!.device).toBe('default');
      expect(parseMeshEventInfo({ ...base, channel: 99 })!.channel).toBe(7);
      expect(parseMeshEventInfo({ ...base, channel: -1 })!.channel).toBe(0);
      expect(parseMeshEventInfo({ ...base, channel: 2.5 })!.channel).toBe(0);
      expect(parseMeshEventInfo({ ...base, channel: '3' })!.channel).toBe(0);
    });

    it('registered is STRICT === true; rssi/snr kept only when finite, clamped into range', () => {
      const base = { node: '!a1b2c3d4' };
      expect(parseMeshEventInfo({ ...base, registered: 'yes' })!.registered).toBeFalse();
      expect(parseMeshEventInfo({ ...base, registered: 1 })!.registered).toBeFalse();
      expect(parseMeshEventInfo({ ...base, rssi: Number.NaN })!.rssi).toBeUndefined();
      expect(parseMeshEventInfo({ ...base, rssi: '−87' })!.rssi).toBeUndefined();
      expect(parseMeshEventInfo({ ...base, rssi: Number.NEGATIVE_INFINITY })!.rssi).toBeUndefined();
      expect(parseMeshEventInfo({ ...base, rssi: -9999 })!.rssi).toBe(-200);
      expect(parseMeshEventInfo({ ...base, snr: 1e9 })!.snr).toBe(100);
      expect(parseMeshEventInfo({ ...base })!.rssi).toBeUndefined();
      expect(parseMeshEventInfo({ ...base })!.snr).toBeUndefined();
    });
  });

  it('maps + parses the mesh provenance fragment off an event content field', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's2',
      rooms: {
        join: {
          '!r:test': {
            timeline: { events: [{
              event_id: '$m1', type: 'm.room.message', sender: '@mesh-a1b2c3d4:test', origin_server_ts: 5,
              content: { msgtype: 'm.text', body: 'over the air', [MESH_EVENT_CONTENT_FIELD]: { node: '!a1b2c3d4', device: 'default', channel: 0, registered: false, rssi: -92 } },
            }], limited: false },
          },
        },
      },
    }));
    const state = await service.sync('s1', 0);
    expect(state.rooms['!r:test'].timeline[0].mesh)
      .toEqual({ node: '!a1b2c3d4', device: 'default', channel: 0, registered: false, rssi: -92 });
  });

  it('LEGACY read-fallback: a pre-rebrand LEGACY_MESH_EVENT_CONTENT_FIELD fragment still yields the badge, '
    + 'and the canonical field wins when both exist', async () => {
    // Bridged events written before the rebrand carry their provenance under
    // the legacy field name forever (events are immutable) — the badge must
    // not vanish off the room's history. Read-fallback only: the UI never
    // writes this field at all.
    const legacy = { node: '!a1b2c3d4', device: 'default', channel: 1, registered: false };
    const canonical = { node: '!feedf00d', device: 'default', channel: 2, registered: true };
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's2',
      rooms: { join: { '!r:test': { timeline: { events: [
        { event_id: '$l1', type: 'm.room.message', sender: '@mesh-a1b2c3d4:test', origin_server_ts: 5,
          content: { msgtype: 'm.text', body: 'old air', [LEGACY_MESH_EVENT_CONTENT_FIELD]: legacy } },
        { event_id: '$l2', type: 'm.room.message', sender: '@mesh-feedf00d:test', origin_server_ts: 6,
          content: { msgtype: 'm.text', body: 'both', [MESH_EVENT_CONTENT_FIELD]: canonical, [LEGACY_MESH_EVENT_CONTENT_FIELD]: legacy } },
      ], limited: false } } } },
    }));
    const state = await service.sync('s1', 0);
    expect(state.rooms['!r:test'].timeline[0].mesh).toEqual(legacy);
    expect(state.rooms['!r:test'].timeline[1].mesh).toEqual(canonical);
  });

  it('leaves mesh undefined for an ordinary event and for a MALFORMED fragment', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      next_batch: 's2',
      rooms: { join: { '!r:test': { timeline: { events: [
        { event_id: '$e1', type: 'm.room.message', sender: '@a:test', origin_server_ts: 5, content: { msgtype: 'm.text', body: 'plain' } },
        { event_id: '$e2', type: 'm.room.message', sender: '@a:test', origin_server_ts: 6, content: { msgtype: 'm.text', body: 'forged', [MESH_EVENT_CONTENT_FIELD]: { node: '<script>alert(1)</script>' } } },
      ], limited: false } } } },
    }));
    const state = await service.sync('s1', 0);
    expect(state.rooms['!r:test'].timeline[0].mesh).toBeUndefined();
    expect(state.rooms['!r:test'].timeline[1].mesh).toBeUndefined();
  });

  // ─────────────────────────── mxc → http conversion (through the proxy) ───────────────────────────

  it('converts an mxc uri to an authenticated v1 download URL through the proxy prefix', () => {
    const url = service.mxcToHttp('mxc://matrix.test/abc123');
    expect(url).toBe(`${BFF}/bff/user/matrix/_matrix/client/v1/media/download/matrix.test/abc123`);
  });

  it('builds a thumbnail URL with width/height/method params', () => {
    const url = service.mxcToHttp('mxc://matrix.test/abc123', { thumbnail: true, w: 64, h: 64, method: 'scale' });
    expect(url).toContain('/bff/user/matrix/_matrix/client/v1/media/thumbnail/matrix.test/abc123');
    expect(url).toContain('width=64');
    expect(url).toContain('height=64');
    expect(url).toContain('method=scale');
  });

  it('returns an empty string for a non-mxc uri', () => {
    expect(service.mxcToHttp('https://not-mxc/x')).toBe('');
    expect(service.mxcToHttp('')).toBe('');
  });

  // ─────────────────────────── AI-cloak BFF media proxy ───────────────────────────

  function imageFile(): File {
    return new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' });
  }

  it('uploadMedia POSTs the bytes to the content repo through the proxy prefix (opt-out/fallback path)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ content_uri: 'mxc://matrix.test/raw' }));
    const res = await service.uploadMedia(imageFile(), 'pic.png');
    expect(lastUrl()).toContain(`${BFF}/bff/user/matrix/_matrix/media/v3/upload`);
    expect(res.mxcUri).toBe('mxc://matrix.test/raw');
  });

  it('uploadMediaProtected POSTs multipart (file + platform=matrix + mode + roomId) to the BFF media proxy with the HttpOnly bff_ cookie', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ mxcUri: 'mxc://matrix.test/cloaked', status: 'pending', backend: 'cuda' }));
    const res = await service.uploadMediaProtected(imageFile(), 'cloak', '!r:test');
    // Routes through the BFF media proxy, NOT the homeserver content repo.
    expect(lastUrl()).toBe('https://bff.test/bff/user/media/upload');
    const init = lastInit();
    expect(init.method).toBe('POST');
    // Authenticates via the cookie ONLY — no browser-held bearer.
    expect(header('Authorization')).toBeUndefined();
    expect(init.credentials).toBe('include');
    const form = init.body as FormData;
    expect(form.get('platform')).toBe('matrix');
    expect(form.get('mode')).toBe('cloak');
    expect(form.get('roomId')).toBe('!r:test');
    expect(form.get('file')).toBeTruthy();
    // The returned mxc + the server's honest cloak decision come back to the caller.
    expect(res.mxcUri).toBe('mxc://matrix.test/cloaked');
    expect(res.decision.status).toBe('pending');
    expect(res.decision.mode).toBe('cloak');
  });

  it('uploadMediaProtected throws on a non-OK proxy response', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 502 }));
    await expectAsync(service.uploadMediaProtected(imageFile(), 'cloak', '!r:test'))
      .toBeRejectedWithError(/uploadMediaProtected failed: 502/);
  });

  it('cloakCapability reports the heavy-tier backend + availability from the BFF probe', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ backend: 'cuda', available: true, expectedSeconds: 90 }));
    const cap = await service.cloakCapability();
    expect(lastUrl()).toBe('https://bff.test/bff/user/media/capability');
    expect(cap).toEqual({ backend: 'cuda', available: true, expectedSeconds: 90 });
  });

  it('cloakCapability degrades to an honest "none/unavailable" when the probe fails (no throw)', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 503 }));
    expect(await service.cloakCapability()).toEqual({ backend: 'none', available: false });
  });

  it('cloakStatus returns the server-owned decision for an mxc (badge source of truth)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ mode: 'cloak', status: 'degraded', backend: 'cpu' }));
    const d = await service.cloakStatus('mxc://matrix.test/cloaked');
    expect(lastUrl()).toContain('/bff/user/media/status/');
    expect(d.status).toBe('degraded');
    expect(d.mode).toBe('cloak');
  });

  // ─────────────────────────── VoIP TURN credentials (ICE) ───────────────────────────

  it('turnServer() GETs the canonical /voip/turnServer endpoint through the proxy with the HttpOnly bff_ cookie', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ uris: ['turn:relay.test:3478'], username: 'u1', password: 'p1', ttl: 86400 }));
    await service.turnServer();
    expect(lastUrl()).toBe(`${BFF}/bff/user/matrix/_matrix/client/v3/voip/turnServer`);
    const init = lastInit();
    expect(init.method).toBeUndefined(); // a GET
    expect(header('Authorization')).toBeUndefined();
    expect(init.credentials).toBe('include');
  });

  it('turnServer() maps {uris,username,password} → a single RTCIceServer {urls,username,credential}', async () => {
    fetchSpy.and.resolveTo(jsonResponse({
      uris: ['turn:relay.test:3478?transport=udp', 'turns:relay.test:5349?transport=tcp'],
      username: 'tok-user', password: 'tok-pass', ttl: 86400,
    }));
    const ice = await service.turnServer();
    expect(ice).toEqual([{
      urls: ['turn:relay.test:3478?transport=udp', 'turns:relay.test:5349?transport=tcp'],
      username: 'tok-user',
      credential: 'tok-pass',
    }]);
  });

  it('turnServer() omits username/credential for a bare STUN entry (no creds in the response)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ uris: ['stun:stun.test:3478'] }));
    const ice = await service.turnServer();
    expect(ice).toEqual([{ urls: ['stun:stun.test:3478'] }]);
    expect((ice[0] as RTCIceServer).username).toBeUndefined();
    expect((ice[0] as RTCIceServer).credential).toBeUndefined();
  });

  it('turnServer() returns [] (host-only default) when the homeserver advertises no uris', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ uris: [], username: 'u', password: 'p', ttl: 0 }));
    expect(await service.turnServer()).toEqual([]);
  });

  it('turnServer() returns [] (no throw) on a non-OK response — graceful degrade to host-only', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 404 }));
    expect(await service.turnServer()).toEqual([]);
  });

  it('turnServer() returns [] (no throw) when the fetch itself rejects', async () => {
    fetchSpy.and.rejectWith(new Error('network down'));
    await expectAsync(service.turnServer()).toBeResolvedTo([]);
  });

  // ─────────────────────────── Pinned events (3D room media panel) ───────────────────────────

  it('getPinnedEvents() reads m.room.pinned_events state and returns the pinned ids', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ pinned: ['$a:1', '$b:2'] }));
    const ids = await service.getPinnedEvents('!room:test');
    expect(lastUrl()).toBe(`${BFF}/bff/user/matrix/_matrix/client/v3/rooms/!room:test/state/m.room.pinned_events/`);
    expect(ids).toEqual(['$a:1', '$b:2']);
  });

  // ─────────────────────────── Path-segment spelling (enc contract) ───────────────────────────
  // The hsproxy re-escapes '%' in already-encoded paths (Spring URI-template
  // factory), so `%3A` reaches the homeserver as `%253A` and room-scoped calls
  // 500. enc() therefore emits the RFC 3986 raw-pchar spelling: ':'/'@' etc.
  // literal, while true delimiters ('#' in aliases, '/', '?', '%') STAY
  // encoded. This test pins both halves of that contract.
  it('path segments spell pchar characters raw but keep true delimiters encoded', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ room_id: '!j:test' }));
    await service.joinRoom('#alias:test');
    expect(lastUrl()).toBe(`${BFF}/bff/user/matrix/_matrix/client/v3/join/%23alias:test`);
  });

  it('getPinnedEvents() drops non-event-id junk and caps the list (member-writable content is untrusted)', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `$pin${i}:test`);
    fetchSpy.and.resolveTo(jsonResponse({ pinned: [42, 'not-an-id', { evil: true }, null, ...many] }));
    const ids = await service.getPinnedEvents('!room:test');
    expect(ids.length).toBe(MatrixService.MAX_PINNED_EVENTS);
    expect(ids[0]).toBe('$pin0:test');
    expect(ids.every((id) => id.startsWith('$'))).toBeTrue();
  });

  it('getPinnedEvents() fails soft to [] on unset state, malformed content and rejected fetch', async () => {
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 404 }));
    expect(await service.getPinnedEvents('!room:test')).toEqual([]);
    fetchSpy.and.resolveTo(jsonResponse({ pinned: 'not-an-array' }));
    expect(await service.getPinnedEvents('!room:test')).toEqual([]);
    fetchSpy.and.rejectWith(new Error('network down'));
    await expectAsync(service.getPinnedEvents('!room:test')).toBeResolvedTo([]);
  });

  // ─────────────────────────── Media bytes (3D room texture path) ───────────────────────────

  it('fetchMediaBytes() downloads authenticated media as an ArrayBuffer through the proxy', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    fetchSpy.and.resolveTo({
      ok: true, status: 200, arrayBuffer: async () => bytes,
    } as unknown as Response);
    const out = await service.fetchMediaBytes('mxc://matrix.test/tex1');
    expect(lastUrl()).toBe(`${BFF}/bff/user/matrix/_matrix/client/v1/media/download/matrix.test/tex1`);
    expect(lastInit().credentials).toBe('include');
    expect(out).toBe(bytes);
  });

  it('fetchMediaBytes() uses the thumbnail endpoint for poster frames (video v1 path)', async () => {
    fetchSpy.and.resolveTo({
      ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1),
    } as unknown as Response);
    await service.fetchMediaBytes('mxc://matrix.test/vid1', { thumbnail: true, w: 640, h: 360, method: 'scale' });
    expect(lastUrl()).toContain('/_matrix/client/v1/media/thumbnail/matrix.test/vid1');
    expect(lastUrl()).toContain('width=640');
    expect(lastUrl()).toContain('height=360');
    expect(lastUrl()).toContain('method=scale');
  });

  it('fetchMediaBytes() fails soft to null on a bad mxc, a non-OK response and a rejected fetch', async () => {
    expect(await service.fetchMediaBytes('https://not-mxc.test/x')).toBeNull();
    fetchSpy.and.resolveTo(jsonResponse(null, { ok: false, status: 403 }));
    expect(await service.fetchMediaBytes('mxc://matrix.test/denied')).toBeNull();
    fetchSpy.and.rejectWith(new Error('network down'));
    await expectAsync(service.fetchMediaBytes('mxc://matrix.test/gone')).toBeResolvedTo(null);
  });
});
