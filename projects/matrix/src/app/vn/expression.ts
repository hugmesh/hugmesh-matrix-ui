/**
 * The CANONICAL VN-character expression vocabulary + the rule-based sentiment
 * fallback (Phase B1/B2, matrix-ui side).
 *
 * This is the TS twin of the B1 backend's single Java home for the enum —
 * hugmesh-user-bff-api `character/StickerExpression.java` — kept identical by
 * convention (the same 10 lowercase, shortcode-safe labels the DB CHECK 017 and
 * the MSC2545 `im.ponies.user_emotes` pack shortcodes use). Each label IS the
 * per-expression sticker key in the pack `images` map B1 #89 registers.
 *
 * The rule-based sentiment fallback maps message keywords/emoji to these labels
 * (e.g. `lol/😂→happy`, `sorry/😢→sad`) exactly as the B1 enum doc describes;
 * `neutral` is the default when nothing matches. It is intentionally tiny and
 * deterministic — the LIVE expression priority is `vn.expression` (explicit) >
 * this sentiment derivation > `neutral`.
 */

/** A canonical expression label (also the MSC2545 pack image shortcode). */
export type Expression =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'embarrassed'
  | 'thinking'
  | 'wink'
  | 'sleepy'
  | 'smug';

/** The 10 canonical expressions, in the B1 enum's stable order. */
export const EXPRESSIONS: readonly Expression[] = [
  'neutral', 'happy', 'sad', 'angry', 'surprised',
  'embarrassed', 'thinking', 'wink', 'sleepy', 'smug',
] as const;

/** The default expression when nothing else resolves. */
export const DEFAULT_EXPRESSION: Expression = 'neutral';

/** Whether `value` is a recognised canonical expression label. */
export function isExpression(value: unknown): value is Expression {
  return typeof value === 'string' && (EXPRESSIONS as readonly string[]).includes(value);
}

/**
 * Keyword/emoji → expression rules, evaluated in order; the first whose pattern
 * matches the (lowercased) body wins. Word-boundary anchored for the ASCII
 * keywords so `class` doesn't trip `:('-style substrings; emoji match anywhere.
 * Mirrors the B1 enum doc's examples (`lol/😂→happy`, `sorry/😢→sad`).
 */
const SENTIMENT_RULES: ReadonlyArray<{ re: RegExp; expr: Expression }> = [
  { re: /😂|🤣|😄|😁|😊|🙂|\block\b|\blol\b|\blmao\b|\bhaha\b|\bhehe\b|\byay\b|:\)|:d/i, expr: 'happy' },
  { re: /😢|😭|😞|☹️|\bsorry\b|\bsad\b|\bcry(?:ing)?\b|\bmiss you\b|:\(/i, expr: 'sad' },
  { re: /😠|😡|🤬|\bangry\b|\bmad\b|\bwtf\b|\bugh\b|\bgrr+\b/i, expr: 'angry' },
  { re: /😮|😯|😲|😱|\bwow\b|\bwhat[?!]+|\bomg\b|\bwhoa\b|\breally\?/i, expr: 'surprised' },
  { re: /😳|😅|🙈|\boops\b|\bawkward\b|\bembarrass/i, expr: 'embarrassed' },
  { re: /🤔|\bhmm+\b|\bthinking\b|\bnot sure\b|\bmaybe\b/i, expr: 'thinking' },
  { re: /😉|😜|;\)|\bwink\b/i, expr: 'wink' },
  { re: /😴|🥱|\bsleepy\b|\btired\b|\byawn\b|\bzzz+\b/i, expr: 'sleepy' },
  { re: /😏|\bsmug\b|\btold you\b|\bobviously\b|\bheh\b/i, expr: 'smug' },
];

/**
 * Derive an expression from a message body via the rule-based sentiment
 * fallback. Returns {@link DEFAULT_EXPRESSION} (`neutral`) when the body is
 * empty or no rule matches. Pure + deterministic.
 */
export function expressionFromSentiment(body: string | null | undefined): Expression {
  if (!body) {
    return DEFAULT_EXPRESSION;
  }
  for (const rule of SENTIMENT_RULES) {
    if (rule.re.test(body)) {
      return rule.expr;
    }
  }
  return DEFAULT_EXPRESSION;
}

/**
 * The LIVE expression for a timeline event content, applying the B2 priority:
 * an explicit `vn.expression` field (validated against the canonical set) >
 * the rule-based sentiment derivation of the body > `neutral`. `content` is the
 * raw Matrix event content (the `vn.expression` is a custom top-level field a
 * sender's client may stamp on its own message).
 */
export function expressionForEvent(content: unknown, body: string | null | undefined): Expression {
  const explicit = (content as Record<string, unknown> | null | undefined)?.['vn.expression'];
  if (isExpression(explicit)) {
    return explicit;
  }
  return expressionFromSentiment(body);
}
