import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HugStickerPickerComponent } from './hug-sticker-picker.component';
import { CharacterPackService, UserEmotesPack } from './character-pack.service';
import { MatrixService } from '../matrix.service';

const MY_ID = '@me:test';

/** A pack with two canonical expressions; one entry carries explicit info dims. */
const PACK: UserEmotesPack = {
  pack: { display_name: 'Aria', usage: ['sticker'] },
  images: {
    // out-of-order on purpose: the picker must order canonical exprs first
    happy: { url: 'mxc://snap/hap', body: 'happy face' },
    neutral: { url: 'mxc://snap/neu', body: 'neutral face' },
  },
};

class MatrixStub {
  me: string | null = MY_ID;
  whoami = jasmine.createSpy('whoami').and.callFake(() => Promise.resolve(this.me));
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl')
    .and.callFake((mxc: string) => Promise.resolve(`blob:${mxc}`));
  sendEvent = jasmine.createSpy('sendEvent').and.resolveTo('$sticker-event');
}

class PackStub {
  pack: UserEmotesPack | null = PACK;
  resolveCharacterPack = jasmine.createSpy('resolveCharacterPack')
    .and.callFake(() => Promise.resolve(this.pack));
  imageFor = (p: UserEmotesPack | null, expr: string) =>
    p ? (p.images[expr] ?? p.images['neutral'] ?? null) : null;
}

describe('HugStickerPickerComponent', () => {
  let fixture: ComponentFixture<HugStickerPickerComponent>;
  let component: HugStickerPickerComponent;
  let matrix: MatrixStub;
  let packs: PackStub;

  beforeEach(async () => {
    matrix = new MatrixStub();
    packs = new PackStub();
    await TestBed.configureTestingModule({
      imports: [HugStickerPickerComponent],
      providers: [
        { provide: MatrixService, useValue: matrix },
        { provide: CharacterPackService, useValue: packs },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(HugStickerPickerComponent);
    component = fixture.componentInstance;
    component.roomId = '!r:test';
  });

  async function settle(): Promise<void> {
    fixture.detectChanges(); // triggers ngAfterViewInit → load()
    // load() is a chain of awaited promises (whoami → resolve → per-image media
    // fetch → microtask focus); flush several macro/microtask turns, detecting
    // changes each time so the *ngFor renders once the tiles signal is set.
    for (let i = 0; i < 8; i++) {
      await fixture.whenStable();
      await Promise.resolve();
      fixture.detectChanges();
    }
  }

  function tiles(): HTMLButtonElement[] {
    const host = fixture.nativeElement as HTMLElement;
    return Array.from(host.querySelectorAll<HTMLButtonElement>('button.sticker-btn'));
  }

  it('resolves the CURRENT user\'s own pack (whoami → resolveCharacterPack)', async () => {
    await settle();
    expect(matrix.whoami).toHaveBeenCalled();
    expect(packs.resolveCharacterPack).toHaveBeenCalledWith(MY_ID);
  });

  it('renders the pack\'s stickers as <img src="blob:…"> (authenticated object URL)', async () => {
    await settle();
    const imgs = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLImageElement>('img.sticker-img');
    expect(imgs.length).toBe(2);
    expect(matrix.fetchMediaObjectUrl).toHaveBeenCalledWith('mxc://snap/neu', jasmine.anything());
    expect(matrix.fetchMediaObjectUrl).toHaveBeenCalledWith('mxc://snap/hap', jasmine.anything());
    // The XSS boundary: rendered via <img src>, never innerHTML.
    expect(fixture.nativeElement.querySelector('[data-testid="sticker-picker"]').innerHTML)
      .not.toContain('<svg');
    expect(imgs[0].getAttribute('src')!.startsWith('blob:')).toBeTrue();
  });

  it('orders the canonical expressions first (neutral before happy)', async () => {
    await settle();
    const order = tiles().map((b) => b.getAttribute('data-testid'));
    expect(order).toEqual(['sticker-neutral', 'sticker-happy']);
  });

  it('gives each tile + its <img> a meaningful accessible name / alt', async () => {
    await settle();
    const neutral = fixture.nativeElement.querySelector('[data-testid="sticker-neutral"]') as HTMLButtonElement;
    expect(neutral.getAttribute('aria-label')).toBe('Send neutral face sticker');
    expect(neutral.querySelector('img')!.getAttribute('alt')).toBe('neutral face');
  });

  it('shows the friendly empty state when the user has no pack (fail-soft, no crash)', async () => {
    packs.pack = null;
    await settle();
    expect(tiles().length).toBe(0);
    const empty = fixture.nativeElement.querySelector('[data-testid="sticker-empty"]');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain('no expression stickers');
  });

  it('shows the empty state and never throws when resolveCharacterPack rejects', async () => {
    packs.resolveCharacterPack.and.rejectWith(new Error('boom'));
    await settle();
    expect(tiles().length).toBe(0);
    expect(fixture.nativeElement.querySelector('[data-testid="sticker-empty"]')).toBeTruthy();
  });

  it('shows the empty state when whoami yields no user (no pack to read)', async () => {
    matrix.me = null;
    await settle();
    expect(packs.resolveCharacterPack).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="sticker-empty"]')).toBeTruthy();
  });

  it('clicking a sticker SENDS an MSC2545 m.sticker into the right room with the right mxc', async () => {
    await settle();
    const happy = fixture.nativeElement.querySelector('[data-testid="sticker-happy"]') as HTMLButtonElement;
    happy.click();
    await fixture.whenStable();

    expect(matrix.sendEvent).toHaveBeenCalledTimes(1);
    const [roomId, type, content, txnId] = matrix.sendEvent.calls.mostRecent().args;
    expect(roomId).toBe('!r:test');
    expect(type).toBe('m.sticker');
    // m.sticker spec shape: url=mxc, body, info{mimetype,w,h}
    expect(content.url).toBe('mxc://snap/hap');
    expect(content.body).toBe('happy face');
    expect(content.info.mimetype).toBe('image/png');
    expect(content.info.w).toBe(256);
    expect(content.info.h).toBe(256);
    // namespaced ext carries the VN expression for clients that understand it
    expect(content['systems.hugmesh.vn'].expression).toBe('happy');
    // a fresh txnId is used (either explicit arg or service-generated default)
    expect(txnId === undefined || typeof txnId === 'string').toBeTrue();
  });

  it('emits picked with the sent event id (host closes the picker)', async () => {
    await settle();
    const picked = jasmine.createSpy('picked');
    component.picked.subscribe(picked);
    (fixture.nativeElement.querySelector('[data-testid="sticker-neutral"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(picked).toHaveBeenCalledWith('$sticker-event');
  });

  it('FAIL-SOFT on send error: surfaces an inline status, does not throw or emit picked', async () => {
    await settle();
    matrix.sendEvent.and.rejectWith(new Error('send failed'));
    const picked = jasmine.createSpy('picked');
    component.picked.subscribe(picked);

    await component.send({ shortcode: 'happy', mxc: 'mxc://snap/hap', label: 'happy face', src: 'blob:x' });

    expect(picked).not.toHaveBeenCalled();
    fixture.detectChanges();
    const status = fixture.nativeElement.querySelector('[data-testid="sticker-status"]');
    expect(status).toBeTruthy();
    expect(status.textContent).toContain('Could not send');
  });

  it('uses the pack image info dims/mimetype when present (no default override)', async () => {
    packs.pack = {
      pack: {},
      images: {
        neutral: { url: 'mxc://snap/neu', body: 'neutral' },
      },
    } as UserEmotesPack;
    // attach a raw info block the picker reads off the parsed image
    (packs.pack.images['neutral'] as any).info = { w: 512, h: 512, mimetype: 'image/webp' };
    await settle();
    (fixture.nativeElement.querySelector('[data-testid="sticker-neutral"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    const content = matrix.sendEvent.calls.mostRecent().args[2];
    expect(content.info.w).toBe(512);
    expect(content.info.h).toBe(512);
    expect(content.info.mimetype).toBe('image/webp');
  });

  it('is keyboard-operable: roving tabindex + Arrow moves focus, Escape dismisses', async () => {
    await settle();
    const btns = tiles();
    // exactly one tab stop into the grid
    expect(btns.filter((b) => b.getAttribute('tabindex') === '0').length).toBe(1);
    expect(btns[0].getAttribute('tabindex')).toBe('0');

    component.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowRight' }), 0);
    fixture.detectChanges();
    expect(component.activeIndex()).toBe(1);
    expect(tiles()[1].getAttribute('tabindex')).toBe('0');

    const dismissed = jasmine.createSpy('dismissed');
    component.dismissed.subscribe(dismissed);
    component.onKeydown(new KeyboardEvent('keydown', { key: 'Escape' }), 1);
    expect(dismissed).toHaveBeenCalled();
  });

  it('exposes the grid as a role="menu" with a descriptive aria-label', async () => {
    await settle();
    const menu = fixture.nativeElement.querySelector('[data-testid="sticker-picker"]');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toContain('sticker');
  });
});
