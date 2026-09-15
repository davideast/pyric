import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThresholdConfigStore } from '../../src/serve/threshold-config-store.js';
import { readThresholdConfig } from '../../src/serve/runtime/rate-threshold-config.js';
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pyric-thresholds-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('reading defaults writes nothing; save preserves unrelated project fields and survives restart', () => fixture(async root => {
  const store = createThresholdConfigStore(root);
  expect((await store.read()).config).toEqual({});
  expect(await readFile(join(root, 'pyric.json'), 'utf8').catch(() => null)).toBeNull();
  await writeFile(join(root, 'pyric.json'), JSON.stringify({ command: 'vite', runtime: { custom: true }, flow: { treatment: 'scan' } }));
  const current = await store.read();
  await store.save({ rtdb: { writes: 7, reads: null } }, current.revision);
  expect(JSON.parse(await readFile(join(root, 'pyric.json'), 'utf8'))).toEqual({ command: 'vite', runtime: { custom: true, thresholds: { rtdb: { writes: 7, reads: null } } }, flow: { treatment: 'scan' } });
  expect((await createThresholdConfigStore(root).read()).config.rtdb?.writes).toBe(7);
}));
test('stale and concurrent writes cannot silently overwrite a newer edit', () => fixture(async root => {
  const store = createThresholdConfigStore(root);
  const current = await store.read();
  const results = await Promise.allSettled([store.save({ rtdb: { writes: 7 } }, current.revision), store.save({ rtdb: { writes: 8 } }, current.revision)]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect((await store.read()).config.rtdb?.writes).toBe(7);
}));
test('invalid JSON, invalid limits, and symlink escapes are rejected', () => fixture(async root => {
  const store = createThresholdConfigStore(root);
  await writeFile(join(root, 'pyric.json'), '{broken');
  await expect(store.read()).rejects.toThrow();
  await rm(join(root, 'pyric.json'));
  await symlink(join(tmpdir(), 'outside-pyric.json'), join(root, 'pyric.json'));
  await expect(store.read()).rejects.toThrow();
  for (const value of [{ rtdb: { writes: -1 } }, { firestore: { reads: 1 } }, { sustainedSeconds: 0 }, { sustainedSeconds: 61 }, { rtdb: { writes: Infinity } }]) expect(() => readThresholdConfig(value)).toThrow();
}));
