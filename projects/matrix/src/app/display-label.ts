/**
 * The ONE rule for naming a Matrix user on screen.
 *
 * Every surface that shows a person used to fall back to the full
 * `@localpart:server` mxid when no display name was known, and a handful
 * (signed-in-as, inviter, power users, moderation targets) always rendered
 * the raw id. Mesh accounts are provisioned with an opaque localpart, so those
 * surfaces showed `@c18f905c-…:server` where a person expected a name.
 *
 * `displayLabel` prefers the member/profile display name, then the localpart.
 * A value that is not an mxid at all (an instance domain on a server-wide
 * block, a free-text target) passes through unchanged. Callers that need the
 * server (moderation, settings) keep the full id reachable as secondary text
 * or a `title`.
 */

const MXID = /^@([^:]+):(.+)$/;

/** Whether `value` parses as a Matrix user id (`@local:server`). */
export function isMxid(value: string | null | undefined): boolean {
  return !!value && MXID.test(value);
}

/**
 * The localpart of a Matrix user id (`@local:server` → `local`); the input
 * itself when it doesn't parse (fail-soft — it only feeds display copy).
 */
export function localpartOf(userId: string | null | undefined): string {
  if (!userId) return '';
  const m = MXID.exec(userId);
  return m ? m[1] : userId;
}

/**
 * What to SHOW for a user: the trimmed display name when there is one, else
 * the localpart of the id (never the full `@local:server`), else the input
 * unchanged when it is not an mxid.
 */
export function displayLabel(userId: string | null | undefined, displayName?: string | null): string {
  const name = displayName?.trim();
  if (name) return name;
  return localpartOf(userId);
}
