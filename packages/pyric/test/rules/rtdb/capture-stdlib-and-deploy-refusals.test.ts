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
import { defineRtdbRules, rtdbRules, type PathDef } from 'pyric/rules';
import { compileRtdbRules, rtdbRulesSourceRejection, simulateRtdbRules } from '@pyric/rules/internal/rtdb';
import { ALL_RULES_RTDB_DEPLOY_SCENARIOS, ALL_RULES_RTDB_SCENARIOS } from '../../../../conformance/rules-corpus/rtdb/index.ts';
import { RULES_DEPLOY_REFUSAL_CASES } from '../../../../conformance/src/capture/rtdb-climb/rules-deploy-refusals.cases.ts';
import { identityToken } from '../../../../conformance/src/rules-rtdb-replay.ts';
import { CORE_PATTERN_PATHS } from './stdlib/fixtures/match-rules.js';
import { PRESENCE_TIMING_PATHS } from './stdlib/fixtures/presence-timing-rules.js';
import { AUTH_MEMBERSHIP_PATHS } from './stdlib/fixtures/auth-membership-rules.js';
import { simulateCase, type StdlibCase, type StdlibScenario } from './stdlib/harness.js';

const OBS_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations');
const UID = 'corpus-user';

function readObservation(surfaceDir: string, stem: string): Record<string, unknown> {
  const raw = readFileSync(join(OBS_ROOT, surfaceDir, `${stem}.json`), 'utf8');
  const parsed = JSON.parse(raw) as { behavior: Record<string, unknown> };
  return parsed.behavior;
}

function substituteUid<T>(value: T): T {
  let normalized: unknown = null;
  if (value !== undefined) {
    normalized = value;
  }
  const serialized = JSON.stringify(normalized).replaceAll('<UID>', UID);
  return JSON.parse(serialized) as T;
}

function buildSeedTree(
  scenarioId: string,
  seed: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  if (seed === undefined) {
    return root;
  }
  for (const [rawPath, rawValue] of Object.entries(seed)) {
    const cleanPath = substituteUid(rawPath);
    const segments = [scenarioId, ...cleanPath.split('/').filter(Boolean)];
    let cursor: Record<string, unknown> = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = cursor[segment];
      if (typeof existing === 'object' && existing !== null) {
        cursor = existing as Record<string, unknown>;
      } else {
        const next: Record<string, unknown> = {};
        cursor[segment] = next;
        cursor = next;
      }
    }
    const leafKey = segments[segments.length - 1];
    if (leafKey !== undefined) {
      cursor[leafKey] = substituteUid(rawValue);
    }
  }
  return root;
}

describe('RTDB rules parse-gap simulation, ruleset compilation, and deploy refusals', () => {
  test('rtdb#67: simulateRtdbRules reports unsupported on unparseable expressions captured in rtdb-rules-type-check and rtdb-rules-deploy-refusals', () => {
    const typeCheckObs = readObservation('rtdb', 'rtdb-rules-type-check');
    const probes = typeCheckObs.probes as Array<{
      name: string;
      kind: 'read' | 'write' | 'validate';
      expression: string;
      accepted: boolean;
    }>;
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

  test('rtdb#86, #87, #88: defineRtdbRules definition handles match compiled JSON lint and simulate verdicts across r27, r28, and r34 captures', () => {
    const fixtures: ReadonlyArray<{ id: string; paths: Record<string, PathDef> }> = [
      { id: 'r27-stdlib-core-patterns', paths: CORE_PATTERN_PATHS },
      { id: 'r28-stdlib-presence-timing', paths: PRESENCE_TIMING_PATHS },
      { id: 'r34-stdlib-auth-membership-quota', paths: AUTH_MEMBERSHIP_PATHS },
    ];

    for (const { id, paths } of fixtures) {
      const scenario = ALL_RULES_RTDB_SCENARIOS.find((entry) => entry.id === id);
      expect(scenario).toBeDefined();
      if (scenario === undefined) {
        continue;
      }
      const capturedVerdicts = readObservation('rtdb-rules', `rules-rtdb-${id}`);
      const definitionHandle = rtdbRules(defineRtdbRules({ paths }));
      const generatedJson = definitionHandle.toJSON() as { rules: Record<string, unknown> };
      const jsonHandle = rtdbRules(generatedJson);

      expect(definitionHandle.lint()).toEqual(jsonHandle.lint());
      const compileErrorIssues = definitionHandle
        .lint()
        .filter((issue) => issue.severity === 'error' && !issue.code.startsWith('RTDB-SEC-'));
      expect(compileErrorIssues).toEqual([]);

      const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;
      const mounted: StdlibScenario = {
        json: { rules: { '.read': false, '.write': false, [id]: subtree } },
        cases: [],
      };
      for (const testCase of scenario.cases) {
        let authValue: StdlibCase['auth'] = null;
        if (testCase.authPresent) {
          if (testCase.identity !== undefined) {
            authValue = { uid: UID, token: identityToken(UID, testCase.identity) };
          } else {
            authValue = UID;
          }
        }
        const stdlibCase: StdlibCase = {
          description: testCase.description,
          expectation: testCase.expectation,
          operation: testCase.operation,
          path: `/${id}${substituteUid(testCase.opPath)}`.replace(/\/$/, ''),
          auth: authValue,
          data: buildSeedTree(id, testCase.seed),
        };
        if (testCase.newData !== undefined) {
          stdlibCase.newData = substituteUid(testCase.newData);
        }
        const expectedVerdict = capturedVerdicts[testCase.description];
        expect(expectedVerdict).toBe(testCase.expectation);
        expect(simulateCase(mounted, stdlibCase)).toBe(expectedVerdict);
      }
    }
  });

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

        const badSnapshot = structuredClone(baseSnapshot);
        badSnapshot.rules.rtdb = { [DEFAULT_SNAPSHOT_RESOURCE]: JSON.stringify(candidate) };
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

      const badSnapshot = structuredClone(baseSnapshot);
      badSnapshot.rules.rtdb = { [DEFAULT_SNAPSHOT_RESOURCE]: JSON.stringify(candidate) };
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
