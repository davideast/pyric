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
import { getStorageSandbox, ref as storageRef, uploadString } from 'pyric/storage';
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
      targets: { 'rules-demo': { database: { chat: ['rules-demo-chat'] } } },
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

  it('applies the first storage entry with rules', async () => {
    const { sandbox } = load(project(fullProject));
    const storage = getStorageSandbox(sandbox.withAuth(null));
    await uploadString(storageRef(storage, 'public/a.txt'), 'hello');
    await expect(uploadString(storageRef(storage, 'private/a.txt'), 'no')).rejects.toMatchObject({ code: 'storage/unauthorized' });
  });

  it('reads database.rules.json for the default instance when firebase.json has no database key', async () => {
    const { sandbox, stderr } = load(project({ 'firebase.json': {}, 'database.rules.json': DEFAULT_RTDB_RULES }));
    expect(stderr).toBe('');
    await set(ref(getDatabase(sandbox.withAuth(null)), 'open/a'), 1);
  });

  it('names an unresolved deploy target on stderr and still loads Firestore and Storage', async () => {
    const dir = project({ ...fullProject, '.firebaserc': { projects: { default: 'rules-demo' } } });
    const { sandbox, stderr } = load(dir);
    expect(stderr).toContain('pyric/app/register: could not load Realtime Database rules');
    expect(stderr).toContain('"chat"');
    const ctx = sandbox.withAuth(null);
    await expect(set(ref(getDatabase(ctx), 'open/a'), 1)).rejects.toMatchObject(permissionDenied);
    await setDoc(doc(getFirestore(ctx), 'open/a'), { ok: true });
    await uploadString(storageRef(getStorageSandbox(ctx), 'public/a.txt'), 'hello');
  });

  it('names a storage rules file that does not parse and still loads RTDB', async () => {
    const { sandbox, stderr } = load(project({ ...fullProject, 'storage.rules': 'service firebase.storage {' }));
    expect(stderr).toContain('pyric/app/register: could not load storage.rules');
    await set(ref(getDatabase(sandbox.withAuth(null)), 'open/a'), 1);
  });

  it('names a declared rules file that does not exist', () => {
    const { stderr } = load(project({ 'firebase.json': { storage: { rules: 'missing.rules' } } }));
    expect(stderr).toContain('could not load storage.rules: firebase.json names missing.rules');
  });

  it('does nothing without firebase.json', () => {
    expect(load(project({})).stderr).toBe('');
  });
});
