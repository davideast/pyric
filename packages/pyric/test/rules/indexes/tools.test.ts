/**
 * Unit tests for createFirestoreIndexesTools — the Node-only
 * `firestore_extract_indexes` factory backing `firestore_indexes.generate`.
 * Focus areas: inline `files` extraction, disk `paths`, and the optional
 * `out` write.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFirestoreIndexesTools } from '../../../src/rules/indexes/tools.js';

function handler() {
  const tools = createFirestoreIndexesTools();
  const tool = tools.find((t) => t.name === 'firestore_extract_indexes');
  if (!tool) throw new Error('firestore_extract_indexes not registered');
  return tool;
}

const COMPOUND_SOURCE =
  'function listMine(db, uid) {\n' +
  '  let q = query(collection(db, "orders"));\n' +
  '  q = query(q, where("ownerId", "==", uid), orderBy("createdAt", "desc"));\n' +
  '  return q;\n' +
  '}\n';

describe('createFirestoreIndexesTools', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('extracts a composite index from inline files', async () => {
    const result = (await handler().execute({
      files: [{ name: 'orders.ts', source: COMPOUND_SOURCE }],
    })) as { ok: boolean; data: { success: boolean; data: { config: { indexes: unknown[] } } } };

    expect(result.ok).toBe(true);
    expect(result.data.success).toBe(true);
    expect(result.data.data.config.indexes).toHaveLength(1);
    expect(result.data.data.config.indexes[0]).toMatchObject({ collectionGroup: 'orders' });
  });

  test('extracts from an on-disk path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'firestore-indexes-tool-'));
    tempDirs.push(dir);
    const file = join(dir, 'orders.ts');
    writeFileSync(file, COMPOUND_SOURCE, 'utf-8');

    const result = (await handler().execute({ paths: [file] })) as {
      ok: boolean;
      data: { success: boolean; data: { config: { indexes: unknown[] } } };
    };

    expect(result.ok).toBe(true);
    expect(result.data.data.config.indexes).toHaveLength(1);
  });

  test('out writes the config to disk in addition to returning it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'firestore-indexes-tool-out-'));
    tempDirs.push(dir);
    const outPath = join(dir, 'nested', 'firestore.indexes.json');

    const result = (await handler().execute({
      files: [{ name: 'orders.ts', source: COMPOUND_SOURCE }],
      out: outPath,
    })) as { ok: boolean; data: { data: { config: { indexes: unknown[] } } } };

    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(written.indexes).toHaveLength(1);
    expect(written).toEqual(result.data.data.config);
  });

  test('no files and no paths fails with EXTRACT_FAILED', async () => {
    const result = (await handler().execute({})) as {
      ok: boolean;
      data: { success: boolean; error: { code: string } };
    };
    expect(result.ok).toBe(false);
    expect(result.data.success).toBe(false);
    expect(result.data.error.code).toBe('EXTRACT_FAILED');
  });
});
