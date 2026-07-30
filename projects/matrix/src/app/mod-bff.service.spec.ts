import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ModBffService, ModerationRequest } from './mod-bff.service';

const ROW: ModerationRequest = {
  id: 7,
  requester: 'google:alice',
  kind: 'instance-block',
  target: 'evil.test',
  reason: 'spam',
  status: 'recommended',
  modReferrer: null,
  adminDecider: null,
  ts: '2026-01-01T00:00:00Z',
};

describe('ModBffService', () => {
  let svc: ModBffService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    svc = TestBed.inject(ModBffService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GET /bff/mod/moderation (HttpOnly bff_ cookie, no Authorization header) unwraps {requests} and caches onto moderation$', () => {
    let cached: ModerationRequest[] = [];
    svc.moderation$.subscribe((r) => (cached = r));
    let emitted: ModerationRequest[] = [];
    svc.loadModeration().subscribe((r) => (emitted = r));

    const req = http.expectOne('/bff/mod/moderation');
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.headers.has('authorization')).toBeFalse();
    req.flush({ requests: [ROW] });
    expect(emitted).toEqual([ROW]);
    expect(cached).toEqual([ROW]);
  });

  it('GET /bff/mod/moderation passes a status filter', () => {
    svc.loadModeration('referred').subscribe();
    const req = http.expectOne('/bff/mod/moderation?status=referred');
    expect(req.request.method).toBe('GET');
    req.flush({ requests: [] });
  });

  it('POST /bff/mod/moderation/{id}/refer returns the referred request and refreshes', () => {
    let referred: ModerationRequest | undefined;
    svc.refer(7).subscribe((r) => (referred = r));
    const post = http.expectOne('/bff/mod/moderation/7/refer');
    expect(post.request.method).toBe('POST');
    expect(post.request.withCredentials).toBeTrue();
    post.flush({ request: { ...ROW, status: 'referred', modReferrer: 'google:mod' } });
    expect(referred?.status).toBe('referred');
    // refresh fired
    http.expectOne('/bff/mod/moderation').flush({ requests: [] });
  });

  it('POST /bff/mod/block sends platform=matrix scope/target/reason with credentials', () => {
    let result: { external: string; note?: string } | undefined;
    svc.block({ platform: 'matrix', scope: 'instance', target: 'evil.test', reason: 'abuse' })
      .subscribe((r) => (result = r));
    const post = http.expectOne('/bff/mod/block');
    expect(post.request.method).toBe('POST');
    expect(post.request.withCredentials).toBeTrue();
    expect(post.request.body).toEqual({ platform: 'matrix', scope: 'instance', target: 'evil.test', reason: 'abuse' });
    post.flush({
      blocked: { id: 'a1', actor: 'mod', action: 'block', platform: 'matrix', target: 'evil.test', reason: 'abuse', result: 'stubbed', ts: '' },
      external: 'stubbed',
      note: 'external homeserver admin call is STUBBED',
    });
    expect(result?.external).toBe('stubbed');
    expect(result?.note).toContain('STUBBED');
  });
});
