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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { cert, deleteApp, initializeApp, type App, type AppOptions, type Credential } from 'firebase-admin/app';
import { adminAppProjectId, adminEnvRefusal, adminProjectGate } from '../src/admin/project-gate.js';
import { LIVE_REFUSED, type LiveAdminProjectRefusal } from '../src/refusal.js';

const HOST = 'a';
const OTHER = 'b';
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-admin-project-gate-'));
  tempDirs.push(dir);
  return dir;
}

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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function refusalOf(error: unknown): LiveAdminProjectRefusal {
  return error as LiveAdminProjectRefusal;
}

describe('adminEnvRefusal', () => {
  test('passes when no project variable is set, or each names the host', () => {
    expect(adminEnvRefusal({}, HOST)).toBeNull();
    expect(adminEnvRefusal({ FIREBASE_CONFIG: '' }, HOST)).toBeNull();
    expect(adminEnvRefusal({ FIREBASE_CONFIG: '{}' }, HOST)).toBeNull();
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

  test('reads file-path FIREBASE_CONFIG matching firebase-admin and refuses cross-project or unreadable configs', () => {
    const dir = makeTempDir();
    const hostFile = join(dir, 'host-config.json');
    const emptyFile = join(dir, 'empty-config.json');
    const otherFile = join(dir, 'other-config.json');
    const foreignBucketFile = join(dir, 'foreign-bucket.json');
    const foreignDbFile = join(dir, 'foreign-db.json');
    const malformedFile = join(dir, 'malformed.json');
    const arrayFile = join(dir, 'array.json');
    const missingFile = join(dir, 'missing-config.json');

    writeFileSync(hostFile, JSON.stringify({
      projectId: HOST,
      storageBucket: `${HOST}.appspot.com`,
      databaseURL: `https://${HOST}-default-rtdb.firebaseio.com`,
    }));
    writeFileSync(emptyFile, '{}');
    writeFileSync(otherFile, JSON.stringify({ projectId: OTHER }));
    writeFileSync(foreignBucketFile, JSON.stringify({ storageBucket: `${OTHER}.firebasestorage.app` }));
    writeFileSync(foreignDbFile, JSON.stringify({ databaseURL: `https://${OTHER}-default-rtdb.firebaseio.com` }));
    writeFileSync(malformedFile, '{ not valid json');
    writeFileSync(arrayFile, '["a"]');

    // Host and empty JSON config files pass.
    expect(adminEnvRefusal({ FIREBASE_CONFIG: hostFile }, HOST)).toBeNull();
    expect(adminEnvRefusal({ FIREBASE_CONFIG: emptyFile }, HOST)).toBeNull();

    // Cross-project file-path FIREBASE_CONFIG (absolute and relative paths) refuses.
    const otherRefusal = adminEnvRefusal({ FIREBASE_CONFIG: otherFile }, HOST);
    expect(otherRefusal?.code).toBe(LIVE_REFUSED);
    expect(otherRefusal?.source).toBe('FIREBASE_CONFIG');
    expect(otherRefusal?.appProjectId).toBe(OTHER);
    expect(otherRefusal?.hostProjectId).toBe(HOST);

    const relOther = relative(process.cwd(), otherFile);
    const relRefusal = adminEnvRefusal({ FIREBASE_CONFIG: relOther }, HOST);
    expect(relRefusal?.code).toBe(LIVE_REFUSED);
    expect(relRefusal?.appProjectId).toBe(OTHER);

    // Foreign default storageBucket or databaseURL without projectId refuses.
    expect(adminEnvRefusal({ FIREBASE_CONFIG: foreignBucketFile }, HOST)?.code).toBe(LIVE_REFUSED);
    expect(adminEnvRefusal({ FIREBASE_CONFIG: foreignDbFile }, HOST)?.code).toBe(LIVE_REFUSED);
    expect(
      adminEnvRefusal({ FIREBASE_CONFIG: JSON.stringify({ storageBucket: `${OTHER}.appspot.com` }) }, HOST)?.code,
    ).toBe(LIVE_REFUSED);

    // Unreadable, directory, malformed, non-object, and leading-space-file FIREBASE_CONFIG fail closed.
    for (const badValue of [
      missingFile,
      dir,
      malformedFile,
      arrayFile,
      '{broken',
      '[]',
      'null',
      ` ${JSON.stringify({ projectId: HOST })}`,
    ]) {
      const refusal = adminEnvRefusal({ FIREBASE_CONFIG: badValue }, HOST);
      expect(refusal?.code).toBe(LIVE_REFUSED);
      expect(refusal?.source).toBe('FIREBASE_CONFIG');
      expect(refusal?.hostProjectId).toBe(HOST);
      expect(refusal?.message.includes(missingFile)).toBe(false);
    }
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
  function gate(env: Record<string, string> = {}): { lines: string[]; run: ReturnType<typeof adminProjectGate> } {
    const lines: string[] = [];
    return { lines, run: adminProjectGate(HOST, (line) => lines.push(line), env) };
  }

  test('refuses an app with explicit ADC options on another project, though FIREBASE_CONFIG names the host', async () => {
    const { run } = gate({ FIREBASE_CONFIG: JSON.stringify({ projectId: HOST }) });
    let ran = 0;
    const refused = await run(app({ credential: adcCredential(OTHER) }), () => {
      ran += 1;
      return Promise.resolve('real');
    }).catch((error: unknown) => error);
    expect(ran).toBe(0);
    expect(refusalOf(refused).code).toBe(LIVE_REFUSED);
    expect(refusalOf(refused).source).toBe('credential');
    expect(refusalOf(refused).appProjectId).toBe(OTHER);
  });

  test('writes one line for the process, however many apps it refuses', async () => {
    const { lines, run } = gate();
    const call = () => Promise.resolve('real');
    await run(app({ projectId: OTHER }), call).catch(() => undefined);
    await run(app({ credential: adcCredential(OTHER) }), call).catch(() => undefined);
    expect(lines).toHaveLength(1);
  });

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
