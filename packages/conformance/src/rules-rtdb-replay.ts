import { compileRtdbRules, simulateRtdbRules } from '../../pyric/src/rules/rtdb/compiled-rules.ts';
import type { SimulateResult, SimulationInput, SimulationResult } from '../../pyric/src/rules/rtdb/simulation/spec.ts';
import type { RtdbScenario, RtdbTestCase } from '../rules-corpus/rtdb/types.ts';

const REPLAY_UID = 'THP041EPnYbzh9c8GGBniSDoUKc2';
export type RtdbVerdict = 'ALLOW' | 'DENY';

/**
 * The simulator's answer for one case. `UNSUPPORTED` is a rule the engine
 * abstained on and `ERROR` is an engine error. Neither is a verdict, so
 * neither matches a production ALLOW or DENY.
 */
export type RtdbSimulatorOutcome = RtdbVerdict | 'UNSUPPORTED' | 'ERROR';

export interface RtdbReplayResult {
  caseKey: string;
  production: RtdbVerdict;
  simulator: RtdbSimulatorOutcome;
}

/**
 * True when a result's rule-by-rule trace accounts for its verdict. Replayed
 * rulesets carry root `.read` and `.write` rules, so every replayed request
 * evaluates at least one rule. An allow needs a granting `.read` or `.write`
 * as the last cascade entry and no failing `.validate`. A deny needs either a
 * failing `.validate` as the last entry or a cascade with no grant. An
 * abstention needs an `UNSUPPORTED` entry.
 */
export function traceAgreesWithVerdict(result: SimulationResult): boolean {
  const { trace } = result;
  if (trace.length === 0) return false;
  if (result.unsupported) return trace.some((entry) => entry.verdict === 'UNSUPPORTED');
  const cascade = trace.filter((entry) => entry.kind !== 'validate');
  const validateFailed = trace.some((entry) => entry.kind === 'validate' && entry.verdict !== 'ALLOW');
  const granted = cascade.some((entry) => entry.verdict === 'ALLOW');
  if (result.allowed) {
    const cascadeGrants = cascade.length === 0 || cascade[cascade.length - 1].verdict === 'ALLOW';
    return cascadeGrants && !validateFailed;
  }
  const last = trace[trace.length - 1];
  const lastValidateFails = last.kind === 'validate' && last.verdict !== 'ALLOW';
  return lastValidateFails || !granted;
}

/**
 * The simulator outcome of one simulate result. A result whose trace does not
 * account for its verdict is an engine error, not a verdict.
 */
function outcomeOf(result: SimulateResult): RtdbSimulatorOutcome {
  if (!result.success) return 'ERROR';
  if (!traceAgreesWithVerdict(result.data)) return 'ERROR';
  if (result.data.unsupported) return 'UNSUPPORTED';
  return result.data.allowed ? 'ALLOW' : 'DENY';
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

/** The scenario's subtree mounted under its id, compiled once per scenario. */
function compileScenario(scenario: RtdbScenario): ReturnType<typeof compileRtdbRules> {
  const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;
  return compileRtdbRules({
    rules: {
      '.read': false,
      '.write': false,
      [scenario.id]: subtree,
    },
  });
}

function simulatorVerdict(
  scenario: RtdbScenario,
  compiled: ReturnType<typeof compileRtdbRules>,
  testCase: RtdbTestCase,
): RtdbSimulatorOutcome {
  const uid = testCase.authPresent ? REPLAY_UID : '';
  const opPath = substituteUid(testCase.opPath, uid);
  const simPath = `/${scenario.id}${opPath}`;
  const mockData = testCase.mockData !== undefined
    ? substituteUid(testCase.mockData, uid)
    : undefined;
  const auth: SimulationInput['auth'] = testCase.authPresent
    ? { uid, token: { firebase: { sign_in_provider: 'anonymous' }, provider_id: 'anonymous' } }
    : null;
  const simMock = buildSimMock(scenario, simPath, mockData, testCase.seed, uid);
  const newData = testCase.newData !== undefined
    ? substituteUid(testCase.newData, uid)
    : undefined;

  if (testCase.operation === 'update') {
    // An update writes each patch location; it is allowed only when every
    // location's write is, each evaluated against the whole update. An engine
    // error or an abstention at any location is reported as such.
    const updates = Object.entries(newData as Record<string, unknown>).map(([key, value]) => ({
      path: `${simPath}/${key}`.replace(/\/+/g, '/'),
      value,
    }));
    const outcomes = updates.map((update) => outcomeOf(simulateRtdbRules(compiled, {
      operation: 'write', path: update.path, auth, mockData: simMock, newData: update.value, updates,
    })));
    if (outcomes.includes('ERROR')) return 'ERROR';
    if (outcomes.includes('UNSUPPORTED')) return 'UNSUPPORTED';
    return outcomes.every((outcome) => outcome === 'ALLOW') ? 'ALLOW' : 'DENY';
  }

  return outcomeOf(simulateRtdbRules(compiled, {
    operation: testCase.operation, path: simPath, auth, mockData: simMock, newData,
  }));
}

export function replayRtdbScenario(scenario: RtdbScenario): RtdbReplayResult[] {
  const compiled = compileScenario(scenario);
  return scenario.cases
    .filter((testCase) => !testCase.pendingCapture)
    .map((testCase) => ({
      caseKey: testCase.description,
      production: testCase.expectation,
      simulator: simulatorVerdict(scenario, compiled, testCase),
    }));
}
