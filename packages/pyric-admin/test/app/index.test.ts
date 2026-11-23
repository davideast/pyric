import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  cert as realCert,
  deleteApp as deleteRealApp,
  initializeApp as initializeRealApp,
  type App as RealApp,
  type AppOptions as RealAppOptions,
} from 'firebase-admin/app';
import {
  REMOTE_SANDBOX_FACTORY,
  initializeSandbox,
  type RemoteSandbox,
} from 'pyric/sandbox';
import {
  applicationDefault,
  cert,
  deleteApp,
  getApps,
  initializeApp,
  refreshToken,
} from '../../src/app/index.js';

type FactoryGlobal = { [REMOTE_SANDBOX_FACTORY]?: unknown };

const realApps: RealApp[] = [];
const savedEnv: Record<string, string | undefined> = {};
let savedFactory: unknown;
let savedStderrWrite: typeof process.stderr.write;

const RSA_KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function captureThrow(fn: () => unknown): { code: string | null; message: string } | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof Error) {
      const coded = error as Error & { code?: unknown };
      let code: string | null = null;
      if (typeof coded.code === 'string') {
        code = coded.code;
      }
      return { code, message: error.message };
    }
    throw error;
  }
}

beforeEach(() => {
  for (const key of ['PYRIC_SANDBOX', 'FIREBASE_CONFIG', 'NODE_ENV']) {
    savedEnv[key] = process.env[key];
  }
  delete process.env.PYRIC_SANDBOX;
  delete process.env.FIREBASE_CONFIG;
  delete process.env.NODE_ENV;

  const globals = globalThis as FactoryGlobal;
  savedFactory = globals[REMOTE_SANDBOX_FACTORY];
  globals[REMOTE_SANDBOX_FACTORY] = () => initializeSandbox() as unknown as RemoteSandbox;

  savedStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stderr.write = savedStderrWrite;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const globals = globalThis as FactoryGlobal;
  if (savedFactory === undefined) {
    delete globals[REMOTE_SANDBOX_FACTORY];
  } else {
    globals[REMOTE_SANDBOX_FACTORY] = savedFactory;
  }
  const createdReal = realApps.splice(0, realApps.length);
  await Promise.all(createdReal.map((app) => deleteRealApp(app)));
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('pyric-admin/app options parity (#1547)', () => {
  it('keeps explicit cert, applicationDefault, and refreshToken credentials in app.options by reference', () => {
    const upstreamCredential = realCert({
      projectId: 'demo-project',
      privateKey: RSA_KEY_PAIR.privateKey,
      clientEmail: 'sa@demo-project.iam.gserviceaccount.com',
    });
    const upstreamApp = initializeRealApp({ credential: upstreamCredential }, 'upstream-cert');
    realApps.push(upstreamApp);

    const sandboxCert = cert({ projectId: 'demo-project' });
    const appFromCert = initializeApp({ sandbox: initializeSandbox(), credential: sandboxCert }, 'pyric-cert');
    expect(appFromCert.options.credential === sandboxCert).toBe(
      upstreamApp.options.credential === upstreamCredential,
    );
    expect(Object.keys(appFromCert.options)).toEqual(Object.keys(upstreamApp.options));
    expect('projectId' in appFromCert.options).toBe('projectId' in upstreamApp.options);
    expect(JSON.stringify(appFromCert.options)).toBe('{"credential":{}}');

    const sandboxAdc = applicationDefault();
    const appFromAdc = initializeApp({ sandbox: initializeSandbox(), credential: sandboxAdc }, 'pyric-adc');
    expect(appFromAdc.options.credential).toBe(sandboxAdc);
    expect(JSON.stringify(appFromAdc.options)).toBe('{"credential":{}}');

    const sandboxRefresh = refreshToken({ type: 'authorized_user', refresh_token: 'placeholder' });
    const appFromRefresh = initializeApp(
      { sandbox: initializeSandbox(), credential: sandboxRefresh },
      'pyric-refresh',
    );
    expect(appFromRefresh.options.credential).toBe(sandboxRefresh);
    expect(JSON.stringify(appFromRefresh.options)).toBe('{"credential":{}}');
  });

  it('synthesizes an inert default credential when credential is omitted on sandbox and ambient apps', () => {
    const upstreamDefault = initializeRealApp({}, 'upstream-default-cred');
    realApps.push(upstreamDefault);

    const sandboxApp = initializeApp({ sandbox: initializeSandbox() }, 'pyric-default-cred');
    expect('credential' in sandboxApp.options).toBe('credential' in upstreamDefault.options);
    expect(typeof sandboxApp.options.credential).toBe('object');
    expect(JSON.stringify(sandboxApp.options)).toBe('{"credential":{}}');

    process.env.PYRIC_SANDBOX = 'remote';
    const ambientBare = initializeApp(undefined, 'pyric-ambient-bare');
    expect('credential' in ambientBare.options).toBe(true);
    expect(JSON.stringify(ambientBare.options)).toBe('{"credential":{}}');

    const ambientCert = cert({ project_id: 'demo-ambient' });
    const ambientConfigured = initializeApp({ credential: ambientCert }, 'pyric-ambient-cert');
    expect(ambientConfigured.options.credential).toBe(ambientCert);
    expect('projectId' in ambientConfigured.options).toBe(false);
    expect(JSON.stringify(ambientConfigured.options)).toBe('{"credential":{}}');
  });

  it('clones plain custom credential objects and nested options on read, matching firebase-admin deepCopy', () => {
    const customCredential = {
      getAccessToken: async () => ({ access_token: 'tok', expires_in: 60 }),
    };
    const upstreamCustom = initializeRealApp({ credential: customCredential }, 'upstream-custom');
    realApps.push(upstreamCustom);

    const override = { uid: 'alice', token: { admin: false } };
    const pyricCustom = initializeApp(
      {
        sandbox: initializeSandbox(),
        credential: customCredential,
        projectId: 'demo-project',
        databaseAuthVariableOverride: override,
      },
      'pyric-custom',
    );

    expect(pyricCustom.options === pyricCustom.options).toBe(
      upstreamCustom.options === upstreamCustom.options,
    );
    expect(pyricCustom.options.credential === customCredential).toBe(
      upstreamCustom.options.credential === customCredential,
    );
    expect(JSON.stringify({ credential: pyricCustom.options.credential })).toBe(
      JSON.stringify(upstreamCustom.options),
    );

    const readOptions = pyricCustom.options as {
      projectId?: string;
      databaseAuthVariableOverride?: { uid?: string; token?: { admin?: boolean } };
    };
    readOptions.projectId = 'mutated';
    if (readOptions.databaseAuthVariableOverride?.token !== undefined) {
      readOptions.databaseAuthVariableOverride.token.admin = true;
    }
    expect(pyricCustom.options.projectId).toBe('demo-project');
    expect(pyricCustom.options.databaseAuthVariableOverride).toEqual({
      uid: 'alice',
      token: { admin: false },
    });
  });

  it('throws app/app-deleted when reading app.options after deleteApp, matching firebase-admin', async () => {
    const upstreamApp = initializeRealApp(
      {
        credential: {
          getAccessToken: async () => ({ access_token: 'tok', expires_in: 60 }),
        },
      },
      'deleted-options-check',
    );
    await deleteRealApp(upstreamApp);

    const pyricApp = initializeApp({ sandbox: initializeSandbox() }, 'deleted-options-check');
    await deleteApp(pyricApp);

    expect(captureThrow(() => pyricApp.options)).toEqual(captureThrow(() => upstreamApp.options));
  });

  it('rejects non-object options and invalid credential values with firebase-admin code and message', () => {
    process.env.PYRIC_SANDBOX = 'remote';
    const invalidConfigs: ReadonlyArray<readonly [string, unknown]> = [
      ['null-options', null],
      ['array-options', []],
      ['primitive-options', 'bad'],
      ['undefined-cred', { credential: undefined }],
      ['null-cred', { credential: null }],
      ['empty-cred', { credential: {} }],
    ];

    for (const [label, badConfig] of invalidConfigs) {
      const appName = `bad-${label}`;
      const upstreamThrown = captureThrow(() =>
        initializeRealApp(badConfig as RealAppOptions, appName),
      );
      const pyricAmbientThrown = captureThrow(() =>
        initializeApp(badConfig as Record<string, unknown>, appName),
      );
      expect(pyricAmbientThrown).toEqual(upstreamThrown);
    }

    const sandboxBadCred = captureThrow(() =>
      initializeApp(
        { sandbox: initializeSandbox(), credential: {} } as Parameters<typeof initializeApp>[0],
        'bad-sandbox-cred',
      ),
    );
    const upstreamBadCred = captureThrow(() =>
      initializeRealApp({ credential: {} as RealAppOptions['credential'] }, 'bad-sandbox-cred'),
    );
    expect(sandboxBadCred).toEqual(upstreamBadCred);
  });
});
