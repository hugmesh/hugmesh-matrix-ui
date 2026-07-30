import { TestBed } from '@angular/core/testing';
import { MatrixService, TimelineEvent } from '../matrix.service';
import { CHAT3D_STATE_TYPE } from './chat3d-state.service';
import {
  CHAT3D_SCENE_TYPE,
  Chat3dSceneService,
  MAX_PLACEMENTS,
  parseChat3dSceneState,
} from './chat3d-scene.service';

class MatrixStub {
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt:1');
  roomState = jasmine.createSpy('roomState').and.resolveTo([]);
}

/** A valid placement row. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { surfaceId: 'table-1', eventId: '$evt1', kind: 'image', label: 'sunset.png', ...over };
}

/** A minimal state event as MatrixService.roomState returns them. */
function stateEvent(type: string, content: unknown, sender = '@mod:test', stateKey = ''): TimelineEvent {
  return { type, content, sender, stateKey, eventId: `$${type}`, roomId: '!r:test', originServerTs: 0 } as unknown as TimelineEvent;
}

/** Room power levels: mod at 50, everyone else 0, state_default 50 — but the
 *  chat3d.scene event OPEN to members (the enable flow's override). */
function plContent(sceneLevel = 0): unknown {
  return { users: { '@mod:test': 50 }, users_default: 0, state_default: 50, events: { [CHAT3D_SCENE_TYPE]: sceneLevel } };
}

/** The chat3d config event content (enabled, media on, stage mod-only). */
function configContent(over: Record<string, unknown> = {}): unknown {
  return { enabled: true, style: 'noir', maxParticipants: 8, allowMedia: true, stageModOnly: true, ...over };
}

describe('parseChat3dSceneState (untrusted room-state content)', () => {
  it('parses well-formed placements', () => {
    const state = parseChat3dSceneState({ placements: [row(), row({ surfaceId: 'screen-2', kind: 'thread' })] });
    expect(state!.placements).toEqual([
      { surfaceId: 'table-1', eventId: '$evt1', kind: 'image', label: 'sunset.png' },
      { surfaceId: 'screen-2', eventId: '$evt1', kind: 'thread', label: 'sunset.png' },
    ]);
  });

  it('null / non-object content parses to null; a missing placements array parses empty', () => {
    expect(parseChat3dSceneState(null)).toBeNull();
    expect(parseChat3dSceneState('x')).toBeNull();
    expect(parseChat3dSceneState({})!.placements).toEqual([]);
    expect(parseChat3dSceneState({ placements: 'junk' })!.placements).toEqual([]);
  });

  it('drops rows whose surfaceId is not one of the 11 scene surfaces', () => {
    for (const bad of ['table-0', 'table-7', 'screen-5', 'stage-2', 'STAGE', 'floor', '', 7, null]) {
      const state = parseChat3dSceneState({ placements: [row({ surfaceId: bad })] })!;
      expect(state.placements.length).withContext(String(bad)).toBe(0);
    }
    for (const good of ['table-1', 'table-6', 'screen-1', 'screen-4', 'stage']) {
      const state = parseChat3dSceneState({ placements: [row({ surfaceId: good })] })!;
      expect(state.placements.length).withContext(good).toBe(1);
    }
  });

  it('drops rows without a $-prefixed event id', () => {
    for (const bad of ['evt1', '', '$', 7, null, undefined, '$' + 'x'.repeat(300)]) {
      const state = parseChat3dSceneState({ placements: [row({ eventId: bad })] })!;
      expect(state.placements.length).withContext(String(bad)).toBe(0);
    }
  });

  it('an unknown kind falls back to file (plaque, no bytes); labels are truncated at 80', () => {
    const state = parseChat3dSceneState({
      placements: [row({ kind: 'executable', label: 'L'.repeat(200) })],
    })!;
    expect(state.placements[0].kind).toBe('file');
    expect(state.placements[0].label.length).toBe(80);
    expect(parseChat3dSceneState({ placements: [row({ label: 7 })] })!.placements[0].label).toBe('');
  });

  it('keeps only the FIRST row per surface (one item per surface — no stacking)', () => {
    const state = parseChat3dSceneState({
      placements: [row({ label: 'first' }), row({ label: 'second' })],
    })!;
    expect(state.placements.length).toBe(1);
    expect(state.placements[0].label).toBe('first');
  });

  it(`caps parsing at ${MAX_PLACEMENTS} rows (hostile flood)`, () => {
    const flood = Array.from({ length: 200 }, (_, i) => row({ surfaceId: `table-${(i % 6) + 1}` }));
    const state = parseChat3dSceneState({ placements: flood })!;
    // 6 distinct table surfaces survive the dedupe; the loop must have stopped
    // long before 200 (cap + dedupe both bound it).
    expect(state.placements.length).toBe(6);
  });
});

describe('Chat3dSceneService', () => {
  let service: Chat3dSceneService;
  let matrix: MatrixStub;

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [{ provide: MatrixService, useValue: matrix }],
    });
    service = TestBed.inject(Chat3dSceneService);
  });

  it('writes placements as the exact spec content shape (normalized)', async () => {
    const ok = await service.setSceneState('!r:test', {
      placements: [{ surfaceId: 'stage', eventId: '$e', kind: 'image', label: 'talk' }],
    });
    expect(ok).toBeTrue();
    expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', CHAT3D_SCENE_TYPE, {
      placements: [{ surfaceId: 'stage', eventId: '$e', kind: 'image', label: 'talk' }],
    });
  });

  it('FAIL-SOFT write: rejected PUT resolves false; no room id never touches the wire', async () => {
    matrix.setStateEvent.and.rejectWith(new Error('403'));
    expect(await service.setSceneState('!r:test', { placements: [] })).toBeFalse();
    expect(await service.setSceneState('', { placements: [] })).toBeFalse();
    expect(matrix.setStateEvent).toHaveBeenCalledTimes(1);
  });

  describe('getModeratedSceneState (receive trust boundary)', () => {
    it('returns the clamped placements when the room is enabled and the sender is fine', async () => {
      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_STATE_TYPE, configContent()),
        stateEvent('m.room.power_levels', plContent()),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row()] }, '@member:test'),
      ]);
      const state = await service.getModeratedSceneState('!r:test');
      expect(state!.placements).toEqual([{ surfaceId: 'table-1', eventId: '$evt1', kind: 'image', label: 'sunset.png' }]);
    });

    it('accepts a pre-fetched stateEvents array (single-fetch poll path) without re-fetching', async () => {
      const events = [
        stateEvent(CHAT3D_STATE_TYPE, configContent()),
        stateEvent('m.room.power_levels', plContent()),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row()] }, '@member:test'),
      ];
      const state = await service.getModeratedSceneState('!r:test', undefined, events);
      expect(state!.placements.length).toBe(1);
      expect(matrix.roomState).not.toHaveBeenCalled();
    });

    it('resolves null while the room chat3d state is unset/disabled — nothing renders', async () => {
      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row()] }, '@member:test'),
      ]);
      expect(await service.getModeratedSceneState('!r:test')).toBeNull();

      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_STATE_TYPE, configContent({ enabled: false })),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row()] }, '@member:test'),
      ]);
      expect(await service.getModeratedSceneState('!r:test')).toBeNull();
    });

    it('allowMedia=false ⇒ NO placements render, regardless of sender power', async () => {
      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_STATE_TYPE, configContent({ allowMedia: false })),
        stateEvent('m.room.power_levels', plContent()),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row()] }, '@mod:test'),
      ]);
      const state = await service.getModeratedSceneState('!r:test');
      expect(state!.placements).toEqual([]);
    });

    it('stageModOnly: a below-moderator sender\'s STAGE placement is dropped, their other surfaces kept', async () => {
      // Scene level 0 WITH stageModOnly on is a real room shape, not a
      // contrived one: room-settings' power-level write is best-effort (it has
      // its own "could not be written" note), so a room saved once with
      // stageModOnly OFF and then flipped ON with a failed PL write sits
      // exactly here — as does any hand-configured room. This is the case the
      // guard exists for.
      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_STATE_TYPE, configContent({ stageModOnly: true })),
        stateEvent('m.room.power_levels', plContent(0)),
        stateEvent(CHAT3D_SCENE_TYPE, {
          placements: [row({ surfaceId: 'stage', label: 'grab-the-spotlight' }), row({ surfaceId: 'table-2' })],
        }, '@member:test'),
      ]);
      const state = await service.getModeratedSceneState('!r:test');
      expect(state!.placements.map((p) => p.surfaceId)).toEqual(['table-2']);
    });

    it('…and in the SHIPPED default (enable flow wrote scene level 50) the same guard still holds '
       + 'for a below-moderator sender, so a homeserver that accepted the write cannot seize the stage', async () => {
      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_STATE_TYPE, configContent({ stageModOnly: true })),
        stateEvent('m.room.power_levels', plContent(50)),
        stateEvent(CHAT3D_SCENE_TYPE, {
          placements: [row({ surfaceId: 'stage', label: 'grab-the-spotlight' }), row({ surfaceId: 'table-2' })],
        }, '@member:test'),
      ]);
      const state = await service.getModeratedSceneState('!r:test');
      expect(state!.placements.map((p) => p.surfaceId)).toEqual(['table-2']);
    });

    it('stageModOnly: a moderator\'s STAGE placement is applied', async () => {
      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_STATE_TYPE, configContent({ stageModOnly: true })),
        // The enable flow writes the scene override at 50 when stage is mod-only.
        stateEvent('m.room.power_levels', plContent(50)),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row({ surfaceId: 'stage' })] }, '@mod:test'),
      ]);
      const state = await service.getModeratedSceneState('!r:test');
      expect(state!.placements.map((p) => p.surfaceId)).toEqual(['stage']);
    });

    it('stageModOnly=false: a plain member may hold the stage', async () => {
      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_STATE_TYPE, configContent({ stageModOnly: false })),
        stateEvent('m.room.power_levels', plContent(0)),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row({ surfaceId: 'stage' })] }, '@member:test'),
      ]);
      const state = await service.getModeratedSceneState('!r:test');
      expect(state!.placements.map((p) => p.surfaceId)).toEqual(['stage']);
    });

    it('RATE LIMIT: coalesces a burst of genuine flips, keeping the last applied scene', async () => {
      const eventsFor = (label: string) => [
        stateEvent(CHAT3D_STATE_TYPE, configContent()),
        stateEvent('m.room.power_levels', plContent()),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row({ label })] }, '@member:test'),
      ];
      // The shared SceneRateLimiter allows 3 flips per 5s window.
      for (const label of ['a', 'b', 'c']) {
        matrix.roomState.and.resolveTo(eventsFor(label));
        expect((await service.getModeratedSceneState('!r:test'))!.placements[0].label).toBe(label);
      }
      matrix.roomState.and.resolveTo(eventsFor('d'));
      // 4th flip inside the window: coalesced — the last GOOD scene stays.
      expect((await service.getModeratedSceneState('!r:test'))!.placements[0].label).toBe('c');
    });

    it('a redundant re-read of the same scene spends NO rate token', async () => {
      const events = [
        stateEvent(CHAT3D_STATE_TYPE, configContent()),
        stateEvent('m.room.power_levels', plContent()),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row()] }, '@member:test'),
      ];
      matrix.roomState.and.resolveTo(events);
      for (let i = 0; i < 10; i++) {
        expect((await service.getModeratedSceneState('!r:test'))!.placements.length).toBe(1);
      }
      // Still able to apply a genuine change afterwards (tokens were not spent).
      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_STATE_TYPE, configContent()),
        stateEvent('m.room.power_levels', plContent()),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row({ label: 'new' })] }, '@member:test'),
      ]);
      expect((await service.getModeratedSceneState('!r:test'))!.placements[0].label).toBe('new');
    });

    it('FAIL-SOFT: a thrown roomState keeps the last applied scene', async () => {
      matrix.roomState.and.resolveTo([
        stateEvent(CHAT3D_STATE_TYPE, configContent()),
        stateEvent('m.room.power_levels', plContent()),
        stateEvent(CHAT3D_SCENE_TYPE, { placements: [row()] }, '@member:test'),
      ]);
      await service.getModeratedSceneState('!r:test');
      matrix.roomState.and.rejectWith(new Error('network'));
      const state = await service.getModeratedSceneState('!r:test');
      expect(state!.placements.length).toBe(1);
    });
  });
});
