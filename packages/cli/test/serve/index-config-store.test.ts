import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureIndexQuery } from 'pyric/sandbox/internal';
import { createIndexConfigStore } from '../../src/serve/index-config-store.js';

const query = captureIndexQuery('projects', false, [{ kind: 'where', field: 'status', op: '==' }], [{ field: 'createdAt', direction: 'desc' }]);
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pyric-indexes-'));
  try { await mkdir(join(root, 'config')); await writeFile(join(root, 'firebase.json'), JSON.stringify({ firestore: { indexes: 'config/indexes.json' } })); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('preview is read-only; apply preserves indexes, overrides and unrelated metadata', () => fixture(async root => {
  const existing = { indexes: [{ collectionGroup: 'orders', queryScope: 'COLLECTION', fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'total', order: 'DESCENDING' }] }], fieldOverrides: [{ collectionGroup: 'projects', fieldPath: 'secret', indexes: [] }], label: 'keep' };
  const path = join(root, 'config/indexes.json');
  await writeFile(path, JSON.stringify(existing));
  const store = createIndexConfigStore(root);
  const preview = await store.preview(query);
  expect(preview.path).toBe('config/indexes.json');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(existing);
  await store.apply(query, preview.revision);
  const result = JSON.parse(await readFile(path, 'utf8'));
  expect(result.indexes).toHaveLength(2);
  expect(result.indexes[0]).toEqual(existing.indexes[0]);
  expect(result.fieldOverrides).toEqual(existing.fieldOverrides);
  expect(result.label).toBe('keep');
  const next = await store.preview(query);
  expect(next.addition).toBeNull();
  await store.apply(query, next.revision);
  expect(JSON.parse(await readFile(path, 'utf8')).indexes).toHaveLength(2);
}));
test('rejects stale previews and changed configured paths', () => fixture(async root => {
  const store = createIndexConfigStore(root);
  const preview = await store.preview(query);
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ firestore: { indexes: 'config/other.json' } }));
  await expect(store.apply(query, preview.revision)).rejects.toThrow('changed');
}));
test('invalid JSON and symlink escapes cannot be overwritten', () => fixture(async root => {
  await writeFile(join(root, 'config/indexes.json'), '{bad');
  const store = createIndexConfigStore(root);
  await expect(store.preview(query)).rejects.toThrow();
  await rm(join(root, 'config/indexes.json'));
  await symlink(tmpdir(), join(root, 'config/outside'));
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ firestore: { indexes: 'config/outside/indexes.json' } }));
  await expect(store.read()).rejects.toThrow('escapes');
}));

test('accepts a project directory from a directory URL with a trailing slash', () => fixture(async root => {
  const store = createIndexConfigStore(`${root}/`);
  const preview = await store.preview(query);
  expect(preview.path).toBe('config/indexes.json');
  expect(preview.finding.status).toBe('missing');
  await store.apply(query, preview.revision);
  expect((await store.preview(query)).finding.status).toBe('covered');
}));
