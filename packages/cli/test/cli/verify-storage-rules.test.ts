/**
 * `pyric verify` checks each Storage bucket a session used against the rules
 * deployed to it (#1313): `--rules storage:<bucket>=<path>`, else the
 * firebase.json storage array.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import { getStorage, getStorageSandbox, ref, uploadBytes } from 'pyric/storage';
import { lockUndeployedStorageBuckets, nameStorageBucket, replaceStorageRules, type StorageDefaultPolicy } from 'pyric/storage/internal';

import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerify } from '../../src/cli/verify.js';
import { buildVerifyFixture, type PyricVerifyFixture } from '../../src/verify/index.js';

const DEFAULT_BUCKET = 'demo-app.appspot.com';
const MEDIA_BUCKET = 'media-bucket';
const UNDEPLOYED_BUCKET = 'undeployed-bucket';

const OPEN = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

const SIGNED_IN = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if request.auth != null; }
  }
}`;

const BYTES = new Uint8Array([1]);

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A session with sign-in rules on the default bucket and open rules on
 * media-bucket: alice uploads to each, and a signed-out visitor uploads to
 * media-bucket and to a bucket nothing deploys to.
 */
async function captureSession(policy: StorageDefaultPolicy = 'deny'): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: uniqueName('verify-storage-rules') });
  lockUndeployedStorageBuckets(sandbox, policy);
  await replaceStorageRules(sandbox, SIGNED_IN, { bucket: DEFAULT_BUCKET });
  await replaceStorageRules(sandbox, OPEN, { bucket: MEDIA_BUCKET });
  const alice = sandbox.withAuth({ uid: 'alice' });
  const visitor = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: DEFAULT_BUCKET }, uniqueName('app'));
  await uploadBytes(ref(nameStorageBucket(getStorageSandbox(alice), DEFAULT_BUCKET), 'a.txt'), BYTES);
  await uploadBytes(ref(getStorageSandbox(alice, { bucket: MEDIA_BUCKET }), 'b.txt'), BYTES);
  await uploadBytes(ref(getStorage(visitor, `gs://${MEDIA_BUCKET}`), 'c.txt'), BYTES);
  await uploadBytes(ref(getStorage(visitor, `gs://${UNDEPLOYED_BUCKET}`), 'd.txt'), BYTES).catch(() => undefined);
  return buildVerifyFixture({ sandbox, storageRules: SIGNED_IN });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project directory holding `files` (objects are written as JSON) and the captured session. */
async function project(files: Record<string, unknown>, fixture?: PyricVerifyFixture): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-verify-storage-')));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(fixture ?? await captureSession()));
  return dir;
}

interface VerifyReport {
  ok: boolean;
  rulesPaths: Record<string, string>;
  results: Array<{ services: { storage?: { divergences: Array<{ kind: string; bucket?: string; path?: string }> } } }>;
}

/** Run `pyric verify session.json --json ...argv` in `dir`: its exit code and its report, when it printed one. */
async function verify(dir: string, argv: string[] = []): Promise<{ code: number; report?: VerifyReport }> {
  const out: string[] = [];
  const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const code = await runVerify(parseArgs(['verify', 'session.json', '--json', ...argv]));
    const text = out.join('');
    return { code, ...(text.trim() === '' ? {} : { report: JSON.parse(text) as VerifyReport }) };
  } finally {
    process.chdir(previous);
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

/** Each Storage divergence, by kind, bucket and path. */
function divergences(report: VerifyReport | undefined) {
  return (report?.results[0]?.services.storage?.divergences ?? []).map(({ kind, bucket, path }) => ({ kind, bucket, path }));
}

const BUCKET_ARRAY = {
  storage: [
    { bucket: MEDIA_BUCKET, rules: 'media.rules' },
    { bucket: DEFAULT_BUCKET, rules: 'storage.rules' },
  ],
};

describe('pyric verify with more than one Storage bucket', () => {
  it('checks each bucket of a firebase.json storage array against its own rules', async () => {
    const dir = await project({ 'firebase.json': BUCKET_ARRAY, 'media.rules': OPEN, 'storage.rules': SIGNED_IN });
    const result = await verify(dir);
    expect(divergences(result.report)).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.report?.rulesPaths).toEqual({
      [`storage:${MEDIA_BUCKET}`]: join(dir, 'media.rules'),
      [`storage:${DEFAULT_BUCKET}`]: join(dir, 'storage.rules'),
    });
  });

  it('takes --rules storage:<bucket>=<path> over firebase.json for that bucket only', async () => {
    const dir = await project({
      'firebase.json': BUCKET_ARRAY,
      'media.rules': OPEN,
      'storage.rules': SIGNED_IN,
      'media-strict.rules': SIGNED_IN,
    });
    const result = await verify(dir, ['--rules', `storage:${MEDIA_BUCKET}=media-strict.rules`]);
    expect(result.code).toBe(1);
    expect(divergences(result.report)).toEqual([{ kind: 'now-denied', bucket: MEDIA_BUCKET, path: 'c.txt' }]);
    expect(result.report?.rulesPaths[`storage:${MEDIA_BUCKET}`]).toBe(join(dir, 'media-strict.rules'));
  });

  it('reads a gs:// bucket key as the bucket name', async () => {
    const dir = await project({ 'media.rules': OPEN, 'storage.rules': SIGNED_IN });
    const result = await verify(dir, [
      '--rules', `storage:gs://${MEDIA_BUCKET}=media.rules`,
      '--rules', `storage:${DEFAULT_BUCKET}=storage.rules`,
    ]);
    expect(divergences(result.report)).toEqual([]);
    expect(result.code).toBe(0);
  });

  it('replays a bucket no rules name as locked', async () => {
    const dir = await project({ 'storage.rules': SIGNED_IN });
    const result = await verify(dir, ['--rules', `storage:${DEFAULT_BUCKET}=storage.rules`]);
    expect(result.code).toBe(1);
    expect(divergences(result.report)).toEqual([
      { kind: 'now-denied', bucket: MEDIA_BUCKET, path: 'b.txt' },
      { kind: 'now-denied', bucket: MEDIA_BUCKET, path: 'c.txt' },
    ]);
  });

  it('replays an undeployed bucket as open when the capture was recorded in permissive mode', async () => {
    const dir = await project(
      { 'firebase.json': BUCKET_ARRAY, 'media.rules': OPEN, 'storage.rules': SIGNED_IN },
      await captureSession('allow'),
    );
    const result = await verify(dir);
    expect(divergences(result.report)).toEqual([]);
    expect(result.code).toBe(0);
  });

  it('keeps one ruleset for every bucket under a single storage object', async () => {
    const dir = await project({ 'firebase.json': { storage: { rules: 'storage.rules' } }, 'storage.rules': SIGNED_IN });
    const result = await verify(dir);
    expect(result.code).toBe(1);
    expect(divergences(result.report)).toEqual([{ kind: 'now-denied', bucket: MEDIA_BUCKET, path: 'c.txt' }]);
  });

  it('refuses a rules file firebase.json names that does not exist', async () => {
    const dir = await project({ 'firebase.json': BUCKET_ARRAY, 'storage.rules': SIGNED_IN });
    const result = await verify(dir);
    expect(result.code).toBe(2);
    expect(result.report).toBeUndefined();
  });
});
