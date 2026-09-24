import { TestBed } from '@angular/core/testing';
import { BFF_BASE_URL, MatrixService } from '../matrix.service';
import { CALL_MEMBER_EVENT_TYPE, MATRIX_RTC_ENABLED, MATRIX_RTC_WELLKNOWN_URL, RTC_FOCI_WELLKNOWN_KEY } from './matrix-rtc';
import {
  MAX_RTC_DATA_FRAME_BYTES, MAX_RTC_DEVICE_SLOTS, MatrixRtcService, RTC_DEVICE_BASE_STORAGE_KEY,
  RTC_DEVICE_SLOT_LOCK_PREFIX, RtcLockManagerLike, RtcRoomLike,
} from './matrix-rtc.service';

const FOCUS = { type: 'livekit' as const, livekit_service_url: 'https://rtc.example.test/livekit/jwt' };
const OPENID = { access_token: 'oid-tok', token_type: 'Bearer', matrix_server_name: 'example.test', expires_in: 3600 };

interface Call { url: string; init: RequestInit | undefined }

/** A scripted fetch: each URL maps to a responder; every call is recorded. */
class FakeFetch {
  calls: Call[] = [];
  routes = new Map<string, () => Response | Promise<Response>>();
  readonly fn = (url: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url, init });
    const route = this.routes.get(url);
    return route ? Promise.resolve(route()) : Promise.resolve(new Response('nope', { status: 404 }));
  };
  json(url: string, body: unknown, status = 200): void {
    this.routes.set(url, () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  }
}

/** A fake LiveKit room: records calls, lets the spec fire room events. */
class FakeRoom implements RtcRoomLike {
  listeners = new Map<string, ((...args: any[]) => void)[]>();
  connected: { url: string; token: string } | null = null;
  disconnects = 0;
  published: MediaStreamTrack[] = [];
  data: { data: Uint8Array; opts: { reliable: boolean } }[] = [];
  connectError: Error | null = null;
  localParticipant = {
    publishTrack: async (t: MediaStreamTrack) => {
      this.published.push(t);
    },
    publishData: async (data: Uint8Array, opts: { reliable: boolean }) => {
      this.data.push({ data, opts });
    },
  };
  async connect(url: string, token: string): Promise<void> {
    if (this.connectError) {
      throw this.connectError;
    }
    this.connected = { url, token };
  }
  async disconnect(): Promise<void> {
    this.disconnects++;
  }
  on(event: string, listener: (...args: any[]) => void): unknown {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) {
      l(...args);
    }
  }
}

class MatrixStub {
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$m1');
}

/** A Web Locks manager with the real `ifAvailable` contract: a held name hands the callback null. */
class FakeLocks implements RtcLockManagerLike {
  held = new Set<string>();
  request(name: string, _opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | undefined): Promise<unknown> {
    if (this.held.has(name)) {
      return Promise.resolve(cb(null));
    }
    this.held.add(name);
    return Promise.resolve(cb({ name })).finally(() => this.held.delete(name));
  }
}

class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

const WELL_KNOWN = '/.well-known/matrix/client';
const OPENID_URL = '/bff/user/matrix/_matrix/client/v3/user/@alice:example.test/openid/request_token';
const SFU_GET = 'https://rtc.example.test/livekit/jwt/sfu/get';

describe('MatrixRtcService (discovery → OpenID → LiveKit JWT → connect → membership)', () => {
  let svc: MatrixRtcService;
  let fake: FakeFetch;
  let room: FakeRoom;
  let matrix: MatrixStub;
  let releases: number;

  function setup(enabled: boolean): void {
    fake = new FakeFetch();
    room = new FakeRoom();
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: MatrixService, useValue: matrix },
        { provide: BFF_BASE_URL, useValue: '' },
        { provide: MATRIX_RTC_ENABLED, useValue: enabled },
        { provide: MATRIX_RTC_WELLKNOWN_URL, useValue: WELL_KNOWN },
      ],
    });
    svc = TestBed.inject(MatrixRtcService);
    svc.fetchFn = fake.fn;
    svc.roomFactory = async () => room;
    svc.streamFromTrack = (t) => ({ fakeStreamOf: t }) as unknown as MediaStream;
    svc.deviceIdFactory = () => 'HUGRTCDEV1';
    releases = 0;
    svc.claimDeviceId = async () => ({ id: 'HUGRTCDEV1', release: () => void releases++ });
  }

  function happyPath(): void {
    fake.json(WELL_KNOWN, { [RTC_FOCI_WELLKNOWN_KEY]: [FOCUS] });
    fake.json(OPENID_URL, OPENID);
    fake.json(SFU_GET, { url: 'wss://sfu.example.test', jwt: 'lk-jwt' });
  }

  describe('flag OFF (the default)', () => {
    beforeEach(() => setup(false));

    it('discoverFocus makes NO request at all and reports no focus', async () => {
      happyPath();
      expect(await svc.discoverFocus()).toBeNull();
      expect(fake.calls).toEqual([]);
    });
  });

  describe('flag ON', () => {
    beforeEach(() => setup(true));

    it('discovers the focus from the client well-known, same-origin', async () => {
      happyPath();
      expect(await svc.discoverFocus()).toEqual(FOCUS);
      expect(fake.calls.length).toBe(1);
      expect(fake.calls[0].url).toBe(WELL_KNOWN);
      expect(fake.calls[0].init?.credentials).toBe('same-origin');
    });

    it('no focus when the well-known 404s, is HTML (the SPA fallback), throws, or names none', async () => {
      expect(await svc.discoverFocus()).withContext('404').toBeNull();
      fake.routes.set(WELL_KNOWN, () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
      expect(await svc.discoverFocus()).withContext('html').toBeNull();
      fake.routes.set(WELL_KNOWN, () => {
        throw new Error('network');
      });
      expect(await svc.discoverFocus()).withContext('throw').toBeNull();
      fake.json(WELL_KNOWN, { 'm.homeserver': { base_url: 'https://x' } });
      expect(await svc.discoverFocus()).withContext('none').toBeNull();
    });

    it('OpenID token: POSTs through the hsproxy with @ and : kept literal, cookie auth, no bearer', async () => {
      happyPath();
      expect(await svc.requestOpenIdToken('@alice:example.test')).toEqual(OPENID);
      const call = fake.calls[0];
      expect(call.url).toBe(OPENID_URL);
      expect(call.init?.method).toBe('POST');
      expect(call.init?.credentials).toBe('include');
      expect(call.init?.body).toBe('{}');
      expect(JSON.stringify(call.init?.headers)).not.toContain('Authorization');
    });

    it('LiveKit JWT: legacy /sfu/get body is literal, cookies OMITTED to the other origin', async () => {
      happyPath();
      expect(await svc.requestSfuToken(FOCUS, '!r:example.test', OPENID, 'HUGRTCDEV1'))
        .toEqual({ url: 'wss://sfu.example.test', jwt: 'lk-jwt' });
      const call = fake.calls[0];
      expect(call.url).toBe(SFU_GET);
      expect(call.init?.method).toBe('POST');
      expect(call.init?.credentials).toBe('omit');
      expect(JSON.parse(String(call.init?.body))).toEqual({
        room: '!r:example.test', openid_token: OPENID, device_id: 'HUGRTCDEV1',
      });
    });

    it('LiveKit JWT: a non-wss LiveKit URL, a missing jwt, or a refusal yields nothing', async () => {
      fake.json(SFU_GET, { url: 'ws://sfu.example.test', jwt: 'lk-jwt' });
      expect(await svc.requestSfuToken(FOCUS, '!r', OPENID, 'D')).withContext('ws:').toBeNull();
      fake.json(SFU_GET, { url: 'wss://sfu.example.test' });
      expect(await svc.requestSfuToken(FOCUS, '!r', OPENID, 'D')).withContext('no jwt').toBeNull();
      fake.json(SFU_GET, { errcode: 'M_FORBIDDEN' }, 403);
      expect(await svc.requestSfuToken(FOCUS, '!r', OPENID, 'D')).withContext('403').toBeNull();
    });

    it('join: connects with the JWT, THEN publishes the call-membership state event', async () => {
      happyPath();
      const res = await svc.join('!r:example.test', '@alice:example.test', FOCUS);
      expect(res.ok).toBeTrue();
      expect(room.connected).toEqual({ url: 'wss://sfu.example.test', token: 'lk-jwt' });
      expect(matrix.setStateEvent).toHaveBeenCalledOnceWith(
        '!r:example.test', CALL_MEMBER_EVENT_TYPE,
        jasmine.objectContaining({ application: 'm.call', device_id: 'HUGRTCDEV1', membershipID: '@alice:example.test:HUGRTCDEV1' }),
        '_@alice:example.test_HUGRTCDEV1_m.call');
      expect(res.ok && res.membershipPublished).toBeTrue();
    });

    it('leave: disconnects AND clears the membership with {} on the same state key; idempotent', async () => {
      happyPath();
      const res = await svc.join('!r:example.test', '@alice:example.test', FOCUS);
      if (!res.ok) {
        fail('join failed');
        return;
      }
      matrix.setStateEvent.calls.reset();
      await res.session.leave();
      await res.session.leave();
      expect(room.disconnects).toBe(1);
      expect(matrix.setStateEvent).toHaveBeenCalledOnceWith(
        '!r:example.test', CALL_MEMBER_EVENT_TYPE, {}, '_@alice:example.test_HUGRTCDEV1_m.call');
      expect(releases).withContext('device slot released once, on leave').toBe(1);
    });

    it('join: a REFUSED membership publish (power levels) keeps the call and says so', async () => {
      happyPath();
      matrix.setStateEvent.and.rejectWith(new Error('setStateEvent failed: 403'));
      const res = await svc.join('!r:example.test', '@alice:example.test', FOCUS);
      expect(res.ok).toBeTrue();
      expect(res.ok && res.membershipPublished).toBeFalse();
      if (res.ok) {
        matrix.setStateEvent.calls.reset();
        await res.session.leave();
        // Nothing was published, so nothing is cleared.
        expect(matrix.setStateEvent).not.toHaveBeenCalled();
      }
    });

    it('join fails at the step that failed, and never publishes membership for a call it is not in', async () => {
      expect(await svc.join('!r', '@alice:example.test', FOCUS)).toEqual({ ok: false, step: 'openid' });
      fake.json(OPENID_URL, OPENID);
      expect(await svc.join('!r', '@alice:example.test', FOCUS)).toEqual({ ok: false, step: 'token' });
      fake.json(SFU_GET, { url: 'wss://sfu.example.test', jwt: 'lk-jwt' });
      room.connectError = new Error('ws refused');
      expect(await svc.join('!r', '@alice:example.test', FOCUS)).toEqual({ ok: false, step: 'connect' });
      expect(room.disconnects).toBe(1);
      expect(matrix.setStateEvent).not.toHaveBeenCalled();
      // openid failed before a claim; token + connect failures each released theirs.
      expect(releases).toBe(2);
    });

    describe('the joined session', () => {
      async function joined() {
        happyPath();
        const res = await svc.join('!r:example.test', '@alice:example.test', FOCUS);
        if (!res.ok) {
          throw new Error('join failed');
        }
        return res.session;
      }

      it('maps remote audio to the VERIFIED mxid; ignores video and unparseable identities', async () => {
        const session = await joined();
        const got: [string, unknown][] = [];
        session.onPeerAudio = (u, s) => got.push([u, s]);
        const track = { id: 't1' } as unknown as MediaStreamTrack;
        room.emit('trackSubscribed', { kind: 'audio', mediaStreamTrack: track }, {}, { identity: '@bob:example.test:DEVB' });
        room.emit('trackSubscribed', { kind: 'video', mediaStreamTrack: track }, {}, { identity: '@bob:example.test:DEVB' });
        room.emit('trackSubscribed', { kind: 'audio', mediaStreamTrack: track }, {}, { identity: 'mallory' });
        expect(got).toEqual([['@bob:example.test', { fakeStreamOf: track }]]);
      });

      it('RETAINS remote audio that arrives before a consumer handler exists; newest wins; forgotten on unsubscribe/leave', async () => {
        const session = await joined();
        expect(session.onPeerAudio).toBeNull();
        const t1 = { id: 't1' } as unknown as MediaStreamTrack;
        const t2 = { id: 't2' } as unknown as MediaStreamTrack;
        room.emit('trackSubscribed', { kind: 'audio', mediaStreamTrack: t1 }, {}, { identity: '@bob:example.test:DEVB' });
        expect(session.remoteAudio('@bob:example.test')).toEqual({ fakeStreamOf: t1 } as unknown as MediaStream);
        // A second device of the same user: its newer stream is the one handed out.
        room.emit('trackSubscribed', { kind: 'audio', mediaStreamTrack: t2 }, {}, { identity: '@bob:example.test:DEVC' });
        expect(session.remoteAudio('@bob:example.test')).toEqual({ fakeStreamOf: t2 } as unknown as MediaStream);
        // Unsubscribing an OLD track of that identity does not forget a newer one.
        room.emit('trackUnsubscribed', { kind: 'audio', mediaStreamTrack: t1 }, {}, { identity: '@bob:example.test:DEVC' });
        expect(session.remoteAudio('@bob:example.test')).toEqual({ fakeStreamOf: t2 } as unknown as MediaStream);
        room.emit('trackUnsubscribed', { kind: 'audio', mediaStreamTrack: t2 }, {}, { identity: '@bob:example.test:DEVC' });
        expect(session.remoteAudio('@bob:example.test')).toEqual({ fakeStreamOf: t1 } as unknown as MediaStream);
        room.emit('participantDisconnected', { identity: '@bob:example.test:DEVB' });
        expect(session.remoteAudio('@bob:example.test')).toBeNull();
        room.emit('trackSubscribed', { kind: 'audio', mediaStreamTrack: t1 }, {}, { identity: '@carol:example.test:D' });
        await session.leave();
        expect(session.remoteAudio('@carol:example.test')).toBeNull();
        room.emit('trackSubscribed', { kind: 'audio', mediaStreamTrack: t1 }, {}, { identity: '@carol:example.test:D' });
        expect(session.remoteAudio('@carol:example.test')).withContext('nothing retained after leave').toBeNull();
        expect(session.remoteAudio('@nobody:example.test')).toBeNull();
      });

      it('data frames: copied out as an ArrayBuffer, oversized/serverside/non-bytes dropped', async () => {
        const session = await joined();
        const got: [string, number[]][] = [];
        session.onData = (u, f) => got.push([u, [...new Uint8Array(f)]]);
        const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
        room.emit('dataReceived', backing.subarray(2, 5), { identity: '@bob:example.test:DEVB' });
        room.emit('dataReceived', new Uint8Array(MAX_RTC_DATA_FRAME_BYTES + 1), { identity: '@bob:example.test:DEVB' });
        room.emit('dataReceived', new Uint8Array([1]), undefined);
        room.emit('dataReceived', 'text', { identity: '@bob:example.test:DEVB' });
        expect(got).toEqual([['@bob:example.test', [1, 2, 3]]]);
      });

      it('sendData publishes LOSSY bytes; publishMic reuses the captured track', async () => {
        const session = await joined();
        session.sendData(new Uint8Array([4, 5]).buffer);
        expect(room.data.length).toBe(1);
        expect([...room.data[0].data]).toEqual([4, 5]);
        expect(room.data[0].opts).toEqual({ reliable: false });
        const mic = { id: 'mic' } as unknown as MediaStreamTrack;
        await session.publishMic(mic);
        expect(room.published).toEqual([mic]);
      });

      it('participant departures and an unrequested disconnect reach the consumer; our own leave does not', async () => {
        const session = await joined();
        const left: string[] = [];
        let dropped = 0;
        session.onPeerLeft = (u) => left.push(u);
        session.onDisconnected = () => dropped++;
        room.emit('participantDisconnected', { identity: '@bob:example.test:DEVB' });
        room.emit('disconnected');
        expect(left).toEqual(['@bob:example.test']);
        expect(dropped).toBe(1);
        await session.leave();
        room.emit('disconnected');
        expect(dropped).toBe(1);
      });
    });
  });
});

describe('MatrixRtcService.claimDeviceId (bounded membership state keys, refute major)', () => {
  let svc: MatrixRtcService;
  let store: FakeStorage;
  let locks: FakeLocks;
  let seq: number;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MatrixService, useValue: new MatrixStub() },
        { provide: BFF_BASE_URL, useValue: '' },
        { provide: MATRIX_RTC_ENABLED, useValue: true },
      ],
    });
    svc = TestBed.inject(MatrixRtcService);
    store = new FakeStorage();
    locks = new FakeLocks();
    seq = 0;
    svc.deviceIdFactory = () => `HUGRTCRND${++seq}AAAA`;
    svc.storageFn = () => store;
    svc.locksFn = () => locks;
  });

  it('REUSES one id across joins: a stable stored base + the lowest free slot', async () => {
    const a = await svc.claimDeviceId();
    expect(a.id).toBe('HUGRTCRND1AAAA0');
    expect(store.getItem(RTC_DEVICE_BASE_STORAGE_KEY)).toBe('HUGRTCRND1AAAA');
    a.release();
    await new Promise((r) => setTimeout(r, 0));
    const b = await svc.claimDeviceId();
    expect(b.id).withContext('the next join reuses the SAME state key').toBe(a.id);
    b.release();
  });

  it('two live tabs never share an id (the slot is held); a freed slot is reused', async () => {
    const a = await svc.claimDeviceId();
    const b = await svc.claimDeviceId();
    expect(a.id).toBe('HUGRTCRND1AAAA0');
    expect(b.id).toBe('HUGRTCRND1AAAA1');
    expect(locks.held).toEqual(new Set([`${RTC_DEVICE_SLOT_LOCK_PREFIX}0`, `${RTC_DEVICE_SLOT_LOCK_PREFIX}1`]));
    a.release();
    await new Promise((r) => setTimeout(r, 0));
    const c = await svc.claimDeviceId();
    expect(c.id).toBe('HUGRTCRND1AAAA0');
  });

  it('BOUNDED: at most MAX_RTC_DEVICE_SLOTS stable ids; beyond that a one-off id', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_RTC_DEVICE_SLOTS; i++) {
      ids.push((await svc.claimDeviceId()).id);
    }
    expect(new Set(ids).size).toBe(MAX_RTC_DEVICE_SLOTS);
    expect(ids.every((id) => id.startsWith('HUGRTCRND1AAAA'))).toBeTrue();
    const extra = await svc.claimDeviceId();
    expect(extra.id).toBe('HUGRTCRND2AAAA');
  });

  it('a stored base that is not id-shaped is replaced, not trusted', async () => {
    store.setItem(RTC_DEVICE_BASE_STORAGE_KEY, 'x"y/../');
    expect((await svc.claimDeviceId()).id).toBe('HUGRTCRND1AAAA0');
  });

  it('no storage, a throwing storage, a write-dropping storage or no Web Locks: a one-off id, no-op release', async () => {
    svc.storageFn = () => null;
    expect((await svc.claimDeviceId()).id).toBe('HUGRTCRND1AAAA');
    svc.storageFn = () => {
      throw new Error('SecurityError');
    };
    expect((await svc.claimDeviceId()).id).toBe('HUGRTCRND2AAAA');
    svc.storageFn = () => ({ getItem: () => null, setItem: () => undefined });
    expect((await svc.claimDeviceId()).id).toBe('HUGRTCRND4AAAA'); // RND3 was the dropped seed
    svc.storageFn = () => store;
    svc.locksFn = () => null;
    const c = await svc.claimDeviceId();
    expect(c.id).toBe('HUGRTCRND6AAAA'); // RND5 seeded the base
    expect(() => c.release()).not.toThrow();
  });

  it('the REAL browser Web Locks API fits the narrowed contract (two claims, two slots, release frees)', async () => {
    svc.locksFn = () => ((navigator as unknown as { locks?: RtcLockManagerLike }).locks) ?? null;
    if (!svc.locksFn()) {
      pending('navigator.locks unavailable in this browser');
      return;
    }
    const a = await svc.claimDeviceId();
    const b = await svc.claimDeviceId();
    expect(a.id).toBe('HUGRTCRND1AAAA0');
    expect(b.id).toBe('HUGRTCRND1AAAA1');
    a.release();
    b.release();
    await new Promise((r) => setTimeout(r, 0));
    const c = await svc.claimDeviceId();
    expect(c.id).toBe('HUGRTCRND1AAAA0');
    c.release();
  });
});
