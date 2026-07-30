import { accessibleName, defaultScreenReaderName, isPrintableAscii } from './accessible-name';

describe('accessible-name util (mirrors server ScreenReaderNames)', () => {
  describe('isPrintableAscii', () => {
    it('treats null/undefined/empty as ASCII (optional field)', () => {
      expect(isPrintableAscii(null)).toBe(true);
      expect(isPrintableAscii(undefined)).toBe(true);
      expect(isPrintableAscii('')).toBe(true);
    });

    it('accepts the printable-ASCII range U+0020..U+007E', () => {
      expect(isPrintableAscii('Alex')).toBe(true);
      expect(isPrintableAscii(' ~!@#ABC xyz 012')).toBe(true);
      expect(isPrintableAscii('~')).toBe(true); // 0x7E upper bound
      expect(isPrintableAscii(' ')).toBe(true); // 0x20 lower bound
    });

    it('rejects control chars the naive \\x00-\\x7F regex would wrongly accept', () => {
      expect(isPrintableAscii('tab\there')).toBe(false); // U+0009 (server rejects this exact case)
      expect(isPrintableAscii('a\nb')).toBe(false); // newline U+000A
      expect(isPrintableAscii('a\x00b')).toBe(false); // NUL
      expect(isPrintableAscii('a\x7Fb')).toBe(false); // DEL U+007F
    });

    it('rejects non-ASCII (accented Latin, other scripts, emoji)', () => {
      expect(isPrintableAscii('José')).toBe(false);
      expect(isPrintableAscii('山田太郎')).toBe(false);
      expect(isPrintableAscii('hi👋')).toBe(false);
    });
  });

  describe('defaultScreenReaderName (mirrors defaultFor)', () => {
    it('defaults an ASCII display name to itself', () => {
      expect(defaultScreenReaderName('Alex')).toBe('Alex');
    });

    it('returns null (=> PROMPT) for a non-ASCII display name', () => {
      expect(defaultScreenReaderName('José')).toBeNull();
      expect(defaultScreenReaderName('山田太郎')).toBeNull();
    });

    it('returns null for null/blank display names', () => {
      expect(defaultScreenReaderName(null)).toBeNull();
      expect(defaultScreenReaderName('   ')).toBeNull();
    });
  });

  describe('accessibleName', () => {
    it('announces the ASCII screenReaderName when present', () => {
      expect(accessibleName('山田太郎', 'Yamada Taro')).toBe('Yamada Taro');
    });

    it('falls back to the displayName when no screen-reader name is set', () => {
      expect(accessibleName('Alex', null)).toBe('Alex');
      expect(accessibleName('Alex', '')).toBe('Alex');
      expect(accessibleName('Alex', '   ')).toBe('Alex');
    });

    it('returns the display name even when non-ASCII if no screen-reader name exists', () => {
      expect(accessibleName('José', null)).toBe('José');
    });

    it('returns an empty string when nothing is available', () => {
      expect(accessibleName(null, null)).toBe('');
    });
  });
});
