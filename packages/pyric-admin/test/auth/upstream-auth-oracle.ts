/**
 * Offline two-layer differential oracle for installed `firebase-admin/auth`
 * (`v13.10.0`).
 *
 * -- Exact Two-Layer Oracle Boundary ------------------------------------------
 * 1. Client-side preflight (`acceptedPreflight: false`):
 *    Runs the real installed `firebase-admin/auth` with an in-memory 2048-bit
 *    RSA `cert(...)` credential (`projectId: 'demo-project'`), intercepting
 *    `authRequestHandler.httpClient.send`, `idTokenVerifier.signatureVerifier`,
 *    and `sessionCookieVerifier.signatureVerifier` BEFORE any network socket
 *    opens. Any synchronous throw or pre-HTTP rejection comes directly from
 *    `firebase-admin` itself (`TypeError` or `FirebaseAuthError` `auth/*`).
 *
 * 2. Observation-backed Identity Toolkit REST & JWT wire rules
 *    (`acceptedPreflight: true`):
 *    Requests that pass client preflight reach the intercepted Identity Toolkit
 *    wire handler (`auth-request-auth-per-sign-in.json`), enforcing server-side
 *    email format, password-requires-email, account uniqueness/existence,
 *    `listUsers` integer `maxResults` and cursor `nextPageToken`, and sandbox
 *    ID-token signature, expiry, and revocation standing.
 *
 * 3. Documented unsupported backend operations (`auth-admin#8/#10/#11/#12`):
 *    When upstream rejects at client preflight (`acceptedPreflight: false`),
 *    `pyric-admin/auth` must reject with the exact same `FirebaseAuthError`
 *    code or `TypeError`. When upstream accepts preflight for an unmodeled
 *    backend operation (`getUserByPhoneNumber`, `getUsers`, `deleteUsers`,
 *    `createSessionCookie`, `verifySessionCookie`, email action-link
 *    generators, or `updateUser` with unmodeled link/MFA/photo/phone fields),
 *    `pyric-admin/auth` rejects with its canonical `not implemented` error.
 */

import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  cert,
  deleteApp as deleteUpstreamApp,
  initializeApp as initializeUpstreamApp,
  type App as UpstreamApp,
} from 'firebase-admin/app';
import {
  getAuth as getUpstreamAuth,
  type Auth as UpstreamAuth,
} from 'firebase-admin/auth';
import { checkIdToken } from 'pyric/sandbox/internal';

const requireFromHere = createRequire(import.meta.url);
const firebaseAdminLibDir = dirname(requireFromHere.resolve('firebase-admin'));
const { RequestResponseError } = requireFromHere(
  join(firebaseAdminLibDir, 'utils', 'api-request.js'),
) as {
  RequestResponseError: new (response: HttpStubResponse) => Error;
};

export interface NormalizedAuthOutcome {
  readonly accepted: boolean;
  readonly acceptedPreflight?: boolean;
  readonly errorKind?: 'TypeError' | 'FirebaseError' | 'NotImplementedError' | 'OtherError';
  readonly code?: string;
  readonly message?: string;
}

interface HttpStubResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly data: unknown;
  readonly isJson: () => boolean;
}

interface WireUserState {
  readonly uid: string;
  email?: string;
  disabled: boolean;
  validSinceSec: number;
}

const cachedRsaKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const STRICT_WIRE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WIRE_E164_PHONE_RE = /^\+[1-9]\d{1,14}$/;

function jsonHttpResponse(status: number, payload: unknown): HttpStubResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify(payload),
    data: payload,
    isJson: () => true,
  };
}

function identityToolkitError(code: number, message: string): Promise<never> {
  const payload = { error: { code, message } };
  return Promise.reject(new RequestResponseError(jsonHttpResponse(code, payload)));
}

function compareWireUids(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function encodeCursorToken(uid: string): string {
  return Buffer.from(JSON.stringify({ v: 1, uid }), 'utf8').toString('base64url');
}

function isCanonicalWireCursorPayload(
  raw: unknown,
  token: string,
): raw is { readonly v: 1; readonly uid: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const candidate = raw as { v?: unknown; uid?: unknown };
  if (candidate.v !== 1 || typeof candidate.uid !== 'string') {
    return false;
  }
  if (candidate.uid.length === 0 || candidate.uid.length > 128) {
    return false;
  }
  return encodeCursorToken(candidate.uid) === token;
}

function decodeCursorToken(token: string): string | null {
  try {
    const raw: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (isCanonicalWireCursorPayload(raw, token)) {
      return raw.uid;
    }
  } catch {
    return null;
  }
  return null;
}

function toWireAccountPayload(account: WireUserState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    localId: account.uid,
    disabled: account.disabled,
    validSince: String(account.validSinceSec),
    createdAt: String(account.validSinceSec * 1000),
  };
  if (account.email !== undefined) {
    payload.email = account.email;
  }
  return payload;
}

function hasStringCode(error: unknown): error is { code: string; message?: unknown } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

function isNotImplementedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('is not implemented in pyric-admin/auth');
}

export function classifyAuthError(error: unknown): {
  errorKind: 'TypeError' | 'FirebaseError' | 'NotImplementedError' | 'OtherError';
  code?: string;
  message: string;
} {
  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }
  if (error instanceof TypeError) {
    return { errorKind: 'TypeError', message };
  }
  if (isNotImplementedError(error)) {
    return { errorKind: 'NotImplementedError', message };
  }
  if (hasStringCode(error)) {
    return { errorKind: 'FirebaseError', code: error.code, message };
  }
  return { errorKind: 'OtherError', message };
}

function readTransportFlag(didReachTransport?: () => boolean): boolean | undefined {
  if (didReachTransport === undefined) return undefined;
  return didReachTransport();
}

export async function captureAuthOutcome(
  invoke: () => unknown,
  didReachTransport?: () => boolean,
): Promise<NormalizedAuthOutcome> {
  try {
    await invoke();
    return {
      accepted: true,
      acceptedPreflight: readTransportFlag(didReachTransport),
    };
  } catch (error) {
    const info = classifyAuthError(error);
    return {
      accepted: false,
      acceptedPreflight: readTransportFlag(didReachTransport),
      errorKind: info.errorKind,
      code: info.code,
      message: info.message,
    };
  }
}

let upstreamAppSequence = 0;

export interface OfflineUpstreamAuthHarness {
  readonly app: UpstreamApp;
  readonly svc: UpstreamAuth;
  readonly resetState: (seedUsers: ReadonlyArray<{
    uid: string;
    email?: string;
    disabled?: boolean;
    validSinceSec?: number;
  }>, nowSec?: number) => void;
  readonly resetTransportFlag: () => void;
  readonly didReachTransport: () => boolean;
  readonly dispose: () => Promise<void>;
}

export function createOfflineUpstreamAuthHarness(): OfflineUpstreamAuthHarness {
  const app = initializeUpstreamApp(
    {
      projectId: 'demo-project',
      credential: cert({
        projectId: 'demo-project',
        clientEmail: 'svc@demo-project.iam.gserviceaccount.com',
        privateKey: cachedRsaKey.privateKey,
      }),
    },
    `upstream-auth-diff-${++upstreamAppSequence}`,
  );
  const svc = getUpstreamAuth(app);

  let reachedTransport = false;
  let currentNowSec = Math.floor(Date.UTC(2026, 5, 1, 12, 0, 0) / 1000);
  let mintedSeq = 0;
  const usersByUid = new Map<string, WireUserState>();

  const resetState: OfflineUpstreamAuthHarness['resetState'] = (seedUsers, nowSec) => {
    usersByUid.clear();
    mintedSeq = 0;
    if (nowSec !== undefined) {
      currentNowSec = nowSec;
    }
    for (const seed of seedUsers) {
      usersByUid.set(seed.uid, {
        uid: seed.uid,
        email: seed.email,
        disabled: seed.disabled === true,
        validSinceSec: seed.validSinceSec ?? currentNowSec,
      });
    }
  };

  const handleHttpSend = async (req: {
    method: string;
    url: string;
    data?: Record<string, unknown>;
  }): Promise<HttpStubResponse> => {
    reachedTransport = true;
    const body = req.data ?? {};
    const parsedUrl = new URL(req.url);

    if (parsedUrl.pathname.endsWith('/accounts:batchGet')) {
      const rawMax = body.maxResults ?? parsedUrl.searchParams.get('maxResults');
      const numMax = Number(rawMax);
      if (!Number.isInteger(numMax) || numMax <= 0 || numMax > 1000) {
        return identityToolkitError(400, 'INVALID_ARGUMENT');
      }
      let nextToken = parsedUrl.searchParams.get('nextPageToken');
      if (typeof body.nextPageToken === 'string') {
        nextToken = body.nextPageToken;
      }
      let cursorUid: string | null = null;
      if (nextToken !== null) {
        cursorUid = decodeCursorToken(nextToken);
        if (cursorUid === null) {
          return identityToolkitError(400, 'INVALID_PAGE_SELECTION');
        }
      }
      const sorted = [...usersByUid.values()].sort((a, b) => compareWireUids(a.uid, b.uid));
      let remaining = sorted;
      if (cursorUid !== null) {
        const afterUid = cursorUid;
        remaining = sorted.filter((account) => compareWireUids(account.uid, afterUid) > 0);
      }
      const page = remaining.slice(0, numMax);
      const users = page.map(toWireAccountPayload);
      const last = page[page.length - 1];
      if (last !== undefined && page.length < remaining.length) {
        return jsonHttpResponse(200, { users, nextPageToken: encodeCursorToken(last.uid) });
      }
      return jsonHttpResponse(200, { users });
    }

    if (parsedUrl.pathname.endsWith('/accounts:lookup')) {
      const localIds = body.localId as string[] | undefined;
      const emails = body.email as string[] | undefined;
      const phones = body.phoneNumber as string[] | undefined;
      if (emails !== undefined) {
        for (const em of emails) {
          if (!STRICT_WIRE_EMAIL_RE.test(em)) {
            return identityToolkitError(400, 'INVALID_EMAIL');
          }
        }
      }
      if (phones !== undefined) {
        for (const ph of phones) {
          if (!WIRE_E164_PHONE_RE.test(ph)) {
            return identityToolkitError(400, 'INVALID_PHONE_NUMBER');
          }
        }
      }
      const found: Record<string, unknown>[] = [];
      if (localIds !== undefined) {
        for (const id of localIds) {
          const hit = usersByUid.get(id);
          if (hit !== undefined) found.push(toWireAccountPayload(hit));
        }
      }
      if (emails !== undefined) {
        for (const em of emails) {
          const lower = em.toLowerCase();
          const hit = [...usersByUid.values()].find(
            (u) => u.email !== undefined && u.email.toLowerCase() === lower,
          );
          if (hit !== undefined) found.push(toWireAccountPayload(hit));
        }
      }
      return jsonHttpResponse(200, { users: found });
    }

    if (parsedUrl.pathname.endsWith('/accounts:delete')) {
      const uid = String(body.localId ?? '');
      if (!usersByUid.has(uid)) {
        return identityToolkitError(400, 'USER_NOT_FOUND');
      }
      usersByUid.delete(uid);
      return jsonHttpResponse(200, { kind: 'identitytoolkit#DeleteAccountResponse' });
    }

    if (parsedUrl.pathname.endsWith('/accounts:batchDelete')) {
      const ids = (body.localIds as string[] | undefined) ?? [];
      for (const id of ids) {
        usersByUid.delete(id);
      }
      return jsonHttpResponse(200, {});
    }

    if (parsedUrl.pathname.endsWith('/accounts:update')) {
      const uid = String(body.localId ?? '');
      const existing = usersByUid.get(uid);
      if (existing === undefined) {
        return identityToolkitError(400, 'USER_NOT_FOUND');
      }
      if (typeof body.email === 'string') {
        if (!STRICT_WIRE_EMAIL_RE.test(body.email)) {
          return identityToolkitError(400, 'INVALID_EMAIL');
        }
        const lower = body.email.toLowerCase();
        const conflict = [...usersByUid.values()].some(
          (u) => u.uid !== uid && u.email !== undefined && u.email.toLowerCase() === lower,
        );
        if (conflict) {
          return identityToolkitError(400, 'EMAIL_EXISTS');
        }
        existing.email = body.email;
      }
      if (typeof body.disableUser === 'boolean') {
        existing.disabled = body.disableUser;
      }
      if (typeof body.phoneNumber === 'string' && !WIRE_E164_PHONE_RE.test(body.phoneNumber)) {
        return identityToolkitError(400, 'INVALID_PHONE_NUMBER');
      }
      if (typeof body.validSince === 'number') {
        existing.validSinceSec = body.validSince;
      }
      return jsonHttpResponse(200, { localId: uid });
    }

    if (parsedUrl.pathname.endsWith('/accounts')) {
      let uid: string;
      if (typeof body.localId === 'string') {
        uid = body.localId;
      } else {
        mintedSeq += 1;
        uid = `wire-auto-${mintedSeq}`;
      }
      if (usersByUid.has(uid)) {
        return identityToolkitError(400, 'DUPLICATE_LOCAL_ID');
      }
      if (typeof body.email === 'string') {
        if (!STRICT_WIRE_EMAIL_RE.test(body.email)) {
          return identityToolkitError(400, 'INVALID_EMAIL');
        }
        const lower = body.email.toLowerCase();
        const conflict = [...usersByUid.values()].some(
          (u) => u.email !== undefined && u.email.toLowerCase() === lower,
        );
        if (conflict) {
          return identityToolkitError(400, 'EMAIL_EXISTS');
        }
      } else if (typeof body.password === 'string' || typeof body.rawPassword === 'string') {
        return identityToolkitError(400, 'INVALID_EMAIL');
      }
      if (typeof body.phoneNumber === 'string' && !WIRE_E164_PHONE_RE.test(body.phoneNumber)) {
        return identityToolkitError(400, 'INVALID_PHONE_NUMBER');
      }
      usersByUid.set(uid, {
        uid,
        email: typeof body.email === 'string' ? body.email : undefined,
        disabled: body.disabled === true,
        validSinceSec: currentNowSec,
      });
      return jsonHttpResponse(200, { localId: uid });
    }

    if (parsedUrl.pathname.endsWith(':createSessionCookie')) {
      return jsonHttpResponse(200, { sessionCookie: 'stub-session-cookie' });
    }

    if (parsedUrl.pathname.endsWith('/accounts:sendOobCode')) {
      const email = String(body.email ?? '');
      if (!STRICT_WIRE_EMAIL_RE.test(email)) {
        return identityToolkitError(400, 'INVALID_EMAIL');
      }
      if (typeof body.newEmail === 'string' && !STRICT_WIRE_EMAIL_RE.test(body.newEmail)) {
        return identityToolkitError(400, 'INVALID_EMAIL');
      }
      return jsonHttpResponse(200, { oobLink: 'https://example.com/__/auth/action?oobCode=stub' });
    }

    return jsonHttpResponse(200, {});
  };

  const requestHandler = (
    svc as unknown as {
      authRequestHandler: {
        httpClient: {
          send: (req: {
            method: string;
            url: string;
            data?: Record<string, unknown>;
          }) => Promise<HttpStubResponse>;
        };
      };
      idTokenVerifier: {
        signatureVerifier: { verify: (jwtToken: string) => Promise<void> };
      };
      sessionCookieVerifier: {
        signatureVerifier: { verify: (jwtToken: string) => Promise<void> };
      };
    }
  );

  requestHandler.authRequestHandler.httpClient.send = handleHttpSend;
  requestHandler.idTokenVerifier.signatureVerifier = {
    async verify(jwtToken: string): Promise<void> {
      reachedTransport = true;
      const checked = await checkIdToken(jwtToken);
      if (!checked.ok && checked.reason === 'kid') {
        const kidErr = new Error('No matching kid') as Error & { code: string };
        kidErr.code = 'no-matching-kid';
        throw kidErr;
      }
      if (!checked.ok) {
        const sigErr = new Error('Invalid signature') as Error & { code: string };
        sigErr.code = 'invalid-signature';
        throw sigErr;
      }
      const nbf = checked.claims.nbf;
      if (nbf !== undefined && (typeof nbf !== 'number' || nbf > currentNowSec)) {
        const nbfErr = new Error('Invalid signature') as Error & { code: string };
        nbfErr.code = 'invalid-signature';
        throw nbfErr;
      }
      const exp = checked.claims.exp;
      if (exp !== undefined) {
        if (typeof exp !== 'number') {
          const expTypeErr = new Error('Invalid signature') as Error & { code: string };
          expTypeErr.code = 'invalid-signature';
          throw expTypeErr;
        }
        if (currentNowSec >= exp) {
          const expiredErr = new Error('Token expired') as Error & { code: string };
          expiredErr.code = 'token-expired';
          throw expiredErr;
        }
      }
    },
  };
  requestHandler.sessionCookieVerifier.signatureVerifier = {
    async verify(): Promise<void> {
      reachedTransport = true;
    },
  };

  return {
    app,
    svc,
    resetState,
    resetTransportFlag: () => {
      reachedTransport = false;
    },
    didReachTransport: () => reachedTransport,
    dispose: async () => {
      try {
        await deleteUpstreamApp(app);
      } catch {}
    },
  };
}

const UNMODELED_BACKEND_AUTH_METHODS = new Set([
  'getUserByPhoneNumber',
  'getUsers',
  'deleteUsers',
  'createSessionCookie',
  'verifySessionCookie',
  'generatePasswordResetLink',
  'generateEmailVerificationLink',
  'generateSignInWithEmailLink',
  'generateVerifyAndChangeEmailLink',
]);

function isEmptyBatchClientBypass(methodName: string, rawArgs: readonly unknown[]): boolean {
  if (methodName !== 'getUsers' && methodName !== 'deleteUsers') return false;
  return Array.isArray(rawArgs[0]) && rawArgs[0].length === 0;
}

export function isDocumentedUnmodeledAuthBackendDiff(
  methodName: string,
  rawArgs: readonly unknown[],
  upstream: NormalizedAuthOutcome,
  pyric: NormalizedAuthOutcome,
): boolean {
  if (pyric.errorKind !== 'NotImplementedError') {
    return false;
  }
  if (UNMODELED_BACKEND_AUTH_METHODS.has(methodName)) {
    if (upstream.acceptedPreflight === true) return true;
    if (upstream.accepted && isEmptyBatchClientBypass(methodName, rawArgs)) return true;
    return false;
  }
  if (methodName === 'updateUser' && upstream.acceptedPreflight === true) {
    return true;
  }
  return false;
}
