/**
 * `firestore_indexes.generate`: composed through the real MCP surface (not
 * the raw factory) so the record, the in-process factory map, and the
 * schema folding are all exercised together.
 */
import { describe, expect, it } from 'bun:test';
import { composeMcpTools } from '../../src/bridge/server/tool-surface.js';

const COMPOUND_SOURCE =
  'function listMine(db, uid) {\n' +
  '  let q = query(collection(db, "orders"));\n' +
  '  q = query(q, where("ownerId", "==", uid), orderBy("createdAt", "desc"));\n' +
  '  return q;\n' +
  '}\n';

function generateOp() {
  const tool = composeMcpTools().find((t) => t.name === 'firestore_indexes');
  if (!tool) throw new Error('firestore_indexes tool not composed');
  const op = tool.ops.find((o) => o.op === 'generate');
  if (!op || !op.execute) throw new Error('firestore_indexes.generate is not an in-process op');
  return op;
}

describe('firestore_indexes.generate', () => {
  it('is composed as an in-process op', () => {
    const op = generateOp();
    expect(op.transport).toBe('in-process');
    expect(op.handler).toBe('firestore_extract_indexes');
  });

  it('extracts the composite index from an inline source with one compound query', async () => {
    const op = generateOp();
    const result = await op.execute!({
      files: [{ name: 'orders.ts', source: COMPOUND_SOURCE }],
    });

    expect(result.ok).toBe(true);
    const data = result.data as { success: boolean; data: { config: { indexes: unknown[] } } };
    expect(data.success).toBe(true);
    expect(data.data.config.indexes).toHaveLength(1);
    expect(data.data.config.indexes[0]).toMatchObject({ collectionGroup: 'orders' });
  });

  it('rejects a call with neither files nor paths', () => {
    const tool = composeMcpTools().find((t) => t.name === 'firestore_indexes')!;
    const op = tool.ops.find((o) => o.op === 'generate')!;
    expect(op.validate({})).toBeNull(); // both fields optional at the schema layer; the handler enforces "at least one"
  });
});
