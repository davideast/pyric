import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDatabaseIndexQuery, analyzeServiceIndex } from 'pyric/sandbox/internal';
import { createIndexConfigStore } from '../../src/serve/index-config-store.js';
import { readDatabaseIndexConfig } from '../../src/serve/database-index-config.js';

const query = captureDatabaseIndexQuery('/teams/alice/projects', { orderBy: { kind: 'child', path: 'budget' } });
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rtdb-index-config-'));
  try {
    await writeFile(join(root, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('RTDB preview and apply preserve security, wildcard paths, comments and existing array entries', () => fixture(async root => {
  const original = `// keep header\n{"rules":{".read":false,"teams":{"$uid":{"projects":{".read":"auth.uid == $uid",".write":false,".validate":"newData.hasChildren()",".indexOn":["name" /* preserve inner comment */]}}}}}`;
  const path = join(root, 'database.rules.json');
  await writeFile(path, original);
  const store = createIndexConfigStore(root);
  const preview = await store.preview(query);
  expect(preview.finding.status).toBe('missing');
  expect(preview.addition).toEqual({ path: '/teams/$uid/projects', indexOn: ['name', 'budget'] });
  expect(await readFile(path, 'utf8')).toBe(original);
  await store.apply(query, preview.revision);
  const changed = await readFile(path, 'utf8');
  expect(changed).toContain('// keep header');
  expect(changed).toContain('/* preserve inner comment */');
  const updatedRules = readDatabaseIndexConfig(changed);
  expect(updatedRules).toEqual({ rules: { '.read': false, teams: { '$uid': { projects: { '.read': 'auth.uid == $uid', '.write': false, '.validate': 'newData.hasChildren()', '.indexOn': ['name', 'budget'] } } } } });
  expect((await store.preview(query)).finding.status).toBe('covered');
  const again = await store.preview(query);
  await store.apply(query, again.revision);
  expect(await readFile(path, 'utf8')).toBe(changed);
}));
test('RTDB stale revisions and duplicate rule keys cannot overwrite rules', () => fixture(async root => {
  const path = join(root, 'database.rules.json');
  await writeFile(path, '{"rules":{"teams":{"$uid":{"projects":{".read":true}}}}}');
  const store = createIndexConfigStore(root);
  const preview = await store.preview(query);
  await writeFile(path, '{"rules":{".read":false}}');
  await expect(store.apply(query, preview.revision)).rejects.toThrow('changed');
  await writeFile(path, '{"rules":{".read":true,".read":false}}');
  await expect(store.preview(query)).rejects.toThrow('Duplicate');
}));
test('known missing indexes retain warnings but block ambiguous automatic edits', () => fixture(async root => {
  const path = join(root, 'database.rules.json');
  const original = '{"rules":{"teams":{"$uid":{"projects":{}},"alice":{"projects":{}}}}}';
  await writeFile(path, original);
  const store = createIndexConfigStore(root);
  const preview = await store.preview(query);
  expect(preview.finding).toMatchObject({ status: 'missing', editBlocked: expect.stringContaining('Several rule paths') });
  expect(preview.addition).toBeNull();
  await store.apply(query, preview.revision);
  expect(await readFile(path, 'utf8')).toBe(original);
}));
test('built-in orderings are automatic; nested child and value indexes remain distinct', () => {
  const config = readDatabaseIndexConfig('{"rules":{"projects":{".indexOn":["owner/name",".value"]}}}');
  for (const orderBy of [{ kind: 'key' }, { kind: 'priority' }, { kind: 'value' }, { kind: 'child', path: 'owner/name' }] as const) {
    expect(analyzeServiceIndex(captureDatabaseIndexQuery('/projects', { orderBy }), config).status).toBe('covered');
  }
  expect(analyzeServiceIndex(captureDatabaseIndexQuery('/projects', { orderBy: { kind: 'child', path: 'name' } }), config).status).toBe('missing');
});
test('string index becomes an array without changing unrelated rules; multi-database selection stays manual', () => fixture(async root => {
  const path = join(root, 'database.rules.json');
  await writeFile(path, '{"rules":{"teams":{"$uid":{"projects":{".indexOn":"name",".write":"auth != null"}}}}}');
  const store = createIndexConfigStore(root);
  const preview = await store.preview(query);
  await store.apply(query, preview.revision);
  expect(readDatabaseIndexConfig(await readFile(path, 'utf8'))).toEqual({ rules: { teams: { '$uid': { projects: { '.indexOn': ['name', 'budget'], '.write': 'auth != null' } } } } });
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ database: [{ rules: 'database.rules.json' }, { rules: 'other.rules.json' }] }));
  await expect(store.preview(query)).rejects.toThrow('single database');
}));
