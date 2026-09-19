import { FirebaseError } from 'pyric/app';
import { inTransaction, type SqlConnection } from './sqlite.js';

export interface PersistenceStatus {
  state: 'healthy' | 'unhealthy';
  commits: number;
  lastCommitMs: number | null;
  maxCommitMs: number;
  failedAt: number | null;
}

export type Commit = <T>(work: () => T) => T;

/** One failure latch for all durable services, with bounded commit telemetry. */
export function createCommitController(connection: SqlConnection) {
  let status: PersistenceStatus = { state: 'healthy', commits: 0, lastCommitMs: null, maxCommitMs: 0, failedAt: null };
  let active = false;
  const listeners = new Set<() => void>();
  function markUnhealthy(): void {
    const alreadyFailed = status.state === 'unhealthy';
    if (alreadyFailed) return;
    status = { ...status, state: 'unhealthy', failedAt: Date.now() };
    for (const listener of listeners) listener();
  }
  function commit<T>(work: () => T): T {
    const unhealthy = status.state === 'unhealthy';
    if (unhealthy) throw new FirebaseError('persistence-unhealthy', 'Hosted persistence is unhealthy. Repair it and restart before further mutations.');
    // A fixture may contain several services; their writes join its transaction.
    if (active) return work();
    const started = performance.now();
    active = true;
    try {
      const result = inTransaction(connection, work);
      const duration = performance.now() - started;
      status = { ...status, commits: status.commits + 1, lastCommitMs: duration, maxCommitMs: Math.max(status.maxCommitMs, duration) };
      return result;
    } catch (error) {
      markUnhealthy();
      const sqliteFailure = error instanceof Error && 'errcode' in error;
      if (sqliteFailure) throw new FirebaseError('persistence-unhealthy', 'The persistence transaction failed. Repair the store and restart before further mutations.', { cause: error });
      throw error;
    } finally { active = false; }
  }
  return {
    commit,
    markUnhealthy,
    status: (): PersistenceStatus => ({ ...status }),
    onFailure(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
