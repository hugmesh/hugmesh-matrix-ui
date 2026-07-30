import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ThreadPanelComponent } from './thread-panel.component';
import { MatrixService, TimelineEvent } from './matrix.service';

const ROOT: TimelineEvent = { eventId: '$root', roomId: '!r:test', type: 'm.room.message', sender: '@a:test', originServerTs: 1, content: {}, body: 'root msg' } as TimelineEvent;
const REPLY: TimelineEvent = { eventId: '$reply', roomId: '!r:test', type: 'm.room.message', sender: '@b:test', originServerTs: 2, content: {}, body: 'a reply' } as TimelineEvent;

class MatrixServiceStub {
  getEvent = jasmine.createSpy('getEvent').and.resolveTo(ROOT);
  getRelations = jasmine.createSpy('getRelations').and.resolveTo([REPLY]);
  getThreads = jasmine.createSpy('getThreads').and.resolveTo({ events: [ROOT], start: '', end: '' });
  setTyping = jasmine.createSpy('setTyping').and.resolveTo(undefined);
}

describe('ThreadPanelComponent', () => {
  let fixture: ComponentFixture<ThreadPanelComponent>;
  let component: ThreadPanelComponent;
  let matrix: MatrixServiceStub;

  beforeEach(async () => {
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [ThreadPanelComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ roomId: '!r:test', eventId: '$root' })) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ThreadPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    // ngOnInit chains paramMap -> loadRoot + reloadReplies + loadThreadList;
    // flush several turns so each chained promise settles before assertions.
    for (let i = 0; i < 4; i++) {
      await fixture.whenStable();
    }
    fixture.detectChanges();
  });

  it('loads the thread root and its m.thread replies for the route params', () => {
    expect(matrix.getEvent).toHaveBeenCalledWith('!r:test', '$root');
    expect(matrix.getRelations).toHaveBeenCalledWith('!r:test', '$root', 'm.thread');
    expect(component.root()?.eventId).toBe('$root');
    expect(component.replies().map((e) => e.eventId)).toEqual(['$reply']);
  });

  it('renders the replies list as a labelled live region', () => {
    const list = fixture.nativeElement.querySelector('ul.replies');
    expect(list.getAttribute('aria-label')).toBeTruthy();
    expect(list.getAttribute('aria-live')).toBe('polite');
  });

  it('labels the panel and the thread region', () => {
    const panel = fixture.nativeElement.querySelector('[data-testid="thread-panel"]');
    expect(panel.getAttribute('aria-label')).toBe('Thread');
  });

  it('latestId() returns the last reply id, falling back to the root', () => {
    expect(component.latestId()).toBe('$reply');
    component.replies.set([]);
    expect(component.latestId()).toBe('$root');
  });
});
