/**
 * Seeding and state reading are one round trip: whatever `applySeed` writes into
 * `.pyric/state/headless.json` is what `buildEvalState` must hand a task's
 * assertion. These tests pin the three shapes a task is most likely to assert
 * on: a document, a user carrying a tenant and custom claims, and a stored object.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySeed,
  DATABASE_RULES_FILE,
  FIRESTORE_RULES_FILE,
  SESSION_FILE,
  STORAGE_RULES_FILE,
} from '../seed.js';
import { buildEvalState } from '../state.js';
import { HEADLESS_STATE_RELATIVE } from '../../src/bridge/server/headless.js';

function runDir(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-seed-'));
}

const ALLOW_ALL_FIRESTORE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}
`;

const ALLOW_ALL_STORAGE = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}
`;

describe('seed and state round trip', () => {
  test('a seeded document reads back through the state accessors', async () => {
    const dir = runDir();
    await applySeed(dir, { firestore: { 'posts/p1': { title: 'first', likes: 2 } } });

    expect(existsSync(join(dir, HEADLESS_STATE_RELATIVE))).toBe(true);

    const state = await buildEvalState(dir, join(dir, 'events.ndjson'));
    expect(state.firestore.get('posts/p1')).toMatchObject({ title: 'first', likes: 2 });
    expect(state.firestore.get('posts/missing')).toBeNull();
    expect(state.firestore.list('posts')).toEqual([
      { id: 'p1', data: { title: 'first', likes: 2 } },
    ]);
  });

  test('a seeded user keeps its tenant and custom claims', async () => {
    const dir = runDir();
    await applySeed(dir, {
      users: [
        {
          uid: 'alice',
          email: 'alice@example.com',
          customClaims: { role: 'editor' },
          tenantId: 'acme',
        },
      ],
    });

    const state = await buildEvalState(dir, join(dir, 'events.ndjson'));
    const alice = state.users.get('alice');
    expect(alice).not.toBeNull();
    expect(alice?.uid).toBe('alice');
    expect(alice?.email).toBe('alice@example.com');
    expect(alice?.claims).toMatchObject({ role: 'editor' });
    expect(alice?.tenant).toBe('acme');
    expect(state.users.list()).toEqual([{ uid: 'alice' }]);
    expect(state.users.get('nobody')).toBeNull();
  });

  test('a seeded storage object reads back with its content type and size', async () => {
    const dir = runDir();
    const contentBase64 = Buffer.from('hello world').toString('base64');
    await applySeed(dir, {
      storageRules: ALLOW_ALL_STORAGE,
      storage: [{ path: 'uploads/greeting.txt', contentBase64, contentType: 'text/plain' }],
    });

    const state = await buildEvalState(dir, join(dir, 'events.ndjson'));
    const object = state.storage.get('uploads/greeting.txt');
    expect(object).not.toBeNull();
    expect(object?.contentType).toBe('text/plain');
    expect(object?.size).toBe('hello world'.length);
    expect(state.storage.get('uploads/absent.txt')).toBeNull();
  });

  test('a seeded database tree reads back by path', async () => {
    const dir = runDir();
    await applySeed(dir, { database: { notes: { n1: { title: 'x' } } } });

    const state = await buildEvalState(dir, join(dir, 'events.ndjson'));
    expect(state.database.get('notes/n1')).toMatchObject({ title: 'x' });
    expect(state.database.get('notes/absent')).toBeNull();
  });

  test('rules sources are written into the run directory as files', async () => {
    const dir = runDir();
    await applySeed(dir, {
      firestoreRules: ALLOW_ALL_FIRESTORE,
      databaseRules: '{ "rules": { ".read": true, ".write": true } }',
      storageRules: ALLOW_ALL_STORAGE,
    });

    expect(readFileSync(join(dir, FIRESTORE_RULES_FILE), 'utf8')).toBe(ALLOW_ALL_FIRESTORE);
    expect(readFileSync(join(dir, STORAGE_RULES_FILE), 'utf8')).toBe(ALLOW_ALL_STORAGE);
    expect(readFileSync(join(dir, DATABASE_RULES_FILE), 'utf8')).toContain('".read"');
  });

  test('a declared session is planted where the assurance methods look for one', async () => {
    const dir = runDir();
    const session = {
      schema: 'pyric.verify.fixture.v1',
      description: 'one recorded write',
      events: [],
      services: {},
    };
    await applySeed(dir, { session });

    expect(existsSync(join(dir, SESSION_FILE))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, SESSION_FILE), 'utf8'))).toEqual(session);
  });

  test('a seed that declares no session plants no capture', async () => {
    const dir = runDir();
    await applySeed(dir, { firestore: { 'posts/p1': { title: 'hi' } } });
    expect(existsSync(join(dir, SESSION_FILE))).toBe(false);
  });
});
