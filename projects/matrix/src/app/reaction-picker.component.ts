import { AfterViewInit, Component, ElementRef, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatrixService } from './matrix.service';

/** Human-readable name for each emoji so the reaction buttons announce a
 *  meaningful accessible name rather than the bare glyph (WCAG 4.1.2). */
const EMOJI_LABELS: Record<string, string> = {
  '👍': 'thumbs up',
  '👎': 'thumbs down',
  '😄': 'grinning',
  '🎉': 'party',
  '❤️': 'heart',
  '🚀': 'rocket',
  '👀': 'eyes',
  '😢': 'crying',
  '🔥': 'fire',
  '✅': 'check mark',
};

/**
 * Quick emoji grid for reacting to an event (Element Web EmojiPicker for
 * reactions). Toggles a reaction on/off: sendReaction to add, redactEvent of
 * the caller's own m.reaction to remove.
 *
 * Exposed as a `role="menu"` of `menuitemcheckbox`es with a roving tabindex —
 * one Tab stop into the picker, then Left/Right/Home/End move the active item
 * and Enter/Space toggles it (the HugMesh roving-tabindex menu pattern).
 *
 * Per the WAI-ARIA APG menu pattern, the picker is a transient overlay: opening
 * it moves focus to the active item (so keyboard users land INSIDE the menu),
 * and Escape `dismiss()`es it. Because the parent owns the open/closed state
 * (the picker is mounted via `*ngIf`), Escape emits {@link dismissed} so the
 * parent can both close the picker and RESTORE focus to the trigger button —
 * the APG "Escape closes the menu and returns focus to the button" contract.
 */
@Component({
  selector: 'hug-reaction-picker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './reaction-picker.component.html',
  styleUrl: './reaction-picker.component.scss',
})
export class ReactionPickerComponent implements AfterViewInit {
  private readonly matrix = inject(MatrixService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  @Input() roomId = '';
  @Input() targetEventId = '';
  /** Map of emoji key -> my existing reaction event id (to toggle off). */
  @Input() myReactions: Record<string, string | undefined> = {};
  @Output() reacted = new EventEmitter<string>();
  /** Emitted when the user dismisses the picker with Escape (no reaction made).
   *  The parent closes the picker AND restores focus to the trigger button. */
  @Output() dismissed = new EventEmitter<void>();

  readonly emojis = ['👍', '👎', '😄', '🎉', '❤️', '🚀', '👀', '😢', '🔥', '✅'];

  /** Index of the currently roving-focusable emoji button (the single Tab stop). */
  readonly activeIndex = signal(0);

  /** On open (the picker is mounted via *ngIf), move focus to the active emoji
   *  so a keyboard user lands inside the menu rather than being stranded at the
   *  trigger — the APG "opening a menu focuses the first item" behaviour. */
  ngAfterViewInit(): void {
    this.focusButton(this.activeIndex());
  }

  label(key: string): string {
    return EMOJI_LABELS[key] ?? key;
  }

  /** True when the caller already has a reaction with this key (drives aria-checked). */
  isMine(key: string): boolean {
    return !!this.myReactions[key];
  }

  /** Roving-tabindex keyboard nav across the emoji row, plus Escape to dismiss. */
  onKeydown(ev: KeyboardEvent, index: number): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.dismissed.emit();
      return;
    }
    const last = this.emojis.length - 1;
    let next = index;
    switch (ev.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index === 0 ? last : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    ev.preventDefault();
    this.activeIndex.set(next);
    this.focusButton(next);
  }

  private focusButton(index: number): void {
    const buttons = this.host.nativeElement.querySelectorAll<HTMLButtonElement>('button.emoji-btn');
    buttons.item(index)?.focus();
  }

  async pick(key: string): Promise<void> {
    if (!this.roomId || !this.targetEventId) return;
    const existing = this.myReactions[key];
    if (existing) {
      await this.matrix.redactEvent(this.roomId, existing);
    } else {
      await this.matrix.sendReaction(this.roomId, this.targetEventId, key);
    }
    this.reacted.emit(key);
  }
}
