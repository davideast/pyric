/**
 * The project's checkpoints, as the serve process names them.
 *
 * What a checkpoint holds and how a backend keeps one is pinned in
 * `pyric/sandbox/checkpoints`. What these pin is that the serve process points
 * the module at the project directory and hands its answers back unchanged, so
 * a checkpoint written here is a checkpoint the module reads.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, getDoc, setDoc } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';

import {
  CHECKPOINT_NAME_PATTERN,
  checkpointNames,
  listProjectCheckpoints,
  readCheckpoint,
  removeCheckpoint,
  restoreCheckpoint,
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

describe('the project checkpoint operations', () => {
  it('captures the live sandbox and restores it', async () => {
    const sandbox = initializeSandbox();
    const projectDir = tmpProjectDir();
    const db = getAdminFirestore(sandbox);
    await setDoc(doc(db, 'rooms/lobby'), { open: true });

    const first = await writeCheckpoint(sandbox, projectDir, 'first');
    expect(first.overwrote).toBe(false);
    expect(first.checkpoint.counts.firestore).toBe(1);

    await setDoc(doc(db, 'rooms/annex'), { open: false });
    const before = await readCheckpoint(projectDir, 'first');
    expect(before).not.toBeNull();

    const restored = await restoreCheckpoint(sandbox, projectDir, 'first');
    expect(restored).not.toBeNull();
    const annex = await getDoc(doc(getAdminFirestore(sandbox), 'rooms/annex'));
    expect(annex.exists()).toBe(false);
    const lobby = await getDoc(doc(getAdminFirestore(sandbox), 'rooms/lobby'));
    expect(lobby.exists()).toBe(true);
  });

  it('writes each checkpoint under the project state directory', async () => {
    const sandbox = initializeSandbox();
    const projectDir = tmpProjectDir();
    await writeCheckpoint(sandbox, projectDir, 'nightly');
    expect(existsSync(join(projectDir, '.pyric', 'state', 'checkpoints', 'nightly.json'))).toBe(
      true,
    );
  });

  it('replaces an existing checkpoint of the same name', async () => {
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
    const { checkpoint } = await writeCheckpoint(sandbox, projectDir, 'ruled');
    expect(checkpoint.state.rules.firestore).toBe(rules);
  });

  it('lists every saved checkpoint by name, sorted, with its counts', async () => {
    const sandbox = initializeSandbox();
    const projectDir = tmpProjectDir();
    expect(await checkpointNames(projectDir)).toEqual([]);
    await writeCheckpoint(sandbox, projectDir, 'b');
    await writeCheckpoint(sandbox, projectDir, 'a');

    expect(await checkpointNames(projectDir)).toEqual(['a', 'b']);
    const listed = await listProjectCheckpoints(projectDir);
    expect(listed.map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(typeof listed[0]!.at).toBe('number');
  });

  it('reads back null for a checkpoint that was never saved', async () => {
    expect(await readCheckpoint(tmpProjectDir(), 'never-saved')).toBeNull();
  });

  it('reports nothing when restoring a checkpoint the project does not hold', async () => {
    const sandbox = initializeSandbox();
    expect(await restoreCheckpoint(sandbox, tmpProjectDir(), 'absent')).toBeNull();
  });

  it('removes one checkpoint and reports whether there was one', async () => {
    const sandbox = initializeSandbox();
    const projectDir = tmpProjectDir();
    await writeCheckpoint(sandbox, projectDir, 'nightly');
    expect(await removeCheckpoint(projectDir, 'nightly')).toBe(true);
    expect(await checkpointNames(projectDir)).toEqual([]);
    expect(await removeCheckpoint(projectDir, 'nightly')).toBe(false);
  });
});
