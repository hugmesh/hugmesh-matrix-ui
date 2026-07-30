import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatrixService } from '../matrix.service';
import { CharacterPackService } from '../vn/character-pack.service';
import { Chat3dState, Chat3dStateService } from './chat3d-state.service';
import { Chat3dAvatarMode, Chat3dAvatarState } from './chat3d-avatar.service';
import { ActiveForgeCharacter, CharacterForgeBffService } from './character-forge-bff.service';
import { randomChar3dConfig } from './char3d-config';
import { Chat3dHostComponent } from './chat3d-host.component';

/**
 * The 3D-room JOIN MENU at `rooms/:roomId/chat3d` — the doorway between a
 * Matrix room and its "Shadows of the Net" chamber. Reachable only through the
 * room-view button (which itself renders only when the room's chat3d state
 * parses enabled), but deep-linkable, so it re-checks enablement itself and
 * explains an off room instead of loading anything.
 *
 * The character-source chain (DESIGN §6): the caller's ACTIVE character-forge
 * character (via the thin BFF client) → their VN sticker pack as a flat
 * billboard → a seeded random guest. Unavailable sources are OFFERED-BUT-
 * GREYED with WHY-helptext (mesh-bridge control precedent), never hidden —
 * the user should learn HOW to get a real character, not wonder where the
 * option went. Entering swaps this menu for the embedded room host.
 */
@Component({
  selector: 'hug-chat3d-join',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, Chat3dHostComponent],
  templateUrl: './chat3d-join.component.html',
  styleUrl: './chat3d-join.component.scss',
})
export class Chat3dJoinComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly matrix = inject(MatrixService);
  private readonly chat3d = inject(Chat3dStateService);
  private readonly forge = inject(CharacterForgeBffService);
  private readonly packs = inject(CharacterPackService);

  readonly roomId = signal<string | null>(null);
  /** The room's parsed chat3d state (null = off/unset/unreadable). */
  readonly state = signal<Chat3dState | null>(null);
  /** True while the enablement/source probes are still resolving. */
  readonly loading = signal(true);
  /** True once the user entered — the join menu yields to the room host. */
  readonly entered = signal(false);

  // ── Character sources ──
  /** My ACTIVE character-forge character (null = none/BFF dark). */
  readonly forgeCharacter = signal<ActiveForgeCharacter | null>(null);
  /** My VN sticker pack's neutral-frame mxc (null = no pack). */
  readonly stickerUrl = signal<string | null>(null);
  /** My own mxid ('' until whoami resolves). */
  readonly myUserId = signal('');

  /** The chosen source. Defaults to the best available once probes resolve. */
  source: Chat3dAvatarMode = 'guest';
  /** Guest randomizer seed (same seed = same guest, shareable). */
  guestSeed = Math.random().toString(36).slice(2, 8);
  micEnabled = false;
  cameraEnabled = false;

  readonly enabled = computed(() => this.state()?.enabled === true);

  /** WHY-helptext for the greyed character-forge option. */
  readonly forgeHelp = computed(() =>
    this.forgeCharacter()
      ? ''
      : 'No active Character Forge character found. Create one in Character Forge and mark it active, then rejoin.');
  /** WHY-helptext for the greyed sticker-billboard option. */
  readonly billboardHelp = computed(() =>
    this.stickerUrl()
      ? ''
      : 'No VN sticker pack is registered for your account. Publish character stickers from Character Studio to use billboard mode.');

  private sub?: { unsubscribe(): void };

  ngOnInit(): void {
    this.sub = this.route.paramMap.subscribe((pm) => {
      const rid = pm.get('roomId');
      this.roomId.set(rid);
      if (rid) {
        void this.load(rid);
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private async load(rid: string): Promise<void> {
    this.loading.set(true);
    try {
      // Enablement first — a disabled room needs no source probes.
      this.state.set(await this.chat3d.getChat3dState(rid));
      if (!this.enabled()) {
        return;
      }
      // Probe the three sources in fallback order; each is independently
      // fail-soft (null = greyed option), so one dark BFF never blocks entry.
      const me = (await this.matrix.whoami().catch(() => null)) ?? '';
      this.myUserId.set(me);
      this.forgeCharacter.set(await this.forge.getActiveCharacter());
      if (me) {
        const pack = await this.packs.resolveCharacterPack(me);
        this.stickerUrl.set(this.packs.imageFor(pack, 'neutral')?.url ?? null);
      }
      this.source = this.forgeCharacter() ? 'forge' : this.stickerUrl() ? 'billboard' : 'guest';
    } finally {
      this.loading.set(false);
    }
  }

  /** The localpart of my mxid (`@alice:server` → `alice`) for name fallbacks. */
  private myLocalpart(): string {
    const m = /^@([^:]+):/.exec(this.myUserId());
    return m ? m[1] : '';
  }

  /**
   * The avatar snapshot the chosen source yields — what the room host
   * publishes as my `systems.hugmesh.chat3d.avatar` state. A source that
   * lost its backing mid-menu (e.g. forge chosen but the character vanished)
   * degrades to the seeded guest rather than failing the join.
   */
  buildAvatar(): Chat3dAvatarState {
    const forge = this.forgeCharacter();
    if (this.source === 'forge' && forge) {
      return { mode: 'forge', config: forge.definition, sticker: null, name: forge.name };
    }
    const sticker = this.stickerUrl();
    if (this.source === 'billboard' && sticker) {
      return { mode: 'billboard', config: null, sticker, name: this.myLocalpart() };
    }
    const seed = this.guestSeed.trim() || 'guest';
    return { mode: 'guest', config: randomChar3dConfig(seed), sticker: null, name: `Guest ${seed}` };
  }

  /** Frozen at Enter time so re-rolls of the menu never re-dress the room. */
  readonly joinedAvatar = signal<Chat3dAvatarState | null>(null);

  enter(): void {
    if (!this.enabled()) {
      return;
    }
    this.joinedAvatar.set(this.buildAvatar());
    this.entered.set(true);
  }
}
