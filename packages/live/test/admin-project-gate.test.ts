/**
 * The Admin project gate. At register start, each project environment
 * variable firebase-admin reads must name the live project. Per Admin app,
 * the project firebase-admin itself resolves (`options.projectId`, a
 * `cert()` credential's `projectId`, or the credential's `getProjectId()`)
 * must too, before the app's first call runs. Apps come from the real
 * `firebase-admin/app`; the ADC path uses a stand-in credential, so no test
 * reads a credentials file or asks for a token.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { cert, deleteApp, initializeApp, type App, type AppOptions, type Credential } from 'firebase-admin/app';
import { adminAppProjectId, adminEnvRefusal, adminProjectGate } from '../src/admin/project-gate.js';
import { LIVE_REFUSED, type LiveAdminProjectRefusal } from '../src/refusal.js';

const HOST = 'a';
const OTHER = 'b';

/** A throwaway key made for this run: `cert()` parses it, and nothing here signs with it. */
const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const made: App[] = [];
let appCount = 0;

function app(options: AppOptions): App {
  appCount += 1;
  const created = initializeApp(options, `gate-${appCount}`);
  made.push(created);
  return created;
}

function certFor(projectId: string): Credential {
  return cert({ projectId, clientEmail: `sa@${projectId}.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY });
}

/** An ADC-like credential whose project resolves asynchronously, as `applicationDefault()`'s does. */
interface CountingCredential extends Credential {
  tokens: number;
}

function adcCredential(projectId: string): CountingCredential {
  const credential: CountingCredential = {
    tokens: 0,
    getAccessToken() {
      credential.tokens += 1;
      return Promise.reject(new Error('no token in this test'));
    },
  };
  return Object.assign(credential, { getProjectId: () => Promise.resolve(projectId) });
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((each) => deleteApp(each)));
});

function refusalOf(error: unknown): LiveAdminProjectRefusal {
  return error as LiveAdminProjectRefusal;
}

describe('adminEnvRefusal', () => {
  test('passes when no project variable is set, or each names the host', () => {
    expect(adminEnvRefusal({}, HOST)).toBeNull();
    const env = { GOOGLE_CLOUD_PROJECT: HOST, GCLOUD_PROJECT: HOST, FIREBASE_CONFIG: JSON.stringify({ projectId: HOST }) };
    expect(adminEnvRefusal(env, HOST)).toBeNull();
  });

  test.each([
    ['GOOGLE_CLOUD_PROJECT', { GOOGLE_CLOUD_PROJECT: OTHER }],
    ['GCLOUD_PROJECT', { GCLOUD_PROJECT: OTHER }],
    ['FIREBASE_CONFIG', { FIREBASE_CONFIG: JSON.stringify({ projectId: OTHER }) }],
  ] as const)('refuses %s naming another project', (source, env) => {
    const refusal = adminEnvRefusal(env, HOST);
    expect(refusal?.code).toBe(LIVE_REFUSED);
    expect(refusal?.source).toBe(source);
    expect(refusal?.appProjectId).toBe(OTHER);
    expect(refusal?.hostProjectId).toBe(HOST);
  });
});

describe('adminAppProjectId', () => {
  test('reads options.projectId first', async () => {
    const resolved = await adminAppProjectId(app({ projectId: OTHER, credential: adcCredential(HOST) }));
    expect(resolved).toEqual({ source: 'options.projectId', projectId: OTHER });
  });

  test("reads a cert() credential's projectId", async () => {
    const resolved = await adminAppProjectId(app({ credential: certFor(OTHER) }));
    expect(resolved).toEqual({ source: 'credential', projectId: OTHER });
  });

  test("asks an ADC credential's getProjectId, and never for a token", async () => {
    const credential = adcCredential(OTHER);
    const resolved = await adminAppProjectId(app({ credential }));
    expect(resolved).toEqual({ source: 'credential', projectId: OTHER });
    expect(credential.tokens).toBe(0);
  });
});

describe('adminProjectGate', () => {
  function gate(): { lines: string[]; run: ReturnType<typeof adminProjectGate> } {
    const lines: string[] = [];
    return { lines, run: adminProjectGate(HOST, (line) => lines.push(line)) };
  }

  test("runs the call when the app's project is the host's", async () => {
    const { lines, run } = gate();
    const result = await run(app({ projectId: HOST }), () => Promise.resolve('real'));
    expect(result).toBe('real');
    expect(lines).toEqual([]);
  });

  test.each([
    ['options.projectId', () => app({ projectId: OTHER })],
    ['cert()', () => app({ credential: certFor(OTHER) })],
    ['ADC', () => app({ credential: adcCredential(OTHER) })],
  ] as const)('refuses every call from an app on another project (%s) before it runs, and writes one line', async (_path, makeApp) => {
    const { lines, run } = gate();
    const refusedApp = makeApp();
    let ran = 0;
    const call = () => {
      ran += 1;
      return Promise.resolve('real');
    };
    const first = await run(refusedApp, call).catch((error: unknown) => error);
    const second = await run(refusedApp, call).catch((error: unknown) => error);
    expect(ran).toBe(0);
    expect(refusalOf(first).code).toBe(LIVE_REFUSED);
    expect(refusalOf(first).appProjectId).toBe(OTHER);
    expect(refusalOf(first).hostProjectId).toBe(HOST);
    expect(refusalOf(second).code).toBe(LIVE_REFUSED);
    expect(lines).toHaveLength(1);
  });
});
