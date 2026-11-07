import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminDatabase, ref, set, setPriority } from '../../../src/database/index.js';
import { exportDatabaseVal } from '../../../src/database/internal/export-val.js';

describe('exportDatabaseVal', () => {
  it("reads an instance's whole tree, priorities kept, and records no read", async () => {
    const sandbox = initializeSandbox();
    try {
      const db = getAdminDatabase(sandbox, 'second-instance');
      await set(ref(db, '/items/a'), { count: 1 });
      await setPriority(ref(db, '/items/a'), 3);
      const before = sandbox.history().length;
      expect(exportDatabaseVal(db)).toEqual({ items: { a: { count: 1, '.priority': 3 } } });
      expect(sandbox.history().length).toBe(before);
    } finally {
      sandbox.dispose();
    }
  });
});
