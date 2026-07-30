import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ReactionPickerComponent } from './reaction-picker.component';
import { MatrixService } from './matrix.service';

class MatrixServiceStub {
  sendReaction = jasmine.createSpy('sendReaction').and.resolveTo('$react');
  redactEvent = jasmine.createSpy('redactEvent').and.resolveTo('$redact');
}

describe('ReactionPickerComponent', () => {
  let fixture: ComponentFixture<ReactionPickerComponent>;
  let component: ReactionPickerComponent;
  let matrix: MatrixServiceStub;

  beforeEach(async () => {
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [ReactionPickerComponent],
      providers: [{ provide: MatrixService, useValue: matrix }],
    }).compileComponents();

    fixture = TestBed.createComponent(ReactionPickerComponent);
    component = fixture.componentInstance;
    component.roomId = '!r:test';
    component.targetEventId = '$evt';
    fixture.detectChanges();
  });

  function buttons(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('button.emoji-btn'));
  }

  it('renders the picker as a role=menu of menuitemcheckbox buttons', () => {
    const menu = fixture.nativeElement.querySelector('.reaction-picker');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBeTruthy();
    const btns = buttons();
    expect(btns.length).toBe(component.emojis.length);
    expect(btns.every((b) => b.getAttribute('role') === 'menuitemcheckbox')).toBeTrue();
  });

  it('gives each emoji a human-readable accessible name (not the bare glyph)', () => {
    const first = buttons()[0];
    expect(first.getAttribute('aria-label')).toContain('thumbs up');
    // The glyph itself is hidden from assistive tech.
    expect(first.querySelector('[aria-hidden="true"]')!.textContent).toBe('👍');
  });

  it('marks the caller\'s own reaction with aria-checked=true', () => {
    const own = component.emojis[0];
    // setInput marks the view dirty so the *ngFor aria-checked bindings re-render.
    fixture.componentRef.setInput('myReactions', { [own]: '$mine' });
    expect(component.isMine(own)).toBeTrue();
    expect(component.isMine(component.emojis[1])).toBeFalse();
    fixture.detectChanges();
    expect(buttons()[0].getAttribute('aria-checked')).toBe('true');
    expect(buttons()[1].getAttribute('aria-checked')).toBe('false');
  });

  it('implements a roving tabindex: exactly one button is tabbable', () => {
    const tabbable = buttons().filter((b) => b.getAttribute('tabindex') === '0');
    expect(tabbable.length).toBe(1);
    expect(buttons()[0].getAttribute('tabindex')).toBe('0');
  });

  it('moves the active item with ArrowRight (roving tabindex)', () => {
    component.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowRight' }), 0);
    fixture.detectChanges();
    expect(component.activeIndex()).toBe(1);
    expect(buttons()[1].getAttribute('tabindex')).toBe('0');
    expect(buttons()[0].getAttribute('tabindex')).toBe('-1');
  });

  it('wraps from the last item back to the first with ArrowRight', () => {
    const last = component.emojis.length - 1;
    component.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowRight' }), last);
    expect(component.activeIndex()).toBe(0);
  });

  it('jumps to first/last with Home/End', () => {
    component.onKeydown(new KeyboardEvent('keydown', { key: 'End' }), 0);
    expect(component.activeIndex()).toBe(component.emojis.length - 1);
    component.onKeydown(new KeyboardEvent('keydown', { key: 'Home' }), 3);
    expect(component.activeIndex()).toBe(0);
  });

  it('moves focus INTO the menu (the active emoji) when it opens', () => {
    // ngAfterViewInit ran in beforeEach; the active emoji button is focused so a
    // keyboard user lands inside the menu rather than at the trigger.
    expect(document.activeElement).toBe(buttons()[component.activeIndex()]);
  });

  it('Escape emits dismissed (so the parent closes it + restores trigger focus)', () => {
    const spy = jasmine.createSpy('dismissed');
    component.dismissed.subscribe(spy);
    const ev = new KeyboardEvent('keydown', { key: 'Escape' });
    spyOn(ev, 'preventDefault');
    component.onKeydown(ev, 0);
    expect(spy).toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('Escape does NOT send a reaction (it only dismisses)', () => {
    component.onKeydown(new KeyboardEvent('keydown', { key: 'Escape' }), 0);
    expect(matrix.sendReaction).not.toHaveBeenCalled();
    expect(matrix.redactEvent).not.toHaveBeenCalled();
  });

  it('adds a reaction via the service when none of mine exists', async () => {
    await component.pick('🎉');
    expect(matrix.sendReaction).toHaveBeenCalledWith('!r:test', '$evt', '🎉');
    expect(matrix.redactEvent).not.toHaveBeenCalled();
  });

  it('toggles my existing reaction off by redacting it', async () => {
    component.myReactions = { '👍': '$mine' };
    await component.pick('👍');
    expect(matrix.redactEvent).toHaveBeenCalledWith('!r:test', '$mine');
    expect(matrix.sendReaction).not.toHaveBeenCalled();
  });
});
