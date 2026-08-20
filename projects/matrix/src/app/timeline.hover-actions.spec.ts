import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TimelineComponent } from './timeline.component';
import { MatrixService, TimelineEvent } from './matrix.service';
import { SessionService } from './session.service';

/**
 * REGRESSION GUARD — "the matrix chat elements jitter as you move the mouse
 * between msgs as everything resizes to show the options on each msg".
 *
 * The per-message action controls used to be revealed by toggling a LAYOUT
 * property: `.actions{display:none}` + `.event:hover .actions{display:flex}`.
 * Hovering therefore INSERTED a row into the message — the hovered event grew
 * (measured on the built remote: 43px -> 65px) and every message below it
 * jumped down the page (3 siblings displaced by 22px each). The controls were
 * also raw UA <button>s (grey, text-labelled, 18px tall) and, being
 * `display:none` at rest, unreachable by keyboard.
 *
 * These specs measure REAL geometry in the karma browser. `:hover` cannot be
 * synthesised from script, so the hover state is reproduced FROM THE COMPONENT'S
 * OWN COMPILED CSS: every `:hover` rule that matches inside the target row is
 * re-applied to those elements as an inline style. That is the actual reveal
 * the browser performs, so the assertions bind to the shipped stylesheet rather
 * than to a hand-copied guess of what it says.
 */

class MatrixServiceStub {
  messages = jasmine.createSpy('messages').and.resolveTo({ events: [], start: '', end: '' });
  getRelations = jasmine.createSpy('getRelations').and.resolveTo([]);
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('blob:x');
  redactEvent = jasmine.createSpy('redactEvent').and.resolveTo('$r');
  sendReaction = jasmine.createSpy('sendReaction').and.resolveTo('$rx');
  mxcToHttp = jasmine.createSpy('mxcToHttp').and.returnValue('https://m/x');
}

function msg(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId: '$e1',
    roomId: '!r:test',
    type: 'm.room.message',
    sender: '@alice:test',
    originServerTs: 1000,
    content: { msgtype: 'm.text', body: 'hi' },
    msgtype: 'm.text',
    body: 'hi',
    ...over,
  } as TimelineEvent;
}

interface Box { x: number; y: number; w: number; h: number }

function box(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
}

const round = (n: number) => Math.round(n * 100) / 100;

interface HoverRule { selector: string; css: string }

function allSheets(): CSSStyleSheet[] {
  return [
    ...Array.from(document.styleSheets as unknown as CSSStyleSheet[]),
    ...Array.from((document as unknown as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []),
  ];
}

/**
 * Karma's headless Chrome reports `(hover: none)` — it looks like a touch
 * device. The timeline deliberately drops the overlay on hover-less pointers
 * (an overlay revealed only by hover would be unreachable there) and shows the
 * toolbar in flow instead, which is jitter-free by construction because no
 * hover exists. These specs must therefore exercise the HOVER-CAPABLE path —
 * the only one where a reveal can shift the layout — so the `(hover: none)`
 * blocks are lifted out of the cascade for the duration of each spec.
 */
function suspendHoverlessBlocks(): () => void {
  const restores: Array<() => void> = [];
  for (const sheet of allSheets()) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i];
      if (!(rule instanceof CSSMediaRule)) continue;
      if (!/hover\s*:\s*none/.test(rule.conditionText)) continue;
      const text = rule.cssText;
      const index = i;
      sheet.deleteRule(index);
      restores.push(() => sheet.insertRule(text, index));
    }
  }
  return () => restores.reverse().forEach((f) => f());
}

/** Every `:hover` rule currently in the document, with `:hover` stripped from
 *  the selector so it can be matched against elements directly. Recurses into
 *  media/supports blocks that actually apply in this browser. */
function hoverRules(): HoverRule[] {
  const out: HoverRule[] = [];
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        if (window.matchMedia(rule.conditionText).matches) visit(rule.cssRules);
        continue;
      }
      if (typeof CSSSupportsRule !== 'undefined' && rule instanceof CSSSupportsRule) {
        visit(rule.cssRules);
        continue;
      }
      if (!(rule instanceof CSSStyleRule)) continue;
      if (!rule.selectorText.includes(':hover')) continue;
      if (!rule.style.cssText) continue;
      out.push({ selector: rule.selectorText.replace(/:hover\b/g, ''), css: rule.style.cssText });
    }
  };
  for (const sheet of allSheets()) {
    try {
      visit(sheet.cssRules);
    } catch {
      /* cross-origin sheet — nothing of ours lives there */
    }
  }
  return out;
}

/** Is `el` painted at all? Covers every way the toolbar has been hidden:
 *  display:none (the old reveal), visibility:hidden, and opacity:0. */
function visuallyHidden(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  return cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.01;
}

/** Reproduce `:hover` on `row` by inlining every matching hover declaration.
 *  Returns an undo function restoring the original inline styles. */
function applyHoverState(row: HTMLElement): () => void {
  const undo: Array<() => void> = [];
  // The reveal is transitioned, and getComputedStyle reports the INTERPOLATED
  // value — a freshly-set opacity still reads as 0. Kill transitions for the
  // duration of the measurement so the end state is what we read.
  const freeze = document.createElement('style');
  freeze.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(freeze);
  undo.push(() => freeze.remove());
  for (const { selector, css } of hoverRules()) {
    let targets: HTMLElement[];
    try {
      targets = [row, ...Array.from(row.querySelectorAll<HTMLElement>(selector))].filter((el) =>
        el.matches(selector),
      );
    } catch {
      continue; // selector the browser cannot match standalone — skip
    }
    for (const el of targets) {
      const previous = el.getAttribute('style');
      undo.push(() => (previous === null ? el.removeAttribute('style') : el.setAttribute('style', previous)));
      el.style.cssText = `${el.style.cssText};${css}`;
    }
  }
  return () => undo.reverse().forEach((f) => f());
}

/** Layout-affecting properties. A `:hover` rule that sets any of these on a
 *  timeline control moves the page around under the pointer — the whole defect. */
const LAYOUT_PROPS = [
  'display', 'position', 'float', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border', 'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'font-size', 'line-height', 'gap', 'row-gap', 'column-gap', 'flex', 'flex-basis', 'flex-direction', 'writing-mode',
];

describe('TimelineComponent — per-message action toolbar', () => {
  let fixture: ComponentFixture<TimelineComponent>;
  let component: TimelineComponent;
  let restoreHoverless: () => void;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TimelineComponent],
      providers: [provideRouter([]), { provide: MatrixService, useValue: new MatrixServiceStub() }],
    }).compileComponents();

    fixture = TestBed.createComponent(TimelineComponent);
    component = fixture.componentInstance;
    component.me = '@me:test';
    // A real, fixed width so the measured boxes are stable and comparable.
    (fixture.nativeElement as HTMLElement).style.display = 'block';
    (fixture.nativeElement as HTMLElement).style.width = '900px';
    // Renders once so the component's stylesheet is in the document, THEN the
    // touch fallback is lifted (see suspendHoverlessBlocks).
    fixture.detectChanges();
    restoreHoverless = suspendHoverlessBlocks();
  });

  afterEach(() => {
    restoreHoverless();
    TestBed.inject(SessionService).clear();
  });

  async function withEvents(events: TimelineEvent[]): Promise<void> {
    component.liveEvents = events;
    await component.ngOnChanges({
      liveEvents: { currentValue: events, previousValue: null, firstChange: true, isFirstChange: () => true },
    });
    fixture.detectChanges();
  }

  /** Five same-day messages from another member (so React/Reply/Thread render). */
  function conversation(): TimelineEvent[] {
    return [0, 1, 2, 3, 4].map((i) =>
      msg({ eventId: `$e${i}`, originServerTs: 1000 + i * 60_000, body: `message ${i}`, content: { msgtype: 'm.text', body: `message ${i}` } }),
    );
  }

  it('reveals the actions on hover WITHOUT moving or resizing any message row', async () => {
    await withEvents(conversation());
    const rows = Array.from(fixture.nativeElement.querySelectorAll('li.event')) as HTMLElement[];
    expect(rows.length).toBe(5);

    // NON-VACUITY, half 1: the toolbar is hidden before the pointer arrives.
    const actions = rows[2].querySelector('.actions') as HTMLElement;
    expect(visuallyHidden(actions)).withContext('.actions is hidden at rest').toBeTrue();

    const before = rows.map(box);
    const restore = applyHoverState(rows[2]);
    try {
      // NON-VACUITY, half 2: hovering ACTUALLY reveals it — otherwise the
      // geometry assertion below would pass without measuring anything.
      expect(visuallyHidden(actions)).withContext('.actions is revealed by hover').toBeFalse();
      expect(actions.getBoundingClientRect().width).withContext('hovered .actions width').toBeGreaterThan(0);

      const after = rows.map(box);
      after.forEach((rect, i) => {
        expect(rect)
          .withContext(
            `message row ${i} (${rows[i].getAttribute('data-testid')}) must not move or resize when row 2 is hovered`,
          )
          .toEqual(before[i]);
      });
    } finally {
      restore();
    }
  });

  it('reserves the toolbar\'s box at rest, so revealing it adds nothing to the row', async () => {
    await withEvents(conversation());
    const row = fixture.nativeElement.querySelector('li.event') as HTMLElement;
    const actions = row.querySelector('.actions') as HTMLElement;
    // The old `display:none` collapsed the toolbar to a 0x0 box, which is
    // exactly the space hover then had to make room for.
    const rect = actions.getBoundingClientRect();
    expect(rect.width).withContext('resting .actions width').toBeGreaterThan(0);
    expect(rect.height).withContext('resting .actions height').toBeGreaterThan(0);
    // …and it sits INSIDE the row it belongs to, not on top of the message text.
    const rowRect = row.getBoundingClientRect();
    expect(rect.bottom).withContext('.actions stays within its own row').toBeLessThanOrEqual(rowRect.bottom + 0.5);
  });

  it('leaves the actions focusable at rest so keyboard users can reach them', async () => {
    await withEvents(conversation());
    const actions = fixture.nativeElement.querySelector('li.event .actions') as HTMLElement;
    const resting = getComputedStyle(actions);
    // display:none / visibility:hidden remove the buttons from the tab order
    // entirely — the controls were mouse-only before this.
    expect(resting.display).withContext('resting .actions display').not.toBe('none');
    expect(resting.visibility).withContext('resting .actions visibility').not.toBe('hidden');
  });

  it('declares no layout-affecting property in any :hover rule for its own controls', async () => {
    await withEvents(conversation());
    const offenders: string[] = [];
    for (const { selector, css } of hoverRules()) {
      if (!/\.(actions|action-btn|event|paginate|pill)\b/.test(selector)) continue;
      const parsed = css.split(';').map((d) => d.split(':')[0].trim().toLowerCase()).filter(Boolean);
      for (const prop of parsed) {
        if (LAYOUT_PROPS.includes(prop)) offenders.push(`${selector} { ${prop} }`);
      }
    }
    expect(offenders)
      .withContext('hover must change appearance only — these rules reflow the timeline')
      .toEqual([]);
  });

  it('renders every action as an ICON button with its own accessible name', async () => {
    TestBed.inject(SessionService).set({
      id: 'google:me@test', label: 'me', provider: 'google', roles: ['user', 'mod'], registrationComplete: true,
    });
    await withEvents([msg({ senderDisplayName: 'Alice' })]);
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.actions button'),
    ) as HTMLButtonElement[];
    // react + reply + thread + delete (mod on someone else's message)
    expect(buttons.length).toBe(4);

    for (const btn of buttons) {
      const testid = btn.getAttribute('data-testid');
      // Styled, not a bare UA button.
      expect(btn.classList.contains('action-btn')).withContext(`${testid} is styled`).toBeTrue();
      // Icon-only ⇒ the accessible name MUST come from aria-label…
      const label = (btn.getAttribute('aria-label') ?? '').trim();
      expect(label.length).withContext(`${testid} aria-label`).toBeGreaterThan(0);
      // …because the visible glyph is decoration and is hidden from the a11y tree.
      const glyph = btn.querySelector('[aria-hidden="true"]');
      expect(glyph).withContext(`${testid} decorative glyph`).toBeTruthy();
      expect((glyph!.textContent ?? '').trim().length).withContext(`${testid} glyph text`).toBeGreaterThan(0);
      // A target big enough to hit (WCAG 2.5.8 floor is 24px).
      const rect = btn.getBoundingClientRect();
      expect(rect.width).withContext(`${testid} width`).toBeGreaterThanOrEqual(24);
      expect(rect.height).withContext(`${testid} height`).toBeGreaterThanOrEqual(24);
    }

    // The moderator redact keeps its distinguishing announcement, and the
    // self-redact gets a plain one (it can no longer fall back to button text).
    const del = fixture.nativeElement.querySelector('[data-testid="btn-delete-$e1"]') as HTMLElement;
    expect(del.getAttribute('aria-label')).toContain('moderator');
  });
});
