import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { RoomSettingsComponent } from './room-settings.component';
import { MatrixService, RoomSummary } from './matrix.service';
import { SessionService, HugSession } from './session.service';
import { MESH_BRIDGE_STATE_TYPE } from './mesh/mesh-bridge-state.service';
import { CHAT3D_STATE_TYPE } from './chat3d/chat3d-state.service';
import { CHAT3D_SCENE_TYPE } from './chat3d/chat3d-scene.service';
import { CHAT3D_AVATAR_TYPE } from './chat3d/chat3d-avatar.service';
import { expectDescribedByHelp } from './a11y-help.spec-util';

/** A HugSession on homeserver `test`, carrying the given roles. */
function sessionWith(roles: string[]): HugSession {
  return {
    id: 'google:alice@gmail.com', label: 'alice', provider: 'google', roles,
    registrationComplete: true,
  };
}

class MatrixServiceStub {
  // The caller's homeserver is resolved via the hsproxy whoami() (the browser no
  // longer stores the Matrix user id) → drives localServer() === 'test'.
  whoami = jasmine.createSpy('whoami').and.resolveTo('@alice:test');
  roomSummary = jasmine.createSpy('roomSummary').and.resolveTo({
    name: 'General',
    topic: 'Chat',
    powerLevels: { users: { '@admin:test': 100 }, usersDefault: 0, events: {}, eventsDefault: 0, stateDefault: 50, ban: 50, kick: 50, redact: 50, invite: 0 },
  } as RoomSummary);
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$state');
  // Mesh-bridge state read (MeshBridgeStateService rides the same stub): null = bridge unset.
  getStateEvent = jasmine.createSpy('getStateEvent').and.resolveTo(null);
  invite = jasmine.createSpy('invite').and.resolveTo(undefined);
  leaveRoom = jasmine.createSpy('leaveRoom').and.resolveTo(undefined);
  uploadMedia = jasmine.createSpy('uploadMedia').and.resolveTo({ contentUri: 'mxc://x', mxcUri: 'mxc://x' });
}

describe('RoomSettingsComponent', () => {
  let fixture: ComponentFixture<RoomSettingsComponent>;
  let component: RoomSettingsComponent;
  let matrix: MatrixServiceStub;
  let router: Router;

  beforeEach(async () => {
    localStorage.clear(); // default to an un-locked session
    matrix = new MatrixServiceStub();
    await TestBed.configureTestingModule({
      imports: [RoomSettingsComponent],
      providers: [
        provideRouter([]),
        { provide: MatrixService, useValue: matrix },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ roomId: '!r:test' })) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RoomSettingsComponent);
    component = fixture.componentInstance;
    router = TestBed.inject(Router);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('loads the room summary into the editable fields', () => {
    expect(component.name()).toBe('General');
    expect(component.topic()).toBe('Chat');
    expect(component.powerUsers()).toEqual([{ userId: '@admin:test', level: 100 }]);
  });

  it('associates every text field with an explicit <label for>', () => {
    const el = fixture.nativeElement;
    for (const id of ['rs-name', 'rs-topic', 'rs-invite']) {
      expect(el.querySelector(`#${id}`)).withContext(id).toBeTruthy();
      expect(el.querySelector(`label[for="${id}"]`)).withContext(`label ${id}`).toBeTruthy();
    }
  });

  it('persists name + topic as state events on save', async () => {
    component.name.set('Renamed');
    component.topic.set('New topic');
    await component.save();
    expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', 'm.room.name', { name: 'Renamed' });
    expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', 'm.room.topic', { topic: 'New topic' });
  });

  it('announces the save outcome via an aria-live status region', async () => {
    await component.save();
    fixture.detectChanges();
    const status = fixture.nativeElement.querySelector('[data-testid="room-settings-status"]');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Saved');
  });

  it('leaves the room and navigates back to the room list', async () => {
    const nav = spyOn(router, 'navigate').and.resolveTo(true);
    await component.leave();
    expect(matrix.leaveRoom).toHaveBeenCalledWith('!r:test');
    // Mount-RELATIVE since fix/mount-relative-navigation (1337ed2): under the
    // host shell an absolute ['/rooms'] resolves against the SHELL's router and
    // bounces the user out of Matrix to /user. The spec was never updated with
    // the code, so main shipped red.
    expect(nav).toHaveBeenCalledWith(['rooms'], jasmine.objectContaining({ relativeTo: jasmine.anything() }));
  });

  // ───────── ANNOUNCED-FAILURE HONESTY: never claim "Invited" on a rejection ─────────
  describe('announced membership-verb failures', () => {
    it('a REJECTED invite (403) announces "Invite failed" — NEVER "Invited" — and keeps the target', async () => {
      matrix.invite.and.rejectWith(new Error('invite failed: 403'));
      component.inviteUser = '@bob:test';
      await component.doInvite();
      fixture.detectChanges();
      expect(component.inviteUser).toBe('@bob:test'); // kept for retry
      const status = fixture.nativeElement.querySelector('[data-testid="room-settings-status"]');
      expect(status.textContent).toContain('Invite failed');
      expect(status.textContent).toContain('403');
      expect(status.textContent).not.toMatch(/^\s*Invited\s*$/);
    });

    it('a REJECTED leave announces the failure and does NOT navigate away', async () => {
      matrix.leaveRoom.and.rejectWith(new Error('leaveRoom failed: 500'));
      const nav = spyOn(router, 'navigate').and.resolveTo(true);
      await component.leave();
      fixture.detectChanges();
      expect(nav).not.toHaveBeenCalled();
      const status = fixture.nativeElement.querySelector('[data-testid="room-settings-status"]');
      expect(status.textContent).toContain('Could not leave the room');
    });
  });

  // ───────── HELP TEXT ─────────
  it('wires the name/topic/avatar/save + leave controls to present help', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(expectDescribedByHelp(el, '#rs-name').toLowerCase()).toContain('room list');
    expect(expectDescribedByHelp(el, '#rs-topic').toLowerCase()).toContain('description');
    expect(expectDescribedByHelp(el, '#rs-avatar').toLowerCase()).toContain('image');
    expectDescribedByHelp(el, '[data-testid="btn-save-room"]');
    expect(expectDescribedByHelp(el, '[data-testid="btn-leave-room"]').toLowerCase())
      .toContain('removes you');
  });

  // ───────── un-locked caller: invite is unrestricted (no change) ─────────
  describe('un-locked caller: invite stays unrestricted', () => {
    it('shows no domain-lock note and leaves the invite control enabled, even for a remote target', () => {
      component.inviteUser = '@bob:other.org';
      fixture.detectChanges();
      expect(component.domainLocked()).toBeFalse();
      expect(fixture.nativeElement.querySelector('[data-testid="invite-domain-lock-note"]')).toBeNull();
      const btn = fixture.nativeElement.querySelector('[data-testid="btn-room-invite"]');
      expect(btn.disabled).toBeFalse();
    });

    it('invites a remote user normally when not locked', async () => {
      component.inviteUser = '@bob:other.org';
      await component.doInvite();
      expect(matrix.invite).toHaveBeenCalledWith('!r:test', '@bob:other.org');
    });
  });

  // ───────── CROSS-USER ISOLATION: domain-locked caller — SOCIAL LOCAL-ONLY ─────────
  describe('domain-locked caller: cross-domain (federation) invites are blocked, local ones allowed', () => {
    beforeEach(async () => {
      TestBed.inject(SessionService).set(sessionWith(['user', 'matrix_domainlocked']));
      fixture = TestBed.createComponent(RoomSettingsComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    });

    it('reads the domain lock + derives the caller local server from the hsproxy whoami()', () => {
      expect(component.domainLocked()).toBeTrue();
      expect(matrix.whoami).toHaveBeenCalled();
      expect(component.localServer()).toBe('test');
    });

    it('renders a LOCAL-ONLY note announced as a status', () => {
      const note = fixture.nativeElement.querySelector('[data-testid="invite-domain-lock-note"]');
      expect(note).toBeTruthy();
      expect(note.getAttribute('role')).toBe('status');
      expect((note.textContent || '').toLowerCase()).toContain('domain-locked');
    });

    it('DENY: disables the invite button + wires WHY-helptext for a CROSS-DOMAIN target', () => {
      component.inviteUser = '@bob:other.org';
      fixture.detectChanges();
      expect(component.inviteIsRemote()).toBeTrue();
      expect(component.inviteBlocked()).toBeTrue();
      const btn = fixture.nativeElement.querySelector('[data-testid="btn-room-invite"]');
      expect(btn.disabled).toBeTrue();
      expect(btn.getAttribute('aria-describedby')).toBe('rs-invite-help');
      const help = fixture.nativeElement.querySelector('[data-testid="invite-help"]');
      expect((help.textContent || '').toLowerCase()).toContain('cross-domain');
    });

    it('DENY: doInvite refuses a cross-domain target server-side-style (never calls invite), surfacing WHY', async () => {
      component.inviteUser = '@bob:other.org';
      await component.doInvite();
      expect(matrix.invite).not.toHaveBeenCalled();
      expect((component.status() || '').toLowerCase()).toContain('cross-domain');
    });

    it('ALLOW: a SAME-DOMAIN invite is not blocked and goes through', async () => {
      component.inviteUser = '@carol:test';
      fixture.detectChanges();
      expect(component.inviteIsRemote()).toBeFalse();
      expect(component.inviteBlocked()).toBeFalse();
      const btn = fixture.nativeElement.querySelector('[data-testid="btn-room-invite"]');
      expect(btn.disabled).toBeFalse();
      await component.doInvite();
      expect(matrix.invite).toHaveBeenCalledWith('!r:test', '@carol:test');
    });
  });

  // ───────── Mesh bridge (LoRa): power-level-gated per-room setting ─────────
  describe('Mesh bridge (LoRa) section', () => {
    it('explains the bridge, the @mesh-* sender mapping and the unauthenticated-node-id caution', () => {
      const help = fixture.nativeElement.querySelector('[data-testid="rs-mesh-help"]');
      expect(help.textContent).toContain('both ways');
      expect(help.textContent).toContain('@mesh-*');
      expect(help.textContent.toLowerCase()).toContain('not cryptographically authenticated');
    });

    it('associates the mesh controls with explicit <label for>', () => {
      const el = fixture.nativeElement;
      for (const id of ['rs-mesh-enabled', 'rs-mesh-device', 'rs-mesh-channel']) {
        expect(el.querySelector(`#${id}`)).withContext(id).toBeTruthy();
        expect(el.querySelector(`label[for="${id}"]`)).withContext(`label ${id}`).toBeTruthy();
      }
    });

    // Default stub: @alice:test holds no users entry (users_default 0 < the
    // moderator floor), so she may NOT change the bridge.
    describe('DENY: a below-power-level member', () => {
      it('greys out every mesh control with WHY-helptext (never a bare disabled control)', () => {
        expect(component.canEditMeshBridge()).toBeFalse();
        const el = fixture.nativeElement;
        for (const tid of ['input-mesh-enabled', 'input-mesh-device', 'input-mesh-channel', 'btn-save-mesh']) {
          const control = el.querySelector(`[data-testid="${tid}"]`);
          expect(control.disabled).withContext(tid).toBeTrue();
          expect(control.getAttribute('aria-describedby')).withContext(tid).toContain('rs-mesh-locked-help');
        }
        const why = el.querySelector('[data-testid="mesh-locked-help"]');
        expect((why.textContent || '').toLowerCase()).toContain('power level');
      });

      it('saveMeshBridge refuses without touching the wire, surfacing WHY', async () => {
        await component.saveMeshBridge();
        expect(matrix.setStateEvent).not.toHaveBeenCalledWith(
          '!r:test', MESH_BRIDGE_STATE_TYPE, jasmine.anything());
        expect(matrix.invite).not.toHaveBeenCalled();
        expect((component.status() || '').toLowerCase()).toContain('power level');
      });
    });

    describe('ALLOW: a moderator (PL 50) caller', () => {
      beforeEach(async () => {
        matrix.roomSummary.and.resolveTo({
          name: 'General',
          topic: 'Chat',
          powerLevels: { users: { '@alice:test': 50 }, usersDefault: 0, events: {}, eventsDefault: 0, stateDefault: 50, ban: 50, kick: 50, redact: 50, invite: 0 },
        } as RoomSummary);
        matrix.getStateEvent.and.resolveTo({ enabled: true, device: 'lora-1', meshChannel: 3 });
        fixture = TestBed.createComponent(RoomSettingsComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        // A second flush: load()'s chain is THREE promise hops deep here
        // (paramMap subscribe -> load -> meshBridge.getMeshBridgeState ->
        // matrix.getStateEvent), one hop deeper than the plain name/topic load
        // above — a single whenStable() reliably resolves before that last hop
        // lands, leaving meshEnabled/meshDevice/meshChannel at their pre-load
        // defaults (and, worse, letting that hop land mid-test and stomp a
        // test's own field writes). Confirmed empirically: one whenStable()
        // flakes here, two is stable.
        await fixture.whenStable();
      });

      it('offers the controls and loads the existing bridge state off the room state event', () => {
        expect(component.canEditMeshBridge()).toBeTrue();
        expect(component.meshEnabled()).toBeTrue();
        expect(component.meshDevice()).toBe('lora-1');
        expect(component.meshChannel()).toBe(3);
        const el = fixture.nativeElement;
        expect(el.querySelector('[data-testid="btn-save-mesh"]').disabled).toBeFalse();
        expect(el.querySelector('[data-testid="mesh-locked-help"]')).toBeNull();
      });

      it('ENABLE: save writes the state AND invites the bridge bot on the caller\'s own homeserver (derived from whoami, never hardcoded)', async () => {
        component.meshEnabled.set(true);
        component.meshDevice.set('lora-1');
        component.meshChannel.set(3);
        await component.saveMeshBridge();
        expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', MESH_BRIDGE_STATE_TYPE,
          { enabled: true, device: 'lora-1', meshChannel: 3 });
        expect(matrix.invite).toHaveBeenCalledWith('!r:test', '@meshbridge:test');
        expect(component.status()).toContain('saved');
      });

      it('tolerates an already-invited/already-joined bridge bot (a rejected invite still reports saved)', async () => {
        matrix.invite.and.rejectWith(new Error('403 M_FORBIDDEN: already in the room'));
        component.meshEnabled.set(true);
        await component.saveMeshBridge();
        expect(component.status()).toContain('saved');
      });

      it('DISABLE: save only writes the state — no invite (the bridge leaves on its own)', async () => {
        component.meshEnabled.set(false);
        await component.saveMeshBridge();
        expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', MESH_BRIDGE_STATE_TYPE,
          jasmine.objectContaining({ enabled: false }));
        expect(matrix.invite).not.toHaveBeenCalled();
      });

      it('surfaces a failed state write (e.g. a race that dropped our PL) without inviting the bot', async () => {
        matrix.setStateEvent.and.rejectWith(new Error('403 M_FORBIDDEN'));
        component.meshEnabled.set(true);
        await component.saveMeshBridge();
        expect(matrix.invite).not.toHaveBeenCalled();
        expect((component.status() || '').toLowerCase()).toContain('failed');
      });

      it('wires the mesh save button + fields to present help', () => {
        const el = fixture.nativeElement as HTMLElement;
        expect(expectDescribedByHelp(el, '#rs-mesh-device').toLowerCase()).toContain('radio');
        expect(expectDescribedByHelp(el, '#rs-mesh-channel').toLowerCase()).toContain('channel');
        expect(expectDescribedByHelp(el, '[data-testid="btn-save-mesh"]').toLowerCase()).toContain('bridge bot');
      });
    });
  });

  describe('3D chat room (Shadows of the Net) section', () => {
    it('explains the 3D room and associates the controls with explicit <label for>', () => {
      const help = fixture.nativeElement.querySelector('[data-testid="rs-c3d-help"]');
      expect(help.textContent.toLowerCase()).toContain('3d');
      expect(help.textContent).toContain('WebXR');
      const el = fixture.nativeElement;
      for (const id of ['rs-c3d-enabled', 'rs-c3d-style', 'rs-c3d-max', 'rs-c3d-media', 'rs-c3d-stage']) {
        expect(el.querySelector(`#${id}`)).withContext(id).toBeTruthy();
        expect(el.querySelector(`label[for="${id}"]`)).withContext(`label ${id}`).toBeTruthy();
      }
    });

    // Default stub: @alice:test holds no users entry (users_default 0 < the
    // moderator floor), so she may NOT change the 3D room (mesh precedent).
    describe('DENY: a below-power-level member', () => {
      it('greys out every chat3d control with WHY-helptext (never a bare disabled control)', () => {
        expect(component.canEditChat3d()).toBeFalse();
        const el = fixture.nativeElement;
        for (const tid of ['input-c3d-enabled', 'input-c3d-style', 'input-c3d-max',
                           'input-c3d-media', 'input-c3d-stage', 'btn-save-chat3d']) {
          const control = el.querySelector(`[data-testid="${tid}"]`);
          expect(control.disabled).withContext(tid).toBeTrue();
          expect(control.getAttribute('aria-describedby')).withContext(tid).toContain('rs-c3d-locked-help');
        }
        const why = el.querySelector('[data-testid="chat3d-locked-help"]');
        expect((why.textContent || '').toLowerCase()).toContain('power level');
      });

      it('saveChat3d refuses without touching the wire, surfacing WHY', async () => {
        await component.saveChat3d();
        expect(matrix.setStateEvent).not.toHaveBeenCalled();
        expect((component.status() || '').toLowerCase()).toContain('power level');
      });
    });

    describe('ALLOW: a moderator (PL 50) caller', () => {
      /** The room's CURRENT power-levels content the override write must
       *  read-modify-write (users + unrelated events entries must survive). */
      const currentPl = () => ({
        users: { '@alice:test': 50, '@admin:test': 100 },
        users_default: 0,
        state_default: 50,
        events: { 'm.room.name': 50 },
      });

      beforeEach(async () => {
        matrix.roomSummary.and.resolveTo({
          name: 'General',
          topic: 'Chat',
          powerLevels: { users: { '@alice:test': 50 }, usersDefault: 0, events: {}, eventsDefault: 0, stateDefault: 50, ban: 50, kick: 50, redact: 50, invite: 0 },
        } as RoomSummary);
        // getStateEvent serves THREE reads here: the mesh-bridge load (null),
        // the chat3d load (an existing enabled room), and saveChat3d's
        // power-levels read-modify-write.
        matrix.getStateEvent.and.callFake((_rid: string, type: string) => {
          if (type === CHAT3D_STATE_TYPE) {
            return Promise.resolve({ enabled: true, style: 'default', maxParticipants: 12, allowMedia: false, stageModOnly: false });
          }
          if (type === 'm.room.power_levels') {
            return Promise.resolve(currentPl());
          }
          return Promise.resolve(null);
        });
        fixture = TestBed.createComponent(RoomSettingsComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
        // load()'s chat3d hop sits one promise deeper than the mesh hop the
        // mesh ALLOW block settles with two rounds — settle with slack.
        for (let i = 0; i < 4; i++) {
          await fixture.whenStable();
        }
        fixture.detectChanges();
      });

      it('offers the controls and loads the existing chat3d state off the room state event', () => {
        expect(component.canEditChat3d()).toBeTrue();
        expect(component.chat3dEnabled()).toBeTrue();
        expect(component.chat3dStyle()).toBe('default');
        expect(component.chat3dMaxParticipants()).toBe(12);
        expect(component.chat3dAllowMedia()).toBeFalse();
        expect(component.chat3dStageModOnly()).toBeFalse();
        const el = fixture.nativeElement;
        expect(el.querySelector('[data-testid="btn-save-chat3d"]').disabled).toBeFalse();
        expect(el.querySelector('[data-testid="chat3d-locked-help"]')).toBeNull();
      });

      it('ENABLE: save writes the (normalized) state AND merges the PL overrides into the CURRENT power levels', async () => {
        component.chat3dEnabled.set(true);
        component.chat3dStyle.set('noir');
        component.chat3dMaxParticipants.set(99); // normalized to the 16-seat cap on the wire
        component.chat3dAllowMedia.set(true);
        component.chat3dStageModOnly.set(false);
        await component.saveChat3d();
        expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', CHAT3D_STATE_TYPE,
          { enabled: true, style: 'noir', maxParticipants: 16, allowMedia: true, stageModOnly: false });
        // The override write is a READ-MODIFY-WRITE: users + the unrelated
        // m.room.name events entry survive; only the two chat3d entries merge in
        // (avatar 0 = everyone dresses themselves; scene 0 because the stage is
        // not moderator-only).
        expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', 'm.room.power_levels', {
          users: { '@alice:test': 50, '@admin:test': 100 },
          users_default: 0,
          state_default: 50,
          events: { 'm.room.name': 50, [CHAT3D_AVATAR_TYPE]: 0, [CHAT3D_SCENE_TYPE]: 0 },
        });
        expect(component.status()).toContain('saved');
      });

      it('REGRESSION: the "Stage is moderator-only" helptext describes what the save REALLY does '
         + '(it locks every surface, not just the stage)', async () => {
        // The override written when the box is ticked is
        // events[chat3d.scene] = 50, which gates the WHOLE scene event — so a
        // PL-0 member cannot place on the tables or the screens either. The
        // shipped copy said "other surfaces stay open to everyone".
        const help = fixture.nativeElement.querySelector('[data-testid="rs-c3d-stage-help"]').textContent as string;
        expect(help.toLowerCase()).not.toContain('other surfaces stay open');
        expect(help.toLowerCase()).toContain('only moderators can place');
        expect(help).toContain('50');
        expect(help.toLowerCase()).toContain('turn it off');
        // And the save helptext no longer promises members can place media
        // unconditionally.
        const saveHelp = fixture.nativeElement.querySelector('[data-testid="rs-c3d-save-help"]').textContent as string;
        expect(saveHelp.toLowerCase()).toContain('stage is moderator-only');
      });

      it('ENABLE with a moderator-only stage: the scene override is 50, avatars stay 0', async () => {
        component.chat3dEnabled.set(true);
        component.chat3dStageModOnly.set(true);
        await component.saveChat3d();
        const plWrite = matrix.setStateEvent.calls.allArgs().find((a) => a[1] === 'm.room.power_levels')!;
        expect(plWrite).toBeDefined();
        expect((plWrite[2] as { events: Record<string, number> }).events[CHAT3D_SCENE_TYPE]).toBe(50);
        expect((plWrite[2] as { events: Record<string, number> }).events[CHAT3D_AVATAR_TYPE]).toBe(0);
      });

      it('DISABLE: save only writes the state — the power levels are left alone', async () => {
        component.chat3dEnabled.set(false);
        await component.saveChat3d();
        expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', CHAT3D_STATE_TYPE,
          jasmine.objectContaining({ enabled: false }));
        expect(matrix.setStateEvent.calls.allArgs().some((a) => a[1] === 'm.room.power_levels')).toBeFalse();
        expect(component.status()).toContain('saved');
      });

      it('TOLERATES a refused override write with an honest note (the room still enabled)', async () => {
        matrix.setStateEvent.and.callFake((_rid: string, type: string) =>
          type === 'm.room.power_levels'
            ? Promise.reject(new Error('403 M_FORBIDDEN'))
            : Promise.resolve('$state'));
        component.chat3dEnabled.set(true);
        await component.saveChat3d();
        expect((component.status() || '').toLowerCase()).toContain('power-level overrides');
        expect((component.status() || '')).toContain('saved');
      });

      it('NEVER fabricates power levels: an unreadable PL event skips the override write with the honest note', async () => {
        // PUTting a made-up power_levels object would WIPE the room's real user
        // levels — an unreadable read must abort the override, not invent one.
        matrix.getStateEvent.and.callFake((_rid: string, type: string) =>
          type === 'm.room.power_levels'
            ? Promise.reject(new Error('500'))
            : Promise.resolve(null));
        component.chat3dEnabled.set(true);
        await component.saveChat3d();
        expect(matrix.setStateEvent.calls.allArgs().some((a) => a[1] === 'm.room.power_levels')).toBeFalse();
        expect((component.status() || '').toLowerCase()).toContain('power-level overrides');
      });

      it('surfaces a failed state write without attempting the override write', async () => {
        matrix.setStateEvent.and.rejectWith(new Error('403 M_FORBIDDEN'));
        component.chat3dEnabled.set(true);
        await component.saveChat3d();
        expect((component.status() || '').toLowerCase()).toContain('failed');
        expect(matrix.setStateEvent.calls.allArgs().some((a) => a[1] === 'm.room.power_levels')).toBeFalse();
      });

      it('wires the chat3d save button + fields to present help', () => {
        const el = fixture.nativeElement as HTMLElement;
        expect(expectDescribedByHelp(el, '#rs-c3d-max').toLowerCase()).toContain('seats 16');
        expect(expectDescribedByHelp(el, '#rs-c3d-stage').toLowerCase()).toContain('moderators');
        expect(expectDescribedByHelp(el, '[data-testid="btn-save-chat3d"]').toLowerCase()).toContain('power levels');
      });
    });
  });
});
