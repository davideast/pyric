/**
 * The directory backend: the on-disk form of a checkpoint and the round trip
 * through it. What these pin is the file layout and the loader, not the
 * capture or restore semantics, which `capture.test.ts` covers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureCheckpoint } from '../../../src/sandbox/checkpoints/index.js';
import {
  CHECKPOINT_STORE_RELATIVE,
  directoryCheckpointBackend,
} from '../../../src/sandbox/checkpoints/directory-backend.js';
import { CheckpointNameError } from '../../../src/sandbox/checkpoints/types.js';
import { populatedSandbox } from '../branches/fixtures.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-checkpoint-dir-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** A checkpoint of a sandbox holding state in every service. */
async function populatedCheckpoint() {
  return captureCheckpoint(await populatedSandbox());
}

describe('the directory checkpoint backend', () => {
  it('writes one file per checkpoint, named by the checkpoint', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    await backend.write('nightly', await populatedCheckpoint());

    const path = join(projectDir, CHECKPOINT_STORE_RELATIVE, 'nightly.json');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { format: string };
    expect(parsed.format).toBe('pyric-checkpoint-v1');
  });

  it('reads a checkpoint back to the value it wrote', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    const checkpoint = await populatedCheckpoint();
    await backend.write('nightly', checkpoint);
    expect(await backend.read('nightly')).toEqual(checkpoint);
  });

  it('reports nothing for a name the directory does not hold', async () => {
    expect(await directoryCheckpointBackend(projectDir).read('absent')).toBeNull();
  });

  it('replaces a checkpoint written under a name it already holds', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    await backend.write('nightly', await populatedCheckpoint());
    const second = await populatedCheckpoint();
    await backend.write('nightly', second);

    expect(await backend.read('nightly')).toEqual(second);
    expect((await backend.list()).map((entry) => entry.name)).toEqual(['nightly']);
  });

  it('lists every checkpoint by filename, ordered, with its counts', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    await backend.write('nightly', await populatedCheckpoint());
    await backend.write('before-migration', await populatedCheckpoint());

    const listed = await backend.list();
    expect(listed.map((entry) => entry.name)).toEqual(['before-migration', 'nightly']);
    expect(listed[0]!.counts).toEqual({ firestore: 2, database: 1, storage: 1, auth: 1 });
  });

  it('lists nothing when the project has no checkpoint directory', async () => {
    expect(await directoryCheckpointBackend(projectDir).list()).toEqual([]);
  });

  it('skips a file that carries no format tag rather than failing the listing', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    await backend.write('good', await populatedCheckpoint());
    writeFileSync(join(projectDir, CHECKPOINT_STORE_RELATIVE, 'rubble.json'), '{"other":1}');
    mkdirSync(join(projectDir, CHECKPOINT_STORE_RELATIVE, 'a-directory.json'), {
      recursive: true,
    });

    expect((await backend.list()).map((entry) => entry.name)).toEqual(['good']);
  });

  it('removes one file and reports whether there was one to remove', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    await backend.write('nightly', await populatedCheckpoint());
    expect(await backend.remove('nightly')).toBe(true);
    expect(await backend.list()).toEqual([]);
    expect(await backend.remove('nightly')).toBe(false);
  });

  it('refuses a name that would escape the checkpoint directory', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    const checkpoint = await populatedCheckpoint();
    expect(backend.write('../escape', checkpoint)).rejects.toThrow(CheckpointNameError);
    expect(backend.read('..')).rejects.toThrow(CheckpointNameError);
    expect(backend.remove('a/b')).rejects.toThrow(CheckpointNameError);
  });
});
