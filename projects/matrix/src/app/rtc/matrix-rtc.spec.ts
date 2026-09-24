import { TestBed } from '@angular/core/testing';
import {
  CALL_MEMBER_EVENT_TYPE, CALL_MEMBERSHIP_EXPIRES_MS, MATRIX_RTC_ENABLED, MATRIX_RTC_WELLKNOWN_URL,
  MAX_FOCI, RTC_FOCI_WELLKNOWN_KEY, buildCallMembership, callMemberStateKey, chooseGroupCallRoute,
  livekitIdentity, parseLivekitFoci, rawPcharSegment, userIdFromIdentity,
} from './matrix-rtc';

const FOCUS = { type: 'livekit' as const, livekit_service_url: 'https://rtc.example.test/livekit/jwt' };

describe('MatrixRTC wire shapes + routing rule (hugmesh-admin-bff-api#98 slice 1)', () => {
  it('the flag is DARK by default: MATRIX_RTC_ENABLED resolves false with no global hook', () => {
    expect((globalThis as any).__HUG_MATRIX_RTC__).toBeUndefined();
    expect(TestBed.inject(MATRIX_RTC_ENABLED)).toBeFalse();
  });

  it('the flag turns on ONLY for a literal true on the global hook', () => {
    for (const [value, expected] of [[true, true], ['true', false], [1, false]] as const) {
      TestBed.resetTestingModule();
      (globalThis as any).__HUG_MATRIX_RTC__ = value;
      try {
        expect(TestBed.inject(MATRIX_RTC_ENABLED)).withContext(String(value)).toBe(expected);
      } finally {
        delete (globalThis as any).__HUG_MATRIX_RTC__;
      }
    }
  });

  it('well-known is read same-origin from the front door by default', () => {
    expect(TestBed.inject(MATRIX_RTC_WELLKNOWN_URL)).toBe('/.well-known/matrix/client');
  });

  it('pins the MSC4143 / MSC3401 literals other MatrixRTC clients read', () => {
    expect(RTC_FOCI_WELLKNOWN_KEY).toBe('org.matrix.msc4143.rtc_foci');
    expect(CALL_MEMBER_EVENT_TYPE).toBe('org.matrix.msc3401.call.member');
    expect(CALL_MEMBERSHIP_EXPIRES_MS).toBe(14_400_000);
  });

  describe('parseLivekitFoci', () => {
    it('reads livekit foci from the well-known key, in order, trailing slash trimmed', () => {
      const doc = {
        'm.homeserver': { base_url: 'https://matrix.example.test' },
        [RTC_FOCI_WELLKNOWN_KEY]: [
          { type: 'livekit', livekit_service_url: 'https://a.example.test/livekit/jwt/' },
          { type: 'livekit', livekit_service_url: 'https://b.example.test' },
        ],
      };
      expect(parseLivekitFoci(doc)).toEqual([
        { type: 'livekit', livekit_service_url: 'https://a.example.test/livekit/jwt' },
        { type: 'livekit', livekit_service_url: 'https://b.example.test' },
      ]);
    });

    it('drops non-https, credentialed, non-livekit and malformed entries (an OpenID token goes there)', () => {
      const doc = {
        [RTC_FOCI_WELLKNOWN_KEY]: [
          { type: 'livekit', livekit_service_url: 'http://plain.example.test' },
          { type: 'livekit', livekit_service_url: 'https://user:pw@creds.example.test' },
          { type: 'other', livekit_service_url: 'https://other.example.test' },
          { type: 'livekit', livekit_service_url: 42 },
          { type: 'livekit', livekit_service_url: 'not a url' },
          null,
          'livekit',
          { type: 'livekit', livekit_service_url: 'https://ok.example.test' },
        ],
      };
      expect(parseLivekitFoci(doc)).toEqual([{ type: 'livekit', livekit_service_url: 'https://ok.example.test' }]);
    });

    it('no key, a wrong key, or a non-object document all mean NO focus', () => {
      expect(parseLivekitFoci(null)).toEqual([]);
      expect(parseLivekitFoci('<html>')).toEqual([]);
      expect(parseLivekitFoci({})).toEqual([]);
      expect(parseLivekitFoci({ 'org.matrix.msc4143.rtc_focus': [FOCUS] })).toEqual([]);
      expect(parseLivekitFoci({ [RTC_FOCI_WELLKNOWN_KEY]: FOCUS })).toEqual([]);
    });

    it('LIMIT: reads at most MAX_FOCI entries', () => {
      const many = Array.from({ length: 50 }, (_, i) => ({ type: 'livekit', livekit_service_url: `https://f${i}.example.test` }));
      expect(parseLivekitFoci({ [RTC_FOCI_WELLKNOWN_KEY]: many }).length).toBe(MAX_FOCI);
    });
  });

  it('membership state key is the underscore-prefixed matrix-js-sdk form', () => {
    expect(callMemberStateKey('@alice:example.test', 'HUGRTCABC')).toBe('_@alice:example.test_HUGRTCABC_m.call');
  });

  it('membership content is the session-format event, literal for literal', () => {
    expect(buildCallMembership('@alice:example.test', 'DEV1', '!room:example.test', FOCUS)).toEqual({
      'application': 'm.call',
      'call_id': '',
      'scope': 'm.room',
      'device_id': 'DEV1',
      'membershipID': '@alice:example.test:DEV1',
      'expires': 14_400_000,
      'm.call.intent': 'audio',
      'focus_active': { type: 'livekit', focus_selection: 'oldest_membership' },
      'foci_preferred': [{
        type: 'livekit', livekit_service_url: 'https://rtc.example.test/livekit/jwt', livekit_alias: '!room:example.test',
      }],
    });
  });

  it('LiveKit identity round-trips to the verified mxid, including a server with a port', () => {
    expect(livekitIdentity('@a:hs.test', 'D1')).toBe('@a:hs.test:D1');
    expect(userIdFromIdentity('@a:hs.test:D1')).toBe('@a:hs.test');
    expect(userIdFromIdentity('@a:hs.test:8448:D1')).toBe('@a:hs.test:8448');
    for (const bad of ['', 'D1', '@a', '@a:D1', 'alice:hs:D1', ':D1', 7, null, undefined]) {
      expect(userIdFromIdentity(bad)).withContext(String(bad)).toBeNull();
    }
  });

  it('path segments keep @ and : literal (the hsproxy re-escapes %)', () => {
    expect(rawPcharSegment('@alice:example.test')).toBe('@alice:example.test');
    expect(rawPcharSegment('a/b?c#d%e')).toBe('a%2Fb%3Fc%23d%25e');
  });

  describe('chooseGroupCallRoute (decision 102a)', () => {
    const base = { enabled: true, focus: FOCUS, p2pCap: 8 };

    it('cap + 1 participants with a focus → the SFU', () => {
      expect(chooseGroupCallRoute({ ...base, rosterSize: 9 })).toEqual({ transport: 'sfu', focus: FOCUS });
    });

    it('exactly AT the cap stays peer-to-peer (off-by-one guard)', () => {
      expect(chooseGroupCallRoute({ ...base, rosterSize: 8 })).toEqual({ transport: 'p2p', reason: 'within-cap' });
    });

    it('above the cap with NO focus stays peer-to-peer, reason no-focus', () => {
      expect(chooseGroupCallRoute({ ...base, focus: null, rosterSize: 9 })).toEqual({ transport: 'p2p', reason: 'no-focus' });
    });

    it('flag OFF never routes to the SFU, even above the cap with a focus', () => {
      expect(chooseGroupCallRoute({ ...base, enabled: false, rosterSize: 17 })).toEqual({ transport: 'p2p', reason: 'flag-off' });
    });

    it('the cap is the room\'s own maxParticipants (16 → 17 routes, 16 does not)', () => {
      expect(chooseGroupCallRoute({ ...base, p2pCap: 16, rosterSize: 16 }).transport).toBe('p2p');
      expect(chooseGroupCallRoute({ ...base, p2pCap: 16, rosterSize: 17 }).transport).toBe('sfu');
    });
  });
});
