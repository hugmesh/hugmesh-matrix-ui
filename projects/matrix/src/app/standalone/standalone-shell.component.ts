import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SessionService } from '../session.service';
import { StandaloneSessionService } from './standalone-session.service';

interface NavItem {
  readonly path: string;
  readonly label: string;
}

/**
 * The shell of a standalone deployment: a sign-in form, then the navigation and the Matrix routes. Used only by the
 * `standalone` build (main.standalone.ts); under the HugMesh host shell the host provides all of this and mounts
 * `./routes` directly.
 */
@Component({
  selector: 'hug-standalone-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule],
  templateUrl: './standalone-shell.component.html',
  styleUrl: './standalone-shell.component.scss',
})
export class StandaloneShellComponent implements OnInit {
  protected readonly standalone = inject(StandaloneSessionService);
  protected readonly session = inject(SessionService);

  protected username = '';
  protected password = '';

  protected readonly title = signal('Matrix');

  protected readonly nav: readonly NavItem[] = [
    { path: '/', label: 'Chats' },
    { path: '/rooms', label: 'Rooms' },
    { path: '/search', label: 'Search' },
    { path: '/settings', label: 'Settings' },
  ];

  async ngOnInit(): Promise<void> {
    await this.standalone.init();
  }

  protected async submit(): Promise<void> {
    const ok = await this.standalone.login(this.username, this.password);
    // never keep the password in the component once it has been sent
    this.password = '';
    if (ok) this.username = '';
  }

  protected signOut(): void {
    void this.standalone.signOut();
  }
}
