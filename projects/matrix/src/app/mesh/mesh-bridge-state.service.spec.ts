import { TestBed } from '@angular/core/testing';
import { MatrixService } from '../matrix.service';
import {
  DEFAULT_MESH_DEVICE,
  MESH_BRIDGE_STATE_TYPE,
  MeshBridgeState,
  MeshBridgeStateService,
  parseMeshBridgeState,
} from './mesh-bridge-state.service';

class MatrixStub {
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt:1');
}

describe('parseMeshBridgeState (untrusted room-state content)', () => {
  it('parses a well-formed content', () => {
    const state = parseMeshBridgeState({ enabled: true, device: 'lora-gw.1', meshChannel: 3 });
    expect(state).toEqual({ enabled: true, device: 'lora-gw.1', meshChannel: 3 });
  });

  it('null / non-object content parses to null (unset bridge)', () => {
    expect(parseMeshBridgeState(null)).toBeNull();
    expect(parseMeshBridgeState(undefined)).toBeNull();
    expect(parseMeshBridgeState('nope')).toBeNull();
    expect(parseMeshBridgeState(42)).toBeNull();
  });

  it('enabled is STRICT === true — a truthy string/number never turns a radio bridge on', () => {
    expect(parseMeshBridgeState({ enabled: 'true' })!.enabled).toBeFalse();
    expect(parseMeshBridgeState({ enabled: 1 })!.enabled).toBeFalse();
    expect(parseMeshBridgeState({ enabled: {} })!.enabled).toBeFalse();
    expect(parseMeshBridgeState({})!.enabled).toBeFalse();
    expect(parseMeshBridgeState({ enabled: true })!.enabled).toBeTrue();
  });

  it('a non-token / empty / overlong / hostile device falls back to "default"', () => {
    expect(parseMeshBridgeState({ device: 7 })!.device).toBe(DEFAULT_MESH_DEVICE);
    expect(parseMeshBridgeState({ device: '' })!.device).toBe(DEFAULT_MESH_DEVICE);
    expect(parseMeshBridgeState({ device: 'a'.repeat(65) })!.device).toBe(DEFAULT_MESH_DEVICE);
    expect(parseMeshBridgeState({ device: 'evil device' })!.device).toBe(DEFAULT_MESH_DEVICE);
    expect(parseMeshBridgeState({ device: '../../etc/passwd' })!.device).toBe(DEFAULT_MESH_DEVICE);
    expect(parseMeshBridgeState({ device: '<script>' })!.device).toBe(DEFAULT_MESH_DEVICE);
  });

  it('BOUNDARY: a 64-char token device is kept; dots/underscores/hyphens are legal', () => {
    const longest = 'a'.repeat(64);
    expect(parseMeshBridgeState({ device: longest })!.device).toBe(longest);
    expect(parseMeshBridgeState({ device: 'Base_Camp-2.lora' })!.device).toBe('Base_Camp-2.lora');
  });

  it('meshChannel must be an INTEGER, clamped into 0..7 — anything else is 0', () => {
    expect(parseMeshBridgeState({ meshChannel: 3 })!.meshChannel).toBe(3);
    expect(parseMeshBridgeState({ meshChannel: 0 })!.meshChannel).toBe(0);
    expect(parseMeshBridgeState({ meshChannel: 7 })!.meshChannel).toBe(7);
    expect(parseMeshBridgeState({ meshChannel: 99 })!.meshChannel).toBe(7);
    expect(parseMeshBridgeState({ meshChannel: -5 })!.meshChannel).toBe(0);
    expect(parseMeshBridgeState({ meshChannel: 2.5 })!.meshChannel).toBe(0);
    expect(parseMeshBridgeState({ meshChannel: Number.NaN })!.meshChannel).toBe(0);
    expect(parseMeshBridgeState({ meshChannel: Number.POSITIVE_INFINITY })!.meshChannel).toBe(0);
    expect(parseMeshBridgeState({ meshChannel: '3' })!.meshChannel).toBe(0);
  });
});

describe('MeshBridgeStateService', () => {
  let service: MeshBridgeStateService;
  let matrix: MatrixStub;

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [{ provide: MatrixService, useValue: matrix }],
    });
    service = TestBed.inject(MeshBridgeStateService);
  });

  it('reads the bridge setting from the systems.hugmesh.mesh.bridge state event', async () => {
    matrix.getStateEvent.and.resolveTo({ enabled: true, device: 'lora-1', meshChannel: 2 });

    const state = await service.getMeshBridgeState('!room:snap');

    expect(matrix.getStateEvent).toHaveBeenCalledWith('!room:snap', MESH_BRIDGE_STATE_TYPE);
    expect(state).toEqual({ enabled: true, device: 'lora-1', meshChannel: 2 });
  });

  it('FAIL-SOFT read: unset event (null), a thrown read, or no room ⇒ null (bridge off)', async () => {
    expect(await service.getMeshBridgeState('!room:snap')).toBeNull(); // stub resolves null

    matrix.getStateEvent.and.rejectWith(new Error('403'));
    expect(await service.getMeshBridgeState('!room:snap')).toBeNull();

    expect(await service.getMeshBridgeState('')).toBeNull();
    // No room id must not even hit the wire.
    expect(matrix.getStateEvent).toHaveBeenCalledTimes(2);
  });

  it('writes the bridge setting as the exact spec content shape', async () => {
    const state: MeshBridgeState = { enabled: true, device: 'lora-1', meshChannel: 5 };

    const ok = await service.setMeshBridgeState('!room:snap', state);

    expect(ok).toBeTrue();
    expect(matrix.setStateEvent).toHaveBeenCalledWith('!room:snap', MESH_BRIDGE_STATE_TYPE, {
      enabled: true,
      device: 'lora-1',
      meshChannel: 5,
    });
  });

  it('normalizes (clamps) our own writes so a junk device/out-of-range channel never goes out', async () => {
    await service.setMeshBridgeState('!room:snap', {
      enabled: true,
      device: 'not a token!',
      meshChannel: 99,
    });
    const content = matrix.setStateEvent.calls.mostRecent().args[2] as MeshBridgeState;
    expect(content).toEqual({ enabled: true, device: DEFAULT_MESH_DEVICE, meshChannel: 7 });
  });

  it('FAIL-SOFT write: a rejected PUT (e.g. power level) resolves false, never throws', async () => {
    matrix.setStateEvent.and.rejectWith(new Error('403 M_FORBIDDEN'));
    const ok = await service.setMeshBridgeState('!room:snap', { enabled: false, device: 'default', meshChannel: 0 });
    expect(ok).toBeFalse();
  });

  it('no room id ⇒ false without touching the wire', async () => {
    expect(await service.setMeshBridgeState('', { enabled: false, device: 'default', meshChannel: 0 })).toBeFalse();
    expect(matrix.setStateEvent).not.toHaveBeenCalled();
  });
});
