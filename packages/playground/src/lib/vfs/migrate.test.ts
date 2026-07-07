/**
 * Legacy `/workspace` → session-container migration tests.
 * Runs against the in-memory adapter (same promises contract as OPFS).
 */
import { describe, expect, it } from 'bun:test';
import { createMemoryVFSAdapter } from './memory-adapter';
import { createScopedVFSAdapter } from './scoped-adapter';
import { migrateLegacyWorkspace } from './migrate';

const CONTAINER = '/sessions/recovered';

async function seedLegacy(raw: ReturnType<typeof createMemoryVFSAdapter>) {
  const fs = raw.promises;
  await fs.mkdir('/workspace/src', { recursive: true });
  await fs.mkdir('/workspace/.git/refs/heads', { recursive: true });
  await fs.writeFile('/workspace/firestore.rules', 'legacy rules');
  await fs.writeFile('/workspace/src/App.tsx', 'legacy app');
  // Binary content (checkpoints git packfile shape).
  await fs.writeFile('/workspace/.git/pack.bin', new Uint8Array([0, 1, 2, 255, 254]));
  await fs.writeFile('/workspace/.git/refs/heads/main', 'abc123\n');
  // Absolute symlink into the legacy tree.
  await fs.symlink('/workspace/firestore.rules', '/workspace/rules-link');
}

describe('migrateLegacyWorkspace', () => {
  it('moves the whole legacy tree (incl. .git, binary, symlinks) into the container and deletes the legacy root', async () => {
    const raw = createMemoryVFSAdapter();
    await seedLegacy(raw);

    const result = await migrateLegacyWorkspace(raw, CONTAINER);
    expect(result.migrated).toBe(true);
    expect(result.files).toBe(5);

    const fs = raw.promises;
    expect(await fs.readFile(`${CONTAINER}/workspace/firestore.rules`, 'utf8')).toBe(
      'legacy rules',
    );
    expect(await fs.readFile(`${CONTAINER}/workspace/src/App.tsx`, 'utf8')).toBe('legacy app');
    expect(await fs.readFile(`${CONTAINER}/workspace/.git/refs/heads/main`, 'utf8')).toBe(
      'abc123\n',
    );
    const bin = (await fs.readFile(`${CONTAINER}/workspace/.git/pack.bin`)) as Uint8Array;
    expect([...bin]).toEqual([0, 1, 2, 255, 254]);
    // Absolute symlink target re-aimed at the container.
    expect(await fs.readlink(`${CONTAINER}/workspace/rules-link`)).toBe(
      `${CONTAINER}/workspace/firestore.rules`,
    );
    // Legacy root is gone.
    await expect(fs.lstat('/workspace')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('migrated content is visible through the session-scoped adapter at the old virtual paths', async () => {
    const raw = createMemoryVFSAdapter();
    await seedLegacy(raw);
    await migrateLegacyWorkspace(raw, CONTAINER);

    const scoped = createScopedVFSAdapter(raw, { realRoot: CONTAINER });
    expect(await scoped.promises.readFile('/workspace/firestore.rules', 'utf8')).toBe(
      'legacy rules',
    );
    expect(await scoped.promises.readlink('/workspace/rules-link')).toBe(
      '/workspace/firestore.rules',
    );
  });

  it('is idempotent — a second run is a no-op', async () => {
    const raw = createMemoryVFSAdapter();
    await seedLegacy(raw);
    const first = await migrateLegacyWorkspace(raw, CONTAINER);
    expect(first.migrated).toBe(true);

    const second = await migrateLegacyWorkspace(raw, CONTAINER);
    expect(second.migrated).toBe(false);
    expect(second.files).toBe(0);
    // Content intact.
    expect(
      await raw.promises.readFile(`${CONTAINER}/workspace/firestore.rules`, 'utf8'),
    ).toBe('legacy rules');
  });

  it('no legacy root → no-op', async () => {
    const raw = createMemoryVFSAdapter();
    const result = await migrateLegacyWorkspace(raw, CONTAINER);
    expect(result.migrated).toBe(false);
  });

  it('retry after a partial copy never overwrites already-copied files', async () => {
    const raw = createMemoryVFSAdapter();
    await seedLegacy(raw);
    // Simulate a prior partial run: one file already landed in the
    // container, and (say) the user edited it there since.
    await raw.promises.mkdir(`${CONTAINER}/workspace`, { recursive: true });
    await raw.promises.writeFile(`${CONTAINER}/workspace/firestore.rules`, 'edited in session');

    const result = await migrateLegacyWorkspace(raw, CONTAINER);
    expect(result.migrated).toBe(true);
    // Pre-existing destination file kept; the rest copied.
    expect(
      await raw.promises.readFile(`${CONTAINER}/workspace/firestore.rules`, 'utf8'),
    ).toBe('edited in session');
    expect(await raw.promises.readFile(`${CONTAINER}/workspace/src/App.tsx`, 'utf8')).toBe(
      'legacy app',
    );
  });
});
