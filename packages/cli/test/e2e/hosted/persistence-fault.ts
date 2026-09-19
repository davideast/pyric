import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Inject a commit failure without depending on permissions of an already-open file. */
export function setPersistenceWritable(stateDirectory: string, writable: boolean): void {
  const path = join(stateDirectory, 'hosted', 'state.sqlite');
  const absent = !existsSync(path);
  if (absent) return;
  const database = new DatabaseSync(path);
  try {
    for (const table of ['records', 'storage_objects']) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const trigger = `test_fail_${table}_${operation}`;
        if (writable) database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
        else database.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`);
      }
    }
  } finally { database.close(); }
}
