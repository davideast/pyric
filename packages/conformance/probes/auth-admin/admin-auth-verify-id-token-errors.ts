import { type Credential, deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import type { Probe } from '../../rigs/types.ts';
import { resolveProbeWebConfig, withAdminAuthProbeSession } from '../../src/sdk-probe-runtime.ts';

interface VerifyCallOutcome {
  mode: 'sync-throw' | 'rejected' | 'resolved';
  code: string | null;
  message: string | null;
}

interface VerifyIdTokenErrorsBehavior {
  nonStringToken: VerifyCallOutcome;
  emptyStringToken: VerifyCallOutcome;
  malformedJwt: VerifyCallOutcome;
  missingKidJwt: VerifyCallOutcome;
  wrongAlgorithmJwt: VerifyCallOutcome;
  wrongAudienceApp: VerifyCallOutcome;
  wrongIssuerJwt: VerifyCallOutcome;
  tamperedSignatureJwt: VerifyCallOutcome;
}

const INERT_CREDENTIAL: Credential = {
  getAccessToken: async () => ({
    access_token: '',
    expires_in: 0,
  }),
};

function encodeJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = Buffer.from('stub-signature').toString('base64url');
  return `${h}.${p}.${s}`;
}

export function rewriteJwtClaim(token: string, claim: string, value: unknown): string {
  const parts = token.split('.');
  const headerPart = parts[0] ?? '';
  const payloadPart = parts[1] ?? '';
  const sigPart = parts[2] ?? '';
  const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  decoded[claim] = value;
  const nextPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  return `${headerPart}.${nextPayload}.${sigPart}`;
}

export function tamperJwtSignature(token: string): string {
  const parts = token.split('.');
  const headerPart = parts[0] ?? '';
  const payloadPart = parts[1] ?? '';
  const sigPart = parts[2] ?? '';
  let suffix = 'AA';
  if (sigPart.endsWith('AA')) {
    suffix = 'BB';
  }
  const flipped = `${sigPart.slice(0, Math.max(0, sigPart.length - 2))}${suffix}`;
  return `${headerPart}.${payloadPart}.${flipped}`;
}

export function scrubVerifyIdTokenMessage(rawMessage: string, projectId: string): string {
  if (projectId.length === 0) {
    return rawMessage;
  }
  return rawMessage.replaceAll(projectId, '<projectId>');
}

function shapeVerifyError(
  mode: 'sync-throw' | 'rejected',
  error: unknown,
  projectId: string,
): VerifyCallOutcome {
  const shaped = error as { code?: unknown; message?: unknown };
  let code: string | null = null;
  if (typeof shaped.code === 'string') {
    code = shaped.code;
  }
  let message = String(error);
  if (typeof shaped.message === 'string') {
    message = shaped.message;
  }
  return {
    mode,
    code,
    message: scrubVerifyIdTokenMessage(message, projectId),
  };
}

async function captureVerifyIdTokenCall(
  invoke: () => Promise<unknown>,
  projectId: string,
): Promise<VerifyCallOutcome> {
  let pending: Promise<unknown>;
  try {
    pending = invoke();
  } catch (error) {
    return shapeVerifyError('sync-throw', error, projectId);
  }
  try {
    await pending;
    return {
      mode: 'resolved',
      code: null,
      message: null,
    };
  } catch (error) {
    return shapeVerifyError('rejected', error, projectId);
  }
}

export async function observeLocalVerifyIdTokenPreSignatureChecks(
  projectId = 'demo-project',
): Promise<{
  nonStringToken: VerifyCallOutcome;
  emptyStringToken: VerifyCallOutcome;
  malformedJwt: VerifyCallOutcome;
  missingKidJwt: VerifyCallOutcome;
  wrongAlgorithmJwt: VerifyCallOutcome;
}> {
  const appName = `admin-auth-local-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const app = initializeAdminApp({ credential: INERT_CREDENTIAL, projectId }, appName);
  const auth = getAdminAuth(app);
  const baseClaims = {
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: 'user-1',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  };
  try {
    const nonStringToken = await captureVerifyIdTokenCall(
      () => auth.verifyIdToken(123 as unknown as string),
      projectId,
    );
    const emptyStringToken = await captureVerifyIdTokenCall(() => auth.verifyIdToken(''), projectId);
    const malformedJwt = await captureVerifyIdTokenCall(
      () => auth.verifyIdToken('not-a-jwt'),
      projectId,
    );
    const missingKidJwt = await captureVerifyIdTokenCall(
      () => auth.verifyIdToken(encodeJwt({ alg: 'RS256', typ: 'JWT' }, baseClaims)),
      projectId,
    );
    const wrongAlgorithmJwt = await captureVerifyIdTokenCall(
      () =>
        auth.verifyIdToken(
          encodeJwt({ alg: 'HS256', typ: 'JWT', kid: 'demo-kid' }, baseClaims),
        ),
      projectId,
    );
    return {
      nonStringToken,
      emptyStringToken,
      malformedJwt,
      missingKidJwt,
      wrongAlgorithmJwt,
    };
  } finally {
    await deleteAdminApp(app).catch(() => undefined);
  }
}

export const probe: Probe = {
  rig: 'admin-auth',
  requires: ['admin-auth', 'web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/auth verifyIdToken rejection modes and error codes across non-string input, empty string, malformed JWT, missing kid, non-RS256 alg, wrong project audience, wrong issuer, and tampered RSA signature on a real Firebase ID token.',
  async observe(): Promise<Record<string, unknown>> {
    return withAdminAuthProbeSession(
      async ({ runId, uidPrefix, adminAuth, serviceAccount, createProbeUser }) => {
        const [{ deleteApp, initializeApp }, clientAuthMod] = await Promise.all([
          import('firebase/app'),
          import('firebase/auth'),
        ]);
        const webConfig = await resolveProbeWebConfig(serviceAccount);
        const clientApp = initializeApp(webConfig, `admin-auth-verify-client-${runId}`);
        const foreignApp = initializeAdminApp(
          { credential: INERT_CREDENTIAL, projectId: 'another-project' },
          `admin-auth-verify-foreign-${runId}`,
        );

        try {
          const uid = `${uidPrefix}-verify`;
          await createProbeUser({ uid });
          const customToken = await adminAuth.createCustomToken(uid);
          const clientAuth = clientAuthMod.getAuth(clientApp);
          await clientAuth.setPersistence(clientAuthMod.inMemoryPersistence);
          const cred = await clientAuthMod.signInWithCustomToken(clientAuth, customToken);
          const validIdToken = await cred.user.getIdToken();

          const projectId = serviceAccount.project_id;
          const baseClaims = {
            aud: projectId,
            iss: `https://securetoken.google.com/${projectId}`,
            sub: uid,
            iat: 1_700_000_000,
            exp: 1_700_003_600,
          };

          const nonStringToken = await captureVerifyIdTokenCall(
            () => adminAuth.verifyIdToken(123 as unknown as string),
            projectId,
          );
          const emptyStringToken = await captureVerifyIdTokenCall(
            () => adminAuth.verifyIdToken(''),
            projectId,
          );
          const malformedJwt = await captureVerifyIdTokenCall(
            () => adminAuth.verifyIdToken('not-a-jwt'),
            projectId,
          );
          const missingKidJwt = await captureVerifyIdTokenCall(
            () => adminAuth.verifyIdToken(encodeJwt({ alg: 'RS256', typ: 'JWT' }, baseClaims)),
            projectId,
          );
          const wrongAlgorithmJwt = await captureVerifyIdTokenCall(
            () =>
              adminAuth.verifyIdToken(
                encodeJwt({ alg: 'HS256', typ: 'JWT', kid: 'demo-kid' }, baseClaims),
              ),
            projectId,
          );
          const wrongAudienceApp = await captureVerifyIdTokenCall(
            () => getAdminAuth(foreignApp).verifyIdToken(validIdToken),
            projectId,
          );
          const wrongIssuerJwt = await captureVerifyIdTokenCall(
            () =>
              adminAuth.verifyIdToken(
                rewriteJwtClaim(validIdToken, 'iss', 'https://example.com/issuer'),
              ),
            projectId,
          );
          const tamperedSignatureJwt = await captureVerifyIdTokenCall(
            () => adminAuth.verifyIdToken(tamperJwtSignature(validIdToken)),
            projectId,
          );

          const behavior: VerifyIdTokenErrorsBehavior = {
            nonStringToken,
            emptyStringToken,
            malformedJwt,
            missingKidJwt,
            wrongAlgorithmJwt,
            wrongAudienceApp,
            wrongIssuerJwt,
            tamperedSignatureJwt,
          };
          return { ...behavior };
        } finally {
          await deleteApp(clientApp).catch(() => undefined);
          await deleteAdminApp(foreignApp).catch(() => undefined);
        }
      },
    );
  },
};
