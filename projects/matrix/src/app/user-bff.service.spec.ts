import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  MeshDevice,
  UserBffService,
  UserBlock,
  normalizeMeshNodeId,
  parseMeshDevice,
} from './user-bff.service';

/** A fully-valid raw mesh-device row (the parse must round-trip it). */
function rawDevice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd1', nodeId: '!a1b2c3d4', label: 'Backpack radio', createdAt: '2026-07-16T00:00:00Z',
    visibility: 'friends', state: 'active', revokeReason: null,
    lastSeenAt: '2026-07-16T00:00:00Z', batteryPct: 87, snr: 6.5, hopsAway: 2, viaDevice: 'lora-1',
    ...over,
  };
}

describe('normalizeMeshNodeId (claim-form input)', () => {
  it('canonicalizes bare and !-prefixed hex, folding case and trimming', () => {
    expect(normalizeMeshNodeId('a1b2c3d4')).toBe('!a1b2c3d4');
    expect(normalizeMeshNodeId('!a1b2c3d4')).toBe('!a1b2c3d4');
    expect(normalizeMeshNodeId('!A1B2C3D4')).toBe('!a1b2c3d4');
    expect(normalizeMeshNodeId('  DEADBEEF  ')).toBe('!deadbeef');
  });

  it('rejects anything not EXACTLY 8 hex digits after the optional leading "!"', () => {
    expect(normalizeMeshNodeId('')).toBeNull();
    expect(normalizeMeshNodeId('!')).toBeNull();
    expect(normalizeMeshNodeId('a1b2c3d')).toBeNull();    // 7 digits
    expect(normalizeMeshNodeId('a1b2c3d4e')).toBeNull();  // 9 digits
    expect(normalizeMeshNodeId('g1b2c3d4')).toBeNull();   // non-hex
    expect(normalizeMeshNodeId('!!a1b2c3d4')).toBeNull(); // double prefix
    expect(normalizeMeshNodeId('a1b2 c3d4')).toBeNull();  // inner whitespace
    expect(normalizeMeshNodeId('!a1b2c3d4 extra')).toBeNull();
  });
});

describe('parseMeshDevice (untrusted radio-reported rows)', () => {
  it('round-trips a fully-valid row', () => {
    expect(parseMeshDevice(rawDevice())).toEqual({
      id: 'd1', nodeId: '!a1b2c3d4', label: 'Backpack radio', createdAt: '2026-07-16T00:00:00Z',
      visibility: 'friends', state: 'active', revokeReason: null,
      lastSeenAt: '2026-07-16T00:00:00Z', batteryPct: 87, snr: 6.5, hopsAway: 2, viaDevice: 'lora-1',
    } as MeshDevice);
  });

  it('drops a non-object row or one without a usable id / canonical-izable node id', () => {
    expect(parseMeshDevice(null)).toBeNull();
    expect(parseMeshDevice('junk')).toBeNull();
    expect(parseMeshDevice(rawDevice({ id: '' }))).toBeNull();
    expect(parseMeshDevice(rawDevice({ id: 7 }))).toBeNull();
    expect(parseMeshDevice(rawDevice({ nodeId: 'not-a-node' }))).toBeNull();
    expect(parseMeshDevice(rawDevice({ nodeId: 7 }))).toBeNull();
  });

  it('canonicalizes the node id and treats absent optional fields as null (fail-soft render)', () => {
    const d = parseMeshDevice({ id: 'd2', nodeId: '!A1B2C3D4' })!;
    expect(d.nodeId).toBe('!a1b2c3d4');
    expect(d.label).toBeNull();
    expect(d.revokeReason).toBeNull();
    expect(d.lastSeenAt).toBeNull();
    expect(d.batteryPct).toBeNull();
    expect(d.snr).toBeNull();
    expect(d.hopsAway).toBeNull();
    expect(d.viaDevice).toBeNull();
    // Unknown visibility/state degrade to the LEAST revealing defaults.
    expect(d.visibility).toBe('private');
    expect(d.state).toBe('active');
  });

  it('an unknown visibility falls back to private; only the exact "revoked" marks a row revoked', () => {
    expect(parseMeshDevice(rawDevice({ visibility: 'everyone' }))!.visibility).toBe('private');
    expect(parseMeshDevice(rawDevice({ visibility: 7 }))!.visibility).toBe('private');
    expect(parseMeshDevice(rawDevice({ state: 'revoked' }))!.state).toBe('revoked');
    expect(parseMeshDevice(rawDevice({ state: 'REVOKED' }))!.state).toBe('active');
  });

  it('CLAMPS hostile telemetry: batteryPct into 0..101, snr/hops into sane ranges, junk → null', () => {
    expect(parseMeshDevice(rawDevice({ batteryPct: 9999 }))!.batteryPct).toBe(101);
    expect(parseMeshDevice(rawDevice({ batteryPct: -5 }))!.batteryPct).toBe(0);
    expect(parseMeshDevice(rawDevice({ batteryPct: Number.NaN }))!.batteryPct).toBeNull();
    expect(parseMeshDevice(rawDevice({ batteryPct: '87' }))!.batteryPct).toBeNull();
    expect(parseMeshDevice(rawDevice({ snr: Number.POSITIVE_INFINITY }))!.snr).toBeNull();
    expect(parseMeshDevice(rawDevice({ snr: 1e9 }))!.snr).toBe(100);
    expect(parseMeshDevice(rawDevice({ hopsAway: 2.5 }))!.hopsAway).toBeNull();
    expect(parseMeshDevice(rawDevice({ hopsAway: -1 }))!.hopsAway).toBe(0);
    expect(parseMeshDevice(rawDevice({ lastSeenAt: 'not a date' }))!.lastSeenAt).toBeNull();
    expect(parseMeshDevice(rawDevice({ viaDevice: 'no spaces!' }))!.viaDevice).toBeNull();
    expect(parseMeshDevice(rawDevice({ label: 'x'.repeat(500) }))!.label!.length).toBe(64);
  });
});

describe('UserBffService', () => {
  let svc: UserBffService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    svc = TestBed.inject(UserBffService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GET /bff/user/blocks lists blocks (HttpOnly bff_ cookie, no Authorization header) and pushes them onto blocks$', () => {
    const rows: UserBlock[] = [{ id: 'b1', target: '@x:test', platform: 'matrix' }];
    let pushed: UserBlock[] = [];
    svc.blocks$.subscribe((b) => (pushed = b));
    svc.list().subscribe();

    const req = http.expectOne('/bff/user/blocks');
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.headers.has('authorization')).toBeFalse();
    req.flush(rows);
    expect(pushed).toEqual(rows);
  });

  it('POST /bff/user/blocks sends {target,platform} with credentials and refreshes the list', () => {
    svc.block('@spam:evil.test', 'matrix').subscribe();
    const post = http.expectOne('/bff/user/blocks');
    expect(post.request.body).toEqual({ target: '@spam:evil.test', platform: 'matrix' });
    expect(post.request.withCredentials).toBeTrue();
    post.flush({ block: { id: 'b2', target: '@spam:evil.test', platform: 'matrix' }, pushed: true, external: 'stubbed' });
    // refresh
    http.expectOne('/bff/user/blocks').flush([]);
  });

  it('supports an internal-only block platform', () => {
    svc.block('@noisy:test', 'internal').subscribe();
    const post = http.expectOne('/bff/user/blocks');
    expect(post.request.body).toEqual({ target: '@noisy:test', platform: 'internal' });
    post.flush({ block: { id: 'b3', target: '@noisy:test', platform: 'internal' }, pushed: false, external: 'n/a' });
    http.expectOne('/bff/user/blocks').flush([]);
  });

  it('DELETE /bff/user/blocks/{id} removes a block (with credentials) then refreshes', () => {
    svc.unblock('b1').subscribe();
    const del = http.expectOne('/bff/user/blocks/b1');
    expect(del.request.method).toBe('DELETE');
    expect(del.request.withCredentials).toBeTrue();
    del.flush(null);
    http.expectOne('/bff/user/blocks').flush([]);
  });

  it('POST /bff/user/recommend-instance-block sends {instance,reason} with credentials', () => {
    svc.recommendInstanceBlock('evil.test', 'spam farm').subscribe();
    const req = http.expectOne('/bff/user/recommend-instance-block');
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.body).toEqual({ instance: 'evil.test', reason: 'spam farm' });
    req.flush({ recommended: true, instance: 'evil.test', federation: {} });
  });

  // ───────── Mesh devices ─────────

  it('GET /bff/user/mesh-devices lists devices (with credentials), tolerant-parses rows and pushes onto meshDevices$', () => {
    let pushed: MeshDevice[] = [];
    svc.meshDevices$.subscribe((d) => (pushed = d));
    svc.listMeshDevices().subscribe();

    const req = http.expectOne('/bff/user/mesh-devices');
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBeTrue();
    // One valid row, one hostile row (dropped, never thrown on).
    req.flush([rawDevice(), { id: 'evil', nodeId: '<script>' }]);
    expect(pushed.length).toBe(1);
    expect(pushed[0].id).toBe('d1');
    expect(pushed[0].nodeId).toBe('!a1b2c3d4');
  });

  it('POST /bff/user/mesh-devices sends {nodeId,label} with credentials and refreshes the list', () => {
    svc.claimMeshDevice('!a1b2c3d4', 'Backpack radio').subscribe();
    const post = http.expectOne('/bff/user/mesh-devices');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ nodeId: '!a1b2c3d4', label: 'Backpack radio' });
    expect(post.request.withCredentials).toBeTrue();
    post.flush(rawDevice());
    // refresh
    http.expectOne('/bff/user/mesh-devices').flush([]);
  });

  it('omits the label field entirely when none is given', () => {
    svc.claimMeshDevice('!a1b2c3d4').subscribe();
    const post = http.expectOne('/bff/user/mesh-devices');
    expect(post.request.body).toEqual({ nodeId: '!a1b2c3d4' });
    post.flush(rawDevice({ label: null }));
    http.expectOne('/bff/user/mesh-devices').flush([]);
  });

  it('surfaces a 409 (node id already claimed) to the caller WITHOUT refreshing the list', () => {
    let error: HttpErrorResponse | null = null;
    svc.claimMeshDevice('!a1b2c3d4').subscribe({ error: (e) => (error = e) });
    http.expectOne('/bff/user/mesh-devices').flush('conflict', { status: 409, statusText: 'Conflict' });
    expect(error!.status).toBe(409);
    // No refresh GET follows a failed claim (http.verify() in afterEach enforces it).
  });

  it('PUT /bff/user/mesh-devices/{id}/visibility sends {visibility} with credentials then refreshes', () => {
    svc.setMeshDeviceVisibility('d1', 'channels').subscribe();
    const put = http.expectOne('/bff/user/mesh-devices/d1/visibility');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ visibility: 'channels' });
    expect(put.request.withCredentials).toBeTrue();
    put.flush(null);
    http.expectOne('/bff/user/mesh-devices').flush([]);
  });

  it('surfaces a 409/422 visibility rejection (revoked row) WITHOUT refreshing', () => {
    let error: HttpErrorResponse | null = null;
    svc.setMeshDeviceVisibility('d1', 'friends').subscribe({ error: (e) => (error = e) });
    http.expectOne('/bff/user/mesh-devices/d1/visibility')
      .flush('revoked', { status: 422, statusText: 'Unprocessable Entity' });
    expect(error!.status).toBe(422);
  });

  it('DELETE /bff/user/mesh-devices/{id} releases a device (with credentials) then refreshes', () => {
    svc.releaseMeshDevice('d1').subscribe();
    const del = http.expectOne('/bff/user/mesh-devices/d1');
    expect(del.request.method).toBe('DELETE');
    expect(del.request.withCredentials).toBeTrue();
    del.flush(null);
    http.expectOne('/bff/user/mesh-devices').flush([]);
  });
});
