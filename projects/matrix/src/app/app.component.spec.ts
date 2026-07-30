import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';

/**
 * The standalone dev shell wraps the federated routes. It is only mounted by
 * `ng serve matrix`; in production the host federates `./routes` directly. The
 * shell must still be accessible on its own: a skip link to the main landmark
 * and a single <main> region (WCAG 2.4.1 / 1.3.1).
 */
describe('AppComponent (standalone dev shell)', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([])],
    }).compileComponents(),
  );

  it('creates the dev shell', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders a single <main> landmark holding the router outlet', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const mains = fixture.nativeElement.querySelectorAll('main');
    expect(mains.length).toBe(1);
    expect(mains[0].getAttribute('id')).toBe('main-content');
    expect(mains[0].querySelector('router-outlet')).toBeTruthy();
  });

  it('exposes a skip link that targets the main landmark', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const skip: HTMLAnchorElement | null = fixture.nativeElement.querySelector('.sr-skip');
    expect(skip).toBeTruthy();
    expect(skip!.getAttribute('href')).toBe('#main-content');
  });
});
