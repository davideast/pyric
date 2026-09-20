import { expect, test } from 'bun:test';
import { inTransaction, type SqlConnection } from '../../../src/serve/hosted/persistence/sqlite.js';

for (const failureAt of ['work', 'commit'] as const) {
  test(`a rollback failure preserves the original ${failureAt} error`, () => {
    const original = new Error(`${failureAt} failed`);
    const rollback = new Error('no transaction is active');
    // Fault injection at the SQLite driver boundary, not the transaction helper.
    const connection: SqlConnection = {
      exec(sql) {
        const failsCommit = failureAt === 'commit' && sql === 'COMMIT';
        if (failsCommit) throw original;
        const failsRollback = sql === 'ROLLBACK';
        if (failsRollback) throw rollback;
      },
      prepare() { throw new Error('Statements are not used by this transaction'); },
      close() {},
    };
    expect(() => inTransaction(connection, () => {
      const failsWork = failureAt === 'work';
      if (failsWork) throw original;
    })).toThrow(original);
  });
}
