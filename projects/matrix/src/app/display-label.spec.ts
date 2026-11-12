import { displayLabel, isMxid, localpartOf } from './display-label';

describe('displayLabel (how a Matrix user is NAMED on screen)', () => {
  const UUID = '@c18f905c-62a1-4c20-a7c5-c707fb6eae85:hugmesh.local';

  it('prefers the display name, trimmed', () => {
    expect(displayLabel('@alice:test', 'Alice')).toBe('Alice');
    expect(displayLabel('@alice:test', '  Alice  ')).toBe('Alice');
  });

  it('falls back to the LOCALPART, never the full @local:server', () => {
    expect(displayLabel('@alice:test')).toBe('alice');
    expect(displayLabel('@alice:test', '')).toBe('alice');
    expect(displayLabel('@alice:test', '   ')).toBe('alice');
    expect(displayLabel('@alice:test', null)).toBe('alice');
    expect(displayLabel(UUID)).toBe('c18f905c-62a1-4c20-a7c5-c707fb6eae85');
    expect(displayLabel(UUID)).not.toContain(':');
  });

  it('keeps a server part that itself carries a port intact when splitting', () => {
    expect(localpartOf('@bob:matrix.test:8448')).toBe('bob');
  });

  it('passes a non-mxid (an instance domain, free text) through unchanged', () => {
    expect(displayLabel('evil.test')).toBe('evil.test');
    expect(displayLabel('not an id')).toBe('not an id');
    expect(isMxid('evil.test')).toBeFalse();
    expect(isMxid('@spam:evil.test')).toBeTrue();
  });

  it('is empty for an absent id with no name', () => {
    expect(displayLabel(null)).toBe('');
    expect(displayLabel(undefined, undefined)).toBe('');
    expect(isMxid(null)).toBeFalse();
  });
});
