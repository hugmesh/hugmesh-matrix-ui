import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { SearchComponent } from './search.component';
import { MatrixService, SearchResult, TimelineEvent } from './matrix.service';
import { expectDescribedByHelp } from './a11y-help.spec-util';

const HIT: TimelineEvent = {
  eventId: '$e1',
  roomId: '!r:test',
  type: 'm.room.message',
  sender: '@a:test',
  originServerTs: 1,
  content: { body: 'found it' },
  body: 'found it',
} as TimelineEvent;

class MatrixServiceStub {
  search = jasmine.createSpy('search').and.resolveTo({
    results: [
      { event: HIT, rank: 1, contextBefore: [], contextAfter: [], roomId: '!r:test' },
    ] as SearchResult[],
    count: 1,
    nextBatch: 'next-1',
  });
}

function makeRoute(room: string | null) {
  return { snapshot: { queryParamMap: convertToParamMap(room ? { room } : {}) } };
}

describe('SearchComponent', () => {
  let matrix: MatrixServiceStub;

  async function setup(room: string | null = null): Promise<ComponentFixture<SearchComponent>> {
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [SearchComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: ActivatedRoute, useValue: makeRoute(room) },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SearchComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('exposes the search bar as a role=search form with a labelled input', async () => {
    const fixture = await setup();
    const form = fixture.nativeElement.querySelector('form.bar');
    expect(form.getAttribute('role')).toBe('search');
    const input = fixture.nativeElement.querySelector('[data-testid="input-search"]');
    const label = fixture.nativeElement.querySelector('label[for="search-input"]');
    expect(input.id).toBe('search-input');
    expect(label).toBeTruthy();
  });

  it('announces the result count via an aria-live status region', async () => {
    const fixture = await setup();
    const count = fixture.nativeElement.querySelector('[data-testid="search-result-count"]');
    expect(count.getAttribute('role')).toBe('status');
    expect(count.getAttribute('aria-live')).toBe('polite');
  });

  it('reads the room scope from the query param', async () => {
    const fixture = await setup('!scope:test');
    expect(fixture.componentInstance.roomScope()).toBe('!scope:test');
  });

  it('ignores a blank search term', async () => {
    const fixture = await setup();
    fixture.componentInstance.term = '   ';
    await fixture.componentInstance.runSearch(true);
    expect(matrix.search).not.toHaveBeenCalled();
  });

  it('runs a search and renders the results + count', async () => {
    const fixture = await setup();
    fixture.componentInstance.term = 'find';
    await fixture.componentInstance.runSearch(true);
    fixture.detectChanges();
    expect(matrix.search).toHaveBeenCalled();
    expect(fixture.componentInstance.count()).toBe(1);
    expect(fixture.nativeElement.querySelector('[data-testid="search-result-$e1"]')).toBeTruthy();
  });

  it('appends instead of replacing results when paginating (reset=false)', async () => {
    const fixture = await setup();
    fixture.componentInstance.term = 'find';
    await fixture.componentInstance.runSearch(true);
    await fixture.componentInstance.runSearch(false);
    expect(fixture.componentInstance.results().length).toBe(2);
  });

  // ───────── HELP TEXT ─────────
  it('wires the search input + button to present help describing how to search', async () => {
    const fixture = await setup();
    const el = fixture.nativeElement as HTMLElement;
    const help = expectDescribedByHelp(el, '[data-testid="input-search"]');
    expect(help.toLowerCase()).toContain('press enter');
    expectDescribedByHelp(el, '[data-testid="btn-search"]');
  });

  it('scopes the help copy to "every room" when the search is not room-scoped', async () => {
    const wide = await setup();
    expect(expectDescribedByHelp(wide.nativeElement, '[data-testid="input-search"]').toLowerCase())
      .toContain('every room');
  });

  it('scopes the help copy to "this room" when the search is room-scoped', async () => {
    const scoped = await setup('!scope:test');
    expect(expectDescribedByHelp(scoped.nativeElement, '[data-testid="input-search"]').toLowerCase())
      .toContain('this room');
  });

  it('wires the Load more button to help once a next batch exists', async () => {
    const fixture = await setup();
    fixture.componentInstance.term = 'find';
    await fixture.componentInstance.runSearch(true);
    fixture.detectChanges();
    expect(expectDescribedByHelp(fixture.nativeElement, '[data-testid="btn-search-more"]'))
      .toContain('older');
  });
});
