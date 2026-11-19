import { expect, it } from 'bun:test';
import {
  compileRtdbRules,
  simulateRtdbRules,
} from '@pyric/rules/internal/rtdb';
import { initializeSandbox } from 'pyric/sandbox';
import {
  buildAtomsScopedRules,
  observeRulesAtomsVerdicts,
  type ConstraintRulesProbeClients,
} from '../../../../packages/conformance/probes/rtdb/rtdb-rules-atoms-verdicts.ts';
import {
  buildPoliciesScopedRules,
  observeRulesPoliciesVerdicts,
} from '../../../../packages/conformance/probes/rtdb/rtdb-rules-policies-verdicts.ts';
import {
  get,
  getAdminDatabase,
  getDatabase,
  ref,
  remove,
  sandbox as rtdbSandbox,
  set,
} from '../../src/database/index.js';

type ObservationLoader = (name: string) => Record<string, unknown>;

interface SimDbHandle {
  readonly auth: { uid: string } | null;
}

interface SimRefHandle {
  readonly db: SimDbHandle;
  readonly path: string;
}

function normalizeLeadingSlash(rawPath: string): string {
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  return `/${trimmed}`;
}

function writeMockTreePath(
  root: Record<string, unknown>,
  rawPath: string,
  value: unknown,
): void {
  const segments = rawPath.split('/').filter((seg) => seg.length > 0);
  if (segments.length === 0) {
    return;
  }
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (seg === undefined) {
      return;
    }
    const existing = cursor[seg];
    if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = {};
      cursor[seg] = next;
      cursor = next;
    }
  }
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) {
    return;
  }
  if (value === null) {
    delete cursor[leaf];
    return;
  }
  cursor[leaf] = structuredClone(value);
}

function makePermissionDeniedError(): Error & { code: string } {
  return Object.assign(new Error('PERMISSION_DENIED: Permission denied'), {
    code: 'PERMISSION_DENIED',
  });
}

function createSimulatorConstraintHarness(
  runId: string,
  scopedRules: Record<string, unknown>,
) {
  const basePath = `pyric_oracle/${runId}`;
  const compiled = compileRtdbRules({
    rules: {
      pyric_oracle: {
        [runId]: structuredClone(scopedRules),
      },
    },
  });
  const mockData: Record<string, unknown> = {};
  const userADb: SimDbHandle = { auth: { uid: 'sim-user-a' } };
  const userBDb: SimDbHandle = { auth: { uid: 'sim-user-b' } };
  const unauthedDb: SimDbHandle = { auth: null };

  const simRef = (db: SimDbHandle, path: string): SimRefHandle => ({
    db,
    path: normalizeLeadingSlash(path),
  });

  const simGet = async (targetRef: SimRefHandle): Promise<unknown> => {
    const verdict = simulateRtdbRules(compiled, {
      operation: 'read',
      path: targetRef.path,
      auth: targetRef.db.auth,
      mockData: structuredClone(mockData),
    });
    expect(verdict.success).toBe(true);
    if (verdict.success === false) {
      throw new Error(`Unexpected simulator error: ${verdict.error.message}`);
    }
    if (!verdict.data.allowed) {
      throw makePermissionDeniedError();
    }
    return null;
  };

  const simSet = async (targetRef: SimRefHandle, value: unknown): Promise<void> => {
    const verdict = simulateRtdbRules(compiled, {
      operation: 'write',
      path: targetRef.path,
      auth: targetRef.db.auth,
      mockData: structuredClone(mockData),
      newData: structuredClone(value),
    });
    expect(verdict.success).toBe(true);
    if (verdict.success === false) {
      throw new Error(`Unexpected simulator error: ${verdict.error.message}`);
    }
    if (!verdict.data.allowed) {
      throw makePermissionDeniedError();
    }
    writeMockTreePath(mockData, targetRef.path, value);
  };

  const simRemove = async (targetRef: SimRefHandle): Promise<void> => {
    await simSet(targetRef, null);
  };

  const clients: ConstraintRulesProbeClients = {
    userADb: userADb as unknown as ConstraintRulesProbeClients['userADb'],
    userAUid: 'sim-user-a',
    userBDb: userBDb as unknown as ConstraintRulesProbeClients['userBDb'],
    userBUid: 'sim-user-b',
    unauthedDb: unauthedDb as unknown as ConstraintRulesProbeClients['unauthedDb'],
    ref: simRef as unknown as ConstraintRulesProbeClients['ref'],
    get: simGet as unknown as ConstraintRulesProbeClients['get'],
    set: simSet as unknown as ConstraintRulesProbeClients['set'],
    remove: simRemove as unknown as ConstraintRulesProbeClients['remove'],
  };

  return {
    basePath,
    clients,
    async seedAdminData(subpath: string, value: unknown): Promise<void> {
      const cleanSub = subpath.replace(/^\/+|\/+$/g, '');
      writeMockTreePath(mockData, `${basePath}/${cleanSub}`, value);
    },
  };
}

function createSandboxConstraintHarness(
  runId: string,
  scopedRules: Record<string, unknown>,
) {
  const basePath = `pyric_oracle/${runId}`;
  const sandbox = initializeSandbox({ projectId: `demo-rtdb-constraints-${runId}` });
  const userADb = getDatabase(sandbox.withAuth({ uid: 'sandbox-user-a' }));
  const userBDb = getDatabase(sandbox.withAuth({ uid: 'sandbox-user-b' }));
  const unauthedDb = getDatabase(sandbox.withAuth(null));
  const adminDb = getAdminDatabase(sandbox);

  rtdbSandbox.setRules(userADb, {
    rules: {
      pyric_oracle: {
        [runId]: structuredClone(scopedRules),
      },
    },
  });

  const clients: ConstraintRulesProbeClients = {
    userADb: userADb as unknown as ConstraintRulesProbeClients['userADb'],
    userAUid: 'sandbox-user-a',
    userBDb: userBDb as unknown as ConstraintRulesProbeClients['userBDb'],
    userBUid: 'sandbox-user-b',
    unauthedDb: unauthedDb as unknown as ConstraintRulesProbeClients['unauthedDb'],
    ref: ref as unknown as ConstraintRulesProbeClients['ref'],
    get: get as unknown as ConstraintRulesProbeClients['get'],
    set: set as unknown as ConstraintRulesProbeClients['set'],
    remove: remove as unknown as ConstraintRulesProbeClients['remove'],
  };

  return {
    basePath,
    clients,
    async seedAdminData(subpath: string, value: unknown): Promise<void> {
      const cleanSub = subpath.replace(/^\/+|\/+$/g, '');
      await set(ref(adminDb, `${basePath}/${cleanSub}`), value);
    },
  };
}

export function registerRtdbAtomsAndPoliciesOracleConformanceTests(
  load: ObservationLoader,
): void {
  it('rtdb-rules-atoms-verdicts: simulateRtdbRules and sandbox match all 34 live atoms verdicts (rtdb#84)', async () => {
    const obs = load('rtdb-rules-atoms-verdicts.json');
    const runId = 'atoms_replay';
    const scopedRules = buildAtomsScopedRules(['pyric_oracle', runId]);

    const sandboxHarness = createSandboxConstraintHarness(runId, scopedRules);
    const sandboxActual = await observeRulesAtomsVerdicts(
      sandboxHarness.clients,
      sandboxHarness.basePath,
      sandboxHarness.seedAdminData,
    );
    expect(sandboxActual as unknown).toEqual(obs);

    const simHarness = createSimulatorConstraintHarness(runId, scopedRules);
    const simActual = await observeRulesAtomsVerdicts(
      simHarness.clients,
      simHarness.basePath,
      simHarness.seedAdminData,
    );
    expect(simActual as unknown).toEqual(obs);
  });

  it('rtdb-rules-policies-verdicts: simulateRtdbRules and sandbox match all 26 live policies verdicts (rtdb#85)', async () => {
    const obs = load('rtdb-rules-policies-verdicts.json');
    const runId = 'policies_replay';
    const scopedRules = buildPoliciesScopedRules(['pyric_oracle', runId]);

    const sandboxHarness = createSandboxConstraintHarness(runId, scopedRules);
    const sandboxActual = await observeRulesPoliciesVerdicts(
      sandboxHarness.clients,
      sandboxHarness.basePath,
      sandboxHarness.seedAdminData,
    );
    expect(sandboxActual as unknown).toEqual(obs);

    const simHarness = createSimulatorConstraintHarness(runId, scopedRules);
    const simActual = await observeRulesPoliciesVerdicts(
      simHarness.clients,
      simHarness.basePath,
      simHarness.seedAdminData,
    );
    expect(simActual as unknown).toEqual(obs);
  });
}
