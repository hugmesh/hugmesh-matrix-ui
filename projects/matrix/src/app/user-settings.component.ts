import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatrixService } from './matrix.service';
import {
  MAX_MESH_LABEL_LENGTH,
  MeshDevice,
  UserBffService,
  isMeshDeviceVisibility,
  normalizeMeshNodeId,
} from './user-bff.service';
import {
  CHAT_THEME_PRESETS,
  ChatThemeConfig,
  ChatThemePreset,
  ChatThemeService,
  defaultChatTheme,
} from './theme/chat-theme.service';
import { ChatThemeRootDirective } from './theme/chat-theme-root.directive';

/**
 * Render a mesh device's `lastSeenAt` as a coarse relative time ("just now",
 * "5m ago", "3h ago", "2d ago"). Fail-soft: a null/malformed timestamp renders
 * nothing (null); a FUTURE timestamp (clock skew) reads "just now" rather than
 * a negative age. Pure + clock-injectable so the formatting is unit-testable.
 * (No repo-wide relative-time helper exists yet — the timeline's day separator
 * formats absolute dates — so this stays local to the mesh-devices section.)
 */
export function relativeTimeLabel(iso: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const deltaMs = nowMs - t;
  if (deltaMs < 60_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Element Web UserSettingsDialog (General/Profile). Edit own display name,
 * upload + set own avatar, set presence + status message, and show the user_id
 * resolved from whoami. Also hosts the "Chat appearance" section: the per-user
 * chat theme (preset/colors/bubbles/font/density/background) persisted by
 * {@link ChatThemeService} to Matrix account data — the host element is itself
 * a theme root, so the section's mini-preview restyles live as controls change.
 * And the "Mesh devices" section: claim/release the Meshtastic node ids whose
 * radio messages fold onto the caller's name, per-device visibility, and the
 * radio-reported (unauthenticated) status telemetry.
 */
@Component({
  selector: 'hug-user-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  // Theme root: the live mini-preview consumes the --hugm-chat-* vars the
  // service stamps on this host (scoped — never on <body>).
  hostDirectives: [ChatThemeRootDirective],
  templateUrl: './user-settings.component.html',
  styleUrl: './user-settings.component.scss',
})
export class UserSettingsComponent implements OnInit, OnDestroy {
  private readonly matrix = inject(MatrixService);
  private readonly userBff = inject(UserBffService);
  readonly chatTheme = inject(ChatThemeService);

  readonly userId = signal<string | null>(null);
  readonly busy = signal(false);
  readonly status = signal('');
  displayName = '';
  presence: 'online' | 'unavailable' | 'offline' = 'online';
  statusMsg = '';

  // ── Mesh devices ──
  /** My claimed mesh devices (mirrors {@link UserBffService.meshDevices$}, with
   *  an optimistic overlay while a visibility change is in flight). */
  readonly meshDevices = signal<MeshDevice[]>([]);
  /** Non-blocking mesh error note ('' = none) — list/claim/release/visibility
   *  failures land here without taking the rest of the settings page down. */
  readonly meshError = signal('');
  meshNodeId = '';
  meshLabel = '';
  private meshSub?: { unsubscribe(): void };

  /** Swatch rows for the 5 presets (id/label/representative colors). */
  readonly presets = CHAT_THEME_PRESETS;

  async ngOnInit(): Promise<void> {
    // Mesh devices load independently of the Matrix profile — a dead BFF
    // endpoint must never block the profile/presence/theme sections.
    this.meshSub = this.userBff.meshDevices$.subscribe((rows) => this.meshDevices.set(rows));
    this.refreshMeshDevices();
    const me = await this.matrix.whoami();
    this.userId.set(me);
    if (me) {
      const profile = await this.matrix.getProfile(me);
      this.displayName = profile.displayName ?? '';
      // Preload the CURRENT presence + status so "Update presence" edits the
      // server truth. Without this the form always reset to Online, so opening
      // settings and clicking the button silently un-Away'd the user.
      const current = await this.matrix.getPresence(me);
      if (current) {
        this.presence = current.presence;
        this.statusMsg = current.statusMsg ?? '';
      }
    }
  }

  ngOnDestroy(): void {
    this.meshSub?.unsubscribe();
  }

  async saveProfile(): Promise<void> {
    const me = this.userId();
    if (!me) return;
    this.busy.set(true);
    try {
      await this.matrix.setDisplayName(me, this.displayName.trim());
      this.status.set('Profile saved');
    } catch (e: unknown) {
      this.status.set(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy.set(false);
    }
  }

  async onAvatar(ev: Event): Promise<void> {
    const me = this.userId();
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!me || !file) return;
    this.status.set('Uploading avatar…');
    try {
      const up = await this.matrix.uploadMedia(file, file.name);
      await this.matrix.setAvatarUrl(me, up.mxcUri);
      this.status.set('Avatar updated');
    } catch (e: unknown) {
      this.status.set(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async savePresence(): Promise<void> {
    const me = this.userId();
    if (!me) return;
    try {
      await this.matrix.setPresence(me, this.presence, this.statusMsg.trim() || undefined);
      this.status.set('Presence updated');
    } catch (e: unknown) {
      this.status.set(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Mesh devices ──────────────────────────────────────────────────────────

  /** (Re)load my mesh devices. FAIL-SOFT: a dead endpoint leaves the section
   *  with a non-blocking error note; the list itself arrives via meshDevices$. */
  private refreshMeshDevices(): void {
    this.userBff.listMeshDevices().subscribe({
      error: () => this.meshError.set('Mesh devices are unavailable right now — try again later.'),
    });
  }

  /** Claim the typed node id (normalized to canonical "!"+lowercase-hex form —
   *  a non-node-id input is refused client-side, never guessed at). 409 from
   *  the API means someone (possibly me) already claimed that node id. */
  claimMeshDevice(): void {
    const nodeId = normalizeMeshNodeId(this.meshNodeId);
    if (!nodeId) {
      this.meshError.set('Enter a node id of exactly 8 hex digits, like a1b2c3d4 or !A1B2C3D4.');
      return;
    }
    const label = this.meshLabel.trim().slice(0, MAX_MESH_LABEL_LENGTH);
    this.meshError.set('');
    this.userBff.claimMeshDevice(nodeId, label || undefined).subscribe({
      next: () => {
        this.meshNodeId = '';
        this.meshLabel = '';
        this.status.set('Mesh device registered');
      },
      error: (e: unknown) => {
        this.meshError.set(e instanceof HttpErrorResponse && e.status === 409
          ? 'That node id is already registered.'
          : 'Could not register the device — check your connection and try again.');
      },
    });
  }

  /** Release one of my devices. Works on revoked rows too (the one action a
   *  revoked device keeps). */
  releaseMeshDevice(device: MeshDevice): void {
    this.meshError.set('');
    this.userBff.releaseMeshDevice(device.id).subscribe({
      next: () => this.status.set('Mesh device released'),
      error: () => this.meshError.set('Could not release the device — check your connection and try again.'),
    });
  }

  /** Change a device's visibility, OPTIMISTICALLY: the select reflects the
   *  choice immediately, and a failed PUT (400 invalid / 404 not mine /
   *  409-422 revoked / network) rolls the row back and surfaces a non-blocking
   *  note. A successful PUT refreshes the list, so the server's truth wins. */
  onMeshVisibilityChange(device: MeshDevice, ev: Event): void {
    const select = ev.target as HTMLSelectElement;
    const value = select.value;
    if (!isMeshDeviceVisibility(value) || value === device.visibility) return;
    const before = this.meshDevices();
    this.meshDevices.set(before.map((d) => (d.id === device.id ? { ...d, visibility: value } : d)));
    this.meshError.set('');
    this.userBff.setMeshDeviceVisibility(device.id, value).subscribe({
      next: () => this.status.set('Mesh device visibility updated'),
      error: () => {
        this.meshDevices.set(before);
        // Imperative, not just the signal write: the browser already applied the
        // rejected choice to the native <select> the moment the user picked it
        // (before this handler ran), and the rollback above lands in the SAME
        // synchronous tick as the optimistic write — Angular's [value] binding
        // only re-touches the DOM when its checked value differs from what CD
        // last recorded, which is still the pre-optimistic value here, so
        // without this line the dropdown would keep showing the failed choice
        // even though `meshDevices()` correctly reverted.
        select.value = device.visibility;
        this.meshError.set('Could not change the device visibility — try again.');
      },
    });
  }

  /** Visible row label: the user's label, else the bare node id. */
  meshDeviceName(device: MeshDevice): string {
    return device.label || device.nodeId;
  }

  /** Battery display: 101 is the API's "on external power" marker, 0..100 a
   *  percentage, null/absent renders nothing. */
  meshBatteryLabel(device: MeshDevice): string | null {
    if (device.batteryPct === null) return null;
    return device.batteryPct >= 101 ? 'powered' : `battery ${device.batteryPct}%`;
  }

  /** One compact, render-only status line per device ("last seen 5m ago ·
   *  battery 87% · SNR 6.5 dB · 2 hops · via lora-1"). Every part is optional
   *  and absent parts simply do not render — '' hides the line entirely. The
   *  values are RADIO-REPORTED (unauthenticated) telemetry. */
  meshStatusLine(device: MeshDevice): string {
    const parts: string[] = [];
    const seen = relativeTimeLabel(device.lastSeenAt);
    if (seen) parts.push(`last seen ${seen}`);
    const battery = this.meshBatteryLabel(device);
    if (battery) parts.push(battery);
    if (device.snr !== null) parts.push(`SNR ${device.snr} dB`);
    if (device.hopsAway !== null) parts.push(device.hopsAway === 0 ? 'direct' : `${device.hopsAway} hop${device.hopsAway === 1 ? '' : 's'}`);
    if (device.viaDevice) parts.push(`via ${device.viaDevice}`);
    return parts.join(' · ');
  }

  trackMeshDevice = (_: number, d: MeshDevice) => d.id;

  // ── Chat appearance ───────────────────────────────────────────────────────

  /** The config the controls edit: the saved theme, else the defaults (shown
   *  but NOT applied until the user actually changes something). */
  get themeCfg(): ChatThemeConfig {
    return this.chatTheme.theme() ?? defaultChatTheme();
  }

  /** True once the user has a theme saved/applied (drives aria-pressed). */
  get themeActive(): boolean {
    return this.chatTheme.theme() !== null;
  }

  /** Adopt a preset's colors while keeping the user's shape/font/density/
   *  background knobs (a preset is a palette, not a full reset). */
  selectPreset(id: ChatThemePreset): void {
    const cur = this.chatTheme.theme();
    const next = defaultChatTheme(id);
    if (cur) {
      next.bubbleShape = cur.bubbleShape;
      next.font = cur.font;
      next.density = cur.density;
      next.chatBackground = cur.chatBackground;
    }
    void this.saveTheme(next);
  }

  /** Patch + persist one field of the theme (select/change events). */
  updateTheme(patch: Partial<ChatThemeConfig>): void {
    void this.saveTheme({ ...this.themeCfg, ...patch });
  }

  /** Live-preview a color while its picker is still open (input events) —
   *  applies to the roots without hammering account data; the paired (change)
   *  handler persists the final value. */
  previewColor(field: 'accent' | 'bubbleMine' | 'bubbleTheirs', ev: Event): void {
    const value = (ev.target as HTMLInputElement).value;
    this.chatTheme.preview({ ...this.themeCfg, [field]: value });
  }

  /** Persist a color once the picker commits (change event). */
  commitColor(field: 'accent' | 'bubbleMine' | 'bubbleTheirs', ev: Event): void {
    const value = (ev.target as HTMLInputElement).value;
    this.updateTheme({ [field]: value });
  }

  async resetTheme(): Promise<void> {
    try {
      await this.chatTheme.reset();
      this.status.set('Chat appearance reset');
    } catch {
      this.status.set('Chat appearance reset (saved locally)');
    }
  }

  private async saveTheme(cfg: ChatThemeConfig): Promise<void> {
    try {
      await this.chatTheme.setTheme(cfg);
      this.status.set('Chat appearance saved');
    } catch {
      // setTheme is fail-soft internally; this is belt-and-braces.
      this.status.set('Chat appearance saved locally');
    }
  }
}
