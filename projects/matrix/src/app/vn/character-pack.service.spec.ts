import { TestBed } from '@angular/core/testing';
import { CharacterPackService, USER_EMOTES_TYPE } from './character-pack.service';
import { MatrixService } from '../matrix.service';

/** Minimal MatrixService stub — only getAccountData is exercised here. */
class MatrixStub {
  getAccountData = jasmine.createSpy('getAccountData').and.resolveTo(null);
}

const VALID_PACK = {
  pack: { display_name: 'Aria', usage: ['sticker'] },
  images: {
    neutral: { url: 'mxc://snap/neu', body: 'neutral face', usage: ['sticker'] },
    happy: { url: 'mxc://snap/hap', body: 'happy face' },
    // a bad entry (no mxc url) must be dropped, not throw
    broken: { url: 'http://evil/x' },
    alsoBroken: { body: 'no url' },
  },
};

describe('CharacterPackService', () => {
  let svc: CharacterPackService;
  let matrix: MatrixStub;

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [
        CharacterPackService,
        { provide: MatrixService, useValue: matrix },
      ],
    });
    svc = TestBed.inject(CharacterPackService);
  });

  it('parses an MSC2545 im.ponies.user_emotes pack, dropping non-mxc entries', async () => {
    matrix.getAccountData.and.resolveTo(VALID_PACK);
    const pack = await svc.resolveCharacterPack('@aria:test');

    expect(matrix.getAccountData).toHaveBeenCalledWith('@aria:test', USER_EMOTES_TYPE);
    expect(pack).not.toBeNull();
    expect(Object.keys(pack!.images).sort()).toEqual(['happy', 'neutral']);
    expect(pack!.images['neutral'].url).toBe('mxc://snap/neu');
    expect(pack!.images['happy'].body).toBe('happy face');
    expect(pack!.pack.display_name).toBe('Aria');
  });

  it('imageFor picks the requested expression, else falls back to neutral, else null', async () => {
    matrix.getAccountData.and.resolveTo(VALID_PACK);
    const pack = await svc.resolveCharacterPack('@aria:test');

    expect(svc.imageFor(pack, 'happy')!.url).toBe('mxc://snap/hap');
    // absent expression → neutral frame
    expect(svc.imageFor(pack, 'smug')!.url).toBe('mxc://snap/neu');
    expect(svc.imageFor(null, 'happy')).toBeNull();
  });

  it('caches per-userId within the TTL — a second resolve does not refetch', async () => {
    matrix.getAccountData.and.resolveTo(VALID_PACK);
    await svc.resolveCharacterPack('@aria:test');
    await svc.resolveCharacterPack('@aria:test');
    expect(matrix.getAccountData).toHaveBeenCalledTimes(1);
  });

  it('de-dupes concurrent in-flight resolves for the same user', async () => {
    matrix.getAccountData.and.resolveTo(VALID_PACK);
    const [a, b] = await Promise.all([
      svc.resolveCharacterPack('@aria:test'),
      svc.resolveCharacterPack('@aria:test'),
    ]);
    expect(a).toBe(b);
    expect(matrix.getAccountData).toHaveBeenCalledTimes(1);
  });

  it('fail-soft: a missing pack (null account-data) resolves to null, never throws', async () => {
    matrix.getAccountData.and.resolveTo(null);
    const pack = await svc.resolveCharacterPack('@nobody:test');
    expect(pack).toBeNull();
  });

  it('fail-soft: a pack with no usable images resolves to null', async () => {
    matrix.getAccountData.and.resolveTo({ images: { x: { url: 'http://no' } }, pack: {} });
    expect(await svc.resolveCharacterPack('@empty:test')).toBeNull();
  });

  it('fail-soft: an account-data error resolves to null (and is cached as null)', async () => {
    matrix.getAccountData.and.rejectWith(new Error('network'));
    const pack = await svc.resolveCharacterPack('@boom:test');
    expect(pack).toBeNull();
    // cached-null: a second call does not retry within the TTL
    await svc.resolveCharacterPack('@boom:test');
    expect(matrix.getAccountData).toHaveBeenCalledTimes(1);
  });

  it('resolveCharacterPack("") short-circuits to null without a fetch', async () => {
    expect(await svc.resolveCharacterPack('')).toBeNull();
    expect(matrix.getAccountData).not.toHaveBeenCalled();
  });

  it('invalidate forces a refetch on the next resolve', async () => {
    matrix.getAccountData.and.resolveTo(VALID_PACK);
    await svc.resolveCharacterPack('@aria:test');
    svc.invalidate('@aria:test');
    await svc.resolveCharacterPack('@aria:test');
    expect(matrix.getAccountData).toHaveBeenCalledTimes(2);
  });
});
