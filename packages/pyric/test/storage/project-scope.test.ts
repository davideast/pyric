/**
 * Storage database project scoping (issue #359, defect B).
 *
 * IndexedDB is origin-scoped, so the fixed default database name
 * (`pyric-storage`) made every project served on one localhost port share
 * one storage database — unrelated projects' objects surfaced in Studio.
 * The default DB name is now derived from the project identity
 * (`pyric-storage:<projectId>`); an explicit `dbName` still wins.
 *
 * Migration: the old shared `pyric-storage` DB is deliberately orphaned,
 * not migrated and not deleted (see the comment at DEFAULT_DB_NAME).
 *
 * The isolation cases fail against the pre-fix code: without the
 * `projectId` option, both services open the SAME shared database and the
 * cross-project read sees the other project's object.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { storageDbName } from '../../src/storage/persistence.js';
import { getStorageSandbox, getStorageService } from '../../src/storage/service.js';

/** Unique per-run project ids so fake-indexeddb's process-global registry
 *  never bleeds state between test invocations. */
function uniqueProject(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

const META = {
  name: 'logo.png',
  bucket: 'pyric-default',
  generation: '1',
  metageneration: '1',
  timeCreated: '2026-07-17T00:00:00.000Z',
  updated: '2026-07-17T00:00:00.000Z',
  size: 4,
} as const;

async function putObject(projectOptions: { projectId?: string; dbName?: string }): Promise<void> {
  const storage = getStorageSandbox(initializeSandbox(), projectOptions);
  const service = await getStorageService(storage);
  await service.backend.put('uploads/logo.png', new Blob(['data']), {
    ...META,
    fullPath: 'uploads/logo.png',
  });
}

async function listObjects(projectOptions: {
  projectId?: string;
  dbName?: string;
}): Promise<number> {
  const storage = getStorageSandbox(initializeSandbox(), projectOptions);
  const service = await getStorageService(storage);
  return (await service.backend.listByPrefix('')).length;
}

describe('storage db project scoping', () => {
  it('derives pyric-storage:<projectId> and falls back to the legacy shared name', () => {
    expect(storageDbName('demo-app')).toBe('pyric-storage:demo-app');
    expect(storageDbName(null)).toBe('pyric-storage');
    expect(storageDbName(undefined)).toBe('pyric-storage');
  });

  it('two project identities open two isolated databases', async () => {
    const projectA = uniqueProject('proj-a');
    const projectB = uniqueProject('proj-b');

    await putObject({ projectId: projectA });

    // Project B must NOT see project A's object (pre-fix: shared DB, sees it).
    expect(await listObjects({ projectId: projectB })).toBe(0);
    // The same identity on a fresh sandbox shares project A's database.
    expect(await listObjects({ projectId: projectA })).toBe(1);
  });

  it('an explicit dbName overrides the project-derived default', async () => {
    const project = uniqueProject('proj-override');
    const explicit = `explicit-${uniqueProject('db')}`;

    await putObject({ projectId: project });

    // Same projectId + explicit dbName → the explicit database, not the
    // project-scoped one.
    expect(await listObjects({ projectId: project, dbName: explicit })).toBe(0);
    expect(await listObjects({ projectId: project })).toBe(1);
  });
});
