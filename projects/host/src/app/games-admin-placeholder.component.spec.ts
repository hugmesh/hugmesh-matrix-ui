import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { GamesAdminPlaceholderComponent } from './games-admin-placeholder.component';

describe('GamesAdminPlaceholderComponent', () => {
  let fixture: ComponentFixture<GamesAdminPlaceholderComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GamesAdminPlaceholderComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(GamesAdminPlaceholderComponent);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  it('is clearly marked as a TODO placeholder, not a live feature', () => {
    const badge = el.querySelector('[data-testid="games-admin-todo-badge"]');
    expect(badge?.textContent?.trim()).toBe('TODO');
  });

  it('names the future hugmesh-games-admin-ui remote it stands in for', () => {
    const remote = el.querySelector('[data-testid="games-admin-future-remote"]');
    expect(remote?.textContent?.trim()).toBe('hugmesh-games-admin-ui');
  });

  it('explains that no remote is mounted here', () => {
    const msg = el.querySelector('[data-testid="games-admin-placeholder-message"]');
    expect(msg?.textContent).toContain('not');
    expect(msg?.textContent).toContain('placeholder');
  });
});
