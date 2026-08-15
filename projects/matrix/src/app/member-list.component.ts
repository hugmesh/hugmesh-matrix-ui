import { Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatrixService, RoomMember } from './matrix.service';
import { RoleActionsComponent } from './role-actions.component';
import { accessibleName } from './accessible-name';
import { mountRoute } from './mount-route';

/**
 * Element Web MemberList / right panel. Joined members with avatar + display
 * name, a power-level label (Admin 100 / Moderator 50 / Default), a presence dot,
 * and invite + kick moderation controls. Each member row also carries the
 * role-responsive {@link RoleActionsComponent} (self-block/recommend for every
 * user, mod/admin tools for elevated roles) targeting that member's user id.
 */
@Component({
  selector: 'hug-member-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, RoleActionsComponent],
  templateUrl: './member-list.component.html',
  styleUrl: './member-list.component.scss',
})
export class MemberListComponent implements OnInit, OnDestroy, OnChanges {
  /** This remote's mount point — in-app links resolve against it
   *  (see mount-route.ts: absolute links bounce out of the remote). */
  readonly mount = mountRoute();
  private readonly matrix = inject(MatrixService);
  private readonly route = inject(ActivatedRoute);

  /** When EMBEDDED as a pane (rather than reached as its own route), the shell passes
   *  the room id directly. Mirrors room-view's roomIdInput so both panes are driven the
   *  same way; without it this component only works as a route, and a persistent
   *  members pane beside the timeline would be impossible. */
  @Input() roomIdInput: string | null = null;

  readonly roomId = signal<string | null>(null);
  readonly members = signal<RoomMember[]>([]);
  readonly me = signal<string | null>(null);
  /** ANNOUNCED invite/kick outcome (aria-live status region). A rejected verb —
   *  403 insufficient power level, invalid target, homeserver error — must
   *  surface here, never die as a silent no-op refresh. */
  readonly status = signal('');
  inviteUser = '';

  private sub?: { unsubscribe(): void };

  ngOnInit(): void {
    void this.matrix.whoami().then((id) => this.me.set(id));
    this.sub = this.route.paramMap.subscribe(async (pm) => {
      // The embedded id wins: when the shell drives this pane the URL still points at
      // the ROOM, not at its members, so the param is absent and reading it first would
      // blank the pane on every navigation.
      const rid = this.roomIdInput ?? pm.get('roomId');
      this.roomId.set(rid);
      if (rid) await this.reload(rid);
    });
  }

  /** Re-load when the shell switches rooms. The paramMap subscription above does not
   *  fire for an embedded pane, because the room id arrives as an INPUT rather than in
   *  the URL — without this the pane would keep showing the first room's members. */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['roomIdInput'] && this.roomIdInput) {
      this.roomId.set(this.roomIdInput);
      void this.reload(this.roomIdInput);
    }
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private async reload(rid: string): Promise<void> {
    const members = await this.matrix.joinedMembers(rid);
    this.members.set(members.sort((a, b) => b.powerLevel - a.powerLevel));
  }

  bg(m: RoomMember): string {
    return m.avatarUrl ? `url(${this.matrix.mxcToHttp(m.avatarUrl, { thumbnail: true, w: 24, h: 24 })})` : '';
  }

  /** ANNOUNCED member name for aria-labels (e.g. "Kick {name}") — the ASCII
   *  screenReaderName when present, else the display name / user id. The visible
   *  `.name` span keeps the raw UTF-8 display name. */
  ariaName(m: RoomMember): string {
    return accessibleName(m.displayName || m.userId, m.screenReaderName);
  }

  powerLabel(level: number): string {
    if (level >= 100) return 'Admin';
    if (level >= 50) return 'Moderator';
    return 'Default';
  }

  async doInvite(): Promise<void> {
    const rid = this.roomId();
    const u = this.inviteUser.trim();
    if (!rid || !u) return;
    this.status.set('');
    try {
      await this.matrix.invite(rid, u);
      // Only a server-ACCEPTED invite clears the input and claims success.
      this.inviteUser = '';
      this.status.set(`Invited ${u}`);
      await this.reload(rid);
    } catch (e: unknown) {
      // ANNOUNCED failure (403 power level / invalid id / server error) — the
      // input keeps its value so the user can correct and retry.
      this.status.set(`Invite failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async doKick(m: RoomMember): Promise<void> {
    const rid = this.roomId();
    if (!rid) return;
    this.status.set('');
    try {
      await this.matrix.kick(rid, m.userId);
      await this.reload(rid);
    } catch (e: unknown) {
      // ANNOUNCED failure: a member whose power level cannot kick the target
      // (homeserver 403) must see the rejection, never a silent refresh.
      this.status.set(`Kick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
