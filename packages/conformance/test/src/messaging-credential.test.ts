import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type { Credential } from 'firebase-admin/app';
import {
  FIREBASE_MESSAGING_SCOPE,
  loadMessagingServiceAccount,
  messagingAccessToken,
  messagingProjectId,
  messagingSendEndpoint,
  selectMessagingCredentialSource,
  type MessagingCredentialDeps,
} from '../../src/messaging-credential.ts';
import { oracleAppOptions, type OracleKey } from '../../src/oracle-credential.ts';

const ORACLE_ACCOUNT = 'firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const key: OracleKey = {
  project_id: 'key-project',
  client_email: 'key-sa@key-project.iam.gserviceaccount.com',
  private_key: privateKey,
};

function base64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function adcCredential(email: string): Credential {
  return {
    getAccessToken: async () => ({ access_token: 'adc-token', expires_in: 3600 }),
    getServiceAccountEmail: async () => email,
  } as Credential;
}

interface Recorded {
  certKeys: OracleKey[];
  adcCalls: number;
  logs: string[];
  warnings: string[];
}

function fakeDeps(email = ORACLE_ACCOUNT): { deps: MessagingCredentialDeps; recorded: Recorded } {
  const recorded: Recorded = { certKeys: [], adcCalls: 0, logs: [], warnings: [] };
  const deps: MessagingCredentialDeps = {
    log: (message) => recorded.logs.push(message),
    warn: (message) => recorded.warnings.push(message),
    cert(certKey) {
      recorded.certKeys.push(certKey);
      return { getAccessToken: async () => ({ access_token: 'cert-token', expires_in: 3600 }) };
    },
    applicationDefault() {
      recorded.adcCalls += 1;
      return adcCredential(email);
    },
  };
  return { deps, recorded };
}

describe('selectMessagingCredentialSource', () => {
  it('uses the base64 key when its variable is set', () => {
    expect(selectMessagingCredentialSource({ PYRIC_MESSAGING_SA_BASE64: base64(key) })).toBe('base64-key');
  });

  it('uses Application Default Credentials when the key is unset or empty', () => {
    expect(selectMessagingCredentialSource({})).toBe('application-default');
    expect(selectMessagingCredentialSource({ PYRIC_MESSAGING_SA_BASE64: '' })).toBe('application-default');
  });
});

describe('messagingProjectId', () => {
  it('prefers the messaging project variable', () => {
    const env = { PYRIC_MESSAGING_PROJECT_ID: 'messaging', PYRIC_ORACLE_PROJECT_ID: 'digame-mas' };
    expect(messagingProjectId(env)).toBe('messaging');
  });

  it('falls back to the oracle project', () => {
    expect(messagingProjectId({ PYRIC_ORACLE_PROJECT_ID: 'digame-mas' })).toBe('digame-mas');
    expect(messagingProjectId({ PYRIC_MESSAGING_PROJECT_ID: '', PYRIC_ORACLE_PROJECT_ID: 'digame-mas' })).toBe('digame-mas');
  });

  it('is undefined when neither is set', () => {
    expect(messagingProjectId({})).toBeUndefined();
  });
});

describe('loadMessagingServiceAccount with a base64 key', () => {
  it('decodes the key, takes its project, and never touches ADC', async () => {
    const { deps, recorded } = fakeDeps();
    const sa = await loadMessagingServiceAccount({ PYRIC_MESSAGING_SA_BASE64: base64(key) }, deps);
    expect(sa.kind).toBe('key-file');
    expect(sa.project_id).toBe('key-project');
    expect(recorded.certKeys).toEqual([key]);
    expect(recorded.adcCalls).toBe(0);
    expect(recorded.logs).toEqual([
      '[messaging] credential: key from PYRIC_MESSAGING_SA_BASE64 for key-sa@key-project.iam.gserviceaccount.com, project key-project',
    ]);
  });

  it('wins over the project variables', async () => {
    const { deps } = fakeDeps();
    const env = { PYRIC_MESSAGING_SA_BASE64: base64(key), PYRIC_ORACLE_PROJECT_ID: 'digame-mas' };
    const sa = await loadMessagingServiceAccount(env, deps);
    expect(sa.project_id).toBe('key-project');
  });

  it('accepts a messaging project variable that names the key project', async () => {
    const { deps } = fakeDeps();
    const env = { PYRIC_MESSAGING_SA_BASE64: base64(key), PYRIC_MESSAGING_PROJECT_ID: 'key-project' };
    expect((await loadMessagingServiceAccount(env, deps)).project_id).toBe('key-project');
  });

  it('refuses a key for another project than the messaging project variable', async () => {
    const { deps } = fakeDeps();
    const env = { PYRIC_MESSAGING_SA_BASE64: base64(key), PYRIC_MESSAGING_PROJECT_ID: 'digame-mas' };
    await expect(loadMessagingServiceAccount(env, deps)).rejects.toThrow(
      'PYRIC_MESSAGING_SA_BASE64 is a key for project key-project, but PYRIC_MESSAGING_PROJECT_ID is digame-mas.',
    );
  });

  it('refuses a value that is not a whole key', async () => {
    const { deps } = fakeDeps();
    const env = { PYRIC_MESSAGING_SA_BASE64: base64({ project_id: 'key-project' }) };
    await expect(loadMessagingServiceAccount(env, deps)).rejects.toThrow(
      'does not decode to a service-account key with project_id, client_email, and private_key',
    );
  });
});

describe('loadMessagingServiceAccount with Application Default Credentials', () => {
  it('runs on the oracle project when no messaging project is named', async () => {
    const { deps, recorded } = fakeDeps();
    const sa = await loadMessagingServiceAccount({ PYRIC_ORACLE_PROJECT_ID: 'digame-mas' }, deps);
    expect(sa.kind).toBe('application-default');
    expect(sa.project_id).toBe('digame-mas');
    expect(recorded.adcCalls).toBe(1);
    expect(recorded.certKeys).toEqual([]);
    expect(recorded.logs).toEqual([
      `[oracle] credential: Application Default Credentials for ${ORACLE_ACCOUNT}, project digame-mas`,
    ]);
  });

  it('uses the messaging project variable over the oracle project', async () => {
    const { deps } = fakeDeps('fcm-sa@messaging-project.iam.gserviceaccount.com');
    const env = { PYRIC_MESSAGING_PROJECT_ID: 'messaging-project', PYRIC_ORACLE_PROJECT_ID: 'digame-mas' };
    expect((await loadMessagingServiceAccount(env, deps)).project_id).toBe('messaging-project');
  });

  it('refuses to start with no project to send for', async () => {
    const { deps, recorded } = fakeDeps();
    await expect(loadMessagingServiceAccount({}, deps)).rejects.toThrow(
      'Set PYRIC_MESSAGING_PROJECT_ID, or PYRIC_ORACLE_PROJECT_ID when messaging runs on the oracle project.',
    );
    expect(recorded.adcCalls).toBe(0);
  });

  it('refuses an account from another project, naming the messaging variable', async () => {
    const { deps } = fakeDeps('legacy@genkit-idx.iam.gserviceaccount.com');
    await expect(loadMessagingServiceAccount({ PYRIC_ORACLE_PROJECT_ID: 'digame-mas' }, deps)).rejects.toThrow(
      'act as legacy@genkit-idx.iam.gserviceaccount.com, which belongs to project genkit-idx, but PYRIC_MESSAGING_PROJECT_ID is digame-mas',
    );
  });

  it('refuses a login that names no service account', async () => {
    const { deps } = fakeDeps();
    const userLogin: MessagingCredentialDeps = {
      ...deps,
      applicationDefault: () => ({ getAccessToken: async () => ({ access_token: 'user', expires_in: 3600 }) }),
    };
    await expect(loadMessagingServiceAccount({ PYRIC_ORACLE_PROJECT_ID: 'digame-mas' }, userLogin)).rejects.toThrow(
      'Application Default Credentials name no service account',
    );
  });

  it('warns when GOOGLE_APPLICATION_CREDENTIALS replaces the gcloud login', async () => {
    const { deps, recorded } = fakeDeps();
    const env = { PYRIC_ORACLE_PROJECT_ID: 'digame-mas', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/old.json' };
    await loadMessagingServiceAccount(env, deps);
    expect(recorded.warnings).toHaveLength(1);
    expect(recorded.warnings[0]).toContain('PYRIC_MESSAGING_SA_BASE64 is unset and GOOGLE_APPLICATION_CREDENTIALS is set');
  });
});

describe('the send helpers', () => {
  it('builds the v1 send endpoint for the credential project', async () => {
    const { deps } = fakeDeps();
    const sa = await loadMessagingServiceAccount({ PYRIC_ORACLE_PROJECT_ID: 'digame-mas' }, deps);
    expect(messagingSendEndpoint(sa)).toBe('https://fcm.googleapis.com/v1/projects/digame-mas/messages:send');
  });

  it('sends with the ADC token and names the impersonated account to firebase-admin', async () => {
    const { deps } = fakeDeps();
    const sa = await loadMessagingServiceAccount({ PYRIC_ORACLE_PROJECT_ID: 'digame-mas' }, deps);
    expect(await messagingAccessToken(sa)).toBe('adc-token');
    expect(oracleAppOptions(sa)).toMatchObject({ projectId: 'digame-mas', serviceAccountId: ORACLE_ACCOUNT });
  });

  it('asks a key for the firebase.messaging scope', async () => {
    const { deps } = fakeDeps();
    const sa = await loadMessagingServiceAccount({ PYRIC_MESSAGING_SA_BASE64: base64(key) }, deps);
    const realFetch = globalThis.fetch;
    let assertion = '';
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
      return new Response(JSON.stringify({ access_token: 'minted' }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await messagingAccessToken(sa)).toBe('minted');
    } finally {
      globalThis.fetch = realFetch;
    }
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString('utf8')) as { scope: string };
    expect(claims.scope).toBe(FIREBASE_MESSAGING_SCOPE);
  });
});
