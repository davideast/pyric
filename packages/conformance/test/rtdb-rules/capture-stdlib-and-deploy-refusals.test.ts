import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  captureSandboxSnapshot,
  DEFAULT_SNAPSHOT_RESOURCE,
  restoreSandboxSnapshot,
} from 'pyric/sandbox/internal';
import { getDatabase, get, ref, sandbox as rtdbSandbox, set } from 'pyric/database';
import { rtdbRules } from 'pyric/rules';
import {
  compileRtdbRules,
  rtdbRulesSourceRejection,
  simulateRtdbRules,
} from 'pyric/rules/internal/rtdb';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { RULES_DEPLOY_REFUSAL_CASES } from '../../src/capture/rtdb-climb/rules-deploy-refusals.cases.ts';
import {
  OBSERVATION_NAME as TYPE_CHECK_OBS_NAME,
  PROBES as TYPE_CHECK_PROBES,
  probeRules,
  rejectionMessage,
  TYPE_POSITIONS,
  TYPE_SAMPLES,
  type RtdbProbeKind,
  type RtdbTypeProbe,
  type RtdbTypeProbeRecord,
} from '../../src/capture-rtdb-rules-type-check.ts';
import { replayRtdbScenario } from '../../src/rules-rtdb-replay.ts';

const OBS_ROOT = join(import.meta.dir, '..', '..', 'observations');

function readObservation(surfaceDir: string, stem: string): Record<string, unknown> {
  const raw = readFileSync(join(OBS_ROOT, surfaceDir, `${stem}.json`), 'utf8');
  const parsed = JSON.parse(raw) as { behavior: Record<string, unknown> };
  return parsed.behavior;
}

describe('RTDB rules parse-gap simulation, stdlib corpus verdicts, and deploy refusals', () => {
  test('rtdb#67: simulateRtdbRules reports unsupported on unparseable expressions captured in rtdb-rules-type-check and rtdb-rules-deploy-refusals', () => {
    const typeCheckObs = readObservation('rtdb', TYPE_CHECK_OBS_NAME);
    const probes = typeCheckObs.probes as RtdbTypeProbeRecord[];
    expect(probes.length).toBe(TYPE_CHECK_PROBES.length);
    expect(Object.keys(TYPE_SAMPLES).length).toBeGreaterThan(0);
    expect(Object.keys(TYPE_POSITIONS).length).toBeGreaterThan(0);
    expect(rejectionMessage('1:4: Expression must evaluate to a boolean.')).toBe(
      'Expression must evaluate to a boolean.',
    );
    const sampleKind: RtdbProbeKind = 'read';
    const sampleProbe: RtdbTypeProbe = {
      name: 'sample',
      kind: sampleKind,
      expression: 'true',
    };
    expect(probeRules(sampleProbe)).toEqual({ rules: { p: { $id: { '.read': 'true' } } } });

    const indexCallProbe = probes.find((item) => item.name === 'snapshot-index-method-name');
    expect(indexCallProbe).toBeDefined();
    if (indexCallProbe === undefined) {
      return;
    }
    expect(indexCallProbe.accepted).toBe(true);

    const rulesJson = { rules: { items: { '.read': indexCallProbe.expression } } };
    const compiled = compileRtdbRules(rulesJson);
    const itemsNode = compiled.children.find((child) => child.path === '/items');
    expect(itemsNode?.read?.parsed.valid).toBe(false);

    const simResult = simulateRtdbRules(compiled, {
      operation: 'read',
      path: '/items',
      auth: { uid: 'alice', token: {} },
      mockData: { items: 'ok' },
    });
    expect(simResult.success).toBe(true);
    if (simResult.success) {
      expect(simResult.data.allowed).toBe(false);
      expect(simResult.data.unsupported).toBe(true);
      expect(simResult.data.matchedPath).toBe('/items');
    }

    const publicSummary = rtdbRules(rulesJson).simulate([
      { expectation: 'DENY', operation: 'read', path: '/items', auth: 'alice', data: { items: 'ok' } },
    ]);
    expect(publicSummary.cases[0]?.decision).toBe('UNSUPPORTED');

    const deployRefusalsObs = readObservation('rtdb', 'rtdb-rules-deploy-refusals');
    const outcomes = deployRefusalsObs.outcomes as Record<string, { accepted: boolean }>;
    const unclosedClassLabel = 'matches with an unterminated character class';
    expect(outcomes[unclosedClassLabel]?.accepted).toBe(false);
    const unclosedSubtree = RULES_DEPLOY_REFUSAL_CASES[unclosedClassLabel];
    const unclosedCompiled = compileRtdbRules({
      rules: { '.write': true, probe: unclosedSubtree },
    });
    const unclosedSim = simulateRtdbRules(unclosedCompiled, {
      operation: 'write',
      path: '/probe',
      auth: { uid: 'alice', token: {} },
      mockData: {},
      newData: 'abc',
    });
    expect(unclosedSim.success).toBe(true);
    if (unclosedSim.success) {
      expect(unclosedSim.data.allowed).toBe(false);
      expect(unclosedSim.data.unsupported).toBe(true);
    }
  });

  test('rtdb#86, #87, #88: simulator verdicts match every captured production verdict in r27, r28, and r34', () => {
    const stdlibIds = [
      'r27-stdlib-core-patterns',
      'r28-stdlib-presence-timing',
      'r34-stdlib-auth-membership-quota',
    ];

    for (const id of stdlibIds) {
      const scenario = ALL_RULES_RTDB_SCENARIOS.find((entry) => entry.id === id);
      expect(scenario).toBeDefined();
      if (scenario === undefined) {
        continue;
      }
      const capturedVerdicts = readObservation('rtdb-rules', `rules-rtdb-${id}`);
      const subtreeJson = { rules: JSON.parse(scenario.rules) as Record<string, unknown> };
      const compileErrors = rtdbRules(subtreeJson)
        .lint()
        .filter((issue) => issue.severity === 'error' && !issue.code.startsWith('RTDB-SEC-'));
      expect(compileErrors).toEqual([]);

      const replayResults = replayRtdbScenario(scenario);
      expect(replayResults.length).toBe(scenario.cases.length);
      for (const item of replayResults) {
        const expected = capturedVerdicts[item.caseKey];
        expect(expected).toBe(item.production);
        expect(item.simulator).toBe(item.production);
      }
    }
  }, 20_000);

  test('rtdb#89: rtdbRulesSourceRejection and sandbox snapshot import refuse every captured r29 and deploy-refusal error while keeping active rules in force', async () => {
    const box = initializeSandbox();
    const adminDb = getDatabase(box.withAuth({ uid: 'admin' }));
    const aliceDb = getDatabase(box.withAuth({ uid: 'alice' }));
    const bobDb = getDatabase(box.withAuth({ uid: 'bob' }));

    rtdbSandbox.setRules(adminDb, {
      rules: {
        guarded: {
          '.read': "auth != null && auth.uid == 'alice'",
          '.write': "auth != null && auth.uid == 'alice'",
        },
      },
    });
    await set(ref(aliceDb, 'guarded/item'), 'initial');
    const baseSnapshot = await captureSandboxSnapshot(box);

    const r29Scenario = ALL_RULES_RTDB_DEPLOY_SCENARIOS.find(
      (entry) => entry.id === 'r29-deploy-rejections',
    );
    expect(r29Scenario).toBeDefined();
    const r29Obs = readObservation('rtdb-rules', 'rules-rtdb-r29-deploy-rejections') as Record<
      string,
      { verdict: 'ACCEPTED' | 'REJECTED'; error?: string }
    >;

    if (r29Scenario !== undefined) {
      for (const deployCase of r29Scenario.deployCases) {
        const captured = r29Obs[deployCase.description];
        expect(captured?.verdict).toBe(deployCase.expectation.verdict);
        if (captured?.verdict !== 'REJECTED') {
          continue;
        }
        const candidate = { rules: JSON.parse(deployCase.rules) as Record<string, unknown> };
        const rejection = rtdbRulesSourceRejection(candidate);
        expect(rejection).not.toBeNull();
        expect(rejection?.message ?? '').toContain(captured.error ?? '');

        const badSnapshot = {
          ...baseSnapshot,
          rules: {
            ...baseSnapshot.rules,
            rtdb: { [DEFAULT_SNAPSHOT_RESOURCE]: JSON.stringify(candidate) },
          },
        };
        const restored = await restoreSandboxSnapshot(box, badSnapshot, { merge: true });
        expect(restored.refusals[0] ?? '').toContain(captured.error ?? '');
      }
    }

    const deployRefusalsObs = readObservation('rtdb', 'rtdb-rules-deploy-refusals');
    const refusalOutcomes = deployRefusalsObs.outcomes as Record<
      string,
      { accepted: boolean; message: string | null }
    >;
    for (const [label, subtree] of Object.entries(RULES_DEPLOY_REFUSAL_CASES)) {
      const outcome = refusalOutcomes[label];
      if (outcome === undefined || outcome.accepted) {
        continue;
      }
      const candidate = { rules: { probe: subtree } };
      const rejection = rtdbRulesSourceRejection(candidate);
      expect(rejection).not.toBeNull();
      if (label !== 'matches with an unterminated character class' && outcome.message !== null) {
        expect(rejection?.message ?? '').toContain(outcome.message);
      }

      const badSnapshot = {
        ...baseSnapshot,
        rules: {
          ...baseSnapshot.rules,
          rtdb: { [DEFAULT_SNAPSHOT_RESOURCE]: JSON.stringify(candidate) },
        },
      };
      const restored = await restoreSandboxSnapshot(box, badSnapshot, { merge: true });
      expect(restored.refusals.length).toBeGreaterThan(0);
    }

    const aliceSnap = await get(ref(aliceDb, 'guarded/item'));
    expect(aliceSnap.val()).toBe('initial');

    let bobDenied = false;
    try {
      await get(ref(bobDb, 'guarded/item'));
    } catch {
      bobDenied = true;
    }
    expect(bobDenied).toBe(true);
  });
});
