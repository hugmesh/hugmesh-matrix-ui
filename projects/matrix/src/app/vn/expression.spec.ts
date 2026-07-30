import {
  DEFAULT_EXPRESSION,
  EXPRESSIONS,
  expressionForEvent,
  expressionFromSentiment,
  isExpression,
} from './expression';

describe('expression (vocabulary + sentiment fallback)', () => {
  it('exposes the 10 canonical labels (B1 StickerExpression twin), neutral default', () => {
    expect(EXPRESSIONS.length).toBe(10);
    expect(EXPRESSIONS).toContain('neutral');
    expect(EXPRESSIONS).toContain('smug');
    expect(DEFAULT_EXPRESSION).toBe('neutral');
  });

  it('isExpression accepts only canonical labels', () => {
    expect(isExpression('happy')).toBeTrue();
    expect(isExpression('neutral')).toBeTrue();
    expect(isExpression('ecstatic')).toBeFalse();
    expect(isExpression(null)).toBeFalse();
    expect(isExpression(42)).toBeFalse();
  });

  it('maps keywords/emoji to expressions (lol/😂→happy, sorry/😢→sad)', () => {
    expect(expressionFromSentiment('lol that is great')).toBe('happy');
    expect(expressionFromSentiment('😂😂')).toBe('happy');
    expect(expressionFromSentiment('sorry about that')).toBe('sad');
    expect(expressionFromSentiment('😢')).toBe('sad');
    expect(expressionFromSentiment('I am so angry rn')).toBe('angry');
    expect(expressionFromSentiment('wow what?!')).toBe('surprised');
    expect(expressionFromSentiment('hmm maybe')).toBe('thinking');
  });

  it('defaults to neutral for empty / unmatched bodies', () => {
    expect(expressionFromSentiment('')).toBe('neutral');
    expect(expressionFromSentiment(null)).toBe('neutral');
    expect(expressionFromSentiment('the meeting is at noon')).toBe('neutral');
  });

  describe('expressionForEvent — priority vn.expression > sentiment > neutral', () => {
    it('uses an explicit canonical vn.expression over the body sentiment', () => {
      // Body says "happy" via lol, but the explicit field wins.
      expect(expressionForEvent({ 'vn.expression': 'angry' }, 'lol')).toBe('angry');
    });

    it('ignores a non-canonical vn.expression and falls back to sentiment', () => {
      expect(expressionForEvent({ 'vn.expression': 'bogus' }, 'lol')).toBe('happy');
    });

    it('falls back to sentiment when there is no vn.expression', () => {
      expect(expressionForEvent({ msgtype: 'm.text' }, 'sorry')).toBe('sad');
    });

    it('falls back to neutral when neither field nor sentiment matches', () => {
      expect(expressionForEvent({}, 'hello world')).toBe('neutral');
      expect(expressionForEvent(null, null)).toBe('neutral');
    });
  });
});
