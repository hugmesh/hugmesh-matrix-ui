import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatrixService, SearchResult } from './matrix.service';
import { mountRoute } from './mount-route';

/**
 * Element Web RoomSearchView / search results panel. Full-text message search
 * (all rooms or a single room scope), results with sender / room / snippet +
 * surrounding context, next_batch pagination, and click-through to the event
 * in the room timeline.
 */
@Component({
  selector: 'hug-search',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
})
export class SearchComponent implements OnInit {
  /** This remote's mount point — in-app links resolve against it
   *  (see mount-route.ts: absolute links bounce out of the remote). */
  readonly mount = mountRoute();
  private readonly matrix = inject(MatrixService);
  private readonly route = inject(ActivatedRoute);

  term = '';
  readonly results = signal<SearchResult[]>([]);
  readonly count = signal(0);
  readonly nextBatch = signal<string | undefined>(undefined);
  readonly roomScope = signal<string | null>(null);

  ngOnInit(): void {
    this.roomScope.set(this.route.snapshot.queryParamMap.get('room'));
  }

  async runSearch(reset: boolean): Promise<void> {
    const t = this.term.trim();
    if (!t) return;
    const res = await this.matrix.search(t, {
      roomId: this.roomScope() ?? undefined,
      nextBatch: reset ? undefined : this.nextBatch(),
    });
    if (reset) this.results.set(res.results);
    else this.results.update((cur) => [...cur, ...res.results]);
    this.count.set(res.count);
    this.nextBatch.set(res.nextBatch);
  }
}
