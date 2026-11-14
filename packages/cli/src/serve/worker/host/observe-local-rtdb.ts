/**
 * The local RTDB rules' verdict on an observed Realtime Database call.
 *
 * The host simulates the call against the rules the app deployed to the
 * call's instance, supplying `ctx.observedSession`'s pre-operation tree as
 * `mockData`. A write is checked as production checks it: a `set` or `push` at
 * its one location with the value it sent, and an `update` at each location it
 * names, every location seeing the whole update. A remove is a write of `null`.
 *
 * Soundness is fail-closed per dereferenced path: any deciding rule or
 * `.validate` entry that inspects a `data`, `root`, or sibling `newData` path
 * whose existence/value `observedSession` has not authoritatively captured
 * abstains as `unevaluated` with `needs: ['stored-document']` and normalized
 * `missingPaths`.
 */
import type { RtdbRulesJson } from 'pyric/rules';
import {
  compileRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
  type RtdbRuleEvaluation,
} from 'pyric/rules/internal/rtdb';
import { getActiveRules } from 'pyric/sandbox/database';
import { LOCKED_DATABASE_RULES, type ObservedMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { ObservedRtdbLookup } from '../../observed-session/coverage.js';
import { canonicalRtdbPath, joinRtdbPath, rtdbPathSegments, toRtdbMockData } from '../../observed-session/rtdb-tree.js';
import type { HostCtx, HostRtdbInstance } from '../host-context.js';
import { rtdbInstance } from './rtdb-instances.js';
import {
  authOf,
  defineOwnField,
  definedOnly,
  givenBy,
  isPlainRecord,
  unionOf,
  unionPaths,
  verdictOf,
  type Gap,
  type LocalVerdict,
  type RtdbLocal,
} from './observe-local-evaluation.js';
import {
  analyzeRtdbExpression,
  hasCapturedRtdbPriority,
  isNullRtdbWrite,
  rtdbExpressionGaps,
  scrubRtdbWriteValue,
  uncapturedAncestorValidatePaths,
  unwrittenValidates,
} from './observe-local-rtdb-expressions.js';

const RTDB_PUSH_PLACEHOLDER = '-O_pyric_push_000000';

const EMPTY_RTDB_LOOKUP: ObservedRtdbLookup = {
  mockData: {},
  isPathKnown: () => false,
};

/** The RTDB rule kind each request method evaluates. */
const RTDB_OPERATION: Readonly<Record<ObservedMethod, 'read' | 'write'>> = {
  get: 'read',
  list: 'read',
  create: 'write',
  set: 'write',
  update: 'write',
  delete: 'write',
};

type SimulationInput = Parameters<typeof simulateRtdbRules>[1];
type Simulated = ReturnType<typeof simulateRtdbRules>;
type Simulation = Extract<Simulated, { success: true }>['data'];

interface RtdbWrite {
  path: string;
  value: unknown;
}

interface RtdbPlan {
  operation: 'read' | 'write';
  targets: string[];
  newData?: unknown;
  updates?: RtdbWrite[];
  hasWriteData: boolean;
  hasIncrement: boolean;
  isPush: boolean;
  isRemove: boolean;
}

interface RuleReads {
  stored: string[];
  postWrite: string[];
}

interface TargetSimulation {
  target: string;
  data: Simulation;
  readsByEntry: Map<number, RuleReads>;
}

const COMPILED_BY_INSTANCE = new WeakMap<
  HostRtdbInstance,
  { state: unknown; source: unknown; compiled: CompiledRtdbRules }
>();

function appRtdbRules(ctx: HostCtx, instance: string | undefined): CompiledRtdbRules | null {
  const entry = rtdbInstance(ctx, instance);
  const deployed = entry.rules?.source;
  const isAppRules = deployed !== undefined && deployed !== null && deployed !== LOCKED_DATABASE_RULES;
  if (!isAppRules) return null;
  const cached = COMPILED_BY_INSTANCE.get(entry);
  const isCurrent = cached !== undefined && cached.state === entry.rules && cached.source === deployed;
  if (isCurrent) return cached.compiled;
  const ruleset: RtdbRulesJson | null = getActiveRules(entry.live);
  if (ruleset === null) return null;
  const compiled = compileRtdbRules(ruleset);
  COMPILED_BY_INSTANCE.set(entry, { state: entry.rules, source: deployed, compiled });
  return compiled;
}

function depthOf(path: string): number {
  return rtdbPathSegments(path).length;
}

function stripPushPlaceholder(
  bindings: Record<string, string>,
  omitPushPlaceholder: boolean,
): Record<string, string> {
  if (!omitPushPlaceholder) return bindings;
  const filtered: Record<string, string> = {};
  for (const [key, val] of Object.entries(bindings)) {
    if (val !== RTDB_PUSH_PLACEHOLDER) defineOwnField(filtered, key, val);
  }
  return filtered;
}

function sanitizePushPath(
  readPath: string,
  bindings: Record<string, string>,
  omitPushPlaceholder: boolean,
): string {
  const hasPushPlaceholder = omitPushPlaceholder && readPath.includes(RTDB_PUSH_PLACEHOLDER);
  if (!hasPushPlaceholder) return readPath;
  let placeholderName = '$pushId';
  for (const [key, val] of Object.entries(bindings)) {
    if (val === RTDB_PUSH_PLACEHOLDER) {
      placeholderName = key;
      break;
    }
  }
  return readPath
    .split('/')
    .map((seg) => (seg === RTDB_PUSH_PLACEHOLDER ? placeholderName : seg))
    .join('/');
}

function pushTarget(path: string): string {
  return joinRtdbPath(path, RTDB_PUSH_PLACEHOLDER);
}

function rtdbPlan(call: ObservedCall, method: ObservedMethod, path: string): RtdbPlan | null {
  const operation = RTDB_OPERATION[method];
  const isPush = call.method === 'push';
  const isRemove = method === 'delete' || (method === 'set' && isNullRtdbWrite(call.writeData));
  const plan: RtdbPlan = {
    operation,
    targets: [path],
    hasWriteData: false,
    hasIncrement: false,
    isPush,
    isRemove,
  };
  if (isPush) plan.targets = [pushTarget(path)];
  if (operation === 'read') return plan;
  if (isRemove) {
    plan.newData = null;
    plan.hasWriteData = true;
    return plan;
  }
  const written = call.writeData;
  if (written === undefined) return plan;
  if (call.method === 'setWithPriority' && !hasCapturedRtdbPriority(written)) {
    return plan;
  }
  const state = { hasIncrement: false };
  if (call.method !== 'update') {
    plan.newData = scrubRtdbWriteValue(written, call.at, state);
    plan.hasWriteData = true;
    plan.hasIncrement = state.hasIncrement;
    return plan;
  }
  if (!isPlainRecord(written)) return plan;
  const entries = Object.entries(written);
  if (entries.length === 0) return null;
  plan.updates = entries.map(([key, value]) => ({
    path: joinRtdbPath(path, key),
    value: scrubRtdbWriteValue(value, call.at, state),
  }));
  plan.targets = plan.updates.map((update) => update.path);
  plan.hasWriteData = true;
  plan.hasIncrement = state.hasIncrement;
  return plan;
}

function simulationInputAt(
  call: ObservedCall,
  plan: RtdbPlan,
  target: string,
  index: number,
  mockData: unknown,
): SimulationInput {
  const input: SimulationInput = {
    operation: plan.operation,
    path: target,
    auth: authOf(call),
    mockData: toRtdbMockData(mockData),
    now: call.at,
  };
  if (plan.updates !== undefined) {
    input.updates = plan.updates;
    input.newData = plan.updates[index]?.value;
  } else if (plan.hasWriteData) {
    input.newData = plan.newData;
  }
  return input;
}

function simulateTargets(
  compiled: CompiledRtdbRules,
  call: ObservedCall,
  plan: RtdbPlan,
  mockData: unknown,
): TargetSimulation[] | undefined {
  const simulations: TargetSimulation[] = [];
  for (const [index, target] of plan.targets.entries()) {
    const readsByEntry = new Map<number, RuleReads>();
    const simulated = simulateRtdbRules(
      compiled,
      simulationInputAt(call, plan, target, index, mockData),
      {
        onRuleRead(traceIndex, source, readPath) {
          let record = readsByEntry.get(traceIndex);
          if (record === undefined) {
            record = { stored: [], postWrite: [] };
            readsByEntry.set(traceIndex, record);
          }
          if (source === 'stored') record.stored.push(readPath);
          else record.postWrite.push(readPath);
        },
      },
    );
    if (!simulated.success || simulated.data.unsupported) return undefined;
    simulations.push({ target, data: simulated.data, readsByEntry });
  }
  return simulations;
}

/** Trace indices whose evaluation outcome the target simulation's verdict rests on. */
function restingTraceIndices(data: Simulation): number[] {
  if (data.allowed) {
    const indices: number[] = [];
    const granting = data.trace.findIndex((entry) => entry.kind !== 'validate' && entry.verdict === 'ALLOW');
    if (granting !== -1) indices.push(granting);
    for (let i = 0; i < data.trace.length; i++) {
      if (data.trace[i]?.kind === 'validate') indices.push(i);
    }
    return indices;
  }
  const failingValidate = data.trace.findIndex(
    (entry) => entry.kind === 'validate' && (entry.verdict === 'DENY' || entry.verdict === 'ERROR'),
  );
  if (failingValidate !== -1) return [failingValidate];
  return data.trace.map((_, index) => index);
}

function isWrittenPathCover(readPath: string, writtenPath: string): boolean {
  if (writtenPath.endsWith('/.priority')) return readPath === writtenPath;
  if (writtenPath === '/') return true;
  return readPath === writtenPath || readPath.startsWith(`${writtenPath}/`);
}

function isCoveredByWrite(readPath: string, target: string, updates: readonly RtdbWrite[] | undefined): boolean {
  if (updates === undefined) return isWrittenPathCover(readPath, target);
  return updates.some((update) => isWrittenPathCover(readPath, update.path));
}

function resolvedEntryDataPath(target: string, entryPath: string): string {
  return canonicalRtdbPath(rtdbPathSegments(target).slice(0, depthOf(entryPath)));
}

interface SimulationGapCollector {
  gaps: Gap[];
  missingPaths: string[];
  expressions: string[];
  markUncapturedPath(rawPath: string, bindings: Record<string, string>, isPush: boolean): void;
}

function createSimulationGapCollector(): SimulationGapCollector {
  const collector: SimulationGapCollector = {
    gaps: [],
    missingPaths: [],
    expressions: [],
    markUncapturedPath(rawPath, bindings, isPush) {
      collector.gaps.push('stored-document');
      const clean = sanitizePushPath(rawPath, bindings, isPush);
      collector.missingPaths = unionPaths(collector.missingPaths, [clean]);
    },
  };
  return collector;
}

function collectEntryReadGaps(
  collector: SimulationGapCollector,
  plan: RtdbPlan,
  simulation: TargetSimulation,
  entry: RtdbRuleEvaluation,
  reads: RuleReads,
  lookup: ObservedRtdbLookup,
): void {
  for (const readPath of reads.stored) {
    if (!lookup.isPathKnown(readPath)) {
      collector.markUncapturedPath(readPath, entry.pathVariableBindings, plan.isPush);
    }
  }
  const inspectsPostWrite =
    plan.operation === 'write' && plan.hasWriteData && reads.postWrite.length > 0;
  if (!inspectsPostWrite) return;
  if (plan.hasIncrement) collector.gaps.push('stored-document');
  const ancestorPath = resolvedEntryDataPath(simulation.target, entry.path);
  const isUncapturedAncestor =
    depthOf(entry.path) < depthOf(simulation.target) && !lookup.isPathKnown(ancestorPath);
  if (isUncapturedAncestor) {
    collector.markUncapturedPath(ancestorPath, entry.pathVariableBindings, plan.isPush);
  }
  for (const readPath of reads.postWrite) {
    const covered = isCoveredByWrite(readPath, simulation.target, plan.updates);
    const isUncapturedPostWriteRead = !covered && !lookup.isPathKnown(readPath);
    if (isUncapturedPostWriteRead) {
      collector.markUncapturedPath(readPath, entry.pathVariableBindings, plan.isPush);
    }
  }
}

function collectTargetSimulationGaps(
  collector: SimulationGapCollector,
  plan: RtdbPlan,
  simulation: TargetSimulation,
  lookup: ObservedRtdbLookup,
): void {
  for (const index of restingTraceIndices(simulation.data)) {
    const entry = simulation.data.trace[index];
    if (entry === undefined) continue;
    collector.expressions.push(entry.conditionText);
    const reads = simulation.readsByEntry.get(index);
    if (reads !== undefined) {
      collectEntryReadGaps(collector, plan, simulation, entry, reads, lookup);
    }
  }
}

function collectSimulationGaps(
  compiled: CompiledRtdbRules,
  plan: RtdbPlan,
  resting: TargetSimulation[],
  lookup: ObservedRtdbLookup,
): { gaps: Gap[]; missingPaths: string[]; expressions: string[] } {
  const collector = createSimulationGapCollector();
  for (const simulation of resting) {
    collectTargetSimulationGaps(collector, plan, simulation, lookup);
  }

  if (plan.operation === 'write') {
    let clearedTargets: string[] = [];
    const isSingleEffectiveNull =
      plan.isRemove || (plan.updates === undefined && plan.hasWriteData && isNullRtdbWrite(plan.newData));
    if (isSingleEffectiveNull) {
      clearedTargets = plan.targets;
    } else if (plan.updates !== undefined) {
      clearedTargets = plan.updates.filter((u) => isNullRtdbWrite(u.value)).map((u) => u.path);
    }
    for (const target of clearedTargets) {
      const uncapturedAncestors = uncapturedAncestorValidatePaths(compiled, target, lookup);
      if (uncapturedAncestors.length > 0) {
        collector.gaps.push('stored-document');
        collector.missingPaths = unionPaths(collector.missingPaths, uncapturedAncestors);
      }
    }
    if (!plan.isRemove && !plan.hasWriteData) {
      const allowed = resting.every((simulation) => simulation.data.allowed);
      const validates = unwrittenValidates(compiled, plan.targets[0] ?? '/', allowed);
      collector.expressions.push(...validates);
      const readsWrite =
        validates.length > 0 ||
        collector.expressions.some((expr) => analyzeRtdbExpression(expr).readsNewData);
      if (readsWrite) collector.gaps.push('write-data');
    }
  }

  return {
    gaps: unionOf(collector.gaps, []),
    missingPaths: collector.missingPaths,
    expressions: collector.expressions,
  };
}

function shownTrace(resting: TargetSimulation[], plan: RtdbPlan): RtdbRuleEvaluation[] {
  return resting.flatMap((simulation) => simulation.data.trace).map((entry) => ({
    ...entry,
    pathVariableBindings: stripPushPlaceholder(entry.pathVariableBindings, plan.isPush),
  }));
}

function rtdbRecordOf(deciding: Simulation, trace: RtdbRuleEvaluation[], plan: RtdbPlan): RtdbLocal {
  const rtdb: RtdbLocal = {
    matchedPath: deciding.matchedPath,
    matchedRule: deciding.matchedRule,
    rtdbTrace: trace,
  };
  const bindings = stripPushPlaceholder(deciding.pathVariableBindings, plan.isPush);
  if (Object.keys(bindings).length > 0) rtdb.pathVariableBindings = bindings;
  if (deciding.reason !== '') rtdb.reason = deciding.reason;
  if (!deciding.allowed && deciding.matchedPath === '') rtdb.errorCode = 'NO_MATCHING_RULE';
  return rtdb;
}

export function rtdbVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  const compiled = appRtdbRules(ctx, call.instance);
  const path = call.path;
  if (compiled === null || path === undefined) return undefined;
  const plan = rtdbPlan(call, method, joinRtdbPath('/', path));
  if (plan === null) return undefined;
  const lookup = ctx.observedSession?.getRtdbInstance(call.instance) ?? EMPTY_RTDB_LOOKUP;
  const simulations = simulateTargets(compiled, call, plan, lookup.mockData);
  if (simulations === undefined || simulations.length === 0) return undefined;
  const denied = simulations.find((simulation) => !simulation.data.allowed);
  const allowed = denied === undefined;
  let resting = simulations;
  if (denied !== undefined) resting = [denied];
  const deciding = resting[0]!.data;
  const collected = collectSimulationGaps(compiled, plan, resting, lookup);
  const given = { ...givenBy(call, method), writeData: plan.hasWriteData };
  const needs = unionOf(rtdbExpressionGaps(collected.expressions, given), collected.gaps);
  let rule: LocalVerdict['rule'];
  if (deciding.matchedRule !== '') {
    rule = definedOnly({ path: deciding.matchedPath, expression: deciding.matchedRule });
  }
  const rtdb = rtdbRecordOf(deciding, shownTrace(resting, plan), plan);
  return verdictOf(call, {
    allowed,
    rule,
    needs,
    missingPaths: collected.missingPaths,
    rtdb,
  });
}
