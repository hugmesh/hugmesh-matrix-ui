import { TestBed } from '@angular/core/testing';
import { MatrixService, TimelineEvent } from '../matrix.service';
import { randomChar3dConfig } from './char3d-config';
import {
  CHAT3D_AVATAR_TYPE,
  Chat3dAvatarService,
  Chat3dAvatarState,
  MAX_AVATAR_EVENT_BYTES,
  ROOM_MEMBER_TYPE,
  joinedMembersFrom,
  parseChat3dAvatarState,
} from './chat3d-avatar.service';

class MatrixStub {
  setStateEvent = jasmine.createSpy('setStateEvent').and.resolveTo('$evt:1');
  roomState = jasmine.createSpy('roomState').and.resolveTo([]);
}

const config = () => randomChar3dConfig('spec-seed');

/** A valid forge-mode avatar content. */
function forgeContent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, mode: 'forge', config: config(), sticker: null, name: 'Vex', ...over };
}

function avatarEvent(owner: string, content: unknown, sender = owner): TimelineEvent {
  return {
    type: CHAT3D_AVATAR_TYPE, content, sender, stateKey: owner,
    eventId: `$${owner}`, roomId: '!r:test', originServerTs: 0,
  } as unknown as TimelineEvent;
}

/** An `m.room.member` row exactly as `/rooms/{id}/state` returns it. */
function memberEvent(member: string, membership = 'join'): TimelineEvent {
  return {
    type: ROOM_MEMBER_TYPE, content: { membership }, sender: member, stateKey: member,
    eventId: `$m${member}`, roomId: '!r:test', originServerTs: 0,
  } as unknown as TimelineEvent;
}

/** Every mxid mentioned, joined — the shape a real state fetch always has. */
const joined = (...members: string[]) => members.map((m) => memberEvent(m));

describe('parseChat3dAvatarState (untrusted per-member content)', () => {
  it('parses forge/guest configs and billboard stickers', () => {
    const forge = parseChat3dAvatarState(forgeContent())!;
    expect(forge.mode).toBe('forge');
    expect(forge.config).not.toBeNull();
    expect(forge.sticker).toBeNull();
    expect(forge.name).toBe('Vex');

    const guest = parseChat3dAvatarState({ v: 1, mode: 'guest', config: config(), sticker: null, name: 'Guest x' })!;
    expect(guest.mode).toBe('guest');

    const billboard = parseChat3dAvatarState({ v: 1, mode: 'billboard', config: null, sticker: 'mxc://test/abc', name: 'alice' })!;
    expect(billboard).toEqual({ mode: 'billboard', config: null, sticker: 'mxc://test/abc', name: 'alice' });
  });

  it('rejects non-objects, unknown keys, and a wrong/missing version', () => {
    expect(parseChat3dAvatarState(null)).toBeNull();
    expect(parseChat3dAvatarState('x')).toBeNull();
    expect(parseChat3dAvatarState([forgeContent()])).toBeNull();
    expect(parseChat3dAvatarState(forgeContent({ smuggled: true }))).toBeNull();
    expect(parseChat3dAvatarState(forgeContent({ v: 2 }))).toBeNull();
    const noVersion = forgeContent();
    delete noVersion['v'];
    expect(parseChat3dAvatarState(noVersion)).toBeNull();
  });

  it('rejects an unknown mode', () => {
    expect(parseChat3dAvatarState(forgeContent({ mode: 'hologram' }))).toBeNull();
    expect(parseChat3dAvatarState(forgeContent({ mode: 7 }))).toBeNull();
  });

  it('forge/guest REQUIRE a config passing the full §3 mirror validation', () => {
    expect(parseChat3dAvatarState(forgeContent({ config: null }))).toBeNull();
    expect(parseChat3dAvatarState(forgeContent({ config: { schemaVersion: 1, hacked: true } }))).toBeNull();
  });

  it('billboard REQUIRES an mxc:// sticker URL', () => {
    expect(parseChat3dAvatarState({ v: 1, mode: 'billboard', config: null, sticker: 'https://evil/img.png', name: '' })).toBeNull();
    expect(parseChat3dAvatarState({ v: 1, mode: 'billboard', config: null, sticker: null, name: '' })).toBeNull();
    expect(parseChat3dAvatarState({ v: 1, mode: 'billboard', config: null, sticker: 'mxc://' + 'x'.repeat(600), name: '' })).toBeNull();
  });

  it(`rejects content over ${MAX_AVATAR_EVENT_BYTES} bytes (hostile padding)`, () => {
    expect(parseChat3dAvatarState(forgeContent({ name: 'n'.repeat(10_000) }))).toBeNull();
  });

  it('truncates an overlong-but-under-cap name', () => {
    expect(parseChat3dAvatarState(forgeContent({ name: 'n'.repeat(500) }))!.name.length).toBe(120);
    expect(parseChat3dAvatarState(forgeContent({ name: 7 }))!.name).toBe('');
  });
});

describe('Chat3dAvatarService', () => {
  let service: Chat3dAvatarService;
  let matrix: MatrixStub;

  beforeEach(() => {
    matrix = new MatrixStub();
    TestBed.configureTestingModule({
      providers: [{ provide: MatrixService, useValue: matrix }],
    });
    service = TestBed.inject(Chat3dAvatarService);
  });

  it('publishes MY avatar with state_key = my mxid and the exact envelope shape', async () => {
    const state: Chat3dAvatarState = { mode: 'guest', config: config(), sticker: null, name: 'Guest spec' };

    const ok = await service.publishMyAvatar('!r:test', '@alice:test', state);

    expect(ok).toBeTrue();
    expect(matrix.setStateEvent).toHaveBeenCalledWith(
      '!r:test',
      CHAT3D_AVATAR_TYPE,
      { v: 1, mode: 'guest', config: config(), sticker: null, name: 'Guest spec' },
      '@alice:test',
    );
  });

  it('refuses to publish an INVALID state (a peer would reject it anyway)', async () => {
    const ok = await service.publishMyAvatar('!r:test', '@alice:test', {
      mode: 'forge', config: null, sticker: null, name: 'broken',
    });
    expect(ok).toBeFalse();
    expect(matrix.setStateEvent).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT publish: rejected PUT ⇒ false; missing room/user ⇒ false without the wire', async () => {
    matrix.setStateEvent.and.rejectWith(new Error('403'));
    expect(await service.publishMyAvatar('!r:test', '@alice:test', { mode: 'guest', config: config(), sticker: null, name: '' })).toBeFalse();
    expect(await service.publishMyAvatar('', '@alice:test', { mode: 'guest', config: config(), sticker: null, name: '' })).toBeFalse();
    expect(await service.publishMyAvatar('!r:test', '', { mode: 'guest', config: config(), sticker: null, name: '' })).toBeFalse();
    expect(matrix.setStateEvent).toHaveBeenCalledTimes(1);
  });

  it('reads all valid avatars keyed by owner mxid', async () => {
    matrix.roomState.and.resolveTo([
      ...joined('@alice:test', '@bob:test'),
      avatarEvent('@alice:test', forgeContent()),
      avatarEvent('@bob:test', { v: 1, mode: 'billboard', config: null, sticker: 'mxc://t/b', name: 'bob' }),
      { type: 'm.room.name', content: { name: 'x' }, sender: '@x:test', stateKey: '' } as unknown as TimelineEvent,
    ]);
    const avatars = await service.getAvatarStates('!r:test');
    expect(Object.keys(avatars).sort()).toEqual(['@alice:test', '@bob:test']);
    expect(avatars['@bob:test'].mode).toBe('billboard');
  });

  it('IDENTITY BIND: skips events whose state_key is not the sender\'s own mxid', async () => {
    matrix.roomState.and.resolveTo([
      ...joined('@alice:test', '@bob:test', '@mallory:test'),
      // Spoof attempt: mallory publishes an avatar under alice's state key.
      avatarEvent('@alice:test', forgeContent({ name: 'not-alice' }), '@mallory:test'),
      // Non-mxid state key never binds to anyone.
      avatarEvent('shared', forgeContent(), '@mallory:test'),
      avatarEvent('@bob:test', forgeContent({ name: 'bob' })),
    ]);
    const avatars = await service.getAvatarStates('!r:test');
    expect(Object.keys(avatars)).toEqual(['@bob:test']);
  });

  it('skips malformed rows and FAIL-SOFTS a thrown read to an empty roster', async () => {
    matrix.roomState.and.resolveTo([
      ...joined('@alice:test', '@bob:test'),
      avatarEvent('@alice:test', { v: 1, mode: 'forge', config: { junk: true }, sticker: null, name: '' }),
      avatarEvent('@bob:test', forgeContent({ name: 'bob' })),
    ]);
    expect(Object.keys(await service.getAvatarStates('!r:test'))).toEqual(['@bob:test']);

    matrix.roomState.and.rejectWith(new Error('network'));
    expect(await service.getAvatarStates('!r:test')).toEqual({});
    expect(await service.getAvatarStates('')).toEqual({});
  });

  it('accepts a pre-fetched stateEvents array without re-fetching', async () => {
    const events = [...joined('@alice:test'), avatarEvent('@alice:test', forgeContent())];
    const avatars = await service.getAvatarStates('!r:test', events);
    expect(Object.keys(avatars)).toEqual(['@alice:test']);
    expect(matrix.roomState).not.toHaveBeenCalled();
  });

  // ───────────────────── MEMBERSHIP BIND (ghost participants) ─────────────────────

  it('REGRESSION: a member who LEFT, was KICKED or was BANNED stops being a 3D participant '
     + 'even though their avatar state event survives', async () => {
    // Matrix keeps the avatar state row after the membership flips — nothing
    // retracts a departed member's avatar for them, and no UI anywhere can.
    matrix.roomState.and.resolveTo([
      memberEvent('@alice:test', 'join'),
      memberEvent('@gone:test', 'leave'),
      memberEvent('@kicked:test', 'leave'),
      memberEvent('@banned:test', 'ban'),
      memberEvent('@invited:test', 'invite'), // invited ≠ in the room
      avatarEvent('@alice:test', forgeContent({ name: 'alice' })),
      avatarEvent('@gone:test', forgeContent({ name: 'gone' })),
      avatarEvent('@kicked:test', forgeContent({ name: 'kicked' })),
      avatarEvent('@banned:test', forgeContent({ name: 'banned' })),
      avatarEvent('@invited:test', forgeContent({ name: 'invited' })),
    ]);

    // Without the membership bind all five render forever, every client keeps
    // addressing m.call.* signalling to them, and — because the A/V admitted
    // set is the lexicographically first `maxParticipants` mxids — the four
    // ghosts permanently occupy seats that nothing can free.
    expect(Object.keys(await service.getAvatarStates('!r:test'))).toEqual(['@alice:test']);
  });

  it('REGRESSION: a re-JOINED member comes back (the bind reads the CURRENT membership, '
     + 'not a one-way blacklist)', async () => {
    matrix.roomState.and.resolveTo([
      memberEvent('@back:test', 'join'),
      avatarEvent('@back:test', forgeContent({ name: 'back' })),
    ]);
    expect(Object.keys(await service.getAvatarStates('!r:test'))).toEqual(['@back:test']);
  });

  it('FAIL-CLOSED: a state array carrying no membership rows yields an EMPTY roster, '
     + 'never an unverified one', async () => {
    // A real /rooms/{id}/state response always carries the membership rows; a
    // truncated/filtered array is the only way here, and admitting everybody
    // unverified is strictly worse than admitting nobody.
    const avatars = await service.getAvatarStates('!r:test', [
      avatarEvent('@alice:test', forgeContent()),
      avatarEvent('@bob:test', forgeContent()),
    ]);
    expect(avatars).toEqual({});
  });

  it('joinedMembersFrom reads only JOINED, mxid-keyed membership rows', () => {
    const set = joinedMembersFrom([
      memberEvent('@a:test', 'join'),
      memberEvent('@b:test', 'leave'),
      memberEvent('@c:test', 'ban'),
      memberEvent('@d:test', 'invite'),
      memberEvent('@e:test', 'knock'),
      // A non-mxid state key can never name a member.
      { type: ROOM_MEMBER_TYPE, content: { membership: 'join' }, sender: '@x:test', stateKey: 'not-an-mxid' } as unknown as TimelineEvent,
      // Malformed/missing content must not throw or admit.
      { type: ROOM_MEMBER_TYPE, content: null, sender: '@f:test', stateKey: '@f:test' } as unknown as TimelineEvent,
      { type: ROOM_MEMBER_TYPE, content: { membership: 1 }, sender: '@g:test', stateKey: '@g:test' } as unknown as TimelineEvent,
      // A non-membership event never contributes.
      avatarEvent('@h:test', forgeContent()),
    ]);
    expect([...set]).toEqual(['@a:test']);
  });

  // ───────────────────── RETRACT (releasing the seat on exit) ─────────────────────

  it('RETRACT writes an EMPTY avatar content, which every receiver\'s strict parse drops', async () => {
    expect(await service.retractMyAvatar('!r:test', '@alice:test')).toBeTrue();
    expect(matrix.setStateEvent).toHaveBeenCalledWith('!r:test', CHAT3D_AVATAR_TYPE, {}, '@alice:test');
    // The retracted row must read back as "no avatar" — Matrix has no state
    // deletion, so an empty content IS the retract only if the parse rejects it.
    expect(parseChat3dAvatarState({})).toBeNull();
    const readBack = await service.getAvatarStates('!r:test', [
      memberEvent('@alice:test', 'join'),
      avatarEvent('@alice:test', {}),
    ]);
    expect(readBack).toEqual({});
  });

  it('RETRACT is fail-soft: a refused PUT or a missing room/user resolves false, never throws', async () => {
    matrix.setStateEvent.and.rejectWith(new Error('403'));
    expect(await service.retractMyAvatar('!r:test', '@alice:test')).toBeFalse();
    expect(await service.retractMyAvatar('', '@alice:test')).toBeFalse();
    expect(await service.retractMyAvatar('!r:test', '')).toBeFalse();
    expect(matrix.setStateEvent).toHaveBeenCalledTimes(1);
  });
});
