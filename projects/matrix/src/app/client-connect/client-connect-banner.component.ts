import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';

import { ClientConnectService } from './client-connect.service';
import { SSE_NOTIFICATION_EVENT, ShellSseNotification, VIEW_RELOAD_EVENT } from '../shell-events';

/**
 * The CLIENT-CONNECT banner at the top of the Matrix tab: what a user who holds
 * the external-client grant needs in order to point their OWN Matrix client
 * (Element, FluffyChat, …) at this deployment.
 *
 * Renders NOTHING at all for a user without the grant — this is a capability
 * they were specifically given, not general chrome.
 *
 * The critical rule this component exists to enforce: it shows a URL ONLY when
 * {@link ClientConnectService} has SEEN the homeserver answer a real CS-API
 * request. Otherwise it says so, and says why. A front-door 200 is not proof —
 * the gateway serves this very SPA for unrouted paths, so an unrouted
 * /_matrix/** looks like a healthy 200 to anything that does not check the
 * content-type.
 */
@Component({
  selector: 'hug-client-connect-banner',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './client-connect-banner.component.html',
  styleUrl: './client-connect-banner.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClientConnectBannerComponent implements OnInit, OnDestroy {
  private readonly clientConnect = inject(ClientConnectService);

  readonly state = this.clientConnect.state;

  ngOnInit(): void {
    void this.clientConnect.check();
    if (typeof window === 'undefined') return;
    window.addEventListener(VIEW_RELOAD_EVENT, this.recheck);
    window.addEventListener(SSE_NOTIFICATION_EVENT, this.onShellNotification);
  }

  ngOnDestroy(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener(VIEW_RELOAD_EVENT, this.recheck);
    window.removeEventListener(SSE_NOTIFICATION_EVENT, this.onShellNotification);
  }

  /** Property, not method, so add/removeEventListener share one reference. */
  private readonly recheck = (): void => { void this.clientConnect.check(); };

  /**
   * LIVE UPDATE from the shell's SSE stream. `role-change` is the one category
   * that can flip this banner: the external-client grant IS a role, so a grant
   * or revocation arriving over SSE must re-run the check rather than leave a
   * stale banner (or a stale absence of one) until the next full page load.
   * Every other category is ignored — reacting to all of them would re-probe the
   * homeserver for notifications that cannot possibly change this answer.
   */
  private readonly onShellNotification = (event: Event): void => {
    const detail = (event as CustomEvent<ShellSseNotification>).detail;
    if (detail?.category === 'role-change') void this.clientConnect.check();
  };
}
