import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, getDoc, setDoc } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';

import {
  applyCheckpoint,
  CHECKPOINT_NAME_PATTERN,
  checkpointNames,
  readCheckpoint,
  writeCheckpoint,
} from '../../../src/bridge/surface/checkpoints.js';

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-checkpoints-'));
}

describe('CHECKPOINT_NAME_PATTERN', () => {
  it('accepts letters, digits, underscore, and hyphen', () => {
    expect(CHECKPOINT_NAME_PATTERN.test('before-migration_2')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(CHECKPOINT_NAME_PATTERN.test('has a space')).toBe(false);
    expect(CHECKPOINT_NAME_PATTERN.test('../escape')).toBe(false);
  });
});

describe('writeCheckpoint / readCheckpoint / applyCheckpoint', () => {
  it('captures the live sandbox and restores it byte for byte', async () => {
    const sandbox = initializeSandbox();
    const projectDir = tmpProjectDir();
    const db = getAdminFirestore(sandbox);
    await setDoc(doc(db, 'rooms/lobby'), { open: true });

    const first = await writeCheckpoint(sandbox, projectDir, 'first');
    expect(first.overwrote).toBe(false);
    expect(first.file.counts.firestore).toBe(1);

    await setDoc(doc(db, 'rooms/annex'), { open: false });
    const before = readCheckpoint(projectDir, 'first');
    expect(before).not.toBeNull();

    await applyCheckpoint(sandbox, before!);
    const annex = await getDoc(doc(db, 'rooms/annex'));
    expect(annex.exists()).toBe(false);
    const lobby = await getDoc(doc(db, 'rooms/lobby'));
    expect(lobby.exists()).toBe(true);
  });

  it('overwrites an existing checkpoint of the same name', async () => {
    const sandbox = initializeSandbox();
    const projectDir = tmpProjectDir();
    const first = await writeCheckpoint(sandbox, projectDir, 'again');
    expect(first.overwrote).toBe(false);
    const second = await writeCheckpoint(sandbox, projectDir, 'again');
    expect(second.overwrote).toBe(true);
  });

  it('carries the firestore rules source through the round trip', async () => {
    const sandbox = initializeSandbox();
    const projectDir = tmpProjectDir();
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;
    setRules(sandbox, rules);
    const { file } = await writeCheckpoint(sandbox, projectDir, 'ruled');
    expect(file.firestoreRules).toBe(rules);
  });

  it('lists every saved checkpoint by name, sorted', async () => {
    const sandbox = initializeSandbox();
    const projectDir = tmpProjectDir();
    expect(checkpointNames(projectDir)).toEqual([]);
    await writeCheckpoint(sandbox, projectDir, 'b');
    await writeCheckpoint(sandbox, projectDir, 'a');
    expect(checkpointNames(projectDir)).toEqual(['a', 'b']);
  });

  it('reads back null for a checkpoint that was never saved', () => {
    const projectDir = tmpProjectDir();
    expect(readCheckpoint(projectDir, 'never-saved')).toBeNull();
  });
});
