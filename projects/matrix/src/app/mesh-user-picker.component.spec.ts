import { Component } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { DEBOUNCE_MS, MeshUserPickerComponent } from './mesh-user-picker.component';
import { MatrixService } from './matrix.service';

@Component({
  standalone: true,
  imports: [FormsModule, MeshUserPickerComponent],
  template: `<hug-mesh-user-picker inputId="who" testId="input-who" [(ngModel)]="who" (enterKey)="enters = enters + 1" />`,
})
class HostComponent {
  who = '';
  enters = 0;
}

describe('MeshUserPickerComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let http: HttpTestingController;
  let host: HostComponent;

  const input = (): HTMLInputElement => fixture.nativeElement.querySelector('input');
  const type = (text: string) => { input().value = text; input().dispatchEvent(new Event('input')); fixture.detectChanges(); };
  const key = (k: string) => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true })); fixture.detectChanges(); };
  const rows = [
    { username: 'alice', matrixLocalpart: 'alice', domain: 'brandx' },
    { username: 'alina', matrixLocalpart: 'alina', domain: 'brandx' },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent, HttpClientTestingModule],
      providers: [{ provide: MatrixService, useValue: { whoami: () => Promise.resolve('@me:hs.example') } }],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('keeps the host element id and test id on the inner input', () => {
    expect(input().id).toBe('who');
    expect(input().getAttribute('data-testid')).toBe('input-who');
    expect(input().getAttribute('role')).toBe('combobox');
  });

  it('sends no lookup under two characters', fakeAsync(() => {
    type('a');
    tick(DEBOUNCE_MS + 50);
    http.expectNone((r) => r.url.endsWith('/directory/search'));
    expect(host.who).toBe('a');
    flush();
  }));

  it('debounces: only the last fragment is looked up, and a typed full id looks nothing up', fakeAsync(() => {
    type('al'); tick(50);
    type('ali'); tick(DEBOUNCE_MS + 1);
    const req = http.expectOne((r) => r.url.endsWith('/bff/user/directory/search'));
    expect(req.request.params.get('q')).toBe('ali');
    expect(req.request.withCredentials).toBeTrue();
    req.flush(rows);
    type('@bob:other.example'); tick(DEBOUNCE_MS + 50);
    http.expectNone((r) => r.url.endsWith('/directory/search'));
    flush();
  }));

  it('shows the matches and choosing one fills the box with the full Matrix id', fakeAsync(() => {
    tick();   // whoami resolves
    type('@ali'); tick(DEBOUNCE_MS + 1);
    http.expectOne((r) => r.url.endsWith('/directory/search')).flush(rows);
    fixture.detectChanges();
    const options = fixture.nativeElement.querySelectorAll('[role=option]');
    expect(options.length).toBe(2);
    expect(options[0].textContent).toContain('@alice:hs.example');
    options[1].dispatchEvent(new MouseEvent('mousedown', { cancelable: true }));
    fixture.detectChanges();
    expect(host.who).toBe('@alina:hs.example');
    expect(fixture.nativeElement.querySelector('[role=listbox]')).toBeNull();
    flush();
  }));

  it('arrow keys move through the options and Enter picks the highlighted one, not the parent submit', fakeAsync(() => {
    tick();
    type('ali'); tick(DEBOUNCE_MS + 1);
    http.expectOne((r) => r.url.endsWith('/directory/search')).flush(rows);
    key('ArrowDown'); key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toContain('-opt-1');
    key('Enter');
    expect(host.who).toBe('@alina:hs.example');
    expect(host.enters).toBe(0);
    flush();
  }));

  it('Enter with nothing highlighted is the parent submit, and Escape closes the list', fakeAsync(() => {
    tick();
    type('ali'); tick(DEBOUNCE_MS + 1);
    http.expectOne((r) => r.url.endsWith('/directory/search')).flush(rows);
    key('Escape');
    expect(fixture.nativeElement.querySelector('[role=listbox]')).toBeNull();
    key('Enter');
    expect(host.enters).toBe(1);
    flush();
  }));

  it('ignores a slow answer for an older fragment', fakeAsync(() => {
    type('ali'); tick(DEBOUNCE_MS + 1);
    const first = http.expectOne((r) => r.url.endsWith('/directory/search'));
    type('alic'); tick(DEBOUNCE_MS + 1);
    const second = http.expectOne((r) => r.url.endsWith('/directory/search'));
    second.flush([rows[0]]);
    first.flush(rows);   // arrives late
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[role=option]').length).toBe(1);
    flush();
  }));

  it('a failed lookup leaves typing a full id fully working and says so', fakeAsync(() => {
    type('ali'); tick(DEBOUNCE_MS + 1);
    http.expectOne((r) => r.url.endsWith('/directory/search')).flush('nope', { status: 429, statusText: 'Too Many Requests' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role=listbox]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid=picker-status]').textContent).toContain('full Matrix id');
    type('@carol:hs.example');
    expect(host.who).toBe('@carol:hs.example');
    flush();
  }));
});
