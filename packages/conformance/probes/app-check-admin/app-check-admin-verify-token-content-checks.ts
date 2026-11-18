import { type App, type Credential, deleteApp, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import type { Probe } from '../../rigs/types.ts';

interface AdminVerifyCallOutcome {
  mode: 'sync-throw' | 'rejected' | 'resolved';
  code: string | null;
  message: string | null;
}

interface VerifyTokenContentChecksBehavior {
  optionsNull: AdminVerifyCallOutcome;
  nonStringToken: AdminVerifyCallOutcome;
  missingProjectId: AdminVerifyCallOutcome;
  invalidBase64UrlSegment: AdminVerifyCallOutcome;
  wrongAlgorithm: AdminVerifyCallOutcome;
  wrongAudience: AdminVerifyCallOutcome;
  wrongIssuer: AdminVerifyCallOutcome;
  missingSub: AdminVerifyCallOutcome;
  nonStringSub: AdminVerifyCallOutcome;
  emptySub: AdminVerifyCallOutcome;
}

const PROJECT_ID = 'demo-project';
const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:0a1b2c3d4e5f60718293a4`;

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

function shapeAdminError(
  mode: 'sync-throw' | 'rejected',
  error: unknown,
): AdminVerifyCallOutcome {
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
    message,
  };
}

async function captureAdminVerifyCall(
  invoke: () => Promise<unknown>,
): Promise<AdminVerifyCallOutcome> {
  let pending: Promise<unknown>;
  try {
    pending = invoke();
  } catch (error) {
    return shapeAdminError('sync-throw', error);
  }
  try {
    await pending;
    return {
      mode: 'resolved',
      code: null,
      message: null,
    };
  } catch (error) {
    return shapeAdminError('rejected', error);
  }
}

async function withClearedProjectEnv<T>(operation: () => Promise<T>): Promise<T> {
  const keys = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'FIREBASE_CONFIG'] as const;
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return await operation();
  } finally {
    for (const key of keys) {
      const prev = saved.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}

export async function observeVerifyTokenContentChecks(): Promise<VerifyTokenContentChecksBehavior> {
  const createdApps: App[] = [];
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let seq = 0;

  const makeApp = (projectId: string | null): App => {
    seq += 1;
    const appName = `admin-verify-content-${runSuffix}-${seq}`;
    if (projectId === null) {
      const app = initializeApp({ credential: INERT_CREDENTIAL }, appName);
      createdApps.push(app);
      return app;
    }
    const app = initializeApp({ credential: INERT_CREDENTIAL, projectId }, appName);
    createdApps.push(app);
    return app;
  };

  const baseHeader = { alg: 'RS256', typ: 'JWT', kid: 'demo-kid' };
  const baseClaims = {
    aud: [`projects/${PROJECT_NUMBER}`, `projects/${PROJECT_ID}`],
    iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
    sub: APP_ID,
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  };
  const validShapeToken = encodeJwt(baseHeader, baseClaims);

  try {
    const defaultService = getAppCheck(makeApp(PROJECT_ID));
    const optionsNull = await captureAdminVerifyCall(() =>
      defaultService.verifyToken(validShapeToken, null as never),
    );
    const nonStringToken = await captureAdminVerifyCall(() =>
      defaultService.verifyToken(42 as unknown as string),
    );
    const missingProjectId = await withClearedProjectEnv(async () => {
      const noProjectService = getAppCheck(makeApp(null));
      return captureAdminVerifyCall(() => noProjectService.verifyToken(validShapeToken));
    });
    const invalidBase64UrlSegment = await captureAdminVerifyCall(() =>
      defaultService.verifyToken(`${validShapeToken}=`),
    );
    const wrongAlgorithm = await captureAdminVerifyCall(() =>
      defaultService.verifyToken(encodeJwt({ ...baseHeader, alg: 'HS256' }, baseClaims)),
    );
    const anotherProjectService = getAppCheck(makeApp('another-project'));
    const wrongAudience = await captureAdminVerifyCall(() =>
      anotherProjectService.verifyToken(validShapeToken),
    );
    const wrongIssuer = await captureAdminVerifyCall(() =>
      defaultService.verifyToken(
        encodeJwt(baseHeader, { ...baseClaims, iss: 'https://example.com/123' }),
      ),
    );
    const { sub: _omittedSub, ...claimsWithoutSub } = baseClaims;
    const missingSub = await captureAdminVerifyCall(() =>
      defaultService.verifyToken(encodeJwt(baseHeader, claimsWithoutSub)),
    );
    const nonStringSub = await captureAdminVerifyCall(() =>
      defaultService.verifyToken(encodeJwt(baseHeader, { ...baseClaims, sub: 123 })),
    );
    const emptySub = await captureAdminVerifyCall(() =>
      defaultService.verifyToken(encodeJwt(baseHeader, { ...baseClaims, sub: '' })),
    );

    return {
      optionsNull,
      nonStringToken,
      missingProjectId,
      invalidBase64UrlSegment,
      wrongAlgorithm,
      wrongAudience,
      wrongIssuer,
      missingSub,
      nonStringSub,
      emptySub,
    };
  } finally {
    await Promise.all(createdApps.map((app) => deleteApp(app).catch(() => undefined)));
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/app-check verifyToken pre-signature validation order and error contracts: synchronous throws for non-object options and non-string token, async rejection with app-check/invalid-credential when no projectId is configured, base64url decode rejection, and ordered content checks for alg, aud, iss, missing sub, non-string sub, and empty sub.',
  async observe() {
    const observed = await observeVerifyTokenContentChecks();
    return { ...observed };
  },
};
