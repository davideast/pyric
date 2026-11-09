/**
 * The local RTDB rules' verdict on an observed Realtime Database call.
 *
 * The host simulates the call against the rules the app deployed to the
 * call's instance. A write is checked as production checks it: a `set` or a
 * `push` at its one location with the value it sent, and an `update` at each
 * location it names (a key holding `/` names a deeper one), every location
 * seeing the whole update. A remove is a write of `null`.
 *
 * The host never holds the stored tree, so the simulation runs over an empty
 * one. A verdict that read stored data is `unevaluated`: a rule reading
 * `data` or `root`, a server increment checked through `newData`, and any
 * rule above a written location that reads `newData` (there `newData` holds
 * the stored siblings the write left in place) or reads `newData.parent()`.
 */
import type { RtdbRulesJson } from 'pyric/rules';
import {
  collectRtdbRuleAncestors,
  compileRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
  type RtdbNode,
  type RtdbRuleEvaluation,
} from 'pyric/rules/internal/rtdb';
import { getActiveRules } from 'pyric/sandbox/database';
import { LOCKED_DATABASE_RULES, type ObservedMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { HostCtx, HostRtdbInstance } from '../host-context.js';
import { rtdbInstance } from './rtdb-instances.js';
import {
  ALWAYS_OPEN,
  authOf,
  definedOnly,
  gapsIn,
  givenBy,
  isPlainRecord,
  unionOf,
  verdictOf,
  type Gap,
  type GapPattern,
  type LocalVerdict,
  type RtdbLocal,
} from './observe-local-evaluation.js';

const RTDB_EMAIL_CLAIM = /\bauth\.token\.(?:email\b|firebase\.identities\b)/;
const RTDB_NEW_DATA = /(?<![\w.])newData\b/;
/** `newData.parent()` reaches the written location's siblings, which the stored tree holds. */
const RTDB_NEW_DATA_PARENT = /(?<![\w.])newData\s*\.\s*parent\s*\(/;
const RTDB_PUSH_PLACEHOLDER = '-O_pyric_push';

/** What each gap looks like in an RTDB rule expression. */
const RTDB_GAPS: readonly GapPattern[] = [
  ['stored-document', /(?<![\w.])(?:data|root)\b/, ALWAYS_OPEN],
  ['claim-values', /\bauth\.token\b/, (given) => !given.claims],
  // Legacy captures and calls without claimNames cannot tell whether the token carried an email.
  ['claim-values', RTDB_EMAIL_CLAIM, (given) => !given.emailKnown],
  ['query', /(?<![\w.])query\./, ALWAYS_OPEN],
];

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

/** One written location: its absolute path and the value the write leaves there. */
interface RtdbWrite {
  path: string;
  value: unknown;
}

/**
 * How one call is simulated: each location production checks it at, and the
 * value it wrote there, when the call carried it.
 */
interface RtdbPlan {
  operation: 'read' | 'write';
  /** The locations production checks the call's rules at; one but for a multi-location update. */
  targets: string[];
  /** The value a single-location write leaves (`null` for a remove). */
  newData?: unknown;
  /** Every location an update writes, each seeing all of them. */
  updates?: RtdbWrite[];
  /** Whether the call carried the value its write rules check. */
  hasWriteData: boolean;
  /** Whether the value holds a server increment, whose result rests on the stored value. */
  hasIncrement: boolean;
  isPush: boolean;
  isRemove: boolean;
}

/** One target's simulation. */
interface TargetSimulation {
  target: string;
  data: Simulation;
}

/** Each instance's compiled rules, kept while the deployed source is the same: a large ruleset takes long to parse, and every observed call reads it. */
const COMPILED_BY_INSTANCE = new WeakMap<HostRtdbInstance, { state: unknown; source: unknown; compiled: CompiledRtdbRules }>();

/** The compiled rules the app deployed to an RTDB instance, or `null` for none or the locked stand-in. */
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

function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** The absolute path of `relative` under `base`, as an update's key names a location below its reference. */
function joinRtdbPath(base: string, relative: string): string {
  return `/${[...segmentsOf(base), ...segmentsOf(relative)].join('/')}`;
}

function depthOf(path: string): number {
  return segmentsOf(path).length;
}

function collectDescendantValidates(node: RtdbNode, out: string[]): void {
  if (node.validate !== undefined) out.push(node.validate.raw);
  for (const child of node.children) collectDescendantValidates(child, out);
}

/** A written value with server timestamps resolved to `now` and increments to zero, noting any increment. */
function scrubRtdbWriteValue(
  value: unknown,
  now: number,
  state: { hasIncrement: boolean },
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubRtdbWriteValue(item, now, state));
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, '.sv')) {
    const sv = record['.sv'];
    if (sv === 'timestamp') return now;
    if (isPlainRecord(sv) && 'increment' in sv) {
      state.hasIncrement = true;
      return 0;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = scrubRtdbWriteValue(v, now, state);
  }
  return out;
}

function stripPushPlaceholder(
  bindings: Record<string, string>,
  omitPushPlaceholder: boolean,
): Record<string, string> {
  if (!omitPushPlaceholder) return bindings;
  const filtered: Record<string, string> = {};
  for (const [key, val] of Object.entries(bindings)) {
    if (val !== RTDB_PUSH_PLACEHOLDER) filtered[key] = val;
  }
  return filtered;
}

/** The location a push writes: a new child of the reference, under a placeholder key. */
function pushTarget(path: string): string {
  return joinRtdbPath(path, RTDB_PUSH_PLACEHOLDER);
}

/**
 * How the call is simulated, or `null` for an empty update, which the SDK
 * resolves without asking production.
 */
function rtdbPlan(call: ObservedCall, method: ObservedMethod, path: string): RtdbPlan | null {
  const operation = RTDB_OPERATION[method];
  const isPush = call.method === 'push';
  const isRemove = method === 'delete' || (method === 'set' && call.writeData === null);
  const plan: RtdbPlan = { operation, targets: [path], hasWriteData: false, hasIncrement: false, isPush, isRemove };
  if (isPush) plan.targets = [pushTarget(path)];
  if (operation === 'read') return plan;
  if (isRemove) {
    plan.newData = null;
    plan.hasWriteData = true;
    return plan;
  }
  const written = call.writeData;
  if (written === undefined) return plan;
  const state = { hasIncrement: false };
  if (call.method !== 'update') {
    plan.newData = scrubRtdbWriteValue(written, call.at, state);
    plan.hasWriteData = true;
    plan.hasIncrement = state.hasIncrement;
    return plan;
  }
  // An update's value is a map of locations; any other value is not one production would take.
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

/** The simulator's input for one target of `plan`. */
function simulationInputAt(call: ObservedCall, plan: RtdbPlan, target: string, index: number): SimulationInput {
  const input: SimulationInput = {
    operation: plan.operation,
    path: target,
    auth: authOf(call),
    mockData: {},
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

/** Every target's simulation, or `undefined` when the simulator fails or abstains on any. */
function simulateTargets(compiled: CompiledRtdbRules, call: ObservedCall, plan: RtdbPlan): TargetSimulation[] | undefined {
  const simulations: TargetSimulation[] = [];
  for (const [index, target] of plan.targets.entries()) {
    const simulated = simulateRtdbRules(compiled, simulationInputAt(call, plan, target, index));
    if (!simulated.success || simulated.data.unsupported) return undefined;
    simulations.push({ target, data: simulated.data });
  }
  return simulations;
}

/** The expressions one simulation's answer rests on: the granting rule and its validates for an allow, every rule for a deny. */
function restingExpressions(data: Simulation): string[] {
  if (!data.allowed) return data.trace.map((entry) => entry.conditionText);
  const validates = data.trace.filter((entry) => entry.kind === 'validate').map((entry) => entry.conditionText);
  return [data.matchedRule, ...validates];
}

/**
 * The validates a write that carried no value would have been checked
 * against: every one from the root to the target, and below it for an allow.
 */
function unwrittenValidates(compiled: CompiledRtdbRules, target: string, allowed: boolean): string[] {
  const segments = segmentsOf(target);
  const steps = collectRtdbRuleAncestors(compiled, segments);
  const validates = steps
    .map((step) => step.node.validate?.raw)
    .filter((raw): raw is string => raw !== undefined);
  const deepest = steps[steps.length - 1];
  const reachesTarget = allowed && steps.length === segments.length + 1 && deepest !== undefined;
  if (reachesTarget) {
    for (const child of deepest.node.children) collectDescendantValidates(child, validates);
  }
  return validates;
}

/** Whether a rule above `target` read `newData`, which there holds the stored siblings the write left in place. */
function readsNewDataAbove(simulation: TargetSimulation): boolean {
  const targetDepth = depthOf(simulation.target);
  return simulation.data.trace.some((entry) => depthOf(entry.path) < targetDepth && RTDB_NEW_DATA.test(entry.conditionText));
}

/** Whether a remove's location sits under a `.validate`, which production runs on the siblings it leaves and the empty local tree skips. */
function removeUnderValidate(compiled: CompiledRtdbRules, target: string): boolean {
  const targetDepth = depthOf(target);
  const ancestors = collectRtdbRuleAncestors(compiled, segmentsOf(target)).filter((step) => step.depth < targetDepth);
  return ancestors.some((step) => step.node.validate !== undefined);
}

/** The data a write's answer rested on that the call did not carry, beyond what its expressions name. */
function writeGaps(compiled: CompiledRtdbRules, plan: RtdbPlan, resting: TargetSimulation[], expressions: string[]): Gap[] {
  const gaps: Gap[] = [];
  if (plan.isRemove) {
    if (removeUnderValidate(compiled, plan.targets[0] ?? '/')) gaps.push('stored-document');
    return gaps;
  }
  if (!plan.hasWriteData) {
    const allowed = resting.every((simulation) => simulation.data.allowed);
    const validates = unwrittenValidates(compiled, plan.targets[0] ?? '/', allowed);
    expressions.push(...validates);
    const readsWrite = validates.length > 0 || expressions.some((expr) => RTDB_NEW_DATA.test(expr));
    if (readsWrite) gaps.push('write-data');
    return gaps;
  }
  const readsIncrement = plan.hasIncrement && expressions.some((expr) => RTDB_NEW_DATA.test(expr));
  const readsSiblings = resting.some(readsNewDataAbove) || expressions.some((expr) => RTDB_NEW_DATA_PARENT.test(expr));
  if (readsIncrement || readsSiblings) gaps.push('stored-document');
  return gaps;
}

/** The trace a verdict shows: every target's for an allow, the denying target's for a deny. */
function shownTrace(resting: TargetSimulation[], plan: RtdbPlan): RtdbRuleEvaluation[] {
  return resting.flatMap((simulation) => simulation.data.trace).map((entry) => ({
    ...entry,
    pathVariableBindings: stripPushPlaceholder(entry.pathVariableBindings, plan.isPush),
  }));
}

/** The RTDB record a verdict carries, from the deciding target's simulation. */
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

/** The app's RTDB rules' verdict on an observed RTDB call, or `undefined` when the app deployed none to its instance. */
export function rtdbVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  const compiled = appRtdbRules(ctx, call.instance);
  const path = call.path;
  if (compiled === null || path === undefined) return undefined;
  const plan = rtdbPlan(call, method, joinRtdbPath('/', path));
  if (plan === null) return undefined;
  const simulations = simulateTargets(compiled, call, plan);
  if (simulations === undefined || simulations.length === 0) return undefined;
  const denied = simulations.find((simulation) => !simulation.data.allowed);
  const allowed = denied === undefined;
  // An allow rests on every location's; a deny on the location that denied.
  let resting = simulations;
  if (denied !== undefined) resting = [denied];
  const deciding = resting[0]!.data;
  const expressions = resting.flatMap((simulation) => restingExpressions(simulation.data));
  let extraGaps: Gap[] = [];
  if (plan.operation === 'write') extraGaps = writeGaps(compiled, plan, resting, expressions);
  const given = { ...givenBy(call, method), writeData: plan.hasWriteData };
  const needs = unionOf(gapsIn(expressions, RTDB_GAPS, given), extraGaps);
  let rule: LocalVerdict['rule'];
  if (deciding.matchedRule !== '') rule = definedOnly({ path: deciding.matchedPath, expression: deciding.matchedRule });
  const rtdb = rtdbRecordOf(deciding, shownTrace(resting, plan), plan);
  return verdictOf(call, { allowed, rule, needs, rtdb });
}
