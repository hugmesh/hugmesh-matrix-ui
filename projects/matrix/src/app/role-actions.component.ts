import { Component, ElementRef, Input, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SessionService } from './session.service';
import { UserBffService, UserBlock, BlockPlatform } from './user-bff.service';
import { ModBffService, ModerationRequest } from './mod-bff.service';
import { AdminBffService } from './admin-bff.service';

/**
 * Role-responsive moderation/self-action surface for the Matrix remote.
 *
 * A single reusable component that reads the authenticated user's role tier from
 * the JWT claims (via {@link SessionService}) and CONDITIONALLY RENDERS three
 * additive tiers. The conditional rendering is the defence-in-depth gate (the
 * bff-apis also enforce server-side):
 *
 *  - USER  (every authenticated user — {@link SessionService.isUser}):
 *      self block/mute a Matrix user (external `matrix`) or internal-only block,
 *      list/remove my own blocks, and recommend an instance block to the mods.
 *      → wired to hugmesh-user-bff-api /bff/user/**.
 *  - MOD   (mod OR admin — {@link SessionService.isMod}):
 *      server-wide block a user/instance + triage the moderation queue and refer
 *      a request up to an admin.
 *      → wired to hugmesh-mod-bff-api /bff/mod/**.
 *  - ADMIN (admin only — {@link SessionService.isAdmin}):
 *      approve/deny an instance-block or user-removal request, wired to
 *      hugmesh-admin-bff-api's {@code POST /bff/admin/moderation/{id}/decide}
 *      (which itself proxies to federation-api's decide→apply chain — an approved
 *      user-removal auto-applies a kill-switch override; a denied re-decision
 *      rearms it). A failed decide surfaces as an error and NEVER renders as
 *      applied; the queue only refreshes on a real success.
 *
 * INVARIANT: because the tiers are additive and isMod⊇isAdmin, a MOD never sees
 * the ADMIN tier and a USER never sees MOD/ADMIN.
 *
 * Inputs: a target Matrix user id and an optional originating instance/server.
 */
@Component({
  selector: 'hug-role-actions',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './role-actions.component.html',
  styleUrl: './role-actions.component.scss',
})
export class RoleActionsComponent implements OnInit, OnDestroy {
  /** The Matrix user id this action surface targets, e.g. `@spam:evil.test`. */
  @Input() target = '';
  /** Optional homeserver/instance the target belongs to (defaults to the domain
   *  part of the user id). Used for instance-block recommendation + mod block. */
  @Input() instance?: string;
  /** When true the USER self-block control is hidden (e.g. acting on yourself). */
  @Input() isSelf = false;
  /** Embed mode: render the tiers inline (no dropdown trigger), always expanded.
   *  Used by the dedicated moderation panel route. */
  @Input() inline = false;

  readonly session = inject(SessionService);
  private readonly userBff = inject(UserBffService);
  private readonly modBff = inject(ModBffService);
  private readonly adminBff = inject(AdminBffService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** Subscriptions to the long-lived block/moderation datastore streams,
   *  torn down in {@link ngOnDestroy} (same convention as the other
   *  route-driven components in this project, e.g. MemberListComponent). */
  private blocksSub?: { unsubscribe(): void };
  private moderationSub?: { unsubscribe(): void };

  /** Request ids currently mid-flight on a decide call, so the row's buttons can
   *  disable themselves rather than allow a double-submit. */
  readonly decidingIds = signal<Set<number>>(new Set());

  // ── disclosure state for the menu ──
  readonly open = signal(false);

  // ── async result live-region copy ──
  readonly statusMsg = signal('');
  readonly errorMsg = signal('');

  // ── USER tier ──
  readonly blocks = signal<UserBlock[]>([]);
  blockPlatform: BlockPlatform = 'matrix';
  recommendReason = '';

  // ── MOD tier ──
  readonly queue = signal<ModerationRequest[]>([]);
  modScope: 'user' | 'instance' = 'user';
  modReason = '';

  /** The instance/domain derived from the target user id (after the colon). */
  readonly derivedInstance = computed(() => {
    if (this.instance) return this.instance;
    const i = this.target.indexOf(':');
    return i >= 0 ? this.target.slice(i + 1) : this.target;
  });

  ngOnInit(): void {
    if (this.session.isUser()) this.blocksSub = this.userBff.blocks$.subscribe((b) => this.blocks.set(b));
    if (this.session.isMod()) this.moderationSub = this.modBff.moderation$.subscribe((q) => this.queue.set(q));
    if (this.inline) {
      this.open.set(true);
      if (this.session.isUser()) this.userBff.list().subscribe({ error: () => this.fail('Could not load your blocks.') });
      if (this.session.isMod()) this.loadQueue();
    }
  }

  ngOnDestroy(): void {
    this.blocksSub?.unsubscribe();
    this.moderationSub?.unsubscribe();
  }

  toggle(): void {
    this.open.update((v) => !v);
    if (this.open()) {
      this.clearMessages();
      if (this.session.isUser()) this.userBff.list().subscribe({ error: () => this.fail('Could not load your blocks.') });
    }
  }

  close(): void {
    this.open.set(false);
  }

  // ───────────────────────────── USER tier ─────────────────────────────

  /** Block/mute the target on Matrix (or internal-only). */
  blockTarget(): void {
    if (!this.target) return;
    this.clearMessages();
    this.userBff.block(this.target, this.blockPlatform).subscribe({
      next: (ack) => this.ok(`Blocked ${this.target} (${this.blockPlatform}). External push: ${ack.external}.`),
      error: () => this.fail(`Could not block ${this.target}.`),
    });
  }

  /** Remove one of my own blocks. */
  unblock(b: UserBlock): void {
    this.clearMessages();
    this.userBff.unblock(b.id).subscribe({
      next: () => this.ok(`Removed block on ${b.target}.`),
      error: () => this.fail(`Could not remove the block on ${b.target}.`),
    });
  }

  /** Recommend an instance block to the moderators (USER→MOD→ADMIN chain). */
  recommendInstanceBlock(): void {
    const instance = this.derivedInstance();
    if (!instance) return;
    this.clearMessages();
    this.userBff.recommendInstanceBlock(instance, this.recommendReason.trim()).subscribe({
      next: () => { this.ok(`Recommended an instance block on ${instance} to the moderators.`); this.recommendReason = ''; },
      error: () => this.fail(`Could not recommend an instance block on ${instance}.`),
    });
  }

  // ───────────────────────────── MOD tier ─────────────────────────────

  /** Load/refresh the moderation queue (mod or admin only). */
  loadQueue(): void {
    this.clearMessages();
    this.modBff.loadModeration().subscribe({ error: () => this.fail('Could not load the moderation queue.') });
  }

  /** Server-wide block of the target user/instance on Matrix. */
  modBlock(): void {
    const target = this.modScope === 'instance' ? this.derivedInstance() : this.target;
    if (!target) return;
    this.clearMessages();
    this.modBff.block({ platform: 'matrix', scope: this.modScope, target, reason: this.modReason.trim() || undefined }).subscribe({
      next: (r) => this.ok(`Server-wide ${this.modScope} block on ${target} recorded. External: ${r.external}.${r.note ? ' ' + r.note : ''}`),
      error: () => this.fail(`Could not record a server-wide block on ${target}.`),
    });
  }

  /** Refer/escalate a queued request up to an admin. */
  refer(req: ModerationRequest): void {
    this.clearMessages();
    this.modBff.refer(req.id).subscribe({
      next: (r) => this.ok(`Referred request #${req.id} to an admin (status: ${r.status}).`),
      error: () => this.fail(`Could not refer request #${req.id}.`),
    });
  }

  // ───────────────────────────── ADMIN tier ─────────────────────────────

  /**
   * ADMIN approve/deny — POSTs hugmesh-admin-bff-api's
   * {@code /bff/admin/moderation/{id}/decide}, which proxies to federation-api's
   * decide→apply chain (bearer-forwarded, so federation-api authorises + scopes
   * the decision to the caller's own domain). The row is marked mid-flight via
   * {@link decidingIds} to prevent a double-submit; on success the (mod-tier
   * shared) queue is refreshed by the service so the new status renders
   * everywhere. A failure is surfaced honestly and the row is NEVER treated as
   * decided.
   */
  adminDecide(req: ModerationRequest, approve: boolean): void {
    this.clearMessages();
    this.decidingIds.update((s) => new Set(s).add(req.id));
    this.adminBff.decide(req.id, approve).subscribe({
      next: (decided) => {
        this.decidingIds.update((s) => { const n = new Set(s); n.delete(req.id); return n; });
        this.ok(`${approve ? 'Approved' : 'Denied'} request #${req.id} (${req.kind} on ${req.target}). Status: ${decided.status}.`);
      },
      error: () => {
        this.decidingIds.update((s) => { const n = new Set(s); n.delete(req.id); return n; });
        this.fail(`Could not ${approve ? 'approve' : 'deny'} request #${req.id} — it was NOT applied.`);
      },
    });
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private ok(msg: string): void { this.statusMsg.set(msg); this.errorMsg.set(''); }
  private fail(msg: string): void { this.errorMsg.set(msg); this.statusMsg.set(''); }
  private clearMessages(): void { this.statusMsg.set(''); this.errorMsg.set(''); }

  /** Escape-to-close for the disclosure menu, restoring focus to the trigger
   *  (the disclosure-pattern contract: Escape closes AND returns focus to the
   *  button that opened it, so the keyboard user is not stranded). Inline mode
   *  has no trigger and is always open, so Escape is a no-op there. */
  onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.open() && !this.inline) {
      this.close();
      e.stopPropagation();
      this.focusTrigger();
    }
  }

  /** Return focus to the disclosure trigger after closing the menu. */
  private focusTrigger(): void {
    const trigger = this.host.nativeElement.querySelector<HTMLButtonElement>(
      '[data-testid="role-actions-trigger"]',
    );
    trigger?.focus();
  }
}
