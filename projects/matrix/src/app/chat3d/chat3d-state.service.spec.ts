import { TestBed } from '@angular/core/testing';
import { MatrixService } from '../matrix.service';
import {
  CHAT3D_STATE_TYPE,
  Chat3dState,
  Chat3dStateService,
  parseChat3dState,
} from './chat3d-state.service';

class MatrixStub {
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt:1');
}

describe('parseChat3dState (untrusted room-state content)', () => {
  it('parses a well-formed content', () => {
    const state = parseChat3dState({
      enabled: true, style: 'default', maxParticipants: 12, allowMedia: false, stageModOnly: false,
    });
    expect(state).toEqual({
      enabled: true, style: 'default', maxParticipants: 12, allowMedia: false, stageModOnly: false,
    });
  });

  it('null / non-object content parses to null (3D room off)', () => {
    expect(parseChat3dState(null)).toBeNull();
    expect(parseChat3dState(undefined)).toBeNull();
    expect(parseChat3dState('nope')).toBeNull();
    expect(parseChat3dState(42)).toBeNull();
  });

  it('enabled is STRICT === true — a truthy string/number never opens a 3D room', () => {
    expect(parseChat3dState({ enabled: 'true' })!.enabled).toBeFalse();
    expect(parseChat3dState({ enabled: 1 })!.enabled).toBeFalse();
    expect(parseChat3dState({ enabled: {} })!.enabled).toBeFalse();
    expect(parseChat3dState({})!.enabled).toBeFalse();
    expect(parseChat3dState({ enabled: true })!.enabled).toBeTrue();
  });

  it('an unknown / non-string style falls back to noir', () => {
    expect(parseChat3dState({})!.style).toBe('noir');
    expect(parseChat3dState({ style: 'vaporwave' })!.style).toBe('noir');
    expect(parseChat3dState({ style: 7 })!.style).toBe('noir');
    expect(parseChat3dState({ style: 'default' })!.style).toBe('default');
    expect(parseChat3dState({ style: 'noir' })!.style).toBe('noir');
  });

  it('maxParticipants must be an INTEGER, clamped into 2..16 — anything else is 8', () => {
    expect(parseChat3dState({ maxParticipants: 4 })!.maxParticipants).toBe(4);
    expect(parseChat3dState({ maxParticipants: 2 })!.maxParticipants).toBe(2);
    expect(parseChat3dState({ maxParticipants: 16 })!.maxParticipants).toBe(16);
    expect(parseChat3dState({ maxParticipants: 99 })!.maxParticipants).toBe(16);
    expect(parseChat3dState({ maxParticipants: 0 })!.maxParticipants).toBe(2);
    expect(parseChat3dState({ maxParticipants: -1 })!.maxParticipants).toBe(2);
    expect(parseChat3dState({ maxParticipants: 7.5 })!.maxParticipants).toBe(8);
    expect(parseChat3dState({ maxParticipants: Number.NaN })!.maxParticipants).toBe(8);
    expect(parseChat3dState({ maxParticipants: '4' })!.maxParticipants).toBe(8);
    expect(parseChat3dState({})!.maxParticipants).toBe(8);
  });

  it('policy booleans require REAL booleans, defaulting allowMedia=true / stageModOnly=true', () => {
    expect(parseChat3dState({})!.allowMedia).toBeTrue();
    expect(parseChat3dState({})!.stageModOnly).toBeTrue();
    expect(parseChat3dState({ allowMedia: 'no' })!.allowMedia).toBeTrue();
    expect(parseChat3dState({ stageModOnly: 0 })!.stageModOnly).toBeTrue();
    expect(parseChat3dState({ allowMedia: false })!.allowMedia).toBeFalse();
    expect(parseChat3dState({ stageModOnly: false })!.stageModOnly).toBeFalse();
  });
});

describe('Chat3dStateService', () => {
  let service: Chat3dStateService;
  let matrix: MatrixStub;

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [{ provide: MatrixService, useValue: matrix }],
    });
    service = TestBed.inject(Chat3dStateService);
  });

  it('reads the setting from the systems.hugmesh.chat3d state event', async () => {
    matrix.getStateEvent.and.resolveTo({ enabled: true, style: 'noir', maxParticipants: 6, allowMedia: true, stageModOnly: true });

    const state = await service.getChat3dState('!room:snap');

    expect(matrix.getStateEvent).toHaveBeenCalledWith('!room:snap', CHAT3D_STATE_TYPE);
    expect(state).toEqual({ enabled: true, style: 'noir', maxParticipants: 6, allowMedia: true, stageModOnly: true });
  });

  it('FAIL-SOFT read: unset event (null), a thrown read, or no room ⇒ null (room off)', async () => {
    expect(await service.getChat3dState('!room:snap')).toBeNull(); // stub resolves null

    matrix.getStateEvent.and.rejectWith(new Error('403'));
    expect(await service.getChat3dState('!room:snap')).toBeNull();

    expect(await service.getChat3dState('')).toBeNull();
    // No room id must not even hit the wire.
    expect(matrix.getStateEvent).toHaveBeenCalledTimes(2);
  });

  it('writes the setting as the exact spec content shape', async () => {
    const state: Chat3dState = { enabled: true, style: 'default', maxParticipants: 10, allowMedia: false, stageModOnly: true };

    const ok = await service.setChat3dState('!room:snap', state);

    expect(ok).toBeTrue();
    expect(matrix.setStateEvent).toHaveBeenCalledWith('!room:snap', CHAT3D_STATE_TYPE, {
      enabled: true, style: 'default', maxParticipants: 10, allowMedia: false, stageModOnly: true,
    });
  });

  it('normalizes (clamps) our own writes so a junk style/out-of-range cap never goes out', async () => {
    await service.setChat3dState('!room:snap', {
      enabled: true, style: 'vaporwave' as never, maxParticipants: 99, allowMedia: true, stageModOnly: true,
    });
    const content = matrix.setStateEvent.calls.mostRecent().args[2] as Chat3dState;
    expect(content).toEqual({ enabled: true, style: 'noir', maxParticipants: 16, allowMedia: true, stageModOnly: true });
  });

  it('FAIL-SOFT write: a rejected PUT (e.g. power level) resolves false, never throws', async () => {
    matrix.setStateEvent.and.rejectWith(new Error('403 M_FORBIDDEN'));
    const ok = await service.setChat3dState('!room:snap', {
      enabled: false, style: 'noir', maxParticipants: 8, allowMedia: true, stageModOnly: true,
    });
    expect(ok).toBeFalse();
  });

  it('no room id ⇒ false without touching the wire', async () => {
    expect(await service.setChat3dState('', {
      enabled: false, style: 'noir', maxParticipants: 8, allowMedia: true, stageModOnly: true,
    })).toBeFalse();
    expect(matrix.setStateEvent).not.toHaveBeenCalled();
  });
});
