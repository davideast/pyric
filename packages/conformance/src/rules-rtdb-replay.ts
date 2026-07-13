import { compileRtdbRules, simulateRtdbRules } from '../../pyric/src/rules/rtdb/compiled-rules.ts';
import type { SimulationInput } from '../../pyric/src/rules/rtdb/simulation/spec.ts';
import type { RtdbScenario, RtdbTestCase } from '../rules-corpus/rtdb/types.ts';

const REPLAY_UID = 'THP041EPnYbzh9c8GGBniSDoUKc2';
export type RtdbVerdict = 'ALLOW' | 'DENY';

export interface RtdbReplayResult {
  caseKey: string;
  production: RtdbVerdict;
  simulator: RtdbVerdict;
}

function substituteUid<T>(value: T, uid: string): T {
  if (typeof value === 'string') return value.replaceAll('<UID>', uid) as unknown as T;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => substituteUid(item, uid)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteUid(child, uid);
    }
    return out as unknown as T;
  }
  return value;
}

function setAt(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return;
  let cursor = root;
  for (let index = 0; index < segments.length - 1; index++) {
    const existing = cursor[segments[index]];
    const child = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
    cursor[segments[index]] = child;
    cursor = child;
  }
  cursor[segments[segments.length - 1]] = value;
}

function buildSimMock(
  scenario: RtdbScenario,
  simPath: string,
  mockData: unknown,
  seed: Record<string, unknown> | undefined,
  uid: string,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [seedPath, seedValue] of Object.entries(seed ?? {})) {
    setAt(
      root,
      `/${scenario.id}${substituteUid(seedPath, uid)}`,
      substituteUid(seedValue, uid),
    );
  }
  if (mockData !== undefined && mockData !== null) setAt(root, simPath, mockData);
  return root;
}

function simulatorVerdict(scenario: RtdbScenario, testCase: RtdbTestCase): RtdbVerdict {
  const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;
  const compiled = compileRtdbRules(
    {
      rules: {
        '.read': false,
        '.write': false,
        [scenario.id]: subtree,
      },
    },
  );
  const uid = testCase.authPresent ? REPLAY_UID : '';
  const opPath = substituteUid(testCase.opPath, uid);
  const simPath = `/${scenario.id}${opPath}`;
  const mockData = testCase.mockData !== undefined
    ? substituteUid(testCase.mockData, uid)
    : undefined;
  const input: SimulationInput = {
    operation: testCase.operation,
    path: simPath,
    auth: testCase.authPresent
      ? { uid, token: { firebase: { sign_in_provider: 'anonymous' }, provider_id: 'anonymous' } }
      : null,
    mockData: buildSimMock(scenario, simPath, mockData, testCase.seed, uid),
    newData: testCase.newData !== undefined
      ? substituteUid(testCase.newData, uid)
      : undefined,
  };

  const result = simulateRtdbRules(compiled, input);
  if (!result.success) return 'DENY';
  return result.data.allowed ? 'ALLOW' : 'DENY';
}

export function replayRtdbScenario(scenario: RtdbScenario): RtdbReplayResult[] {
  return scenario.cases
    .filter((testCase) => !testCase.pendingCapture)
    .map((testCase) => ({
      caseKey: testCase.description,
      production: testCase.expectation,
      simulator: simulatorVerdict(scenario, testCase),
    }));
}
