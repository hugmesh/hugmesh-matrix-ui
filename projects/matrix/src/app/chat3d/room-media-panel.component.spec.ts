import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MatrixService, Paginated, TimelineEvent } from '../matrix.service';
import { RoomMediaPanelComponent, MEDIA_SCAN_EVENT_LIMIT, MEDIA_SCAN_PAGE_SIZE } from './room-media-panel.component';
import { CHAT3D_SCENE_TYPE } from './chat3d-scene.service';
import { Chat3dState } from './chat3d-state.service';

const ROOM = '!r:test';

function msgEvent(eventId: string, msgtype: string, body: string, url: string | null = 'mxc://t/x'): TimelineEvent {
  return {
    eventId, roomId: ROOM, type: 'm.room.message', sender: '@bob:test',
    originServerTs: 0, msgtype, body, content: { msgtype, body, url },
  } as unknown as TimelineEvent;
}

function page(events: TimelineEvent[], end = ''): Paginated {
  return { events, start: '', end };
}

/**
 * `m.room.power_levels` content. `sceneLevel` is the room's required level to
 * send the chat3d scene event — the chat3d enable flow writes 0 when
 * `stageModOnly` is OFF and 50 when it is ON (its default). Omit it to get the
 * Matrix default (`state_default` 50), i.e. a room the flow never touched.
 */
function plContent(myLevel = 0, sceneLevel?: number): Record<string, unknown> {
  return {
    users: { '@me:test': myLevel },
    users_default: 0,
    state_default: 50,
    ...(sceneLevel === undefined ? {} : { events: { [CHAT3D_SCENE_TYPE]: sceneLevel } }),
  };
}

class MatrixStub {
  whoami = jasmine.createSpy('whoami').and.resolveTo('@me:test');
  messages = jasmine.createSpy('messages').and.resolveTo(page([]));
  getThreads = jasmine.createSpy('getThreads').and.resolveTo(page([]));
  getPinnedEvents = jasmine.createSpy('getPinnedEvents').and.resolveTo([]);
  getEvent = jasmine.createSpy('getEvent').and.rejectWith(new Error('not found'));
  /** Default room: the enable flow ran with `stageModOnly` OFF, so an ordinary
   *  member really may write the scene event (scene level 0). Tests that care
   *  about the moderators-only default override this with plContent(…, 50). */
  getStateEvent = jasmine.createSpy('getStateEvent').and.callFake(
    async (_r: string, type: string) => (type === 'm.room.power_levels' ? plContent(0, 0) : null));
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt');
  fetchMediaObjectUrl = jasmine.createSpy('fetchMediaObjectUrl').and.resolveTo('blob:fake-url');
}

const enabledConfig = (over: Partial<Chat3dState> = {}): Chat3dState => ({
  enabled: true, style: 'noir', maxParticipants: 8, allowMedia: true, stageModOnly: true, ...over,
});

describe('RoomMediaPanelComponent (channel media → scene placements)', () => {
  let fixture: ComponentFixture<RoomMediaPanelComponent>;
  let component: RoomMediaPanelComponent;
  let matrix: MatrixStub;

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      imports: [RoomMediaPanelComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
      ],
    });
  });

  afterEach(() => fixture?.destroy());

  async function create(config: Chat3dState | null = enabledConfig()): Promise<void> {
    fixture = TestBed.createComponent(RoomMediaPanelComponent);
    component = fixture.componentInstance;
    component.roomId = ROOM;
    component.config = config;
    fixture.detectChanges();
    for (let i = 0; i < 8; i++) {
      await fixture.whenStable();
    }
    fixture.detectChanges();
  }

  it('lists media messages (image/video/file) and skips text/redacted events', async () => {
    matrix.messages.and.resolveTo(page([
      msgEvent('$img', 'm.image', 'sunset.png'),
      msgEvent('$vid', 'm.video', 'clip.mp4'),
      msgEvent('$file', 'm.file', 'paper.pdf'),
      msgEvent('$text', 'm.text', 'just chatting', null),
      { ...msgEvent('$gone', 'm.image', 'gone.png'), redacted: true } as TimelineEvent,
    ]));
    await create();
    const items = component.mediaItems();
    expect(items.map((i) => i.eventId)).toEqual(['$img', '$vid', '$file']);
    expect(items.map((i) => i.kind)).toEqual(['image', 'video', 'file']);
    expect(fixture.nativeElement.querySelector('[data-testid="media-item-$img"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="media-item-$text"]')).toBeNull();
  });

  it('BACK-PAGINATES /messages but stops at the scan cap (no unbounded history walk)', async () => {
    // Every page is full and advertises another page — only the cap stops it.
    matrix.messages.and.callFake(async (_room: string, opts?: { from?: string }) => {
      const start = opts?.from ? Number(opts.from) : 0;
      const events = Array.from({ length: MEDIA_SCAN_PAGE_SIZE }, (_, i) =>
        msgEvent(`$m${start + i}`, 'm.image', `img-${start + i}.png`));
      return page(events, String(start + MEDIA_SCAN_PAGE_SIZE));
    });
    await create();
    expect(matrix.messages.calls.count()).toBe(MEDIA_SCAN_EVENT_LIMIT / MEDIA_SCAN_PAGE_SIZE);
    expect(component.mediaItems().length).toBe(MEDIA_SCAN_EVENT_LIMIT);
  });

  it('lists thread roots via getThreads and pinned events via getPinnedEvents+getEvent (failures skipped)', async () => {
    matrix.getThreads.and.resolveTo(page([
      { ...msgEvent('$troot', 'm.text', 'thread topic', null) } as TimelineEvent,
    ]));
    matrix.getPinnedEvents.and.resolveTo(['$pin1', '$pinGone', '$pin2']);
    matrix.getEvent.and.callFake(async (_r: string, id: string) => {
      if (id === '$pinGone') {
        throw new Error('redacted');
      }
      return id === '$pin1'
        ? msgEvent('$pin1', 'm.image', 'pinned-img.png')
        : msgEvent('$pin2', 'm.text', 'pinned words', null);
    });
    await create();
    expect(component.threadItems()).toEqual([jasmine.objectContaining({
      eventId: '$troot', kind: 'thread', label: 'thread topic', mxcUri: null, section: 'thread',
    })]);
    const pinned = component.pinnedItems();
    expect(pinned.length).toBe(2); // the unfetchable pin was skipped, not fatal
    expect(pinned[0]).toEqual(jasmine.objectContaining({ eventId: '$pin1', kind: 'image', section: 'pinned' }));
    // A plain-text pin degrades to a label plaque (kind file, no bytes).
    expect(pinned[1]).toEqual(jasmine.objectContaining({ eventId: '$pin2', kind: 'file', mxcUri: null }));
  });

  it('PLACE upserts the chosen surface into the scene state, preserving other surfaces', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    matrix.getStateEvent.and.callFake(async (_r: string, type: string) =>
      type === CHAT3D_SCENE_TYPE
        ? { placements: [{ surfaceId: 'screen-1', eventId: '$old', kind: 'image', label: 'old' }] }
        : plContent(0, 0));
    await create();
    component.chosenSurface['$img'] = 'table-2';
    await component.place(component.mediaItems()[0]);
    expect(matrix.setStateEvent).toHaveBeenCalledWith(ROOM, CHAT3D_SCENE_TYPE, {
      placements: [
        { surfaceId: 'screen-1', eventId: '$old', kind: 'image', label: 'old' },
        { surfaceId: 'table-2', eventId: '$img', kind: 'image', label: 'sunset.png' },
      ],
    });
    expect(component.placeNote()).toBe('');
  });

  it('placing onto an occupied surface REPLACES that surface\'s row', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    matrix.getStateEvent.and.callFake(async (_r: string, type: string) =>
      type === CHAT3D_SCENE_TYPE
        ? { placements: [{ surfaceId: 'table-2', eventId: '$old', kind: 'file', label: 'old' }] }
        : plContent(0, 0));
    await create();
    component.chosenSurface['$img'] = 'table-2';
    await component.place(component.mediaItems()[0]);
    const written = matrix.setStateEvent.calls.mostRecent().args[2] as { placements: unknown[] };
    expect(written.placements).toEqual([
      jasmine.objectContaining({ surfaceId: 'table-2', eventId: '$img' }),
    ]);
  });

  it('a refused write surfaces WHY instead of silence', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    matrix.setStateEvent.and.rejectWith(new Error('403'));
    await create();
    component.chosenSurface['$img'] = 'table-1';
    await component.place(component.mediaItems()[0]);
    fixture.detectChanges();
    expect(component.placeNote().toLowerCase()).toContain('permission');
    expect(fixture.nativeElement.querySelector('[data-testid="media-panel-place-note"]')).toBeTruthy();
  });

  it('allowMedia=false greys ALL placement controls with WHY-helptext (offered, never hidden)', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    await create(enabledConfig({ allowMedia: false }));
    expect(component.canPlace()).toBeFalse();
    const help = fixture.nativeElement.querySelector('[data-testid="media-panel-place-help"]');
    expect(help).toBeTruthy();
    expect(help.textContent.toLowerCase()).toContain('allowmedia');
    const placeBtn = fixture.nativeElement.querySelector('[data-testid="btn-media-place-$img"]');
    expect(placeBtn.disabled).toBeTrue();
    // And the write path itself refuses, not just the button.
    component.chosenSurface['$img'] = 'table-1';
    await component.place(component.mediaItems()[0]);
    expect(matrix.setStateEvent).not.toHaveBeenCalled();
  });

  it('the STAGE option is moderator-gated when stageModOnly (PL floor 50), with WHY-helptext', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    matrix.getStateEvent.and.callFake(async (_r: string, type: string) =>
      type === 'm.room.power_levels' ? plContent(0, 0) : null);
    await create(enabledConfig({ stageModOnly: true }));
    // The scene event itself IS writable here (level 0), so the stage gate is
    // the only thing refusing — otherwise this test would pass vacuously via
    // the room-wide power-level gate.
    expect(component.canWriteScene()).toBeTrue();
    expect(component.canPlace()).toBeTrue();
    expect(component.canPlaceStage()).toBeFalse();
    expect(fixture.nativeElement.querySelector('[data-testid="media-panel-stage-help"]')).toBeTruthy();
    // The write path refuses stage for a below-floor member.
    component.chosenSurface['$img'] = 'stage';
    await component.place(component.mediaItems()[0]);
    expect(matrix.setStateEvent).not.toHaveBeenCalled();
  });

  it('a moderator (PL ≥ 50) may target the stage', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    matrix.getStateEvent.and.callFake(async (_r: string, type: string) =>
      type === 'm.room.power_levels' ? plContent(50) : null);
    await create(enabledConfig({ stageModOnly: true }));
    expect(component.canPlaceStage()).toBeTrue();
    component.chosenSurface['$img'] = 'stage';
    await component.place(component.mediaItems()[0]);
    expect(matrix.setStateEvent).toHaveBeenCalledWith(ROOM, CHAT3D_SCENE_TYPE, jasmine.objectContaining({
      placements: [jasmine.objectContaining({ surfaceId: 'stage', eventId: '$img' })],
    }));
  });

  it('stageModOnly=false opens the stage to everyone', async () => {
    await create(enabledConfig({ stageModOnly: false }));
    expect(component.canPlaceStage()).toBeTrue();
  });

  it('REGRESSION: in the DEFAULT room (stageModOnly on ⇒ scene power level 50) an ordinary '
     + 'member is not offered a Place button that can only ever fail', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    // Exactly what room-settings' enable flow writes when stageModOnly is ON —
    // and it is ON by default, so this is the shipped configuration.
    matrix.getStateEvent.and.callFake(async (_r: string, type: string) =>
      (type === 'm.room.power_levels' ? plContent(0, 50) : null));
    await create(enabledConfig({ stageModOnly: true, allowMedia: true }));

    // `allowMedia` is ON, so the old gate (allowMedia !== false) said "yes" and
    // handed a PL-0 member a live Place button whose PUT the homeserver refuses.
    expect(component.config!.allowMedia).toBeTrue();
    expect(component.canWriteScene()).toBeFalse();
    expect(component.canPlace()).toBeFalse();
    const placeBtn = fixture.nativeElement.querySelector('[data-testid="btn-media-place-$img"]');
    expect(placeBtn.disabled).toBeTrue();
    // …and it says WHY, with the levels and the actual remedy.
    const help = fixture.nativeElement.querySelector('[data-testid="media-panel-place-help"]').textContent as string;
    expect(help.toLowerCase()).toContain('only moderators');
    expect(help).toContain('50');
    expect(help.toLowerCase()).toContain('stage is moderator-only');
    // The write path refuses too, not just the button.
    component.chosenSurface['$img'] = 'table-1';
    await component.place(component.mediaItems()[0]);
    expect(matrix.setStateEvent).not.toHaveBeenCalled();
  });

  it('a MODERATOR in that same default room still places normally', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    matrix.getStateEvent.and.callFake(async (_r: string, type: string) =>
      (type === 'm.room.power_levels' ? plContent(50, 50) : null));
    await create(enabledConfig({ stageModOnly: true }));
    expect(component.canWriteScene()).toBeTrue();
    expect(component.canPlace()).toBeTrue();
    expect(component.placeHelp()).toBe('');
    component.chosenSurface['$img'] = 'table-1';
    await component.place(component.mediaItems()[0]);
    expect(matrix.setStateEvent).toHaveBeenCalled();
  });

  it('an UNREADABLE power-level event fails OPEN — the homeserver is the authority and '
     + 'place() still surfaces a refusal honestly', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    matrix.getStateEvent.and.rejectWith(new Error('network'));
    matrix.setStateEvent.and.rejectWith(new Error('403'));
    await create(enabledConfig({ stageModOnly: true }));
    // A transient read failure must not grey the panel out for everybody.
    expect(component.canWriteScene()).toBeTrue();
    expect(component.canPlace()).toBeTrue();
    component.chosenSurface['$img'] = 'table-1';
    await component.place(component.mediaItems()[0]);
    expect(component.placeNote().toLowerCase()).toContain('permission');
  });

  it('allowMedia off and the power-level gate give DIFFERENT WHY-helptext (different remedies)', async () => {
    matrix.getStateEvent.and.callFake(async (_r: string, type: string) =>
      (type === 'm.room.power_levels' ? plContent(0, 50) : null));
    await create(enabledConfig({ allowMedia: false }));
    expect(component.placeHelp().toLowerCase()).toContain('allowmedia');
    await create(enabledConfig({ allowMedia: true }));
    expect(component.placeHelp().toLowerCase()).toContain('only moderators');
  });

  it('OPEN plays media in the panel via an authenticated object URL (video v1 = open-in-panel)', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$vid', 'm.video', 'clip.mp4', 'mxc://t/vid')]));
    await create();
    await component.open(component.mediaItems()[0]);
    fixture.detectChanges();
    expect(matrix.fetchMediaObjectUrl).toHaveBeenCalledWith('mxc://t/vid');
    const viewer = fixture.nativeElement.querySelector('[data-testid="media-panel-viewer"]');
    expect(viewer).toBeTruthy();
    expect(viewer.querySelector('video')).toBeTruthy();
    expect(viewer.querySelector('video').getAttribute('src')).toBe('blob:fake-url');
  });

  it('surfaces the activated in-scene placement and its Open action when the item is known', async () => {
    matrix.messages.and.resolveTo(page([msgEvent('$img', 'm.image', 'sunset.png')]));
    await create();
    fixture.componentRef.setInput('activated', { surfaceId: 'table-1', eventId: '$img', kind: 'image', label: 'sunset.png' });
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('[data-testid="media-panel-activated"]');
    expect(banner.textContent).toContain('sunset.png');
    expect(fixture.nativeElement.querySelector('[data-testid="btn-media-panel-open-activated"]')).toBeTruthy();
  });
});
