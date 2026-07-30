import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ComposerComponent } from './composer.component';
import { MatrixService } from './matrix.service';
import { SessionService, HugSession } from './session.service';
import { CharacterPackService } from './vn/character-pack.service';

/** Build a HugSession fixture carrying the given roles (drives the domain-lock
 *  marker the composer reads). */
function sessionWith(roles: string[]): HugSession {
  return {
    id: 'google:alice@gmail.com', label: 'alice', provider: 'google', roles,
    registrationComplete: true,
  };
}

class MatrixServiceStub {
  sendMessage = jasmine.createSpy('sendMessage').and.resolveTo('$sent');
  sendReply = jasmine.createSpy('sendReply').and.resolveTo('$reply');
  editMessage = jasmine.createSpy('editMessage').and.resolveTo('$edit');
  setTyping = jasmine.createSpy('setTyping').and.resolveTo(undefined);
  sendImage = jasmine.createSpy('sendImage').and.resolveTo('$image');
  sendFile = jasmine.createSpy('sendFile').and.resolveTo('$file');
  uploadMedia = jasmine.createSpy('uploadMedia').and.resolveTo({ contentUri: 'mxc://raw', mxcUri: 'mxc://raw' });
  uploadMediaProtected = jasmine.createSpy('uploadMediaProtected').and.resolveTo({
    contentUri: 'mxc://cloaked', mxcUri: 'mxc://cloaked',
    decision: { mxcUri: 'mxc://cloaked', mode: 'cloak', status: 'cloaked' },
  });
  cloakCapability = jasmine.createSpy('cloakCapability').and.resolveTo({ backend: 'cuda', available: true, expectedSeconds: 90 });
  cloakStatus = jasmine.createSpy('cloakStatus').and.resolveTo({ mxcUri: 'mxc://cloaked', mode: 'cloak', status: 'cloaked' });
  // Used by the embedded sticker picker (mounted only when the picker is open).
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('blob:sticker');
  sendEvent = jasmine.createSpy('sendEvent').and.resolveTo('$sticker');
}

/** A CharacterPackService stub for the embedded sticker picker — no pack by
 *  default so the picker mounts into its empty state without homeserver reads. */
class PackStub {
  resolveCharacterPack = jasmine.createSpy('resolveCharacterPack').and.resolveTo(null);
  imageFor = () => null;
  invalidate = () => undefined;
}

/** A synthetic image File. The component derives dims via an <img> load which
 *  never fires in the test DOM, so the .catch path supplies undefined dims —
 *  exactly the production fallback. */
function imageFile(name = 'pic.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

function fileInputEvent(file: File): Event {
  const input = document.createElement('input');
  Object.defineProperty(input, 'files', { value: [file] });
  return { target: input } as unknown as Event;
}

describe('ComposerComponent', () => {
  let fixture: ComponentFixture<ComposerComponent>;
  let component: ComposerComponent;
  let matrix: MatrixServiceStub;

  beforeEach(async () => {
    localStorage.clear(); // default to a logged-out / un-locked session
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [ComposerComponent],
      providers: [
        { provide: MatrixService, useValue: matrix },
        { provide: CharacterPackService, useValue: new PackStub() },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ComposerComponent);
    component = fixture.componentInstance;
    component.roomId = '!r:test';
    fixture.detectChanges();
    await fixture.whenStable(); // let the ngOnInit capability probe resolve
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('labels the message input with a <label for> tied to its id', () => {
    const input: HTMLInputElement = fixture.nativeElement.querySelector('[data-testid="matrix-input"]');
    const label: HTMLLabelElement | null = fixture.nativeElement.querySelector('label[for="composer-input"]');
    expect(input.id).toBe('composer-input');
    expect(label).toBeTruthy();
  });

  it('gives the icon-only emoji/attach buttons an accessible name via aria-label', () => {
    const emoji = fixture.nativeElement.querySelector('[data-testid="btn-emoji"]');
    const attach = fixture.nativeElement.querySelector('[data-testid="btn-attach"]');
    expect(emoji.getAttribute('aria-label')).toBe('Add emoji');
    expect(attach.getAttribute('aria-label')).toBe('Attach a file');
    // The decorative glyphs are hidden from assistive tech.
    expect(emoji.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('hides the file input from the accessibility tree and the tab order', () => {
    const file = fixture.nativeElement.querySelector('[data-testid="input-file"]');
    expect(file.getAttribute('aria-hidden')).toBe('true');
    expect(file.getAttribute('tabindex')).toBe('-1');
  });

  it('sends an m.text message and clears the draft on send', async () => {
    component.draft = 'hello world';
    await component.send();
    expect(matrix.sendMessage).toHaveBeenCalledWith('!r:test', { msgtype: 'm.text', body: 'hello world' });
    expect(component.draft).toBe('');
  });

  it('does not send a blank/whitespace-only draft', async () => {
    component.draft = '   ';
    await component.send();
    expect(matrix.sendMessage).not.toHaveBeenCalled();
  });

  it('ANNOUNCES a rejected send in the aria-live status region and keeps the draft (banned/denied sender)', async () => {
    matrix.sendMessage.and.rejectWith(new Error('sendMessage failed: 403'));
    component.draft = 'i am banned';
    await component.send();
    fixture.detectChanges();
    const status = fixture.nativeElement.querySelector('[data-testid="composer-status"]');
    expect(status).toBeTruthy();
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('Send failed');
    expect(status.textContent).toContain('403');
    // The draft survives a failed send so the user can retry / copy it out.
    expect(component.draft).toBe('i am banned');
    expect(component.busy()).toBeFalse();
  });

  it('routes to sendReply when in reply mode', async () => {
    component.mode = signal('reply');
    component.target = { eventId: '$orig' } as any;
    component.draft = 'a reply';
    await component.send();
    expect(matrix.sendReply).toHaveBeenCalledWith('!r:test', 'a reply', '$orig');
  });

  it('exposes the upload status as an aria-live status region', () => {
    component.status.set('Uploading file…');
    fixture.detectChanges();
    const status = fixture.nativeElement.querySelector('[data-testid="composer-status"]');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Uploading');
  });

  it('switches the placeholder/label text per composer mode', () => {
    expect(component.placeholder).toBe('Send a message…');
    component.mode = signal('edit');
    expect(component.placeholder).toBe('Edit message…');
  });

  // ─────────────────────────── AI-cloak toggle ───────────────────────────

  it('defaults the AI-cloak shield ON with an honest aria-pressed control (never "protected")', () => {
    expect(component.poisonImages()).toBeTrue();
    const toggle = fixture.nativeElement.querySelector('[data-testid="composer-poison-toggle"]');
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('AI-cloak: on');
    // Honest copy: no "protected"/"safe" promise anywhere on the control.
    expect((toggle.textContent || '').toLowerCase()).not.toContain('protected');
  });

  it('togglePoison flips the shield and the aria-pressed state', () => {
    component.togglePoison();
    fixture.detectChanges();
    expect(component.poisonImages()).toBeFalse();
    const toggle = fixture.nativeElement.querySelector('[data-testid="composer-poison-toggle"]');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('AI-cloak: off');
  });

  it('renders the shield as Unavailable + disabled when the heavy tier is absent', async () => {
    matrix.cloakCapability.and.resolveTo({ backend: 'none', available: false });
    const f = TestBed.createComponent(ComposerComponent);
    f.componentInstance.roomId = '!r:test';
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    const toggle = f.nativeElement.querySelector('[data-testid="composer-poison-toggle"]');
    expect(toggle.getAttribute('aria-label')).toBe('AI-cloak: Unavailable');
    expect(toggle.disabled).toBeTrue();
  });

  // ─────────────────────── Reroute upload through the BFF proxy ───────────────────────

  it('routes an image through the AI-cloak BFF proxy when the shield is ON (poison-before-ingest), not the homeserver upload', async () => {
    await component.onFile(fileInputEvent(imageFile()));
    expect(matrix.uploadMediaProtected).toHaveBeenCalledWith(jasmine.any(File), 'cloak', '!r:test');
    expect(matrix.uploadMedia).not.toHaveBeenCalled();
  });

  it('forwards through the BFF in mode=none (honest "skipped" decision) when the shield is OFF for an image', async () => {
    component.togglePoison(); // now OFF
    await component.onFile(fileInputEvent(imageFile()));
    expect(matrix.uploadMediaProtected).toHaveBeenCalledWith(jasmine.any(File), 'none', '!r:test');
  });

  it('DECOUPLES upload from send: onFile uploads but does NOT emit the m.image event', async () => {
    await component.onFile(fileInputEvent(imageFile()));
    expect(matrix.uploadMediaProtected).toHaveBeenCalled();
    expect(matrix.sendImage).not.toHaveBeenCalled(); // held as a pending attachment
    expect(component.pending()).toBeTruthy();
    expect(component.pending()!.mxcUri).toBe('mxc://cloaked');
  });

  it('emits the m.image event only on an explicit sendAttachment, then clears the pending tile', async () => {
    await component.onFile(fileInputEvent(imageFile()));
    await component.sendAttachment();
    expect(matrix.sendImage).toHaveBeenCalledWith('!r:test', 'mxc://cloaked', jasmine.any(File), jasmine.objectContaining({ mimetype: 'image/png' }));
    expect(component.pending()).toBeNull();
  });

  // ─────────────────────────── Badge + progress + escape hatch ───────────────────────────

  it('renders the honest cloak badge from the server decision (AI-cloak applied, never "protected")', async () => {
    await component.onFile(fileInputEvent(imageFile()));
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('[data-testid="cloak-badge"]');
    expect(badge.textContent.trim()).toBe('AI-cloak applied');
    expect(badge.getAttribute('aria-live')).toBe('polite');
    expect(badge.textContent.toLowerCase()).not.toContain('protected');
  });

  it('renders a degraded badge when the round-trip survival gate fails server-side', async () => {
    matrix.uploadMediaProtected.and.resolveTo({
      contentUri: 'mxc://c', mxcUri: 'mxc://c',
      decision: { mxcUri: 'mxc://c', mode: 'cloak', status: 'degraded' },
    });
    await component.onFile(fileInputEvent(imageFile()));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="cloak-badge"]').textContent.trim()).toBe('Protection degraded');
  });

  it('shows the protecting progress + a "post now without protection" escape hatch while pending, and posts on click', async () => {
    matrix.uploadMediaProtected.and.resolveTo({
      contentUri: 'mxc://c', mxcUri: 'mxc://c',
      decision: { mxcUri: 'mxc://c', mode: 'cloak', status: 'pending' },
    });
    await component.onFile(fileInputEvent(imageFile()));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="cloak-progress"]')).toBeTruthy();
    const postNow = fixture.nativeElement.querySelector('[data-testid="btn-post-now"]');
    expect(postNow.textContent).toContain('Post now without protection');
    postNow.click();
    await fixture.whenStable();
    expect(matrix.sendImage).toHaveBeenCalled();
  });

  it('discardAttachment drops the pending tile without sending it', async () => {
    await component.onFile(fileInputEvent(imageFile()));
    component.discardAttachment();
    expect(component.pending()).toBeNull();
    expect(matrix.sendImage).not.toHaveBeenCalled();
  });

  // ───────── USER-SITUATIONAL: AI-poison opt-out (default-ON, per-post) ─────────
  describe('USER-SITUATIONAL — AI-poison opt-out toggle', () => {
    it('DEFAULTS the per-post protection ON (poison images by default)', () => {
      expect(component.poisonImages()).toBeTrue();
      // The default-on shield resolves an uploaded image to the cloak path.
      const toggle = fixture.nativeElement.querySelector('[data-testid="composer-poison-toggle"]');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
    });

    it('exposes an OPT-OUT helptext ("don\'t protect this image from AI") wired via aria-describedby', () => {
      const toggle = fixture.nativeElement.querySelector('[data-testid="composer-poison-toggle"]');
      const helpId = toggle.getAttribute('aria-describedby');
      expect(helpId).toBe('composer-poison-help');
      const help = fixture.nativeElement.querySelector('#composer-poison-help');
      expect(help).toBeTruthy();
      // Default-ON copy invites the opt-out explicitly.
      expect((help.textContent || '').toLowerCase()).toContain('not protect this image from ai');
    });

    it('opting OUT flips the toggle + sends mode=none with the upload (the server records the skip)', async () => {
      // Opt out via the public toggle.
      component.togglePoison();
      fixture.detectChanges();
      expect(component.poisonImages()).toBeFalse();
      const help = fixture.nativeElement.querySelector('#composer-poison-help');
      expect((help.textContent || '').toLowerCase()).toContain('will not be protected from ai');

      // The opt-out intent travels with the upload as mode=none (still via the
      // BFF proxy so the decision is server-owned, not a UI-only convention).
      await component.onFile(fileInputEvent(imageFile()));
      expect(matrix.uploadMediaProtected).toHaveBeenCalledWith(jasmine.any(File), 'none', '!r:test');
    });

    it('opting back IN re-protects: default-on intent (mode=cloak) returns', async () => {
      component.togglePoison(); // off
      component.togglePoison(); // on again
      expect(component.poisonImages()).toBeTrue();
      await component.onFile(fileInputEvent(imageFile()));
      expect(matrix.uploadMediaProtected).toHaveBeenCalledWith(jasmine.any(File), 'cloak', '!r:test');
    });
  });

  // ───────── USER-SITUATIONAL: local-only / domain-lock (disabled + helptext) ─────────
  describe('USER-SITUATIONAL — local-only control is ALWAYS disabled+helptext', () => {
    it('renders the local-only control as aria-disabled (NOT native disabled) so it stays discoverable', () => {
      const toggle = fixture.nativeElement.querySelector('[data-testid="composer-local-only-toggle"]');
      expect(toggle).toBeTruthy();
      // aria-disabled, not native disabled — the helptext must remain readable.
      expect(toggle.getAttribute('aria-disabled')).toBe('true');
      expect(toggle.disabled).toBeFalse();
    });

    it('always wires WHY-helptext via aria-describedby (never a bare disabled control)', () => {
      const toggle = fixture.nativeElement.querySelector('[data-testid="composer-local-only-toggle"]');
      expect(toggle.getAttribute('aria-describedby')).toBe('composer-local-only-help');
      expect(fixture.nativeElement.querySelector('#composer-local-only-help')).toBeTruthy();
    });

    it('does NOT mutate any federation flag when clicked (the control is inert)', () => {
      const toggle = fixture.nativeElement.querySelector('[data-testid="composer-local-only-toggle"]');
      const before = component.localOnly();
      toggle.click();
      fixture.detectChanges();
      // localOnly is derived from the lock, never from the click.
      expect(component.localOnly()).toBe(before);
    });
  });

  // ───────── USER-SITUATIONAL: NOT domain-locked → inert/off room-level note ─────────
  describe('USER-SITUATIONAL — un-locked caller: local-only reads OFF + room-level helptext', () => {
    it('reads OFF (aria-pressed false, "unavailable" label) when the caller is not domain-locked', () => {
      expect(component.domainLocked()).toBeFalse();
      expect(component.localOnly()).toBeFalse();
      const toggle = fixture.nativeElement.querySelector('[data-testid="composer-local-only-toggle"]');
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(toggle.getAttribute('aria-label')).toBe('Local-only: unavailable');
      expect(toggle.classList.contains('is-locked')).toBeFalse();
    });

    it('helptext explains it is a room-level (not per-post) setting with enforcement pending', () => {
      const help = fixture.nativeElement.querySelector('#composer-local-only-help');
      const text = (help.textContent || '').toLowerCase();
      expect(text).toContain('room');             // room-level, not per-post
      expect(text).toContain('not available yet'); // account-level enforcement pending
      // No assertive announcement when nothing is being enforced.
      expect(help.getAttribute('role')).toBeNull();
    });
  });

  // ───────── USER-SITUATIONAL: DOMAIN-LOCKED → SOCIAL LOCAL-ONLY enforced ─────────
  describe('USER-SITUATIONAL — domain-locked caller: SOCIAL LOCAL-ONLY is forced ON', () => {
    let lockedFixture: ComponentFixture<ComposerComponent>;
    let locked: ComposerComponent;

    beforeEach(async () => {
      // A domain-locked session carries the lowercase marker the bff folds into roles[].
      TestBed.inject(SessionService).set(sessionWith(['user', 'matrix_domainlocked']));
      lockedFixture = TestBed.createComponent(ComposerComponent);
      locked = lockedFixture.componentInstance;
      locked.roomId = '!r:test';
      lockedFixture.detectChanges();
      await lockedFixture.whenStable();
      lockedFixture.detectChanges();
    });

    it('reads the domain lock off the session marker', () => {
      expect(locked.domainLocked()).toBeTrue();
    });

    it('FORCES local-only ON (aria-pressed true, enforced label) — non-interactive', () => {
      expect(locked.localOnly()).toBeTrue();
      const toggle = lockedFixture.nativeElement.querySelector('[data-testid="composer-local-only-toggle"]');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(toggle.getAttribute('aria-disabled')).toBe('true'); // still never freely toggleable
      expect(toggle.getAttribute('aria-label')).toContain('on');
      expect(toggle.classList.contains('is-locked')).toBeTrue();
    });

    it('explains the domain lock via aria-describedby helptext announced as a status', () => {
      const toggle = lockedFixture.nativeElement.querySelector('[data-testid="composer-local-only-toggle"]');
      expect(toggle.getAttribute('aria-describedby')).toBe('composer-local-only-help');
      const help = lockedFixture.nativeElement.querySelector('#composer-local-only-help');
      const text = (help.textContent || '').toLowerCase();
      expect(text).toContain('domain-locked');
      expect(text).toContain('cross-domain'); // federation targets unavailable
      expect(text).toContain('local chat is unaffected'); // local interaction stays usable
      // Announced when present so SR users hear the restriction.
      expect(help.getAttribute('role')).toBe('status');
      expect(help.getAttribute('aria-live')).toBe('polite');
    });

    it('keeps LOCAL sending fully usable (the lock greys federation, never the Send button)', async () => {
      const send = lockedFixture.nativeElement.querySelector('[data-testid="matrix-send"]');
      expect(send.disabled).toBeFalse();
      locked.draft = 'hello locally';
      await locked.send();
      expect(matrix.sendMessage).toHaveBeenCalledWith('!r:test', { msgtype: 'm.text', body: 'hello locally' });
    });

    it('does not flip local-only on click (it is derived from the lock, not the user)', () => {
      const toggle = lockedFixture.nativeElement.querySelector('[data-testid="composer-local-only-toggle"]');
      toggle.click();
      lockedFixture.detectChanges();
      expect(locked.localOnly()).toBeTrue(); // stays enforced
    });
  });

  // ─────────────────────────── VN sticker picker wiring ───────────────────────────

  describe('VN sticker picker toggle', () => {
    function stickerBtn(): HTMLButtonElement {
      return fixture.nativeElement.querySelector('[data-testid="btn-sticker"]');
    }
    function picker(): HTMLElement | null {
      return fixture.nativeElement.querySelector('[data-testid="composer-sticker-picker"]');
    }

    it('renders an accessible sticker toggle button (aria-label + haspopup)', () => {
      const btn = stickerBtn();
      expect(btn).toBeTruthy();
      expect(btn.getAttribute('aria-label')).toBe('Send a sticker');
      expect(btn.getAttribute('aria-haspopup')).toBe('menu');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      // The picker is closed by default (no async-state flicker on the button).
      expect(picker()).toBeNull();
    });

    it('toggle OPENS then CLOSES the picker, reflecting aria-expanded', () => {
      stickerBtn().click();
      fixture.detectChanges();
      expect(component.stickerPickerOpen()).toBeTrue();
      expect(stickerBtn().getAttribute('aria-expanded')).toBe('true');
      expect(picker()).toBeTruthy();

      stickerBtn().click();
      fixture.detectChanges();
      expect(component.stickerPickerOpen()).toBeFalse();
      expect(picker()).toBeNull();
    });

    it('does not open the picker when there is no active room', () => {
      component.roomId = '';
      fixture.detectChanges();
      component.toggleStickerPicker();
      fixture.detectChanges();
      expect(component.stickerPickerOpen()).toBeFalse();
    });

    it('onStickerSent forwards the event to the host (sent) and closes the picker', () => {
      const sent = jasmine.createSpy('sent');
      component.sent.subscribe(sent);
      component.stickerPickerOpen.set(true);
      component.onStickerSent('$sticker-1');
      expect(sent).toHaveBeenCalledWith('$sticker-1');
      expect(component.stickerPickerOpen()).toBeFalse();
    });

    it('dismiss closes the picker without emitting sent', () => {
      const sent = jasmine.createSpy('sent');
      component.sent.subscribe(sent);
      component.stickerPickerOpen.set(true);
      component.closeStickerPicker();
      expect(component.stickerPickerOpen()).toBeFalse();
      expect(sent).not.toHaveBeenCalled();
    });

    it('keeps the existing text send untouched while the picker is wired in', async () => {
      component.draft = 'still works';
      await component.send();
      expect(matrix.sendMessage).toHaveBeenCalledWith('!r:test', { msgtype: 'm.text', body: 'still works' });
    });
  });
});
