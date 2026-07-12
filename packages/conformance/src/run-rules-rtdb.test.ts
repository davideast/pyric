/**
 * The RTDB rules runner's DATA CLEANUP contract.
 *
 * The runner restores the rules it deployed and proves the restore by reading
 * back. It must do the same for the DATA the corpus ops write: a run that
 * restores the rules but leaves its run-scoped namespace behind has not cleaned
 * up after itself. `verifyRunDataCleanup` is the seam that makes the invariant
 * testable without credentials — it takes a `RunDataStore` rather than reaching
 * for the network, so a fake store can drive every branch:
 *
 *   - the namespace is deleted, and the deletion is PROVEN by an independent
 *     shallow read of the root (not by trusting the DELETE's status code);
 *   - a delete that "succeeds" but leaves the key visible is a FAILED cleanup;
 *   - a failing delete or a failing read-back propagates, so the caller can
 *     refuse to treat the run as clean.
 *
 * The credentialed capture path itself is not covered here (it needs a live
 * database); the cleanup contract it depends on is.
 */
import { describe, it, expect } from 'bun:test';
import {
  assertMatchingOracleProjects,
  observationLinkageOf,
  selectRtdbScenarios,
  verifyRunDataCleanup,
  type RunDataStore,
} from './run-rules-rtdb.ts';

const AUDIT_KEY = 'pyric_oracle_rulesrtdb_1752000000000_ab12cd';

/** A fake database root. `deleteNamespace` removes the key unless `leaky`, which
 *  models the exact failure the read-back exists to catch: a delete that reports
 *  success but does not remove the data. */
function fakeStore(opts: {
  rootKeys: string[];
  leaky?: boolean;
  failDelete?: boolean;
  failRead?: boolean;
}): RunDataStore & { deleted: string[] } {
  const keys = new Set(opts.rootKeys);
  const deleted: string[] = [];
  return {
    deleted,
    async deleteNamespace(auditKey: string): Promise<void> {
      if (opts.failDelete) throw new Error('delete run data failed: 403 Permission denied');
      deleted.push(auditKey);
      if (!opts.leaky) keys.delete(auditKey);
    },
    async shallowRootKeys(): Promise<string[]> {
      if (opts.failRead) throw new Error('shallow root read failed: 500');
      return [...keys];
    },
  };
}

describe('run-rules-rtdb data cleanup contract', () => {
  it('deletes the run-scoped namespace and verifies its absence by shallow read', async () => {
    const store = fakeStore({ rootKeys: [AUDIT_KEY, 'real_app_data'] });
    await verifyRunDataCleanup(store, AUDIT_KEY);
    expect(store.deleted).toEqual([AUDIT_KEY]);
    // The read-back witness must now agree the namespace is gone.
    expect(await store.shallowRootKeys()).not.toContain(AUDIT_KEY);
  });

  it('leaves unrelated root data untouched', async () => {
    const store = fakeStore({ rootKeys: [AUDIT_KEY, 'real_app_data', 'users'] });
    await verifyRunDataCleanup(store, AUDIT_KEY);
    expect(await store.shallowRootKeys()).toEqual(['real_app_data', 'users']);
  });

  it('is clean when the namespace never existed (read-only run wrote no data)', async () => {
    const store = fakeStore({ rootKeys: ['real_app_data'] });
    await expect(verifyRunDataCleanup(store, AUDIT_KEY)).resolves.toBeUndefined();
  });

  // THE REASON THE READ-BACK EXISTS: a DELETE that reports success but leaves
  // the data behind must NOT pass as a clean run.
  it('FAILS when the shallow read still lists the namespace after deletion', async () => {
    const store = fakeStore({ rootKeys: [AUDIT_KEY], leaky: true });
    await expect(verifyRunDataCleanup(store, AUDIT_KEY)).rejects.toThrow(
      /data cleanup NOT verified/,
    );
    // The delete WAS attempted and reported success — only the read-back caught it.
    expect(store.deleted).toEqual([AUDIT_KEY]);
  });

  it('propagates a failing delete', async () => {
    const store = fakeStore({ rootKeys: [AUDIT_KEY], failDelete: true });
    await expect(verifyRunDataCleanup(store, AUDIT_KEY)).rejects.toThrow(/delete run data failed/);
  });

  it('propagates a failing read-back rather than assuming the delete worked', async () => {
    const store = fakeStore({ rootKeys: [AUDIT_KEY], failRead: true });
    await expect(verifyRunDataCleanup(store, AUDIT_KEY)).rejects.toThrow(/shallow root read failed/);
  });
});

describe('run-rules-rtdb scenario selection', () => {
  it('keeps the full corpus when no selector is supplied', () => {
    expect(selectRtdbScenarios([]).length).toBeGreaterThan(1);
  });

  it('selects exactly one scenario by id', () => {
    expect(selectRtdbScenarios(['--scenario', 'r15-validate-ancestor-scope']).map((s) => s.id)).toEqual([
      'r15-validate-ancestor-scope',
    ]);
    expect(selectRtdbScenarios(['--scenario=r15-validate-ancestor-scope']).map((s) => s.id)).toEqual([
      'r15-validate-ancestor-scope',
    ]);
  });

  it('rejects a missing or unknown scenario instead of silently capturing everything', () => {
    expect(() => selectRtdbScenarios(['--scenario'])).toThrow(/requires an id/);
    expect(() => selectRtdbScenarios(['--scenario', 'not-a-scenario'])).toThrow(/unknown RTDB scenario/);
  });
});

describe('run-rules-rtdb observation metadata', () => {
  it('preserves the registry linkage from an existing observation', () => {
    expect(observationLinkageOf({
      matrixRow: 'rtdb-rules#15',
      rowIds: ['rtdb-rules#15'],
    })).toEqual({
      matrixRow: 'rtdb-rules#15',
      rowIds: ['rtdb-rules#15'],
    });
  });

  it('uses empty linkage only when no prior observation exists', () => {
    expect(observationLinkageOf(undefined)).toEqual({ matrixRow: '', rowIds: [] });
  });

  it('rejects a Web config and service account from different projects', () => {
    expect(() => assertMatchingOracleProjects(
      { projectId: 'oracle-a' },
      { project_id: 'oracle-b' },
    )).toThrow(/project mismatch/);
    expect(() => assertMatchingOracleProjects(
      { projectId: 'oracle-a' },
      { project_id: 'oracle-a' },
    )).not.toThrow();
  });
});
