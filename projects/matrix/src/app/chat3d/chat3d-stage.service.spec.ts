import { TestBed } from '@angular/core/testing';
import { MatrixService, TimelineEvent } from '../matrix.service';
import { CHAT3D_STATE_TYPE, LEGACY_CHAT3D_STATE_TYPES } from './chat3d-state.service';
import {
  CHAT3D_STAGE_TYPE,
  Chat3dStageService,
  LEGACY_CHAT3D_STAGE_TYPES,
  MAX_MXID_LENGTH,
  parseChat3dStageState,
} from './chat3d-stage.service';

class MatrixStub {
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt:1');
  roomState = jasmine.createSpy('roomState').and.resolveTo([]);
}

function stateEvent(type: string, content: unknown, sender = '@mod:test'): TimelineEvent {
  return {
    type, content, sender, stateKey: '', eventId: `$${type}`, roomId: '!r:test', originServerTs: 0,
  } as unknown as TimelineEvent;
}

const enabled = (over: Record<string, unknown> = {}) =>
  stateEvent(CHAT3D_STATE_TYPE, {
    enabled: true, style: 'noir', maxParticipants: 8, allowMedia: true, stageModOnly: true, ...over,
  });

const powerLevels = () =>
  stateEvent('m.room.power_levels', { users: { '@mod:test': 50 }, users_default: 0, state_default: 50 });

const grant = (userId: unknown, sender = '@mod:test') =>
  stateEvent(CHAT3D_STAGE_TYPE, { v: 1, userId }, sender);

describe('parseChat3dStageState (untrusted grant content)', () => {
  it('reads the holder mxid', () => {
    expect(parseChat3dStageState({ v: 1, userId: '@bob:test' })).toBe('@bob:test');
  });

  it('treats an explicit null / absent holder as "the stage is free"', () => {
    expect(parseChat3dStageState({ v: 1, userId: null })).toBeNull();
    expect(parseChat3dStageState({ v: 1 })).toBeNull();
  });

  it('rejects non-objects, unknown keys and a wrong version (payload smuggling)', () => {
    expect(parseChat3dStageState(null)).toBeNull();
    expect(parseChat3dStageState('@bob:test')).toBeNull();
    expect(parseChat3dStageState(['@bob:test'])).toBeNull();
    expect(parseChat3dStageState({ v: 1, userId: '@bob:test', extra: 1 })).toBeNull();
    expect(parseChat3dStageState({ v: 2, userId: '@bob:test' })).toBeNull();
    expect(parseChat3dStageState({ userId: '@bob:test' })).toBeNull();
  });

  it('rejects anything that is not a plausible mxid', () => {
    expect(parseChat3dStageState({ v: 1, userId: 'bob' })).toBeNull();
    expect(parseChat3dStageState({ v: 1, userId: '@bob' })).toBeNull();
    expect(parseChat3dStageState({ v: 1, userId: 42 })).toBeNull();
    expect(parseChat3dStageState({ v: 1, userId: `@${'b'.repeat(MAX_MXID_LENGTH)}:test` })).toBeNull();
  });
});

describe('Chat3dStageService (the §5 `stage` producer the host was missing)', () => {
  let service: Chat3dStageService;
  let matrix: MatrixStub;

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [Chat3dStageService, { provide: MatrixService, useValue: matrix }],
    });
    service = TestBed.inject(Chat3dStageService);
  });

  it('reads a moderator grant out of the room state', async () => {
    const events = [enabled(), powerLevels(), grant('@bob:test')];
    expect(await service.getStageHolder('!r:test', events)).toBe('@bob:test');
  });

  it('IGNORES a grant whose sender is below the moderator floor when stageModOnly', async () => {
    // Same guard the stage SURFACE already gets — one rule for the spotlight,
    // not two. Without it any member could teleport themselves (or anyone else)
    // into every participant's spotlight.
    const events = [enabled(), powerLevels(), grant('@mallory:test', '@mallory:test')];
    expect(await service.getStageHolder('!r:test', events)).toBeNull();
  });

  it('honours a plain member grant once the room turns stageModOnly OFF', async () => {
    const events = [enabled({ stageModOnly: false }), powerLevels(), grant('@bob:test', '@bob:test')];
    expect(await service.getStageHolder('!r:test', events)).toBe('@bob:test');
  });

  it('lights nobody when the 3D room is disabled, unset or unreadable', async () => {
    expect(await service.getStageHolder('!r:test', [enabled({ enabled: false }), grant('@bob:test')]))
      .toBeNull();
    expect(await service.getStageHolder('!r:test', [enabled(), powerLevels()])).toBeNull();
    expect(await service.getStageHolder('', [enabled(), powerLevels(), grant('@bob:test')])).toBeNull();
    matrix.roomState.and.rejectWith(new Error('denied'));
    expect(await service.getStageHolder('!r:test')).toBeNull();
  });

  it('fetches the state itself when the caller has none', async () => {
    matrix.roomState.and.resolveTo([enabled(), powerLevels(), grant('@bob:test')]);
    expect(await service.getStageHolder('!r:test')).toBe('@bob:test');
    expect(matrix.roomState).toHaveBeenCalledWith('!r:test');
  });

  it('LEGACY read-fallback: a grant (and config) under EITHER pre-rebrand name still lights the stage', async () => {
    // Generation-paired: an untouched pre-rebrand room carries BOTH its chat3d
    // config and its stage grant under the same old naming. Reads walk the
    // chain; writes (see below) stay canonical-only.
    for (let gen = 0; gen < LEGACY_CHAT3D_STAGE_TYPES.length; gen++) {
      const events = [
        { ...enabled(), type: LEGACY_CHAT3D_STATE_TYPES[gen] },
        powerLevels(),
        { ...grant('@bob:test'), type: LEGACY_CHAT3D_STAGE_TYPES[gen] },
      ];
      expect(await service.getStageHolder('!r:test', events))
        .withContext(LEGACY_CHAT3D_STAGE_TYPES[gen]).toBe('@bob:test');
    }
  });

  it('LEGACY read-fallback: the canonical grant WINS over both older generations', async () => {
    // The sharp case is a canonical "nobody": clearing the stage post-rename
    // must not resurrect an old grant that still names a holder.
    const events = [
      enabled(), powerLevels(),
      grant(null), // canonical: the stage is free
      { ...grant('@stale:test'), type: LEGACY_CHAT3D_STAGE_TYPES[0], eventId: '$stale0' },
      { ...grant('@staler:test'), type: LEGACY_CHAT3D_STAGE_TYPES[1], eventId: '$stale1' },
    ];
    expect(await service.getStageHolder('!r:test', events)).toBeNull();

    // …and a canonical holder beats a differing legacy one.
    const events2 = [
      enabled(), powerLevels(),
      grant('@bob:test'),
      { ...grant('@stale:test'), type: LEGACY_CHAT3D_STAGE_TYPES[0], eventId: '$stale0' },
    ];
    expect(await service.getStageHolder('!r:test', events2)).toBe('@bob:test');
  });

  it('LEGACY read-fallback: a legacy grant is still PL-guarded, under ITS OWN type name', async () => {
    // The below-floor sender rule holds for old grants too — a pre-rebrand
    // mallory does not get to keep the spotlight through the rename.
    const events = [
      enabled(), powerLevels(),
      { ...grant('@mallory:test', '@mallory:test'), type: LEGACY_CHAT3D_STAGE_TYPES[1] },
    ];
    expect(await service.getStageHolder('!r:test', events)).toBeNull();
  });

  it('mayDriveStage reads a pre-rebrand room\'s config through the generation chain', () => {
    // The gate itself must see "enabled" in a room whose config still lives
    // under an old name — otherwise the button greys in every legacy room.
    for (const legacyConfig of LEGACY_CHAT3D_STATE_TYPES) {
      const events = [{ ...enabled(), type: legacyConfig }, powerLevels()];
      expect(service.mayDriveStage(events, '@mod:test')).withContext(legacyConfig).toBeTrue();
      expect(service.mayDriveStage(events, '@bob:test')).withContext(legacyConfig).toBeFalse();
    }
  });

  it('mayDriveStage mirrors the receive-side guard (so the button can grey with a WHY)', () => {
    const modOnly = [enabled(), powerLevels()];
    expect(service.mayDriveStage(modOnly, '@mod:test')).toBeTrue();
    expect(service.mayDriveStage(modOnly, '@bob:test')).toBeFalse();
    expect(service.mayDriveStage(modOnly, '')).toBeFalse();
    const open = [enabled({ stageModOnly: false }), powerLevels()];
    expect(service.mayDriveStage(open, '@bob:test')).toBeTrue();
    expect(service.mayDriveStage([enabled({ enabled: false })], '@mod:test')).toBeFalse();
    expect(service.mayDriveStage(null, '@mod:test')).toBeFalse();
  });

  it('writes and clears the grant, and never PUTs a holder receivers would drop', async () => {
    expect(await service.setStageHolder('!r:test', '@bob:test')).toBeTrue();
    expect(matrix.setStateEvent).toHaveBeenCalledWith(
      '!r:test', CHAT3D_STAGE_TYPE, { v: 1, userId: '@bob:test' }, '');

    expect(await service.setStageHolder('!r:test', null)).toBeTrue();
    expect(matrix.setStateEvent).toHaveBeenCalledWith(
      '!r:test', CHAT3D_STAGE_TYPE, { v: 1, userId: null }, '');

    matrix.setStateEvent.calls.reset();
    expect(await service.setStageHolder('!r:test', 'not-an-mxid')).toBeFalse();
    expect(await service.setStageHolder('', '@bob:test')).toBeFalse();
    expect(matrix.setStateEvent).not.toHaveBeenCalled();
  });

  it('fail-soft: a refused write resolves false instead of throwing', async () => {
    matrix.setStateEvent.and.rejectWith(new Error('403'));
    expect(await service.setStageHolder('!r:test', '@bob:test')).toBeFalse();
  });
});
