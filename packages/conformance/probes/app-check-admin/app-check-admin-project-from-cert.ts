import { generateKeyPairSync } from 'node:crypto';
import {
  type App,
  type AppOptions,
  cert,
  type Credential,
  deleteApp,
  initializeApp,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import type { Probe } from '../../rigs/types.ts';

interface ProjectResolutionCase {
  resolvedProjectId: string | null;
  appOptionsHasProjectIdKey: boolean;
  appOptionsProjectId: string | null;
}

interface ProjectFromCertBehavior {
  snakeCaseCertOverEnv: ProjectResolutionCase;
  camelCaseCertOverEnv: ProjectResolutionCase;
  explicitOptionOverCert: ProjectResolutionCase;
  googleCloudProjectOverGcloudProject: ProjectResolutionCase;
}

const INERT_CREDENTIAL: Credential = {
  getAccessToken: async () => ({
    access_token: '',
    expires_in: 0,
  }),
};

function encodeAudienceProbeJwt(): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'demo-kid' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      aud: ['projects/probe-unmatched'],
      iss: 'https://firebaseappcheck.googleapis.com/123456789012',
      sub: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    }),
  ).toString('base64url');
  const signature = Buffer.from('stub-signature').toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function parseExpectedProjectFromAudienceError(message: string): string | null {
  const match = /Expected "projects\/([^"]+)"/.exec(message);
  if (!match) {
    return null;
  }
  const captured = match[1];
  if (typeof captured !== 'string') {
    return null;
  }
  return captured;
}

export async function observeProjectFromCert(): Promise<ProjectFromCertBehavior> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const probeJwt = encodeAudienceProbeJwt();
  const createdApps: App[] = [];
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let seq = 0;

  const inspectCase = async (options: AppOptions): Promise<ProjectResolutionCase> => {
    seq += 1;
    const app = initializeApp(options, `admin-cert-project-${runSuffix}-${seq}`);
    createdApps.push(app);

    let resolvedProjectId: string | null = null;
    try {
      await getAppCheck(app).verifyToken(probeJwt);
    } catch (error) {
      const shaped = error as { message?: unknown };
      if (typeof shaped.message === 'string') {
        resolvedProjectId = parseExpectedProjectFromAudienceError(shaped.message);
      }
    }

    const appOptionsHasProjectIdKey = Object.prototype.hasOwnProperty.call(
      app.options,
      'projectId',
    );
    let appOptionsProjectId: string | null = null;
    if (typeof app.options.projectId === 'string') {
      appOptionsProjectId = app.options.projectId;
    }

    return {
      resolvedProjectId,
      appOptionsHasProjectIdKey,
      appOptionsProjectId,
    };
  };

  const keys = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'FIREBASE_CONFIG'] as const;
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
  }
  process.env.GOOGLE_CLOUD_PROJECT = 'demo-env';
  process.env.GCLOUD_PROJECT = 'demo-gcloud';
  delete process.env.FIREBASE_CONFIG;

  try {
    const snakeCaseAccount = {
      project_id: 'demo-cert',
      private_key: privateKey,
      client_email: 'sa@demo-cert.iam.gserviceaccount.com',
    } as unknown as ServiceAccount;
    const camelCaseAccount: ServiceAccount = {
      projectId: 'demo-camel',
      privateKey,
      clientEmail: 'sa@demo-camel.iam.gserviceaccount.com',
    };

    const snakeCaseCertOverEnv = await inspectCase({
      credential: cert(snakeCaseAccount),
    });
    const camelCaseCertOverEnv = await inspectCase({
      credential: cert(camelCaseAccount),
    });
    const explicitOptionOverCert = await inspectCase({
      projectId: 'demo-option',
      credential: cert(snakeCaseAccount),
    });
    const googleCloudProjectOverGcloudProject = await inspectCase({
      credential: INERT_CREDENTIAL,
    });

    return {
      snakeCaseCertOverEnv,
      camelCaseCertOverEnv,
      explicitOptionOverCert,
      googleCloudProjectOverGcloudProject,
    };
  } finally {
    await Promise.all(createdApps.map((app) => deleteApp(app).catch(() => undefined)));
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

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'app-check-admin#project-from-cert',
  rowIds: ['app-check-admin#project-from-cert'],
  description:
    'firebase-admin projectId resolution for getAppCheck(): cert({ project_id }) and cert({ projectId }) supply the project without copying projectId into app.options, explicit options.projectId wins over cert(), and cert() wins over GOOGLE_CLOUD_PROJECT and GCLOUD_PROJECT.',
  async observe() {
    const observed = await observeProjectFromCert();
    return { ...observed };
  },
};
