/**
 * Live-project client + Admin Auth probe session and JWT inspection helpers for
 * modular `firebase/auth` probes (`probes/auth/auth-*.ts`).
 *
 * Lazily imports `firebase/*` and `firebase-admin/*` so `loadModularProbes`
 * stays fast, isolates all accounts under run-scoped UIDs and emails, and
 * deletes every tracked client or Admin UID in `finally`.
 */
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import type { Auth as ClientAuth } from 'firebase/auth';
import type { Auth as AdminAuth, CreateRequest, UserRecord } from 'firebase-admin/auth';
import { loadOracleServiceAccount, oracleAppOptions } from './oracle-credential.ts';
import { resolveProbeWebConfig } from './sdk-probe-runtime.ts';

interface AuthAttemptOutcome {
  [key: string]: unknown;
  threw: boolean;
  errorName: string | null;
  isFirebaseError: boolean;
  code: string | null;
}

export function observeSyncAuthAttempt(
  attempt: () => unknown,
  firebaseErrorCtor: abstract new (...args: never[]) => Error,
): AuthAttemptOutcome {
  try {
    attempt();
    return { threw: false, errorName: null, isFirebaseError: false, code: null };
  } catch (err) {
    const candidate = err as { name?: unknown; code?: unknown };
    let errorName: string | null = null;
    if (typeof candidate?.name === 'string') {
      errorName = candidate.name;
    }
    let code: string | null = null;
    if (typeof candidate?.code === 'string') {
      code = candidate.code;
    }
    return {
      threw: true,
      errorName,
      isFirebaseError: err instanceof firebaseErrorCtor,
      code,
    };
  }
}

export async function observeAsyncAuthAttempt(
  attempt: () => Promise<unknown>,
  firebaseErrorCtor: abstract new (...args: never[]) => Error,
): Promise<AuthAttemptOutcome> {
  try {
    await attempt();
    return { threw: false, errorName: null, isFirebaseError: false, code: null };
  } catch (err) {
    const candidate = err as { name?: unknown; code?: unknown };
    let errorName: string | null = null;
    if (typeof candidate?.name === 'string') {
      errorName = candidate.name;
    }
    let code: string | null = null;
    if (typeof candidate?.code === 'string') {
      code = candidate.code;
    }
    return {
      threw: true,
      errorName,
      isFirebaseError: err instanceof firebaseErrorCtor,
      code,
    };
  }
}

interface ClientAuthProbeContext {
  runId: string;
  uidPrefix: string;
  auth: ClientAuth;
  authSdk: typeof import('firebase/auth');
  adminAuth: AdminAuth;
  createAuxiliaryClientApp(label: string, customOptions?: FirebaseOptions): FirebaseApp;
  nextUid(label: string): string;
  nextEmail(label: string): string;
  nextPhoneNumber(): string;
  trackUid(uid: string): string;
  createProbeUser(properties: CreateRequest & { uid: string }): Promise<UserRecord>;
}

interface DecodedJwtParts {
  segmentCount: number;
  allSegmentsBase64Url: boolean;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

const BASE64URL_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export function decodeJwtParts(token: string): DecodedJwtParts {
  const segments = token.split('.');
  const allSegmentsBase64Url =
    segments.length > 0 && segments.every((seg) => BASE64URL_SEGMENT_RE.test(seg));
  if (segments.length !== 3) {
    return {
      segmentCount: segments.length,
      allSegmentsBase64Url,
      header: {},
      payload: {},
    };
  }
  const rawHeaderSegment = segments[0] ?? '';
  const rawPayloadSegment = segments[1] ?? '';
  const headerRaw = Buffer.from(rawHeaderSegment, 'base64url').toString('utf8');
  const payloadRaw = Buffer.from(rawPayloadSegment, 'base64url').toString('utf8');
  return {
    segmentCount: 3,
    allSegmentsBase64Url,
    header: JSON.parse(headerRaw) as Record<string, unknown>,
    payload: JSON.parse(payloadRaw) as Record<string, unknown>,
  };
}

export function deepEqualJsonValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = canonicalizeJson(record[key]);
    }
    return out;
  }
  return value;
}

function generateRunToken(): string {
  const stamp = Date.now().toString(36);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `authu_${stamp}_${nonce}`;
}

export async function withClientAuthProbeSession(
  runProbe: (ctx: ClientAuthProbeContext) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const [
    { deleteApp, initializeApp },
    authSdk,
    adminAppMod,
    { getAuth: getAdminAuth },
  ] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase-admin/app'),
    import('firebase-admin/auth'),
  ]);

  const sa = await loadOracleServiceAccount();
  const webConfig = await resolveProbeWebConfig(sa);
  const runId = generateRunToken();
  const uidPrefix = `pyric-uprobe-${runId}`;

  const clientApp = initializeApp(webConfig as FirebaseOptions, `sdk-probe-auth-client-${runId}`);
  const auth = authSdk.getAuth(clientApp);
  const adminApp = adminAppMod.initializeApp(
    oracleAppOptions(sa),
    `sdk-probe-auth-admin-${runId}`,
  );
  const adminAuth = getAdminAuth(adminApp);
  const trackedUids = new Set<string>();
  const auxiliaryApps: FirebaseApp[] = [];

  try {
    return await runProbe({
      runId,
      uidPrefix,
      auth,
      authSdk,
      adminAuth,
      createAuxiliaryClientApp(label: string, customOptions?: FirebaseOptions): FirebaseApp {
        const opts = customOptions ?? (webConfig as FirebaseOptions);
        const auxApp = initializeApp(opts, `sdk-probe-auth-aux-${runId}-${label}`);
        auxiliaryApps.push(auxApp);
        return auxApp;
      },
      nextUid(label: string): string {
        const uid = `${uidPrefix}-${label}`;
        trackedUids.add(uid);
        return uid;
      },
      nextEmail(label: string): string {
        return `${uidPrefix}-${label}@example.com`;
      },
      nextPhoneNumber(): string {
        const digits = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
        return `+1555${digits}`;
      },
      trackUid(uid: string): string {
        trackedUids.add(uid);
        return uid;
      },
      async createProbeUser(properties: CreateRequest & { uid: string }): Promise<UserRecord> {
        trackedUids.add(properties.uid);
        return adminAuth.createUser(properties);
      },
    });
  } finally {
    await authSdk.signOut(auth).catch(() => undefined);
    for (const auxApp of auxiliaryApps) {
      await deleteApp(auxApp).catch(() => undefined);
    }
    await deleteApp(clientApp).catch(() => undefined);
    for (const uid of trackedUids) {
      try {
        await adminAuth.deleteUser(uid);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code !== 'auth/user-not-found') {
          console.error(`[sdk-probes] warning: failed to delete test user ${uid}: ${String(err)}`);
        }
      }
    }
    await adminAppMod.deleteApp(adminApp).catch(() => undefined);
  }
}
