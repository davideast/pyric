/**
 * `createToken` and `verifyToken` find the app's project the same way
 * firebase-admin's `getExplicitProjectId` does: the app's `projectId`
 * option, then a cert credential's project id, then `GOOGLE_CLOUD_PROJECT`,
 * then `GCLOUD_PROJECT`. A token minted by an app verifies on that same app,
 * wherever its project came from.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { cert, deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';
const ENV_KEYS = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

let appSeq = 0;
function appWithoutProjectId() {
  return appWith({});
}

function appWith(options: Record<string, unknown>) {
  appSeq += 1;
  const config = { sandbox: initializeSandbox(), ...options } as Parameters<typeof initializeApp>[0];
  return getAppCheck(initializeApp(config, `app-check-project-id-${appSeq}`));
}

/** A service account shaped like a downloaded key file, with a placeholder where the key goes. */
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'demo-cert',
  private_key_id: 'placeholder-key-id',
  private_key: 'placeholder-private-key',
  client_email: 'sandbox@demo-cert.iam.gserviceaccount.com',
};

function serviceAccountFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'pyric-cert-')), 'service-account.json');
  writeFileSync(path, text);
  return path;
}

async function mintedAudience(appCheck: ReturnType<typeof getAppCheck>): Promise<unknown> {
  const { token } = await appCheck.createToken(APP_ID);
  return (await appCheck.verifyToken(token)).token.aud;
}

async function rejection(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code ?? null, message: String(e.message) };
  }
  return null;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('app-check admin project id', () => {
  it('verifies a token it minted when the project comes from GOOGLE_CLOUD_PROJECT', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'demo-env';
    const appCheck = appWithoutProjectId();
    const { token } = await appCheck.createToken(APP_ID);
    const verified = await appCheck.verifyToken(token);
    expect(verified.appId).toBe(APP_ID);
    expect(verified.token.aud).toContain('projects/demo-env');
  });

  it('verifies a token it minted when the project comes from GCLOUD_PROJECT', async () => {
    process.env.GCLOUD_PROJECT = 'demo-gcloud';
    const appCheck = appWithoutProjectId();
    const { token } = await appCheck.createToken(APP_ID);
    expect((await appCheck.verifyToken(token)).token.aud).toContain('projects/demo-gcloud');
  });

  it('refuses to mint without a project, with firebase-admin code and message', async () => {
    const refused = await rejection(() => appWithoutProjectId().createToken(APP_ID));
    expect(refused).toEqual({
      code: 'app-check/unknown-error',
      message:
        'Failed to determine project ID. Initialize the SDK with service account credentials or set project ID as an app option. Alternatively, set the GOOGLE_CLOUD_PROJECT environment variable.',
    });
  });
});

describe('app-check admin project id from a cert credential', () => {
  it('mints and verifies with only a cert credential, no options and no environment', async () => {
    const appCheck = appWith({ credential: cert(SERVICE_ACCOUNT) });
    expect(await mintedAudience(appCheck)).toContain('projects/demo-cert');
  });

  it('reads projectId as firebase-admin also accepts it', async () => {
    const appCheck = appWith({ credential: cert({ projectId: 'demo-camel' }) });
    expect(await mintedAudience(appCheck)).toContain('projects/demo-camel');
  });

  it('prefers the projectId option over the credential', async () => {
    const appCheck = appWith({ projectId: 'demo-option', credential: cert(SERVICE_ACCOUNT) });
    expect(await mintedAudience(appCheck)).toContain('projects/demo-option');
  });

  it('prefers the credential over GOOGLE_CLOUD_PROJECT', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'demo-env';
    const appCheck = appWith({ credential: cert(SERVICE_ACCOUNT) });
    expect(await mintedAudience(appCheck)).toContain('projects/demo-cert');
  });

  it('reads the project id from a service account file path', async () => {
    const appCheck = appWith({ credential: cert(serviceAccountFile(JSON.stringify(SERVICE_ACCOUNT))) });
    expect(await mintedAudience(appCheck)).toContain('projects/demo-cert');
  });

  it('falls back to the environment when the credential has no project id', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'demo-env';
    const appCheck = appWith({ credential: cert({ client_email: 'a@b.c' }) });
    expect(await mintedAudience(appCheck)).toContain('projects/demo-env');
  });

  it('keeps no project id, and does not throw, for a missing, unparsable, or project-less file', async () => {
    const missing = join(tmpdir(), 'pyric-cert-missing', 'no-such-file.json');
    const unparsable = serviceAccountFile('not json');
    const noProject = serviceAccountFile(JSON.stringify({ client_email: 'a@b.c' }));
    for (const path of [missing, unparsable, noProject]) {
      const credential = cert(path);
      const refused = await rejection(() => appWith({ credential }).createToken(APP_ID));
      expect(refused?.code).toBe('app-check/unknown-error');
    }
  });

  it('exposes no field of the service account on the credential', () => {
    const credential = cert(SERVICE_ACCOUNT);
    expect(Object.keys(credential)).toEqual([]);
    expect(JSON.stringify(credential)).toBe('{}');
    expect(Object.values(credential)).not.toContain(SERVICE_ACCOUNT.private_key);
    const ownValues = Reflect.ownKeys(credential).map((key) => (credential as Record<PropertyKey, unknown>)[key]);
    expect(ownValues).not.toContain(SERVICE_ACCOUNT.private_key);
    expect(ownValues).not.toContain(SERVICE_ACCOUNT.client_email);
  });

  it('does not copy the credential project id into app.options, as firebase-admin does not', () => {
    const appCheck = appWith({ credential: cert(SERVICE_ACCOUNT) });
    expect(appCheck.app.options).toEqual({});
  });
});

describe('app-check admin token payload', () => {
  const nonObjectPayloads = ['null', '[]', '42', '"text"'];
  for (const payload of nonObjectPayloads) {
    it(`rejects a token whose payload decodes to ${payload} as a decode failure`, async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'demo-env';
      const token = `e30.${Buffer.from(payload).toString('base64url')}.c`;
      const refused = await rejection(() => appWithoutProjectId().verifyToken(token));
      expect(refused?.code).toBe('app-check/invalid-argument');
      expect(refused?.message).toStartWith('Decoding App Check token failed.');
    });
  }
});
