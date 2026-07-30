import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { UserSettingsComponent, relativeTimeLabel } from './user-settings.component';
import { MatrixService } from './matrix.service';
import { MeshDevice, UserBffService } from './user-bff.service';
import { CHAT_THEME_ACCOUNT_DATA_TYPE, CHAT_THEME_STORAGE_KEY, ChatThemeService } from './theme/chat-theme.service';
import { expectDescribedByHelp } from './a11y-help.spec-util';

class MatrixServiceStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  getProfile = jasmine.createSpy('getProfile').and.resolveTo({ userId: '@me:test', displayName: 'Me' });
  setDisplayName = jasmine.createSpy('setDisplayName').and.resolveTo(undefined);
  setPresence = jasmine.createSpy('setPresence').and.resolveTo(undefined);
  // Presence PRELOAD (server truth): null = nothing saved, form keeps defaults.
  getPresence = jasmine.createSpy('getPresence').and.resolveTo(null);
  uploadMedia = jasmine.createSpy('uploadMedia').and.resolveTo({ contentUri: 'mxc://x', mxcUri: 'mxc://x' });
  setAvatarUrl = jasmine.createSpy('setAvatarUrl').and.resolveTo(undefined);
  // Chat-theme persistence (ChatThemeService).
  getAccountData = jasmine.createSpy('getAccountData').and.resolveTo(null);
  setAccountData = jasmine.createSpy('setAccountData').and.resolveTo(undefined);
}

/** A parsed MeshDevice fixture (post-parse shape: absent telemetry = null). */
function device(over: Partial<MeshDevice> = {}): MeshDevice {
  return {
    id: 'd1', nodeId: '!a1b2c3d4', label: 'Backpack radio', createdAt: '2026-07-16T00:00:00Z',
    visibility: 'private', state: 'active', revokeReason: null,
    lastSeenAt: null, batteryPct: null, snr: null, hopsAway: null, viaDevice: null,
    ...over,
  };
}

class UserBffStub {
  readonly meshSubject = new BehaviorSubject<MeshDevice[]>([]);
  meshDevices$ = this.meshSubject.asObservable();
  listMeshDevices = jasmine.createSpy('listMeshDevices').and.callFake(() => of(this.meshSubject.getValue()));
  claimMeshDevice = jasmine.createSpy('claimMeshDevice').and.returnValue(of(device()));
  releaseMeshDevice = jasmine.createSpy('releaseMeshDevice').and.returnValue(of(undefined));
  setMeshDeviceVisibility = jasmine.createSpy('setMeshDeviceVisibility').and.returnValue(of(undefined));
}

describe('UserSettingsComponent', () => {
  let fixture: ComponentFixture<UserSettingsComponent>;
  let component: UserSettingsComponent;
  let matrix: MatrixServiceStub;
  let userBff: UserBffStub;

  beforeEach(async () => {
    localStorage.clear(); // no leftover chat theme from other specs
    matrix = new MatrixServiceStub();
    userBff = new UserBffStub();
    await TestBed.configureTestingModule({
      imports: [UserSettingsComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: UserBffService, useValue: userBff },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(UserSettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('resolves the signed-in user and pre-fills the display name', () => {
    expect(component.userId()).toBe('@me:test');
    expect(component.displayName).toBe('Me');
  });

  it('labels every form control with an explicit <label for>', () => {
    const el = fixture.nativeElement;
    for (const id of [
      'us-display-name', 'us-avatar', 'us-presence', 'us-status-msg',
      'us-theme-accent', 'us-theme-bubble-mine', 'us-theme-bubble-theirs',
      'us-theme-shape', 'us-theme-font', 'us-theme-density', 'us-theme-chatbg',
    ]) {
      expect(el.querySelector(`#${id}`)).withContext(id).toBeTruthy();
      expect(el.querySelector(`label[for="${id}"]`)).withContext(`label ${id}`).toBeTruthy();
    }
  });

  it('saves a trimmed display name', async () => {
    component.displayName = '  New Name  ';
    await component.saveProfile();
    expect(matrix.setDisplayName).toHaveBeenCalledWith('@me:test', 'New Name');
  });

  it('updates presence with the chosen status', async () => {
    component.presence = 'unavailable';
    component.statusMsg = 'brb';
    await component.savePresence();
    expect(matrix.setPresence).toHaveBeenCalledWith('@me:test', 'unavailable', 'brb');
  });

  // Regression: the form used to always reset to Online, so opening settings
  // and clicking "Update presence" silently un-Away'd the user.
  it('PRELOADS the current server presence + status message instead of resetting to Online', async () => {
    matrix.getPresence.and.resolveTo({ presence: 'unavailable', statusMsg: 'in a meeting' });
    matrix.getPresence.calls.reset(); // ignore the beforeEach fixture's own preload call
    // Drive the lifecycle hook DIRECTLY and await its promise: whenStable()
    // can resolve between the ngOnInit chain's spy-promise hops (jasmine's
    // resolveTo promises are not reliably zone-tracked), which made the
    // fixture-based form of this spec race its own assertions.
    const f = TestBed.createComponent(UserSettingsComponent);
    await f.componentInstance.ngOnInit();
    expect(f.componentInstance.presence).toBe('unavailable');
    expect(f.componentInstance.statusMsg).toBe('in a meeting');
    expect(matrix.getPresence).toHaveBeenCalledWith('@me:test');
  });

  it('keeps the Online default when no server presence is readable (fail-soft null)', () => {
    expect(component.presence).toBe('online');
    expect(component.statusMsg).toBe('');
  });

  it('announces save results via an aria-live status region', async () => {
    await component.saveProfile();
    fixture.detectChanges();
    const status = fixture.nativeElement.querySelector('[data-testid="user-settings-status"]');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('saved');
  });

  // ───────── HELP TEXT ─────────
  it('wires every profile/presence control to present, descriptive help', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(expectDescribedByHelp(el, '#us-display-name')).toContain('other people see');
    expectDescribedByHelp(el, '[data-testid="btn-save-profile"]');
    expect(expectDescribedByHelp(el, '#us-avatar').toLowerCase()).toContain('profile picture');
    expect(expectDescribedByHelp(el, '#us-presence').toLowerCase()).toContain('availability');
    expect(expectDescribedByHelp(el, '#us-status-msg').toLowerCase()).toContain('note');
  });

  // ───────── CHAT APPEARANCE ─────────

  it('renders the Chat appearance section: 5 preset swatches, pickers, selects, preview, reset', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="chat-appearance"]')).toBeTruthy();
    for (const id of ['element-dark', 'pastel', 'neon', 'paper', 'midnight-vn']) {
      expect(el.querySelector(`[data-testid="theme-preset-${id}"]`)).withContext(id).toBeTruthy();
    }
    expect(el.querySelectorAll('input[type="color"]').length).toBe(3);
    expect(el.querySelector('[data-testid="theme-preview"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="preview-bubble-mine"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="preview-bubble-theirs"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="btn-theme-reset"]')).toBeTruthy();
  });

  it('wires every chat-appearance control to present, descriptive help', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(expectDescribedByHelp(el, '#us-theme-accent').toLowerCase()).toContain('accent');
    expect(expectDescribedByHelp(el, '#us-theme-shape').toLowerCase()).toContain('bubble');
    expect(expectDescribedByHelp(el, '#us-theme-font').toLowerCase()).toContain('typeface');
    expect(expectDescribedByHelp(el, '#us-theme-density').toLowerCase()).toContain('spacing');
    expect(expectDescribedByHelp(el, '#us-theme-chatbg').toLowerCase()).toContain('pattern');
    expectDescribedByHelp(el, '[data-testid="btn-theme-reset"]');
  });

  it('clicking a preset swatch applies + persists that theme to account data', async () => {
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="theme-preset-pastel"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    const service = TestBed.inject(ChatThemeService);
    expect(service.theme()?.preset).toBe('pastel');
    expect(matrix.setAccountData).toHaveBeenCalledWith(
      '@me:test', CHAT_THEME_ACCOUNT_DATA_TYPE, jasmine.objectContaining({ preset: 'pastel' }));
    expect(JSON.parse(localStorage.getItem(CHAT_THEME_STORAGE_KEY)!).preset).toBe('pastel');
    const swatch = el.querySelector('[data-testid="theme-preset-pastel"]')!;
    expect(swatch.getAttribute('aria-pressed')).toBe('true');
  });

  it('applies the theme attributes to the COMPONENT HOST (a remote root), and preview reflects it', async () => {
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="theme-preset-neon"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    // The host element registered by the ChatThemeRootDirective hostDirective.
    expect(el.getAttribute('data-matrix-theme')).toBe('neon');
    expect(el.getAttribute('data-matrix-bubbles')).toBe('rounded');
    expect(el.style.getPropertyValue('--hugm-chat-accent')).toBe('#ffd700');
  });

  it('LEAK TEST: theming never lands on <body> — only on the remote root host', async () => {
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="theme-preset-neon"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.hasAttribute('data-matrix-theme')).toBeTrue();
    expect(document.body.hasAttribute('data-matrix-theme')).toBeFalse();
    expect(document.documentElement.hasAttribute('data-matrix-theme')).toBeFalse();
    expect(document.body.style.getPropertyValue('--hugm-chat-accent')).toBe('');
  });

  it('changing a select persists the patched field (bubble shape)', async () => {
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="theme-preset-paper"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    component.updateTheme({ bubbleShape: 'minimal' });
    await fixture.whenStable();
    const service = TestBed.inject(ChatThemeService);
    expect(service.theme()?.bubbleShape).toBe('minimal');
    expect(service.theme()?.preset).toBe('paper'); // rest of the theme kept
    expect(el.getAttribute('data-matrix-bubbles')).toBe('minimal');
  });

  it('Reset returns the host to the stock look and writes the {} reset marker', async () => {
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="theme-preset-pastel"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.hasAttribute('data-matrix-theme')).toBeTrue();

    (el.querySelector('[data-testid="btn-theme-reset"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    const service = TestBed.inject(ChatThemeService);
    expect(service.theme()).toBeNull();
    expect(el.hasAttribute('data-matrix-theme')).toBeFalse();
    expect(localStorage.getItem(CHAT_THEME_STORAGE_KEY)).toBeNull();
    expect(matrix.setAccountData).toHaveBeenCalledWith('@me:test', CHAT_THEME_ACCOUNT_DATA_TYPE, {});
  });

  // ───────── MESH DEVICES ─────────

  describe('relativeTimeLabel (mesh last-seen formatting)', () => {
    const NOW = Date.parse('2026-07-16T12:00:00Z');

    it('renders coarse relative ages: just now / minutes / hours / days', () => {
      expect(relativeTimeLabel('2026-07-16T11:59:30Z', NOW)).toBe('just now');
      expect(relativeTimeLabel('2026-07-16T11:55:00Z', NOW)).toBe('5m ago');
      expect(relativeTimeLabel('2026-07-16T09:00:00Z', NOW)).toBe('3h ago');
      expect(relativeTimeLabel('2026-07-14T12:00:00Z', NOW)).toBe('2d ago');
    });

    it('FAIL-SOFT: null/malformed timestamps render nothing; a future one reads "just now" (clock skew)', () => {
      expect(relativeTimeLabel(null, NOW)).toBeNull();
      expect(relativeTimeLabel(undefined, NOW)).toBeNull();
      expect(relativeTimeLabel('not a date', NOW)).toBeNull();
      expect(relativeTimeLabel('2026-07-16T13:00:00Z', NOW)).toBe('just now');
    });
  });

  describe('Mesh devices section', () => {
    it('explains the claim (under your name) and the unauthenticated-node-id caution', () => {
      const help = fixture.nativeElement.querySelector('[data-testid="us-mesh-help"]');
      expect(help.textContent).toContain('under your name');
      expect(help.textContent.toLowerCase()).toContain('not cryptographically authenticated');
    });

    it('labels the claim inputs and wires the claim/release/visibility controls to present help', () => {
      const el = fixture.nativeElement as HTMLElement;
      for (const id of ['us-mesh-node', 'us-mesh-label']) {
        expect(el.querySelector(`#${id}`)).withContext(id).toBeTruthy();
        expect(el.querySelector(`label[for="${id}"]`)).withContext(`label ${id}`).toBeTruthy();
      }
      expect(expectDescribedByHelp(el, '#us-mesh-node').toLowerCase()).toContain('node id');
      expect(expectDescribedByHelp(el, '#us-mesh-label').toLowerCase()).toContain('name for this radio');
      expect(expectDescribedByHelp(el, '[data-testid="btn-mesh-claim"]').toLowerCase()).toContain('your name');
    });

    it('lists registered devices with label + node id (label falls back to the node id)', () => {
      userBff.meshSubject.next([device(), device({ id: 'd2', nodeId: '!deadbeef', label: null })]);
      fixture.detectChanges();
      const el = fixture.nativeElement;
      const row1 = el.querySelector('[data-testid="mesh-device-d1"]');
      expect(row1.textContent).toContain('Backpack radio');
      expect(row1.textContent).toContain('!a1b2c3d4');
      const row2 = el.querySelector('[data-testid="mesh-device-d2"]');
      expect(row2.querySelector('.mesh-label').textContent.trim()).toBe('!deadbeef');
      expect(el.querySelector('[data-testid="mesh-device-empty"]')).toBeNull();
    });

    it('shows the empty note when nothing is registered', () => {
      expect(fixture.nativeElement.querySelector('[data-testid="mesh-device-empty"]')).toBeTruthy();
    });

    // ── claim ──
    it('CLAIM normalizes the typed node id ("!A1B2C3D4" → "!a1b2c3d4"), passes the trimmed label and clears the form', () => {
      component.meshNodeId = '!A1B2C3D4';
      component.meshLabel = '  Backpack radio  ';
      component.claimMeshDevice();
      expect(userBff.claimMeshDevice).toHaveBeenCalledWith('!a1b2c3d4', 'Backpack radio');
      expect(component.meshNodeId).toBe('');
      expect(component.meshLabel).toBe('');
      expect(component.status()).toContain('registered');
    });

    it('CLAIM accepts the bare form too, omitting an empty label', () => {
      component.meshNodeId = 'deadBEEF';
      component.claimMeshDevice();
      expect(userBff.claimMeshDevice).toHaveBeenCalledWith('!deadbeef', undefined);
    });

    it('REFUSES a non-node-id input client-side (no wire call) with a WHY note', () => {
      component.meshNodeId = 'xyz';
      component.claimMeshDevice();
      expect(userBff.claimMeshDevice).not.toHaveBeenCalled();
      expect(component.meshError()).toContain('8 hex digits');
    });

    it('409 (node id already claimed) surfaces the specific error as a polite status note', () => {
      userBff.claimMeshDevice.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 409, statusText: 'Conflict' })));
      component.meshNodeId = 'a1b2c3d4';
      component.claimMeshDevice();
      fixture.detectChanges();
      expect(component.meshError()).toBe('That node id is already registered.');
      const note = fixture.nativeElement.querySelector('[data-testid="mesh-error"]');
      expect(note.getAttribute('role')).toBe('status');
      expect(note.getAttribute('aria-live')).toBe('polite');
      expect(note.textContent).toContain('already registered');
    });

    it('a NETWORK failure claims a generic, non-blocking note (never the 409 copy)', () => {
      userBff.claimMeshDevice.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Network' })));
      component.meshNodeId = 'a1b2c3d4';
      component.claimMeshDevice();
      expect(component.meshError()).toContain('check your connection');
    });

    // ── release ──
    it('RELEASE calls the service for the row\'s id', () => {
      userBff.meshSubject.next([device()]);
      fixture.detectChanges();
      (fixture.nativeElement.querySelector('[data-testid="btn-mesh-release-d1"]') as HTMLButtonElement).click();
      expect(userBff.releaseMeshDevice).toHaveBeenCalledWith('d1');
    });

    it('a failed release surfaces a non-blocking note', () => {
      userBff.releaseMeshDevice.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 500, statusText: 'Boom' })));
      component.releaseMeshDevice(device());
      expect(component.meshError()).toContain('Could not release');
    });

    it('FAIL-SOFT list load: a dead endpoint leaves a note without blocking the profile sections', async () => {
      userBff.listMeshDevices.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Network' })));
      fixture = TestBed.createComponent(UserSettingsComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.meshError()).toContain('unavailable');
      expect(component.userId()).toBe('@me:test'); // profile still loaded
    });

    // ── visibility ──
    it('VISIBILITY change is optimistic and calls the PUT', () => {
      userBff.meshSubject.next([device({ visibility: 'private' })]);
      fixture.detectChanges();
      const sel: HTMLSelectElement = fixture.nativeElement.querySelector('[data-testid="select-mesh-visibility-d1"]');
      expect(sel.value).toBe('private');
      sel.value = 'friends';
      sel.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(userBff.setMeshDeviceVisibility).toHaveBeenCalledWith('d1', 'friends');
      // Optimistic: the row reflects the choice before any refresh lands.
      expect(component.meshDevices()[0].visibility).toBe('friends');
    });

    it('a FAILED visibility change rolls the row back and leaves a non-blocking note', () => {
      userBff.setMeshDeviceVisibility.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 422, statusText: 'Unprocessable Entity' })));
      userBff.meshSubject.next([device({ visibility: 'private' })]);
      fixture.detectChanges();
      const sel: HTMLSelectElement = fixture.nativeElement.querySelector('[data-testid="select-mesh-visibility-d1"]');
      sel.value = 'channels';
      sel.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(component.meshDevices()[0].visibility).toBe('private'); // rolled back
      expect(component.meshError()).toContain('visibility');
      expect(sel.value).toBe('private'); // the select re-renders the rollback
    });

    // ── revoked ──
    it('a REVOKED device renders clearly flagged (with the reason), visibility frozen, release still offered', () => {
      userBff.meshSubject.next([device({ state: 'revoked', revokeReason: 'abuse report' })]);
      fixture.detectChanges();
      const el = fixture.nativeElement;
      const flag = el.querySelector('[data-testid="mesh-revoked-d1"]');
      expect(flag).toBeTruthy();
      expect(flag.textContent).toContain('Revoked');
      expect(flag.textContent).toContain('abuse report');
      expect(el.querySelector('[data-testid="select-mesh-visibility-d1"]').disabled).toBeTrue();
      expect(el.querySelector('[data-testid="btn-mesh-release-d1"]').disabled).toBeFalse();
    });

    it('a revoked device WITHOUT a reason renders the bare flag', () => {
      userBff.meshSubject.next([device({ state: 'revoked' })]);
      fixture.detectChanges();
      const flag = fixture.nativeElement.querySelector('[data-testid="mesh-revoked-d1"]');
      expect(flag.textContent.trim()).toBe('Revoked');
    });

    // ── status telemetry (render-only, fail-soft) ──
    it('renders the radio-reported status line: last seen, battery, SNR, hops, via', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      userBff.meshSubject.next([device({ lastSeenAt: fiveMinAgo, batteryPct: 87, snr: 6.5, hopsAway: 2, viaDevice: 'lora-1' })]);
      fixture.detectChanges();
      const line = fixture.nativeElement.querySelector('[data-testid="mesh-status-d1"]');
      expect(line.textContent).toContain('last seen 5m ago');
      expect(line.textContent).toContain('battery 87%');
      expect(line.textContent).toContain('SNR 6.5 dB');
      expect(line.textContent).toContain('2 hops');
      expect(line.textContent).toContain('via lora-1');
    });

    it('renders battery 101 as "powered" and 0 hops as "direct"', () => {
      userBff.meshSubject.next([device({ batteryPct: 101, hopsAway: 0 })]);
      fixture.detectChanges();
      const line = fixture.nativeElement.querySelector('[data-testid="mesh-status-d1"]');
      expect(line.textContent).toContain('powered');
      expect(line.textContent).not.toContain('101');
      expect(line.textContent).toContain('direct');
    });

    it('renders NO status line when every telemetry field is absent (fail-soft, no dangling separators)', () => {
      userBff.meshSubject.next([device()]);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="mesh-status-d1"]')).toBeNull();
    });
  });
});
