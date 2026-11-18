import { signInAnonymously, signInWithCustomToken, type Auth } from 'firebase/auth';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { oracleAppOptions, type OracleServiceAccount } from './oracle-credential.ts';

interface DeletableUserHandle {
  isAnonymous: boolean;
  delete(): Promise<void>;
}

interface AuthSessionSubject {
  currentUser: DeletableUserHandle | null;
}

interface SignInOracleClientDeps {
  mintCustomToken?: (serviceAccount: OracleServiceAccount, uid: string) => Promise<string>;
  signInCustomToken?: (auth: Auth, token: string) => Promise<unknown>;
  signInAnonymous?: (auth: Auth) => Promise<unknown>;
}

interface OracleRunAuthSessionOptions {
  getServiceAccount?: () => OracleServiceAccount | null;
  signOutAuth?: () => Promise<void>;
  signInProbe?: (uidHint: string) => Promise<void>;
  freshAuthProbeNames?: ReadonlySet<string>;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

interface OracleRunAuthSession {
  beforeProbe(probeName: string): Promise<void>;
  dropAfterProbeBody(): Promise<void>;
  signInProbeUser(uidHint: string): Promise<void>;
  signOutAndDeleteCurrentUser(): Promise<void>;
  observeWithRateLimitRetry<T>(probeName: string, observe: () => Promise<T>): Promise<T>;
  finishRun(): Promise<void>;
}

const DEFAULT_SIGNUP_BACKOFF_MS: readonly number[] = [15_000, 30_000, 60_000];
const INTENTIONAL_THROWING_OBSERVER_PROBE = 'auth-row-35-throwing-observer-doesnt-block-others';
const INTENTIONAL_THROWING_OBSERVER_MESSAGE = 'intentional throw from oracle probe observer #1';

/**
 * Non-`auth-*` probes in `run.ts` that mutate `auth` via `signOut(auth)` and
 * therefore opt out of shared anonymous session retention.
 */
export const FRESH_AUTH_NON_AUTH_PROBES: ReadonlySet<string> = new Set([
  'storage-rules-denied-signed-out-error-code',
  'rtdb-simulator-vs-prod-agreement',
]);

let adminTokenSeq = 0;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeOracleCustomUid(uidHint: string): string {
  const cleaned = uidHint
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let base = cleaned;
  if (!base.startsWith('pyric-')) {
    base = `pyric-${base}`;
  }
  return base.slice(0, 128);
}

async function defaultMintCustomToken(
  serviceAccount: OracleServiceAccount,
  uid: string,
): Promise<string> {
  adminTokenSeq += 1;
  const adminApp = initializeAdminApp(
    oracleAppOptions(serviceAccount),
    `oracle-custom-token-${Date.now()}-${adminTokenSeq}`,
  );
  try {
    return await getAdminAuth(adminApp).createCustomToken(uid);
  } finally {
    await deleteAdminApp(adminApp).catch(() => undefined);
  }
}

/**
 * Signs `auth` in via a service-account custom token when `serviceAccount` is
 * available (consuming zero `accounts:signUp` quota), falling back to
 * `signInAnonymously(auth)` in manual-config or unit-test runs.
 */
export async function signInOracleClientAuth(
  auth: Auth,
  serviceAccount: OracleServiceAccount | null | undefined,
  uidHint: string,
  deps: SignInOracleClientDeps = {},
): Promise<void> {
  if (serviceAccount) {
    let mint = defaultMintCustomToken;
    if (deps.mintCustomToken !== undefined) {
      mint = deps.mintCustomToken;
    }
    let signInCustom: (targetAuth: Auth, token: string) => Promise<unknown> = (targetAuth, token) =>
      signInWithCustomToken(targetAuth, token);
    if (deps.signInCustomToken !== undefined) {
      signInCustom = deps.signInCustomToken;
    }
    const uid = sanitizeOracleCustomUid(uidHint);
    const token = await mint(serviceAccount, uid);
    await signInCustom(auth, token);
    return;
  }

  let signInAnon: (targetAuth: Auth) => Promise<unknown> = (targetAuth) =>
    signInAnonymously(targetAuth);
  if (deps.signInAnonymous !== undefined) {
    signInAnon = deps.signInAnonymous;
  }
  await signInAnon(auth);
}

function isAuthTooManyRequestsError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'auth/too-many-requests') {
      return true;
    }
  }
  if (err instanceof Error && err.message.includes('auth/too-many-requests')) {
    return true;
  }
  return false;
}

interface RetryAuthRateLimitOptions {
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  beforeRetry?: () => Promise<void>;
}

export async function retryAuthTooManyRequests<T>(
  label: string,
  run: () => Promise<T>,
  options: RetryAuthRateLimitOptions = {},
): Promise<T> {
  let backoffMs = DEFAULT_SIGNUP_BACKOFF_MS;
  if (options.backoffMs !== undefined) {
    backoffMs = options.backoffMs;
  }
  let sleep = defaultSleep;
  if (options.sleep !== undefined) {
    sleep = options.sleep;
  }
  let log: (line: string) => void = (line) => console.log(line);
  if (options.log !== undefined) {
    log = options.log;
  }

  let attemptIndex = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (!isAuthTooManyRequestsError(err) || attemptIndex >= backoffMs.length) {
        throw err;
      }
      const waitMs = backoffMs[attemptIndex];
      attemptIndex += 1;
      log(
        `\n[oracle] ${label} hit auth/too-many-requests; waiting ${waitMs}ms before retry ${attemptIndex}/${backoffMs.length}`,
      );
      if (options.beforeRetry !== undefined) {
        await options.beforeRetry();
      }
      if (waitMs !== undefined) {
        await sleep(waitMs);
      }
    }
  }
}

export function createOracleRunAuthSession(
  getAuthSubject: () => AuthSessionSubject,
  options: OracleRunAuthSessionOptions = {},
): OracleRunAuthSession {
  let freshAuthProbeNames = FRESH_AUTH_NON_AUTH_PROBES;
  if (options.freshAuthProbeNames !== undefined) {
    freshAuthProbeNames = options.freshAuthProbeNames;
  }
  let backoffMs = DEFAULT_SIGNUP_BACKOFF_MS;
  if (options.backoffMs !== undefined) {
    backoffMs = options.backoffMs;
  }
  let sleep = defaultSleep;
  if (options.sleep !== undefined) {
    sleep = options.sleep;
  }
  let log: (line: string) => void = (line) => console.log(line);
  if (options.log !== undefined) {
    log = options.log;
  }

  let activeProbeName = '';

  function requiresFreshAuth(probeName: string): boolean {
    return probeName.startsWith('auth-') || freshAuthProbeNames.has(probeName);
  }

  async function deleteAnyCurrentUser(): Promise<void> {
    const current = getAuthSubject().currentUser;
    if (current) {
      try {
        await current.delete();
      } catch {
        // Best-effort cleanup when user was already deleted or signed out.
      }
    }
  }

  async function beforeProbe(probeName: string): Promise<void> {
    activeProbeName = probeName;
    if (requiresFreshAuth(probeName)) {
      await deleteAnyCurrentUser();
    }
  }

  async function dropAfterProbeBody(): Promise<void> {
    if (requiresFreshAuth(activeProbeName)) {
      await deleteAnyCurrentUser();
    }
  }

  async function signInProbeUser(uidHint: string): Promise<void> {
    if (options.signInProbe !== undefined) {
      await options.signInProbe(uidHint);
      return;
    }
    let sa: OracleServiceAccount | null = null;
    if (options.getServiceAccount !== undefined) {
      sa = options.getServiceAccount();
    }
    await signInOracleClientAuth(getAuthSubject() as unknown as Auth, sa, uidHint);
  }

  async function signOutAndDeleteCurrentUser(): Promise<void> {
    await deleteAnyCurrentUser();
    if (options.signOutAuth !== undefined) {
      await options.signOutAuth();
    }
  }

  async function runWithIntentionalObserverThrowGuard<T>(
    probeName: string,
    observe: () => Promise<T>,
  ): Promise<T> {
    if (probeName !== INTENTIONAL_THROWING_OBSERVER_PROBE) {
      return observe();
    }
    const onIntentionalThrow = (err: unknown): void => {
      if (err instanceof Error && err.message === INTENTIONAL_THROWING_OBSERVER_MESSAGE) {
        return;
      }
      throw err;
    };
    process.on('uncaughtException', onIntentionalThrow);
    process.on('unhandledRejection', onIntentionalThrow);
    try {
      const result = await observe();
      await defaultSleep(0);
      return result;
    } finally {
      process.off('uncaughtException', onIntentionalThrow);
      process.off('unhandledRejection', onIntentionalThrow);
    }
  }

  async function observeWithRateLimitRetry<T>(
    probeName: string,
    observe: () => Promise<T>,
  ): Promise<T> {
    return retryAuthTooManyRequests(
      probeName,
      () => runWithIntentionalObserverThrowGuard(probeName, observe),
      {
        backoffMs,
        sleep,
        log,
        beforeRetry: () => beforeProbe(probeName),
      },
    );
  }

  async function finishRun(): Promise<void> {
    await deleteAnyCurrentUser();
  }

  return {
    beforeProbe,
    dropAfterProbeBody,
    signInProbeUser,
    signOutAndDeleteCurrentUser,
    observeWithRateLimitRetry,
    finishRun,
  };
}
