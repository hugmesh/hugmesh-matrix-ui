import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit, Output, ViewChild, forwardRef, inject, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { MatrixService } from './matrix.service';
import { MeshUser, UserBffService } from './user-bff.service';

/** The shortest typed fragment that searches (the server enforces the same floor). */
export const MIN_QUERY = 2;
/** Quiet time after the last keystroke before a lookup is sent. */
export const DEBOUNCE_MS = 200;

/**
 * A type-to-find box for a Matrix user: as someone types a name it offers mesh users from the member
 * directory (their own domain; every domain for a superadmin) and, on choosing one, fills the box with
 * the full Matrix id. A full id typed by hand still works exactly as before, because federation and
 * cross-domain invites are typed ids; the list is a convenience, never a gate.
 *
 * It is a {@code ControlValueAccessor}, so a template swaps its plain input for this element and keeps
 * its {@code [(ngModel)]}, id and test id. ARIA combobox pattern: the input owns focus; the list is a
 * listbox whose active option is announced through aria-activedescendant; Up/Down move, Enter picks,
 * Escape closes. Enter with no option highlighted is emitted as {@link enterKey} so the parent's own
 * "submit" (invite, start chat) still runs.
 */
@Component({
  selector: 'hug-mesh-user-picker',
  standalone: true,
  imports: [CommonModule],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MeshUserPickerComponent), multi: true }],
  styles: [`
    :host { position: relative; display: inline-block; min-width: 0; }
    input { width: 100%; min-width: 0; box-sizing: border-box; }
    .results { position: absolute; z-index: 20; left: 0; right: 0; margin: 2px 0 0; padding: 0; list-style: none;
      max-height: 14rem; overflow-y: auto; background: var(--hug-bg-1, #fff); color: var(--hug-fg, #111);
      border: 1px solid var(--hug-border, #888); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .results li { display: flex; gap: .5rem; align-items: baseline; padding: .4rem .6rem; cursor: pointer; }
    .results li.active, .results li:hover { background: var(--hug-accent-bg, #dde8ff); }
    .mxid { opacity: .75; font-size: .85em; overflow-wrap: anywhere; }
    .domain { margin-left: auto; opacity: .6; font-size: .8em; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
  template: `
    <input #box type="text" [id]="inputId" [attr.data-testid]="testId" [placeholder]="placeholder"
           role="combobox" aria-autocomplete="list" autocomplete="off" autocapitalize="off" spellcheck="false"
           [attr.aria-expanded]="showList()" [attr.aria-controls]="listId"
           [attr.aria-activedescendant]="active() >= 0 ? optionId(active()) : null"
           [attr.aria-describedby]="describedBy || null" [disabled]="disabled()"
           [value]="value()" (input)="onInput($any($event.target).value)" (keydown)="onKey($event)" (blur)="onBlur()" />
    <ul *ngIf="showList()" class="results" role="listbox" [id]="listId" data-testid="picker-results">
      <li *ngFor="let u of results(); let i = index" role="option" [id]="optionId(i)" [class.active]="i === active()"
          [attr.aria-selected]="i === active()" [attr.data-testid]="'picker-option-' + u.username" (mousedown)="pick(u, $event)">
        <span class="name">{{ u.username }}</span>
        <span class="mxid">{{ mxid(u) }}</span>
        <span class="domain" *ngIf="u.domain">{{ u.domain }}</span>
      </li>
    </ul>
    <span class="sr" role="status" aria-live="polite" data-testid="picker-status">{{ status() }}</span>
  `,
})
export class MeshUserPickerComponent implements ControlValueAccessor, OnInit, OnDestroy {
  private static nextId = 0;

  @Input() inputId = '';
  @Input() testId: string | null = null;
  @Input() placeholder = '@user:server';
  @Input() describedBy: string | null = '';
  /** Fired when Enter is pressed and no option is highlighted: the parent's own submit. */
  @Output() enterKey = new EventEmitter<void>();
  @ViewChild('box', { static: true }) box!: ElementRef<HTMLInputElement>;

  private readonly directory = inject(UserBffService);
  private readonly matrix = inject(MatrixService);
  private readonly uid = MeshUserPickerComponent.nextId++;

  readonly value = signal('');
  readonly results = signal<MeshUser[]>([]);
  readonly active = signal(-1);
  readonly open = signal(false);
  readonly status = signal('');
  readonly disabled = signal(false);

  private server = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private onChange: (v: string) => void = () => {};
  private onTouched: () => void = () => {};

  get listId(): string { return `hug-mesh-user-picker-${this.uid}`; }
  optionId(i: number): string { return `${this.listId}-opt-${i}`; }
  showList(): boolean { return this.open() && this.results().length > 0; }

  ngOnInit(): void {
    // The server part of the ids we offer is the caller's own homeserver; best effort, the list simply
    // shows the localpart alone until it is known.
    this.matrix.whoami().then((me) => { this.server = me && me.includes(':') ? me.slice(me.indexOf(':') + 1) : ''; }, () => {});
  }

  ngOnDestroy(): void { this.cancel(); }

  mxid(u: MeshUser): string {
    const local = u.matrixLocalpart || u.username;
    return this.server ? `@${local}:${this.server}` : `@${local}`;
  }

  // ── ControlValueAccessor ──
  writeValue(v: string | null): void { this.value.set(v ?? ''); }
  registerOnChange(fn: (v: string) => void): void { this.onChange = fn; }
  registerOnTouched(fn: () => void): void { this.onTouched = fn; }
  setDisabledState(d: boolean): void { this.disabled.set(d); if (d) this.close(); }

  onInput(text: string): void {
    this.value.set(text);
    this.onChange(text);
    this.cancel();
    const frag = this.fragmentOf(text);
    if (frag.length < MIN_QUERY) { this.close(); this.status.set(''); return; }
    const mine = ++this.seq;
    this.timer = setTimeout(() => this.lookup(frag, mine), DEBOUNCE_MS);
  }

  onKey(ev: KeyboardEvent): void {
    const n = this.results().length;
    if (ev.key === 'ArrowDown' && this.showList()) { ev.preventDefault(); this.active.set((this.active() + 1) % n); }
    else if (ev.key === 'ArrowUp' && this.showList()) { ev.preventDefault(); this.active.set((this.active() - 1 + n) % n); }
    else if (ev.key === 'Escape' && this.open()) { ev.preventDefault(); this.close(); }
    else if (ev.key === 'Enter') {
      if (this.showList() && this.active() >= 0) { ev.preventDefault(); this.pick(this.results()[this.active()]); }
      else { this.enterKey.emit(); }
    }
  }

  onBlur(): void { this.onTouched(); this.close(); }

  pick(u: MeshUser, ev?: Event): void {
    ev?.preventDefault();   // keep focus in the box (a mousedown would blur it first)
    const id = this.mxid(u);
    this.value.set(id);
    this.onChange(id);
    this.close();
    this.status.set(`${u.username} selected`);
  }

  /** What to search for: the typed name without a leading @; a full id (has a server part) searches nothing. */
  private fragmentOf(text: string): string {
    const t = text.trim().replace(/^@/, '');
    return t.includes(':') ? '' : t;
  }

  private lookup(frag: string, mine: number): void {
    this.directory.searchDirectory(frag).subscribe({
      next: (rows) => {
        if (mine !== this.seq) return;   // a newer keystroke owns the list
        const usable = (rows ?? []).filter((r) => !!(r.matrixLocalpart || r.username));
        this.results.set(usable);
        this.active.set(-1);
        this.open.set(usable.length > 0);
        this.status.set(usable.length ? `${usable.length} people found` : 'No one found; enter a full Matrix id to invite someone else');
      },
      error: () => {
        if (mine !== this.seq) return;
        this.close();
        this.status.set('Could not look people up; enter a full Matrix id instead');
      },
    });
  }

  private cancel(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private close(): void { this.open.set(false); this.active.set(-1); }
}
