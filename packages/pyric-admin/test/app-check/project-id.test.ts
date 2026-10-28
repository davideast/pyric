/**
 * `createToken` and `verifyToken` find the app's project the same way
 * firebase-admin's `getExplicitProjectId` does: the app's `projectId`
 * option, then `GOOGLE_CLOUD_PROJECT`, then `GCLOUD_PROJECT`. A token minted
 * by an app verifies on that same app, wherever its project came from.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';
const ENV_KEYS = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

let appSeq = 0;
function appWithoutProjectId() {
  appSeq += 1;
  const config = { sandbox: initializeSandbox() } as Parameters<typeof initializeApp>[0];
  return getAppCheck(initializeApp(config, `app-check-project-id-${appSeq}`));
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
