/**
 * #1120: the in-process sandbox `pyric/app/register` prepares for
 * `PYRIC_SANDBOX=local` takes every rules file `firebase.json` declares.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { getDatabase, ref, set } from 'pyric/database';
import { getStorage, ref as storageRef, uploadString } from '../../src/storage/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import { loadProjectRules } from '../../src/app/register-rules.js';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /open/{doc} { allow read, write: if true; }
  }
}`;
const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /public/{file} { allow read, write: if true; }
  }
}`;
// Comments and a trailing comma, as a deployed rules file may carry.
const DEFAULT_RTDB_RULES = '{ /* default */ "rules": { "open": { ".read": true, ".write": true, } } }';
const CHAT_RTDB_RULES = JSON.stringify({ rules: { rooms: { '.read': true, '.write': true } } });

const STORAGE_BUCKET = 'rules-demo.appspot.com';

/** The app's Storage on its default bucket, or on `gs://<bucket>`, as a registered process gets it. */
function appStorage(sandbox: LocalSandbox, bucketUrl?: string) {
  const app = createAppForSandbox(sandbox, { projectId: 'rules-demo', storageBucket: STORAGE_BUCKET }, `register-${Math.random()}`);
  return getStorage(app, bucketUrl);
}

const dirs: string[] = [];

function project(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-register-rules-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

function load(dir: string): { sandbox: LocalSandbox; stderr: string } {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  const sandbox = initializeSandbox();
  try {
    loadProjectRules(sandbox, dir);
  } finally {
    spy.mockRestore();
  }
  return { sandbox, stderr: lines.join('') };
}

const permissionDenied = { code: 'PERMISSION_DENIED' };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadProjectRules (pyric/app/register)', () => {
  const fullProject = {
    'firebase.json': {
      firestore: { rules: 'firestore.rules' },
      database: [
        { instance: 'rules-demo-default-rtdb', rules: 'database.rules.json' },
        { target: 'chat', rules: 'chat.rules.json' },
      ],
      storage: [{ target: 'main', rules: 'storage.rules' }],
    },
    '.firebaserc': {
      projects: { default: 'rules-demo' },
      targets: { 'rules-demo': { database: { chat: ['rules-demo-chat'] }, storage: { main: [STORAGE_BUCKET] } } },
    },
    'firestore.rules': FIRESTORE_RULES,
    'database.rules.json': DEFAULT_RTDB_RULES,
    'chat.rules.json': CHAT_RTDB_RULES,
    'storage.rules': STORAGE_RULES,
  };

  it('applies firestore.rules', async () => {
    const { sandbox, stderr } = load(project(fullProject));
    expect(stderr).toBe('');
    const db = getFirestore(sandbox.withAuth(null));
    await setDoc(doc(db, 'open/a'), { ok: true });
    await expect(setDoc(doc(db, 'closed/a'), { ok: false })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('applies each RTDB instance its own rules, the default instance and a mapped deploy target', async () => {
    const { sandbox } = load(project(fullProject));
    const ctx = sandbox.withAuth(null);
    const main = getDatabase(ctx);
    await set(ref(main, 'open/a'), 1);
    await expect(set(ref(main, 'rooms/a'), 1)).rejects.toMatchObject(permissionDenied);
    const chat = getDatabase(ctx, 'rules-demo-chat');
    await set(ref(chat, 'rooms/a'), 1);
    await expect(set(ref(chat, 'open/a'), 1)).rejects.toMatchObject(permissionDenied);
  });

  it('applies a storage deploy target to the bucket .firebaserc maps it to', async () => {
    const { sandbox } = load(project(fullProject));
    const storage = appStorage(sandbox);
    await uploadString(storageRef(storage, 'public/a.txt'), 'hello');
    await expect(uploadString(storageRef(storage, 'private/a.txt'), 'no')).rejects.toMatchObject({ code: 'storage/unauthorized' });
  });

  it('reads database.rules.json for the default instance when firebase.json has no database key', async () => {
    const { sandbox, stderr } = load(project({ 'firebase.json': {}, 'database.rules.json': DEFAULT_RTDB_RULES }));
    expect(stderr).toBe('');
    await set(ref(getDatabase(sandbox.withAuth(null)), 'open/a'), 1);
  });

  it('names an unresolved deploy target on stderr and still loads Firestore and Storage', async () => {
    const dir = project({
      ...fullProject,
      '.firebaserc': { projects: { default: 'rules-demo' }, targets: { 'rules-demo': { storage: { main: [STORAGE_BUCKET] } } } },
    });
    const { sandbox, stderr } = load(dir);
    expect(stderr).toContain('pyric/app/register: could not load Realtime Database rules');
    expect(stderr).toContain('"chat"');
    const ctx = sandbox.withAuth(null);
    await expect(set(ref(getDatabase(ctx), 'open/a'), 1)).rejects.toMatchObject(permissionDenied);
    await setDoc(doc(getFirestore(ctx), 'open/a'), { ok: true });
    await uploadString(storageRef(appStorage(sandbox), 'public/a.txt'), 'hello');
  });

  it('names a storage rules file that does not parse and still loads RTDB', async () => {
    const { sandbox, stderr } = load(project({ ...fullProject, 'storage.rules': 'service firebase.storage {' }));
    expect(stderr).toContain('pyric/app/register: could not load storage.rules');
    await set(ref(getDatabase(sandbox.withAuth(null)), 'open/a'), 1);
  });

  it('gives each bucket the rules firebase.json deploys to it (the ST-H2-2 repro)', async () => {
    const signedIn = STORAGE_RULES.replace('if true', 'if request.auth != null');
    const { sandbox, stderr } = load(project({
      'firebase.json': {
        storage: [
          { bucket: 'media-bucket', rules: 'media.rules' },
          { bucket: STORAGE_BUCKET, rules: 'storage.rules' },
        ],
      },
      'media.rules': STORAGE_RULES,
      'storage.rules': signedIn,
    }));
    expect(stderr).toBe('');
    await expect(uploadString(storageRef(appStorage(sandbox), 'public/a.txt'), 'no')).rejects.toMatchObject({ code: 'storage/unauthorized' });
    await uploadString(storageRef(appStorage(sandbox, 'gs://media-bucket'), 'public/a.txt'), 'hello');
    await expect(uploadString(storageRef(appStorage(sandbox, 'gs://other-bucket'), 'public/a.txt'), 'no')).rejects.toMatchObject({ code: 'storage/unauthorized' });
  });

  it('names a storage deploy target .firebaserc does not map, and keeps its buckets locked', async () => {
    const dir = project({ ...fullProject, '.firebaserc': { projects: { default: 'rules-demo' }, targets: { 'rules-demo': { database: { chat: ['rules-demo-chat'] } } } } });
    const { sandbox, stderr } = load(dir);
    expect(stderr).toContain('Storage deploy target "main" (firebase.json storage[0]) maps to no bucket in .firebaserc');
    await expect(uploadString(storageRef(appStorage(sandbox), 'public/a.txt'), 'no')).rejects.toMatchObject({ code: 'storage/unauthorized' });
  });

  it('names a declared rules file that does not exist', () => {
    const { stderr } = load(project({ 'firebase.json': { storage: { rules: 'missing.rules' } } }));
    expect(stderr).toContain('could not load storage.rules: firebase.json names missing.rules');
  });

  it('does nothing without firebase.json', () => {
    expect(load(project({})).stderr).toBe('');
  });
});

// #1315: the array `firestore` form deploys its `(default)` entry to (default).
describe('loadProjectRules (pyric/app/register) with a firestore array', () => {
  const DECOY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;
  const arrayProject = {
    'firebase.json': {
      firestore: [
        { database: '(default)', rules: 'firestore.default.rules' },
        { database: 'reports', rules: 'reports.rules' },
      ],
    },
    'firestore.default.rules': FIRESTORE_RULES,
    'reports.rules': DECOY_RULES,
    'firestore.rules': DECOY_RULES,
  };

  it('applies the (default) entry, not the decoy firestore.rules', async () => {
    const { sandbox } = load(project(arrayProject));
    const db = getFirestore(sandbox.withAuth(null));
    await setDoc(doc(db, 'open/a'), { ok: true });
    await expect(setDoc(doc(db, 'locked/x'), { ok: false })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('warns on stderr that the named database is not served', () => {
    const { stderr } = load(project(arrayProject));
    expect(stderr).toBe(
      'pyric/app/register: firebase.json deploys reports.rules to Firestore database "reports". Pyric serves only (default) for now, so getFirestore(app, "reports") reads and writes (default) under (default)\'s rules. See https://github.com/davideast/pyric/issues/1314.\n',
    );
  });

  it('applies the (default) rules a .firebaserc deploy target maps', async () => {
    const { sandbox, stderr } = load(project({
      'firebase.json': { firestore: [{ target: 'main', rules: 'firestore.default.rules' }] },
      '.firebaserc': { projects: { default: 'demo' }, targets: { demo: { firestore: { main: ['(default)'] } } } },
      'firestore.default.rules': FIRESTORE_RULES,
      'firestore.rules': DECOY_RULES,
    }));
    expect(stderr).toBe('');
    await expect(setDoc(doc(getFirestore(sandbox.withAuth(null)), 'locked/x'), { ok: false })).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
