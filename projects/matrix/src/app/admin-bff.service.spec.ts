import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { AdminBffService } from './admin-bff.service';
import { ModBffService, ModerationRequest } from './mod-bff.service';

class ModBffStub {
  loadModeration = jasmine.createSpy('loadModeration').and.returnValue(of([]));
}

const DECIDED: ModerationRequest = {
  id: 7,
  requester: 'google:alice',
  kind: 'user-removal',
  target: 'spammer',
  reason: 'spam',
  status: 'approved',
  modReferrer: 'mod-x',
  adminDecider: 'admin-x',
  ts: '2026-01-01T00:00:00Z',
};

describe('AdminBffService', () => {
  let svc: AdminBffService;
  let http: HttpTestingController;
  let modBff: ModBffStub;

  beforeEach(() => {
    modBff = new ModBffStub();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ModBffService, useValue: modBff },
      ],
    });
    svc = TestBed.inject(AdminBffService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('POST /bff/admin/moderation/{id}/decide?approve=true is cookie-authenticated (withCredentials) and returns the decided row', () => {
    let result: ModerationRequest | undefined;
    svc.decide(7, true).subscribe((r) => (result = r));

    const req = http.expectOne('/bff/admin/moderation/7/decide?approve=true');
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.headers.has('authorization')).toBeFalse();
    req.flush(DECIDED);

    expect(result).toEqual(DECIDED);
  });

  it('a deny call posts approve=false', () => {
    svc.decide(7, false).subscribe();
    const req = http.expectOne('/bff/admin/moderation/7/decide?approve=false');
    req.flush({ ...DECIDED, status: 'denied' });
  });

  it('on success it refreshes the shared moderation queue', () => {
    svc.decide(7, true).subscribe();
    http.expectOne('/bff/admin/moderation/7/decide?approve=true').flush(DECIDED);
    expect(modBff.loadModeration).toHaveBeenCalled();
  });

  it('on a downstream failure the error propagates and the queue is NOT refreshed', () => {
    let errored = false;
    svc.decide(7, true).subscribe({ error: () => (errored = true) });
    http.expectOne('/bff/admin/moderation/7/decide?approve=true')
      .flush({ error: 'bad gateway' }, { status: 502, statusText: 'Bad Gateway' });
    expect(errored).toBeTrue();
    expect(modBff.loadModeration).not.toHaveBeenCalled();
  });
});
