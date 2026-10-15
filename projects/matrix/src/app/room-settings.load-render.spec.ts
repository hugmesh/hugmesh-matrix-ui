import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { RoomSettingsComponent } from './room-settings.component';
import { MatrixService, RoomSummary } from './matrix.service';

/**
 * The room-settings load runs on macrotask continuations, like MatrixService's
 * raw `fetch`: nothing inside the framework tracks them. This spec drives the
 * page that way and NEVER calls `fixture.detectChanges()` after the load, so
 * it only passes when the load itself schedules the re-render. It reads the
 * DOM only, so it does not depend on how the component stores its fields.
 */
describe('RoomSettingsComponent — render after an untracked load', () => {
  /** Resolve `value` from a timer, outside any Angular-tracked task. */
  const later = <T>(value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), 0));

  it('shows the loaded name, topic and mesh state and un-locks the bridge for a moderator with no manual change detection', async () => {
    let stateReads = 0;
    const matrix = {
      whoami: () => later('@alice:test'),
      roomSummary: () => later({
        name: 'General',
        topic: 'Chat',
        powerLevels: { users: { '@alice:test': 50 }, usersDefault: 0, events: {}, eventsDefault: 0, stateDefault: 50, ban: 50, kick: 50, redact: 50, invite: 0 },
      } as RoomSummary),
      // First read is the mesh bridge state, second the 3D chat state.
      getStateEvent: () => { stateReads += 1; return later(stateReads === 1 ? { enabled: true, device: 'lora-1', meshChannel: 3 } : null); },
    };
    await TestBed.configureTestingModule({
      imports: [RoomSettingsComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ roomId: '!r:test' })) } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(RoomSettingsComponent);
    fixture.detectChanges(); // the first render only: summary is still unloaded
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="mesh-locked-help"]')).withContext('locked before the load').not.toBeNull();

    // Wait for the whole load: both state reads done, then one more turn.
    while (stateReads < 2) await later(null);
    await later(null);
    await fixture.whenStable();

    const input = (tid: string) => el.querySelector(`[data-testid="${tid}"]`) as HTMLInputElement;
    expect(input('input-room-name').value).toBe('General');
    expect(input('input-room-topic').value).toBe('Chat');
    expect(el.querySelector('[data-testid="mesh-locked-help"]')).withContext('moderator is not locked').toBeNull();
    expect(input('btn-save-mesh').disabled).toBeFalse();
    expect(input('input-mesh-enabled').checked).toBeTrue();
    expect(input('input-mesh-device').value).toBe('lora-1');
    expect(input('input-mesh-channel').value).toBe('3');
  });
});
