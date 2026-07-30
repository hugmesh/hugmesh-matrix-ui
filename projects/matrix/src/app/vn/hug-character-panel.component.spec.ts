import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { HugCharacterPanelComponent } from './hug-character-panel.component';
import { CharacterPackService, UserEmotesPack } from './character-pack.service';
import { SvgRigService } from './services/svg-rig.service';
import { MatrixService } from '../matrix.service';
import { VnCharacter } from './models/vn-character';
import { PartManifest } from './models/vn-manifest';
import { VoicePlaybackService, SpeakSession } from './voice/voice-playback.service';
import { CharacterCaptureService } from './voice/character-capture.service';

const PACK: UserEmotesPack = {
  pack: { display_name: 'Aria' },
  images: {
    neutral: { url: 'mxc://snap/neu' },
    happy: { url: 'mxc://snap/hap' },
  },
};

class MatrixStub {
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl')
    .and.callFake((mxc: string) => Promise.resolve(`blob:${mxc}`));
}

/**
 * A fake {@link SpeakSession}: a writable openness + speaking signal a test can
 * drive, and a `stop()` that flips speaking off (mirroring real teardown).
 */
class FakeSession implements SpeakSession {
  readonly openness: WritableSignal<number> = signal(0);
  readonly speaking: WritableSignal<boolean> = signal(true);
  readonly stopped = jasmine.createSpy('stop').and.callFake(() => {
    this.speaking.set(false);
    this.openness.set(0);
  });
  stop(): void {
    this.stopped();
  }
}

/**
 * A stub {@link VoicePlaybackService}: `enabled` toggles the dark flag; `speak`
 * returns the next queued session (default a fresh {@link FakeSession}) or null.
 */
class VoiceStub {
  enabled = false;
  session: FakeSession | null = new FakeSession();
  isEnabled = jasmine.createSpy('isEnabled').and.callFake(() => this.enabled);
  speak = jasmine.createSpy('speak').and.callFake(() => Promise.resolve(this.session as SpeakSession | null));
}

/**
 * A stub {@link CharacterCaptureService}: `enabled` toggles the (same) dark flag;
 * `recordAndSend` is a controllable spy (resolves an event id by default; a test
 * can make it reject to exercise the panel's fail-soft `finally`).
 */
class CaptureStub {
  enabled = false;
  isEnabled = jasmine.createSpy('isEnabled').and.callFake(() => this.enabled);
  recordAndSend = jasmine.createSpy('recordAndSend').and.resolveTo('$clip:1');
}

class PackStub {
  pack: UserEmotesPack | null = PACK;
  resolveCharacterPack = jasmine.createSpy('resolveCharacterPack')
    .and.callFake(() => Promise.resolve(this.pack));
  // real picking logic (neutral fallback) so priority assertions are meaningful
  imageFor = (p: UserEmotesPack | null, expr: string) =>
    p ? (p.images[expr] ?? p.images['neutral'] ?? null) : null;
}

class RigStub {
  composeSanitizedDataUrl = jasmine.createSpy('composeSanitizedDataUrl')
    .and.resolveTo('data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E');
}

describe('HugCharacterPanelComponent', () => {
  let fixture: ComponentFixture<HugCharacterPanelComponent>;
  let component: HugCharacterPanelComponent;
  let matrix: MatrixStub;
  let packs: PackStub;
  let rig: RigStub;
  let voice: VoiceStub;
  let capture: CaptureStub;

  beforeEach(async () => {
    matrix = new MatrixStub();
    packs = new PackStub();
    rig = new RigStub();
    voice = new VoiceStub();
    capture = new CaptureStub();
    await TestBed.configureTestingModule({
      imports: [HugCharacterPanelComponent],
      providers: [
        { provide: MatrixService, useValue: matrix },
        { provide: CharacterPackService, useValue: packs },
        { provide: SvgRigService, useValue: rig },
        { provide: VoicePlaybackService, useValue: voice },
        { provide: CharacterCaptureService, useValue: capture },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(HugCharacterPanelComponent);
    component = fixture.componentInstance;
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await fixture.whenStable();
    fixture.detectChanges();
  }

  function img(): HTMLImageElement | null {
    return fixture.nativeElement.querySelector('[data-testid="character-img"]');
  }

  function mouthOverlay(): SVGElement | null {
    return fixture.nativeElement.querySelector('[data-testid="mouth-overlay"]');
  }

  function mouthShape(): SVGEllipseElement | null {
    return fixture.nativeElement.querySelector('[data-testid="mouth-shape"]');
  }

  function speakBtn(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('[data-testid="speak-btn"]');
  }

  function recordBtn(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('[data-testid="record-btn"]');
  }

  function recordStatus(): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="record-status"]');
  }

  /** Mount a DRAWABLE character (no sticker pack) so the overlay path is active. */
  async function mountDrawable(): Promise<void> {
    packs.pack = null; // no sticker pack → drawable path
    const def = { packId: 'p', slots: {}, palette: {} } as unknown as VnCharacter;
    const manifest = { packId: 'p', canvas: { width: 10, height: 10 }, slots: [] } as unknown as PartManifest;
    component.characterPack = manifest;
    component.character = def;
    component.expression = 'neutral';
    component.speakText = 'hello world';
    component.roomId = '!room:test';
    component.ownerId = '@drawn:test';
    await settle();
  }

  /** Mount a STICKER-pack character (full-face mxc) — the no-overlay path. */
  async function mountSticker(): Promise<void> {
    packs.pack = PACK;
    component.expression = 'happy';
    component.speakText = 'hello world';
    component.ownerId = '@aria:test';
    await settle();
  }

  it('renders an <img> with the resolved sticker mxc → blob url for the expression', async () => {
    component.ownerName = 'Aria';
    component.expression = 'happy';
    component.ownerId = '@aria:test';
    await settle();

    expect(packs.resolveCharacterPack).toHaveBeenCalledWith('@aria:test');
    expect(matrix.fetchMediaObjectUrl).toHaveBeenCalledWith('mxc://snap/hap', jasmine.anything());
    const el = img();
    expect(el).toBeTruthy();
    expect(el!.getAttribute('src')).toBe('blob:mxc://snap/hap');
  });

  it('gives the <img> a meaningful alt: "<owner> character, <expression>"', async () => {
    component.ownerName = 'Aria';
    component.expression = 'happy';
    component.ownerId = '@aria:test';
    await settle();
    expect(img()!.getAttribute('alt')).toBe('Aria character, happy');
  });

  it('announces the ASCII screen-reader name over a non-ASCII display name', async () => {
    component.ownerName = 'Áría';
    component.ownerScreenReaderName = 'Aria';
    component.expression = 'neutral';
    component.ownerId = '@aria:test';
    await settle();
    expect(img()!.getAttribute('alt')).toBe('Aria character, neutral');
  });

  it('expression priority: an absent expression falls back to the neutral frame', async () => {
    component.expression = 'smug'; // not in the pack
    component.ownerId = '@aria:test';
    await settle();
    expect(matrix.fetchMediaObjectUrl).toHaveBeenCalledWith('mxc://snap/neu', jasmine.anything());
    expect(img()!.getAttribute('src')).toBe('blob:mxc://snap/neu');
  });

  it('renders NOTHING when no pack resolves (fail-soft, no layout break)', async () => {
    packs.pack = null;
    component.expression = 'happy';
    component.ownerId = '@nobody:test';
    await settle();
    expect(img()).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="character-panel"]')).toBeNull();
    expect(component.shown()).toBeFalse();
  });

  it('renders NOTHING when ownerId is cleared', async () => {
    component.expression = 'happy';
    component.ownerId = '@aria:test';
    await settle();
    expect(img()).toBeTruthy();

    component.ownerId = null;
    await settle();
    expect(img()).toBeNull();
  });

  it('DRAWABLE fallback: composes a SANITIZED data: SVG via <img> when no sticker pack', async () => {
    packs.pack = null; // no sticker pack → drawable path
    const def = { packId: 'p', slots: {}, palette: {} } as unknown as VnCharacter;
    const manifest = { packId: 'p', canvas: { width: 10, height: 10 }, slots: [] } as unknown as PartManifest;
    component.characterPack = manifest;
    component.character = def;
    component.expression = 'neutral';
    component.ownerId = '@drawn:test';
    await settle();

    expect(rig.composeSanitizedDataUrl).toHaveBeenCalled();
    const el = img();
    expect(el).toBeTruthy();
    expect(el!.getAttribute('src')!.startsWith('data:image/svg+xml')).toBeTrue();
    // The XSS boundary: it is rendered via <img src>, never via innerHTML.
    expect(fixture.nativeElement.querySelector('[data-testid="character-panel"]')!.innerHTML)
      .not.toContain('<svg');
  });

  it('DRAWABLE: forwards the current expression\'s slot overrides to the compositor', async () => {
    // The re-sync fix wiring: a drawable pack carrying expression presets must
    // compose with the ACTIVE expression's slot→partId overrides, so the drawable
    // mouth/eyes swap per expression (vs the stale inert 2-arg call).
    packs.pack = null; // no sticker pack → drawable path
    const def = { packId: 'p', slots: { mouth: 'm-neutral' }, palette: {} } as unknown as VnCharacter;
    const manifest = {
      packId: 'p',
      canvas: { width: 10, height: 10 },
      expressionSlots: ['mouth'],
      expressions: [{ id: 'happy', slots: { mouth: 'm-happy' } }],
      slots: [],
    } as unknown as PartManifest;
    component.characterPack = manifest;
    component.character = def;
    component.expression = 'happy';
    component.ownerId = '@drawn:test';
    await settle();

    // The active expression ('happy') resolves to its slot overrides and is passed
    // as the 3rd compose arg.
    expect(rig.composeSanitizedDataUrl).toHaveBeenCalledWith(def, manifest, { mouth: 'm-happy' });
  });

  it('DRAWABLE: an expression with no preset forwards {} (neutral base, no throw)', async () => {
    packs.pack = null;
    const def = { packId: 'p', slots: { mouth: 'm-neutral' }, palette: {} } as unknown as VnCharacter;
    const manifest = {
      packId: 'p',
      canvas: { width: 10, height: 10 },
      expressionSlots: ['mouth'],
      expressions: [{ id: 'happy', slots: { mouth: 'm-happy' } }],
      slots: [],
    } as unknown as PartManifest;
    component.characterPack = manifest;
    component.character = def;
    component.expression = 'angry'; // valid label, but no preset in this pack
    component.ownerId = '@drawn:test';
    await settle();

    expect(rig.composeSanitizedDataUrl).toHaveBeenCalledWith(def, manifest, {});
  });

  // ───────────────────────── Voice + amplitude mouth (B3 Wave A) ─────────────

  describe('voice speak control (dark by default)', () => {
    it('DARK: with the voice flag OFF the Speak control is DISABLED and speak() is a no-op', async () => {
      voice.enabled = false;
      await mountDrawable();

      const btn = speakBtn();
      expect(btn).toBeTruthy();
      expect(btn!.disabled).toBeTrue();
      expect(component.canSpeak()).toBeFalse();

      // Even calling speak() directly makes no synth call and never starts speaking.
      await component.speak();
      expect(voice.speak).not.toHaveBeenCalled();
      expect(component.speaking()).toBeFalse();
      expect(mouthOverlay()).toBeNull(); // no overlay
    });

    it('the Speak control is disabled when there is no text (even with the flag on)', async () => {
      voice.enabled = true;
      packs.pack = null;
      const def = { packId: 'p', slots: {}, palette: {} } as unknown as VnCharacter;
      const manifest = { packId: 'p', canvas: { width: 10, height: 10 }, slots: [] } as unknown as PartManifest;
      component.characterPack = manifest;
      component.character = def;
      component.expression = 'neutral';
      component.speakText = '   '; // blank
      component.ownerId = '@drawn:test';
      await settle();

      expect(component.canSpeak()).toBeFalse();
      expect(speakBtn()!.disabled).toBeTrue();
    });

    it('the Speak control has an accessible name that flips Play ↔ Stop', async () => {
      voice.enabled = true;
      await mountDrawable();

      expect(speakBtn()!.getAttribute('aria-label')).toBe('Play character voice');
      expect(speakBtn()!.getAttribute('aria-pressed')).toBe('false');

      await component.speak();
      fixture.detectChanges();

      expect(component.speaking()).toBeTrue();
      expect(speakBtn()!.getAttribute('aria-label')).toBe('Stop character voice');
      expect(speakBtn()!.getAttribute('aria-pressed')).toBe('true');

      component.stopSpeaking();
    });
  });

  describe('amplitude mouth overlay', () => {
    it('DRAWABLE: shows the overlay while speaking and its open-height SCALES with openness', async () => {
      voice.enabled = true;
      await mountDrawable();

      // Not speaking yet → no overlay.
      expect(mouthOverlay()).toBeNull();

      await component.speak();
      fixture.detectChanges();

      expect(component.speaking()).toBeTrue();
      const overlay = mouthOverlay();
      expect(overlay).toBeTruthy();

      // Drive the session openness up → the ellipse ry grows.
      voice.session!.openness.set(0);
      component['opennessSignal'].set(0);
      fixture.detectChanges();
      const closedRy = Number(mouthShape()!.getAttribute('ry'));

      component['opennessSignal'].set(1); // fully open
      fixture.detectChanges();
      const openRy = Number(mouthShape()!.getAttribute('ry'));

      expect(openRy).toBeGreaterThan(closedRy);
      expect(closedRy).toBe(0); // openness 0 → mouth closed
      expect(openRy).toBeGreaterThan(0);

      component.stopSpeaking();
    });

    it('★ LAYOUT: overlay is absolutely positioned OVER the portrait (stage is the positioning context)', async () => {
      voice.enabled = true;
      await mountDrawable();
      await component.speak();
      fixture.detectChanges();

      // Attach to the document so the component stylesheet resolves via getComputedStyle.
      document.body.appendChild(fixture.nativeElement);
      try {
        const stage = fixture.nativeElement.querySelector('.character-stage') as HTMLElement;
        const overlay = mouthOverlay() as unknown as HTMLElement;
        expect(stage).toBeTruthy();
        expect(overlay).toBeTruthy();
        // Without these the inline left/top offsets are inert and the overlay drops
        // into normal flow BELOW the portrait instead of layering over the mouth.
        expect(getComputedStyle(stage).position).toBe('relative');
        expect(getComputedStyle(overlay).position).toBe('absolute');
      } finally {
        document.body.removeChild(fixture.nativeElement);
        component.stopSpeaking();
      }
    });

    it('STICKER-pack character shows NO overlay (static baked-in mouth), even while speaking', async () => {
      voice.enabled = true;
      await mountSticker();

      expect(img()).toBeTruthy();
      await component.speak();
      fixture.detectChanges();

      // Speaking may be true, but a sticker-pack full-face mxc gets no mouth overlay.
      expect(component.showMouth()).toBeFalse();
      expect(mouthOverlay()).toBeNull();

      component.stopSpeaking();
    });

    it('reduced-motion behaviour: a session whose openness stays 0 keeps the mouth static/closed', async () => {
      // The service pins openness to 0 under reduced motion; here the session's
      // openness never rises, so the overlay renders but stays fully closed.
      voice.enabled = true;
      await mountDrawable();

      await component.speak();
      // Simulate the reduced-motion drive: openness pinned at 0.
      voice.session!.openness.set(0);
      component['opennessSignal'].set(0);
      fixture.detectChanges();

      expect(mouthOverlay()).toBeTruthy(); // overlay present
      expect(Number(mouthShape()!.getAttribute('ry'))).toBe(0); // but closed (static)

      component.stopSpeaking();
    });

    it('★ XSS BOUNDARY: the overlay is a SEPARATE sibling — NOT injected into the character <img>/SVG', async () => {
      voice.enabled = true;
      await mountDrawable();
      await component.speak();
      fixture.detectChanges();

      const image = img()!;
      const overlay = mouthOverlay()!;

      // The character is still a plain <img> with a data: SVG src; it has no child
      // nodes and no injected <ellipse>/<script> markup.
      expect(image.tagName.toLowerCase()).toBe('img');
      expect(image.getAttribute('src')!.startsWith('data:image/svg+xml')).toBeTrue();
      expect(image.innerHTML).toBe(''); // <img> is a void element — nothing composed inside
      expect(image.contains(overlay)).toBeFalse(); // overlay is a SIBLING, not a child

      // The overlay is a sibling under the stage, alongside (not inside) the <img>.
      const stage = fixture.nativeElement.querySelector('.character-stage');
      expect(stage.contains(image)).toBeTrue();
      expect(stage.contains(overlay)).toBeTrue();

      // The sanitized composed SVG (the data: URL) never receives the overlay's
      // <ellipse>: the ellipse lives in the DOM overlay, never in the <img> source.
      expect(image.getAttribute('src')).not.toContain('ellipse');

      component.stopSpeaking();
    });

    it('the overlay is decorative: aria-hidden + not focusable', async () => {
      voice.enabled = true;
      await mountDrawable();
      await component.speak();
      fixture.detectChanges();

      const overlay = mouthOverlay()!;
      expect(overlay.getAttribute('aria-hidden')).toBe('true');
      expect(overlay.getAttribute('focusable')).toBe('false');

      component.stopSpeaking();
    });

    it('FAIL-SOFT: a null session (flag on but synth fails) leaves the panel intact, not stuck speaking', async () => {
      voice.enabled = true;
      voice.session = null; // synth/decode failure → speak() resolves null
      await mountDrawable();

      await component.speak();
      fixture.detectChanges();

      expect(voice.speak).toHaveBeenCalled();
      expect(component.speaking()).toBeFalse(); // never stuck speaking
      expect(mouthOverlay()).toBeNull();
      expect(img()).toBeTruthy(); // panel/character intact
    });

    it('toggling speak() while speaking STOPS the session (no leak)', async () => {
      voice.enabled = true;
      await mountDrawable();

      await component.speak();
      const session = voice.session!;
      expect(component.speaking()).toBeTrue();

      await component.speak(); // second press = stop
      expect(session.stopped).toHaveBeenCalled();
      expect(component.speaking()).toBeFalse();
    });

    it('ngOnDestroy stops any in-progress session (no leak)', async () => {
      voice.enabled = true;
      await mountDrawable();
      await component.speak();
      const session = voice.session!;

      component.ngOnDestroy();
      expect(session.stopped).toHaveBeenCalled();
    });
  });

  // ─────────────────── Recorded voice clip control (B3 Wave B) ───────────────

  describe('record voice clip control (dark by default)', () => {
    it('DARK: with the capture flag OFF the Record control is DISABLED and recordClip() is a no-op', async () => {
      capture.enabled = false; // flag off
      await mountDrawable(); // has text + room + a shown character

      const btn = recordBtn();
      expect(btn).toBeTruthy();
      expect(btn!.disabled).toBeTrue();
      expect(component.canRecord()).toBeFalse();

      await component.recordClip();
      expect(capture.recordAndSend).not.toHaveBeenCalled();
      expect(component.recording()).toBeFalse();
    });

    it('canRecord() is true only with flag on + shown + text + room + not recording', async () => {
      capture.enabled = true;
      await mountDrawable(); // shown drawable, text, room
      expect(component.canRecord()).toBeTrue();
      expect(recordBtn()!.disabled).toBeFalse();
    });

    it('Record control is DISABLED when there is no text (even with the flag on)', async () => {
      capture.enabled = true;
      packs.pack = null;
      const def = { packId: 'p', slots: {}, palette: {} } as unknown as VnCharacter;
      const manifest = { packId: 'p', canvas: { width: 10, height: 10 }, slots: [] } as unknown as PartManifest;
      component.characterPack = manifest;
      component.character = def;
      component.expression = 'neutral';
      component.speakText = '   '; // blank
      component.roomId = '!room:test';
      component.ownerId = '@drawn:test';
      await settle();

      expect(component.canRecord()).toBeFalse();
      expect(recordBtn()!.disabled).toBeTrue();
    });

    it('Record control is DISABLED when there is no room', async () => {
      capture.enabled = true;
      packs.pack = null;
      const def = { packId: 'p', slots: {}, palette: {} } as unknown as VnCharacter;
      const manifest = { packId: 'p', canvas: { width: 10, height: 10 }, slots: [] } as unknown as PartManifest;
      component.characterPack = manifest;
      component.character = def;
      component.expression = 'neutral';
      component.speakText = 'hello world';
      component.roomId = null; // no room to post to
      component.ownerId = '@drawn:test';
      await settle();

      expect(component.canRecord()).toBeFalse();
      expect(recordBtn()!.disabled).toBeTrue();
    });

    it('recordClip() forwards the src/character/anchor and posts to the room, clearing recording in finally', async () => {
      capture.enabled = true;
      await mountDrawable();
      expect(component.recording()).toBeFalse();

      await component.recordClip();

      expect(capture.recordAndSend).toHaveBeenCalledTimes(1);
      const [room, text, ctx] = capture.recordAndSend.calls.mostRecent().args;
      expect(room).toBe('!room:test');
      expect(text).toBe('hello world');
      expect(ctx.imageSrc.startsWith('data:image/svg+xml')).toBeTrue();
      expect(component.recording()).toBeFalse(); // cleared after the await
    });

    it('recording() is TRUE during the await and cleared in finally even when recordAndSend REJECTS (fail-soft)', async () => {
      capture.enabled = true;
      // A deferred rejection so we can observe `recording` true mid-flight.
      let reject!: (e: unknown) => void;
      capture.recordAndSend.and.returnValue(new Promise((_res, rej) => { reject = rej; }));
      await mountDrawable();

      const done = component.recordClip();
      expect(component.recording()).toBeTrue(); // set during the await
      fixture.detectChanges();
      expect(recordStatus()!.textContent).toContain('Recording'); // aria-live text present

      reject(new Error('capture blew up'));
      // The panel trusts the capture service (documented fail-soft); its finally
      // ALWAYS clears the indicator whether the call resolved or rejected. Swallow
      // any propagated rejection here so we can assert the finally cleanup ran.
      await done.catch(() => {});

      expect(component.recording()).toBeFalse(); // cleared in finally
      fixture.detectChanges();
      expect(recordStatus()!.textContent!.trim()).toBe(''); // status silent when idle
    });

    it('recordStatus() aria-live text is present only while recording', async () => {
      capture.enabled = true;
      await mountDrawable();

      expect(component.recordStatus()).toBe(''); // idle → silent
      component.recording.set(true);
      expect(component.recordStatus()).toContain('Recording');
      component.recording.set(false);
      expect(component.recordStatus()).toBe('');
    });

    it('recordClip() is a NO-OP when canRecord() is false (e.g. no room)', async () => {
      capture.enabled = true;
      await mountDrawable();
      component.roomId = null; // now canRecord() is false
      expect(component.canRecord()).toBeFalse();

      await component.recordClip();
      expect(capture.recordAndSend).not.toHaveBeenCalled();
      expect(component.recording()).toBeFalse();
    });

    it('the Record control has a fixed descriptive accessible name', async () => {
      capture.enabled = true;
      await mountDrawable();
      expect(recordBtn()!.getAttribute('aria-label')).toBe('Record and send character voice clip');
    });
  });
});
