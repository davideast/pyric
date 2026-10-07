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
  captureDeployScenario,
  createRunUser,
  instanceRulesForCapture,
  normalizeDeployError,
  observationLinkageOf,
  queryConstraintsOf,
  selectRtdbScenarios,
  verifyRunDataCleanup,
  verifyRunUserCleanup,
  verifyRulesTextRestored,
  type RulesDeployEndpoint,
  type RunDataStore,
  type RunUserCreator,
  type RunUserStore,
} from './run-rules-rtdb.ts';
import type { RtdbDeployScenario } from '../rules-corpus/rtdb/index.ts';

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
    const selection = selectRtdbScenarios([]);
    expect(selection.scenarios.length).toBeGreaterThan(1);
    expect(selection.deployScenarios.map((s) => s.id)).toContain('r29-deploy-rejections');
  });

  it('selects exactly one scenario by id', () => {
    expect(selectRtdbScenarios(['--scenario', 'r15-validate-ancestor-scope'])).toEqual({
      scenarios: [expect.objectContaining({ id: 'r15-validate-ancestor-scope' })],
      deployScenarios: [],
    });
    expect(selectRtdbScenarios(['--scenario=r15-validate-ancestor-scope']).scenarios.map((s) => s.id)).toEqual([
      'r15-validate-ancestor-scope',
    ]);
  });

  it('selects a deploy scenario by id without any operation scenario', () => {
    expect(selectRtdbScenarios(['--scenario', 'r29-deploy-rejections'])).toEqual({
      scenarios: [],
      deployScenarios: [expect.objectContaining({ id: 'r29-deploy-rejections' })],
    });
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

const MOUNT_KEY = 'pyric_oracle_rulesrtdb_1752000000000_ab12cd';
const BEFORE_RULES = { '.read': false, '.write': false, app: { '.read': 'auth != null' } };

function deployScenario(): RtdbDeployScenario {
  return {
    id: 'deploy-fixture',
    fm: 'rtdb#71',
    rationale: 'fixture',
    provenance: 'fixture',
    deployCases: [
      {
        description: 'unknown rule key',
        construct: 'rtdb.rule-kind.unknown-key',
        rules: JSON.stringify({ a: { '.valdiate': 'true' } }),
        expectation: { verdict: 'REJECTED', error: 'x' },
      },
      {
        description: 'valid ruleset',
        construct: 'rtdb.rule-kind.read',
        rules: JSON.stringify({ a: { '.read': 'true' } }),
        expectation: { verdict: 'ACCEPTED' },
      },
    ],
  };
}

/** A fake rules endpoint. Dry runs never change the live rules unless
 *  `dryRunDeploys` models an endpoint that ignored the dry-run flag. */
function fakeEndpoint(opts: {
  reject?: (rules: Record<string, unknown>) => string | undefined;
  dryRunDeploys?: boolean;
  failStatus?: number;
}): RulesDeployEndpoint & { sent: Record<string, unknown>[] } {
  let live: Record<string, unknown> = structuredClone(BEFORE_RULES);
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    async dryRun(rules) {
      sent.push(rules);
      if (opts.failStatus) return { status: opts.failStatus, body: 'internal' };
      const error = opts.reject?.(rules);
      if (error) return { status: 400, body: JSON.stringify({ error }) };
      if (opts.dryRunDeploys) live = structuredClone(rules);
      return { status: 200, body: '' };
    },
    async readRules() {
      return structuredClone(live);
    },
  };
}

describe('run-rules-rtdb deploy scenarios', () => {
  it('dry-runs each case merged under the mount and records the rejection text', async () => {
    const endpoint = fakeEndpoint({
      reject: (rules) => {
        const mounted = (rules[MOUNT_KEY] as Record<string, any>)['deploy-fixture'];
        return mounted.a['.valdiate'] ? `/${MOUNT_KEY}/deploy-fixture/a: Invalid key: .valdiate` : undefined;
      },
    });
    const behavior = await captureDeployScenario(endpoint, {
      beforeRules: BEFORE_RULES,
      mountKey: MOUNT_KEY,
      scenario: deployScenario(),
    });
    expect(behavior).toEqual({
      'unknown rule key': { verdict: 'REJECTED', error: '/<mount>/deploy-fixture/a: Invalid key: .valdiate' },
      'valid ruleset': { verdict: 'ACCEPTED' },
    });
    // The existing rules travel with every dry run, so an endpoint that
    // ignored the flag would still keep them.
    for (const rules of endpoint.sent) {
      expect(rules.app).toEqual(BEFORE_RULES.app);
    }
  });

  it('fails when the live rules differ from the snapshot after a dry run', async () => {
    const endpoint = fakeEndpoint({ dryRunDeploys: true });
    await expect(captureDeployScenario(endpoint, {
      beforeRules: BEFORE_RULES,
      mountKey: MOUNT_KEY,
      scenario: deployScenario(),
    })).rejects.toThrow(/live rules changed after the dry run/);
  });

  it('fails on a status that is neither acceptance nor a rules rejection', async () => {
    const endpoint = fakeEndpoint({ failStatus: 500 });
    await expect(captureDeployScenario(endpoint, {
      beforeRules: BEFORE_RULES,
      mountKey: MOUNT_KEY,
      scenario: deployScenario(),
    })).rejects.toThrow(/dry run returned 500/);
  });

  it('replaces every occurrence of the mount key in an error text', () => {
    expect(normalizeDeployError(`/${MOUNT_KEY}/a and /${MOUNT_KEY}/b`, MOUNT_KEY)).toBe('/<mount>/a and /<mount>/b');
  });

  it('drops the line:column prefix, which points into the merged dry-run body', () => {
    expect(normalizeDeployError("1:20775: Unknown variable 'foo'.\n", MOUNT_KEY)).toBe("Unknown variable 'foo'.");
  });
});

describe('run-rules-rtdb query cases', () => {
  it('maps a case query to SDK constraints in order, then limits', () => {
    expect(queryConstraintsOf({ orderByChild: 'owner', equalTo: 'u1', limitToFirst: 2 })).toEqual([
      ['orderByChild', 'owner'],
      ['equalTo', 'u1'],
      ['limitToFirst', 2],
    ]);
    expect(queryConstraintsOf({ orderByKey: true, startAt: 'a', endAt: 'm', limitToLast: 3 })).toEqual([
      ['orderByKey'],
      ['startAt', 'a'],
      ['endAt', 'm'],
      ['limitToLast', 3],
    ]);
    expect(queryConstraintsOf({ orderByValue: true })).toEqual([['orderByValue']]);
    expect(queryConstraintsOf({ orderByPriority: true, equalTo: null })).toEqual([
      ['orderByPriority'],
      ['equalTo', null],
    ]);
  });
});

describe('run-rules-rtdb custom-token user cleanup', () => {
  function fakeUsers(opts: { exists: boolean; sticky?: boolean }): RunUserStore & { deleted: string[] } {
    let exists = opts.exists;
    const deleted: string[] = [];
    return {
      deleted,
      async deleteUser(uid) {
        deleted.push(uid);
        if (!exists) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
        if (!opts.sticky) exists = false;
      },
      async userExists() {
        return exists;
      },
    };
  }

  it('deletes the custom-token user and proves it absent', async () => {
    const users = fakeUsers({ exists: true });
    await verifyRunUserCleanup(users, 'pyric-oracle-uid');
    expect(users.deleted).toEqual(['pyric-oracle-uid']);
  });

  it('is clean when no custom-token sign-in created the user', async () => {
    await expect(verifyRunUserCleanup(fakeUsers({ exists: false }), 'pyric-oracle-uid')).resolves.toBeUndefined();
  });

  it('fails when the user still exists after deletion', async () => {
    await expect(verifyRunUserCleanup(fakeUsers({ exists: true, sticky: true }), 'pyric-oracle-uid'))
      .rejects.toThrow(/user cleanup NOT verified/);
  });
});

describe('run-rules-rtdb identity user creation', () => {
  it('records the uid before creating the user, so a creation that fails late is still cleaned up', async () => {
    const runUids = new Set<string>();
    const creator: RunUserCreator = {
      async createUser() {
        throw new Error('deadline exceeded after the user was written');
      },
    };
    await expect(createRunUser(creator, runUids, { uid: 'pyric-oracle-run-0' })).rejects.toThrow(/deadline exceeded/);
    expect([...runUids]).toEqual(['pyric-oracle-run-0']);
  });

  it('records the uid and creates the user with its email properties', async () => {
    const runUids = new Set<string>();
    const created: unknown[] = [];
    const creator: RunUserCreator = {
      async createUser(props) {
        created.push(props);
      },
    };
    const props = { uid: 'pyric-oracle-run-1', email: 'pyric-oracle-run-1@example.com', emailVerified: true };
    await createRunUser(creator, runUids, props);
    expect([...runUids]).toEqual(['pyric-oracle-run-1']);
    expect(created).toEqual([props]);
  });
});

describe('multi-instance capture rules', () => {
  it('adds the run subtree to JSON rules and keeps every existing key', () => {
    const before = JSON.stringify({ rules: { '.read': false, kept: { '.read': true } } });
    expect(JSON.parse(instanceRulesForCapture(before, AUDIT_KEY, { '.read': true }))).toEqual({
      rules: { '.read': false, kept: { '.read': true }, [AUDIT_KEY]: { '.read': true } },
    });
  });

  it('locks the root around the run subtree when the rules text carries comments', () => {
    const before = '/* comment */ { "rules": { ".read": false } }';
    expect(JSON.parse(instanceRulesForCapture(before, AUDIT_KEY, { open: { '.read': true } }))).toEqual({
      rules: { '.read': false, '.write': false, [AUDIT_KEY]: { open: { '.read': true } } },
    });
  });

  it('verifies a restore by exact text, or by the same rules when reformatted, and throws otherwise', () => {
    const text = '/* c */ { "rules": { ".read": false } }';
    expect(verifyRulesTextRestored('second', text, text)).toEqual({ exact: true });
    expect(verifyRulesTextRestored('default', '{"rules":{"a":1}}', '{ "rules": { "a": 1 } }')).toEqual({ exact: false });
    expect(() => verifyRulesTextRestored('second', text, '{"rules":{}}')).toThrow('restore NOT verified on second');
  });
});
