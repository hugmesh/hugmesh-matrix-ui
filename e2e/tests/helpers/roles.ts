import { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * Catalogue of platform identities the Matrix remote's role-responsive
 * surfaces gate on. Unlike the games/admin remotes (which sign in through a
 * federated Casdoor login form), the standalone Matrix dev shell reads its
 * authenticated tier purely from `localStorage['hug.session']` — the same
 * HugSession the host shell + the login remote write (see
 * projects/matrix/src/app/session.service.ts). So the e2e seeds a session
 * object directly instead of driving a login UI, which is precisely what lets
 * the USER / MOD / ADMIN / banned matrix run WITHOUT a cluster.
 *
 * The `kind` tag drives which role-specific assertions run:
 *  - `user`   every authenticated user: USER tier (self block/mute + recommend
 *             instance block); no MOD/ADMIN tools.
 *  - `mod`    `mod` OR `admin` role: + the MOD server-wide block + queue triage.
 *  - `admin`  `admin` role only: + the (honestly STUBBED) approve/deny control.
 *  - `superadmin` `superadmin` + `admin` roles — platform superadmins ALWAYS
 *             carry `admin` too (see admin-ui SEED_USERS / RBAC
 *             SUPERADMIN > ADMIN). This UI's SessionService exposes NO
 *             distinct superadmin tier (isAdmin keys off 'admin' only, no
 *             isSuperadmin accessor), so a superadmin FOLDS INTO the admin
 *             tier here — the role-tiers scenario asserts exactly that.
 *  - `banned` role-absent / NOT fully registered: DENIED the Matrix surface
 *             (registeredGuard bounces to /login) and the moderation panel
 *             shows only the signed-out prompt.
 *
 * `domainLocked` flags the additive `matrix_domainlocked` restriction marker
 * the admin-bff folds into roles[] — cross-tenant / federation targets must be
 * greyed-out with why-helptext while local interaction stays usable.
 */
export type SeedKind = 'user' | 'mod' | 'admin' | 'superadmin' | 'banned';

export interface SeedUser {
  /** CLI-friendly handle used in feature files. */
  username: string;
  /** Display label (email / discord handle) shown in the UI. */
  label: string;
  provider: 'google' | 'discord';
  /** LOWERCASE Casdoor roles, exactly as SessionService reads them. */
  roles: string[];
  kind: SeedKind;
  /** Whether two-stage registration completed — the ROLE_MATRIX access gate
   *  (host registeredGuard keys off `registrationComplete`). */
  registrationComplete: boolean;
  /** Tenant / homeserver domain this identity belongs to — drives the
   *  cross-tenant isolation assertions. */
  tenant: string;
  /** Additive Matrix domain-lock restriction marker. */
  domainLocked?: boolean;
}

export const SEED_USERS: SeedUser[] = [
  // USER tier — a fully-registered plain member of tenant-a. Has ROLE_MATRIX
  // access; sees only the USER moderation tier.
  {
    username: 'user-alice',
    label: 'alice@tenant-a.test',
    provider: 'google',
    roles: ['user'],
    kind: 'user',
    registrationComplete: true,
    tenant: 'tenant-a.test',
  },
  // A second USER on the SAME tenant — used by the multiuser-situational
  // scenarios (one acts, the other observes the same-tier surface).
  {
    username: 'user-bob',
    label: 'bob@tenant-a.test',
    provider: 'discord',
    roles: ['user'],
    kind: 'user',
    registrationComplete: true,
    tenant: 'tenant-a.test',
  },
  // A USER on a DIFFERENT tenant — the cross-user isolation counterpart.
  {
    username: 'user-carol',
    label: 'carol@tenant-b.test',
    provider: 'google',
    roles: ['user'],
    kind: 'user',
    registrationComplete: true,
    tenant: 'tenant-b.test',
  },
  // MOD tier — `mod` role unlocks the server-wide block + queue triage.
  {
    username: 'mod-mallory',
    label: 'mallory@tenant-a.test',
    provider: 'google',
    roles: ['user', 'mod'],
    kind: 'mod',
    registrationComplete: true,
    tenant: 'tenant-a.test',
  },
  // ADMIN tier — `admin` role; additively also a mod (isMod ⊇ isAdmin).
  {
    username: 'admin-adam',
    label: 'adam@tenant-a.test',
    provider: 'google',
    roles: ['user', 'admin'],
    kind: 'admin',
    registrationComplete: true,
    tenant: 'tenant-a.test',
  },
  // SUPERADMIN — carries `superadmin` AND `admin` (platform superadmins always
  // hold the admin role too; RBAC SUPERADMIN > ADMIN, mirroring the admin-ui
  // seed catalogue). This UI has NO distinct superadmin tier: SessionService
  // exposes isUser/isMod/isAdmin only, so the superadmin FOLDS INTO the admin
  // tier — the role-tiers scenario asserts that explicitly.
  {
    username: 'superadmin-sam',
    label: 'sam@tenant-a.test',
    provider: 'google',
    roles: ['user', 'admin', 'superadmin'],
    kind: 'superadmin',
    registrationComplete: true,
    tenant: 'tenant-a.test',
  },
  // DOMAIN-LOCKED USER — carries the additive `matrix_domainlocked` marker:
  // local interaction usable, federation/cross-domain targets greyed-out.
  {
    username: 'user-dana-locked',
    label: 'dana@tenant-a.test',
    provider: 'google',
    roles: ['user', 'matrix_domainlocked'],
    kind: 'user',
    registrationComplete: true,
    tenant: 'tenant-a.test',
    domainLocked: true,
  },
  // BANNED / role-absent — NOT fully registered, so the host registeredGuard
  // DENIES the Matrix surface and the moderation panel shows only the
  // signed-out prompt. Models the "platform-role ROLE_MATRIX absent" case.
  {
    username: 'banned-eve',
    label: 'eve@tenant-a.test',
    provider: 'google',
    roles: [],
    kind: 'banned',
    registrationComplete: false,
    tenant: 'tenant-a.test',
  },
];

/** The localStorage key the HugSession SessionService persists under. */
export const SESSION_KEY = 'hug.session';

/**
 * The Matrix user id a seed persona resolves to on the LIVE stack (the cluster
 * scenarios kick/invite by Matrix id). Overridable per persona via
 * `E2E_MATRIX_ID_<USERNAME>` (dashes → underscores, uppercased) when the seeded
 * environment maps identities differently; defaults to
 * `@<username>:<tenant>` — the generator seed-job convention.
 */
export function matrixIdFor(user: SeedUser): string {
  const envKey = `E2E_MATRIX_ID_${user.username.replace(/-/g, '_').toUpperCase()}`;
  return process.env[envKey] ?? `@${user.username}:${user.tenant}`;
}

/** Shape of the persisted HugSession (mirrors SessionService.HugSession).
 *  Post-cutover the browser holds NO bearer of any kind — no Matrix/Mastodon
 *  access token, and no bff_ session bearer either. Every /bff/* call rides the
 *  HttpOnly `bff_` session cookie (credentials: 'include'); only non-secret
 *  identity metadata persists in localStorage. */
export interface HugSession {
  id: string;
  label: string;
  provider: 'google' | 'discord';
  roles: string[];
  registrationComplete: boolean;
}

/** Build the persisted HugSession a seed user would carry after login. The
 *  UI gating reads only roles[] + registrationComplete — no token is involved.
 *  The identity's tenant scope rides on `id`/`label` (no Matrix userId is
 *  stored). NOTE: this seeds ONLY the non-secret metadata; it carries no
 *  HttpOnly `bff_` cookie, so a seeded (non-`login()`) session cannot pass the
 *  server-side @PreAuthorize gates — only the client-side role-tier gating. */
export function sessionFor(user: SeedUser): HugSession {
  return {
    id: `${user.provider}:${user.label}`,
    label: user.label,
    provider: user.provider,
    roles: user.roles,
    registrationComplete: user.registrationComplete,
  };
}

/** Create a fresh context that trusts the e2e self-signed cert AND inherits the
 *  config baseURL — `browser.newContext()` does NOT inherit project-level `use`
 *  options, so a hand-rolled context misses ignoreHTTPSErrors and every HTTPS
 *  request fails the cert check. Specs that need two users in parallel (the
 *  cross-user isolation scenarios) MUST call this instead. */
export async function newE2eContext(browser: Browser): Promise<BrowserContext> {
  return await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: process.env.E2E_BASE_URL ?? 'https://host.docker.internal:8080',
  });
}

/**
 * Seed a HugSession into localStorage so the role-responsive surfaces render
 * the seeded user's tier. We navigate to the app origin first (localStorage is
 * origin-scoped and unavailable on about:blank), write the key, then reload so
 * SessionService's constructor re-reads it. For a `banned` user we explicitly
 * CLEAR the key — the absence of a session is the "role absent" condition.
 */
export async function seedSession(page: Page, user: SeedUser): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  if (user.kind === 'banned') {
    await page.evaluate((key) => window.localStorage.removeItem(key), SESSION_KEY);
    return;
  }
  await page.evaluate(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    { key: SESSION_KEY, value: sessionFor(user) },
  );
  // Re-read so the in-page SessionService signal reflects the seeded session
  // before the first guarded navigation.
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/** Read the persisted roles[] back off localStorage — lets a step assert the
 *  seeded tier without trusting the in-memory signal. */
export async function persistedRoles(page: Page): Promise<string[]> {
  return await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    try {
      return (JSON.parse(raw) as { roles?: string[] }).roles ?? [];
    } catch {
      return [];
    }
  }, SESSION_KEY);
}
