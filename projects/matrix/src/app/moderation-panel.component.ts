import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SessionService } from './session.service';
import { RoleActionsComponent } from './role-actions.component';

/**
 * Dedicated role-aware moderation page (route 'moderation'). A thin container
 * that embeds the role-responsive {@link RoleActionsComponent} in inline mode so
 * the same single source of tier logic powers both the per-member dropdown and
 * this full-page surface. The tiers render exactly per the user's JWT role:
 *  - logged-out: a sign-in prompt (no tiers).
 *  - USER:  self-block + recommend-instance-block.
 *  - MOD:   + server-wide block + queue triage/refer.
 *  - ADMIN: + the stubbed approve/deny control.
 *
 * The page takes an optional ?target= / ?instance= query so a deep-link from a
 * room can pre-fill the user/instance to act on.
 */
@Component({
  selector: 'hug-moderation-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, RoleActionsComponent],
  templateUrl: './moderation-panel.component.html',
  styleUrl: './moderation-panel.component.scss',
})
export class ModerationPanelComponent {
  readonly session = inject(SessionService);

  /** Optional pre-filled target user id (bound into the embedded surface). */
  target = '';
  /** Optional pre-filled instance/homeserver. */
  instance = '';
}
