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

test('resolves RTDB indexes and returns unconfigured for firestore when firebase.json only configures database', () => fixture(async root => {
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
  await writeFile(join(root, 'database.rules.json'), JSON.stringify({ rules: { projects: { '.indexOn': 'budget' } } }));
  const store = createIndexConfigStore(root);
  const defaultRead = await store.read();
  expect(defaultRead.status).toBe('configured');
  expect(defaultRead.service).toBe('rtdb');
  expect(defaultRead.path).toBe('database.rules.json');

  const firestoreRead = await store.read('firestore');
  expect(firestoreRead.status).toBe('unconfigured');
  expect(firestoreRead.service).toBe('firestore');
  expect(firestoreRead.path).toBeNull();
  expect(firestoreRead.config).toBeNull();

  const rtdbRead = await store.read('rtdb');
  expect(rtdbRead.status).toBe('configured');
  expect(rtdbRead.service).toBe('rtdb');
  expect(rtdbRead.path).toBe('database.rules.json');

  await expect(store.preview(query)).rejects.toThrow('Set firestore.indexes in firebase.json');
}));

test('returns unconfigured without throwing when firebase.json lacks index configuration or is missing', () => fixture(async root => {
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ storage: { rules: 'storage.rules' } }));
  const store = createIndexConfigStore(root);
  const firestoreRead = await store.read('firestore');
  expect(firestoreRead.status).toBe('unconfigured');
  expect(firestoreRead.path).toBeNull();

  const rtdbRead = await store.read('rtdb');
  expect(rtdbRead.status).toBe('unconfigured');
  expect(rtdbRead.path).toBeNull();

  await rm(join(root, 'firebase.json'));
  const missingRead = await store.read();
  expect(missingRead.status).toBe('unconfigured');
  await expect(store.preview(query)).rejects.toThrow('Set firestore.indexes in firebase.json');
}));

