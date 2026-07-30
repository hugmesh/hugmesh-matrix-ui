import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { GamesPlaceholderComponent } from './games-placeholder.component';

describe('GamesPlaceholderComponent', () => {
  let fixture: ComponentFixture<GamesPlaceholderComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GamesPlaceholderComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(GamesPlaceholderComponent);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  it('is clearly marked as a TODO placeholder, not a live feature', () => {
    const badge = el.querySelector('[data-testid="games-todo-badge"]');
    expect(badge?.textContent?.trim()).toBe('TODO');
  });

  it('names the future hugmesh-games-ui remote it stands in for', () => {
    const remote = el.querySelector('[data-testid="games-future-remote"]');
    expect(remote?.textContent?.trim()).toBe('hugmesh-games-ui');
  });

  it('explains that no remote is mounted here', () => {
    const msg = el.querySelector('[data-testid="games-placeholder-message"]');
    expect(msg?.textContent).toContain('not');
    expect(msg?.textContent).toContain('placeholder');
  });
});
