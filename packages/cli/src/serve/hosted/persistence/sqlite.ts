/** Common SQLite values; no runtime-specific database types cross this seam. */
export type SqlValue = null | string | number | bigint | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  run(...values: SqlValue[]): unknown;
  get(...values: SqlValue[]): SqlRow | undefined;
  all(...values: SqlValue[]): SqlRow[];
  iterate(...values: SqlValue[]): IterableIterator<SqlRow>;
}

export interface SqlConnection {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export function requireNodePersistence(): void {
  const runsOnBun = typeof process.versions.bun === 'string';
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supportedNode = major > 22 || (major === 22 && minor >= 15);
  const unsupportedRuntime = runsOnBun || !supportedNode;
  if (unsupportedRuntime) {
    throw new Error('Hosted SQLite persistence requires Node >=22.15. Hosted mode is unavailable in the Bun standalone binary; use the Node CLI or SharedWorker mode.');
  }
}

/** Only this adapter imports Node's SQLite implementation. */
export async function openNodeSqlite(path: string, readOnly = false): Promise<SqlConnection> {
  requireNodePersistence();
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path, { readOnly });
}

/** The callback is synchronous: no transaction remains open across an await. */
export function inTransaction<T>(connection: SqlConnection, work: () => T, mode: 'read' | 'write' = 'write'): T {
  const isRead = mode === 'read';
  connection.exec(isRead ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    connection.exec('COMMIT');
    return result;
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

export function sqlText(row: SqlRow, name: string): string {
  const value = row[name];
  const isText = typeof value === 'string';
  const invalidText = !isText;
  if (invalidText) throw new Error(`Invalid persisted column '${name}': expected text.`);
  return value;
}
