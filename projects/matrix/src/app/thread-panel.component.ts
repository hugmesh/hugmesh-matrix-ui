import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatrixService, TimelineEvent } from './matrix.service';
import { ComposerComponent } from './composer.component';
import { ChatThemeRootDirective } from './theme/chat-theme-root.directive';
import { mountRoute } from './mount-route';

/**
 * Element Web ThreadView / ThreadPanel. Shows a thread root + its m.thread
 * replies (rooms/:roomId/thread/:eventId), a list of room threads, and a
 * threaded composer that posts via sendThreadMessage.
 */
@Component({
  selector: 'hug-thread-panel',
  standalone: true,
  imports: [CommonModule, RouterLink, ComposerComponent],
  // Chat-theme root: the embedded composer consumes the --hugm-chat-* vars.
  hostDirectives: [ChatThemeRootDirective],
  templateUrl: './thread-panel.component.html',
  styleUrl: './thread-panel.component.scss',
})
export class ThreadPanelComponent implements OnInit, OnDestroy {
  /** This remote's mount point — in-app links resolve against it
   *  (see mount-route.ts: absolute links bounce out of the remote). */
  readonly mount = mountRoute();
  private readonly matrix = inject(MatrixService);
  private readonly route = inject(ActivatedRoute);

  readonly roomId = signal<string | null>(null);
  readonly rootId = signal<string | null>(null);
  readonly root = signal<TimelineEvent | null>(null);
  readonly replies = signal<TimelineEvent[]>([]);
  readonly threadRoots = signal<TimelineEvent[]>([]);
  readonly threadMode = signal<'thread'>('thread');

  private sub?: { unsubscribe(): void };

  ngOnInit(): void {
    this.sub = this.route.paramMap.subscribe(async (pm) => {
      const rid = pm.get('roomId');
      const eid = pm.get('eventId');
      this.roomId.set(rid);
      this.rootId.set(eid);
      if (rid && eid) {
        await this.loadRoot(rid, eid);
        await this.reloadReplies();
      }
      if (rid) await this.loadThreadList(rid);
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  latestId(): string | null {
    const r = this.replies();
    return r.length ? r[r.length - 1].eventId : this.rootId();
  }

  private async loadRoot(rid: string, eid: string): Promise<void> {
    try { this.root.set(await this.matrix.getEvent(rid, eid)); } catch { this.root.set(null); }
  }

  async reloadReplies(): Promise<void> {
    const rid = this.roomId();
    const eid = this.rootId();
    if (!rid || !eid) return;
    const evs = await this.matrix.getRelations(rid, eid, 'm.thread');
    this.replies.set(evs.sort((a, b) => a.originServerTs - b.originServerTs));
  }

  private async loadThreadList(rid: string): Promise<void> {
    const page = await this.matrix.getThreads(rid);
    this.threadRoots.set(page.events);
  }
}
