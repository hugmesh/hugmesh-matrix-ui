import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CharacterForgeBffService } from './character-forge-bff.service';
import { randomChar3dConfig } from './char3d-config';

describe('CharacterForgeBffService (thin active-character client)', () => {
  let service: CharacterForgeBffService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CharacterForgeBffService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GETs /bff/character-forge/characters/active with the session cookie and maps a valid answer', async () => {
    const definition = randomChar3dConfig('forge-spec');
    const promise = service.getActiveCharacter();

    const req = http.expectOne('/bff/character-forge/characters/active');
    expect(req.request.method).toBe('GET');
    // HttpOnly bff_ cookie auth — the request MUST carry credentials.
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ name: 'Vex', definition });

    expect(await promise).toEqual({ name: 'Vex', definition });
  });

  it('resolves null on 404 (no active character) — the join menu greys the option', async () => {
    const promise = service.getActiveCharacter();
    http.expectOne('/bff/character-forge/characters/active')
      .flush({ error: 'not found' }, { status: 404, statusText: 'Not Found' });
    expect(await promise).toBeNull();
  });

  it('resolves null when the OPTIONAL character-forge BFF is dark (5xx/network)', async () => {
    const promise = service.getActiveCharacter();
    http.expectOne('/bff/character-forge/characters/active')
      .error(new ProgressEvent('error'));
    expect(await promise).toBeNull();
  });

  it('re-validates the definition through the §3 mirror — an invalid one resolves null', async () => {
    const promise = service.getActiveCharacter();
    http.expectOne('/bff/character-forge/characters/active')
      .flush({ name: 'Trojan', definition: { schemaVersion: 1, smuggled: 'payload' } });
    expect(await promise).toBeNull();
  });

  it('falls back to the definition name when the row name is blank', async () => {
    const definition = randomChar3dConfig('named');
    const promise = service.getActiveCharacter();
    http.expectOne('/bff/character-forge/characters/active').flush({ name: '', definition });
    expect((await promise)!.name).toBe(definition.name);
  });
});
