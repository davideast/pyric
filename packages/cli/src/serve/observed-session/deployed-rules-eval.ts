/**
 * Evaluates observed Live-mode calls (especially production denials) against
 * fetched deployed Security Rules across Firestore, Realtime Database, and
 * Cloud Storage (`#2363`).
 *
 * Reuses the existing rules simulators (`evaluateFirestoreCall`,
 * `compileRtdbRules`/`simulateRtdbRules`, `parseStorageRules`/`evaluateStorageRules`)
 * while tagging every explanation unambiguously with `source: 'deployed'`,
 * `version: 'deployed-rules'` on Firestore traces, and the deployed-vs-local
 * drift report.
 */
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import {
  compileRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
  type RtdbRuleEvaluation,
} from 'pyric/rules/internal/rtdb';
import type { ObservedCall } from 'pyric/sandbox';
import {
  observedMethod,
  productionVerdict,
  rtdbRulesMethod,
  UNREAD_BUCKET,
  type LocalRtdbEvaluation,
  type LocalStorageEvaluation,
  type ObservedMethod,
} from 'pyric/sandbox/internal';
import {
  authOf,
  definedOnly,
  givenBy,
  unionOf,
  unionPaths,
  type Gap,
  type Rule,
  type Trace,
} from '../worker/host/observe-local-evaluation.js';
import { evaluateFirestoreCall } from '../worker/host/observe-local-firestore.js';
import {
  analyzeRtdbExpression,
  rtdbExpressionGaps,
  unwrittenValidates,
} from '../worker/host/observe-local-rtdb-expressions.js';
import { joinRtdbPath, toRtdbMockData } from './rtdb-tree.js';
import type { ObservedSessionDataStore } from './store.js';
import type {
  DeployedFirestoreRulesSnapshot,
  DeployedRtdbRulesSnapshot,
  DeployedRulesService,
} from './deployed-rules.js';
import type { RulesDriftReport } from './deployed-rules-drift.js';
import type { DeployedRulesFetchErrorCode } from './deployed-rules-http.js';
import { evaluateCallAgainstDeployedStorage } from './deployed-rules-storage-eval.js';
import type { DeployedRulesStore } from './deployed-rules-store.js';

export const DEPLOYED_TRACE_VERSION = 'deployed-rules';

const MAX_TRACE_BYTES = 16 * 1024;
const RTDB_PUSH_PLACEHOLDER = '-O_pyric_push_000000';
const firestoreSimulator = new SimulateFirestoreRulesHandler();

export interface DeployedRulesExplanation {
  readonly source: 'deployed';
  readonly service: DeployedRulesService;
  readonly target: string;
  readonly verdict: 'allow' | 'deny' | 'unevaluated';
  readonly productionDisagrees: boolean;
  readonly rule?: Rule;
  readonly needs?: readonly Gap[];
  readonly missingPaths?: readonly string[];
  readonly trace?: Trace;
  readonly rtdb?: LocalRtdbEvaluation;
  readonly storage?: LocalStorageEvaluation;
  readonly drift: RulesDriftReport;
  readonly releaseName?: string;
  readonly rulesetId?: string;
  readonly deployedHash: string;
}

interface MutableDeployedRulesExplanation {
  source: 'deployed';
  service: DeployedRulesService;
  target: string;
  verdict: 'allow' | 'deny' | 'unevaluated';
  productionDisagrees: boolean;
  rule?: Rule;
  needs?: readonly Gap[];
  missingPaths?: readonly string[];
  trace?: Trace;
  rtdb?: LocalRtdbEvaluation;
  storage?: LocalStorageEvaluation;
  drift: RulesDriftReport;
  releaseName?: string;
  rulesetId?: string;
  deployedHash: string;
}

type DeployedRulesEvaluationFailureReason =
  | DeployedRulesFetchErrorCode
  | 'disabled'
  | 'unsupported-call'
  | 'compile-error';

export type DeployedRulesEvaluationOutcome =
  | { readonly ok: true; readonly explanation: DeployedRulesExplanation }
  | {
      readonly ok: false;
      readonly source: 'local';
      readonly reason: DeployedRulesEvaluationFailureReason;
      readonly message: string;
    };

export interface ExplainLiveCallWithDeployedRulesInput {
  readonly call: ObservedCall;
  readonly store: DeployedRulesStore;
  readonly sessionData?: ObservedSessionDataStore;
  readonly localRules?: {
    readonly firestore?: string | null;
    readonly rtdb?: string | null;
    readonly storage?: string | null;
  };
  readonly firestoreDatabaseId?: string;
  readonly rtdbUrlOrInstance?: string;
  readonly storageBucket?: string;
}

function withinByteCap(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_TRACE_BYTES;
}

function productionDisagreesWith(call: ObservedCall, allowed: boolean): boolean {
  const verdict = productionVerdict(call.outcome);
  if (verdict === 'ok' && !allowed) return true;
  if (verdict === 'denied' && allowed) return true;
  return false;
}

function boundedDeployedTrace(trace: Trace | undefined): Trace | undefined {
  if (trace === undefined) return undefined;
  const tagged: Trace = { ...trace, version: DEPLOYED_TRACE_VERSION };
  if (!withinByteCap(tagged)) return undefined;
  return tagged;
}

/**
 * Evaluates a single observed Firestore call against a deployed rules snapshot.
 */
export function evaluateCallAgainstDeployedFirestore(
  call: ObservedCall,
  snapshot: DeployedFirestoreRulesSnapshot,
  sessionData?: ObservedSessionDataStore,
): DeployedRulesEvaluationOutcome {
  if (call.sdk === 'admin' || call.service !== 'firestore') {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: 'Deployed Firestore rules evaluation applies only to client Firestore calls.',
    };
  }
  const method = observedMethod('firestore', call.method);
  if (method === null) {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: `Firestore method "${call.method}" does not map to a rules operation.`,
    };
  }

  const evaluation = evaluateFirestoreCall(
    (cases, lookups) => firestoreSimulator.simulate(snapshot.source, cases, lookups),
    call,
    method,
    sessionData,
    snapshot.source,
  );
  if (evaluation === undefined) {
    return {
      ok: false,
      source: 'local',
      reason: 'compile-error',
      message: 'Could not simulate deployed Firestore rules for this call.',
    };
  }

  if (evaluation.needs.length > 0) {
    const explanation: MutableDeployedRulesExplanation = {
      source: 'deployed',
      service: 'firestore',
      target: snapshot.databaseId,
      verdict: 'unevaluated',
      productionDisagrees: false,
      needs: [...evaluation.needs],
      drift: snapshot.drift,
      releaseName: snapshot.releaseName,
      rulesetId: snapshot.rulesetId,
      deployedHash: snapshot.hash,
    };
    if (evaluation.rule !== undefined) {
      explanation.rule = evaluation.rule;
    }
    if (evaluation.missingPaths !== undefined && evaluation.missingPaths.length > 0) {
      explanation.missingPaths = [...evaluation.missingPaths];
    }
    return { ok: true, explanation };
  }

  const trace = boundedDeployedTrace(evaluation.trace);
  const verdict = evaluation.allowed ? 'allow' : 'deny';
  const explanation: MutableDeployedRulesExplanation = {
    source: 'deployed',
    service: 'firestore',
    target: snapshot.databaseId,
    verdict,
    productionDisagrees: productionDisagreesWith(call, evaluation.allowed),
    drift: snapshot.drift,
    releaseName: snapshot.releaseName,
    rulesetId: snapshot.rulesetId,
    deployedHash: snapshot.hash,
  };
  if (evaluation.rule !== undefined) {
    explanation.rule = evaluation.rule;
  }
  if (trace !== undefined) {
    explanation.trace = trace;
  }
  return { ok: true, explanation };
}

function rtdbOperationFor(method: ObservedMethod): 'read' | 'write' {
  if (method === 'get' || method === 'list') {
    return 'read';
  }
  return 'write';
}

function boundedRtdbRecord(record: LocalRtdbEvaluation): LocalRtdbEvaluation | undefined {
  if (withinByteCap(record)) return record;
  if (record.rtdbTrace === undefined) return undefined;
  const { rtdbTrace: _dropped, ...withoutTrace } = record;
  if (Object.keys(withoutTrace).length === 0) return undefined;
  if (!withinByteCap(withoutTrace)) return undefined;
  return withoutTrace;
}

/**
 * Evaluates a single observed Realtime Database call against a deployed rules
 * snapshot, abstaining as `unevaluated` when a rule reads an uncaptured
 * stored `data`/`root` path.
 */
export function evaluateCallAgainstDeployedRtdb(
  call: ObservedCall,
  snapshot: DeployedRtdbRulesSnapshot,
  sessionData?: ObservedSessionDataStore,
): DeployedRulesEvaluationOutcome {
  if (call.sdk === 'admin' || call.service !== 'rtdb') {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: 'Deployed Realtime Database rules evaluation applies only to client RTDB calls.',
    };
  }
  const method = rtdbRulesMethod(call.method);
  if (method === null || call.path === undefined) {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: `Realtime Database method "${call.method}" cannot be evaluated against deployed rules.`,
    };
  }

  let compiled: CompiledRtdbRules;
  try {
    compiled = compileRtdbRules(snapshot.parsed);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source: 'local',
      reason: 'compile-error',
      message: `Could not compile deployed Realtime Database rules: ${reason}`,
    };
  }

  const operation = rtdbOperationFor(method);
  let targetPath = joinRtdbPath('/', call.path);
  if (call.method === 'push') {
    targetPath = joinRtdbPath(targetPath, RTDB_PUSH_PLACEHOLDER);
  }
  const lookup = sessionData?.getRtdbInstance(call.instance ?? snapshot.instance);
  const mockData = toRtdbMockData(lookup?.mockData ?? {});
  const isPathKnown = (readPath: string): boolean => {
    if (lookup === undefined) return false;
    return lookup.isPathKnown(readPath);
  };

  const isRemove = method === 'delete';
  const hasWriteData = isRemove || call.writeData !== undefined;
  const simInput: Parameters<typeof simulateRtdbRules>[1] = {
    operation,
    path: targetPath,
    auth: authOf(call),
    mockData,
    now: call.at,
  };
  if (isRemove) {
    simInput.newData = null;
  } else if (operation === 'write' && call.writeData !== undefined) {
    simInput.newData = call.writeData;
  }

  let missingPaths: string[] = [];
  const simulated = simulateRtdbRules(compiled, simInput, {
    onRuleRead(_traceIndex, source, readPath) {
      if (source === 'stored' && !isPathKnown(readPath)) {
        missingPaths = unionPaths(missingPaths, [readPath]);
      }
    },
  });
  if (!simulated.success || simulated.data.unsupported) {
    return {
      ok: false,
      source: 'local',
      reason: 'compile-error',
      message: 'Could not simulate deployed Realtime Database rules for this call.',
    };
  }

  const data = simulated.data;
  const expressions = data.trace.map((entry) => entry.conditionText);
  const baseGaps: Gap[] = [];
  if (missingPaths.length > 0) {
    baseGaps.push('stored-document');
  }
  if (operation === 'write' && !hasWriteData) {
    const validates = unwrittenValidates(compiled, targetPath, data.allowed);
    expressions.push(...validates);
    const readsNewData = validates.length > 0 || expressions.some((expr) => analyzeRtdbExpression(expr).readsNewData);
    if (readsNewData) {
      baseGaps.push('write-data');
    }
  }
  const given = { ...givenBy(call, method), writeData: hasWriteData };
  const needs = unionOf(rtdbExpressionGaps(expressions, given), baseGaps);

  let rule: Rule | undefined;
  if (data.matchedRule !== '') {
    rule = definedOnly({ path: data.matchedPath, expression: data.matchedRule });
  }

  if (needs.length > 0) {
    const context: LocalRtdbEvaluation = {};
    if (data.matchedPath !== '') context.matchedPath = data.matchedPath;
    if (data.matchedRule !== '') context.matchedRule = data.matchedRule;
    if (Object.keys(data.pathVariableBindings).length > 0) {
      context.pathVariableBindings = { ...data.pathVariableBindings };
    }
    const explanation: MutableDeployedRulesExplanation = {
      source: 'deployed',
      service: 'rtdb',
      target: snapshot.instance,
      verdict: 'unevaluated',
      productionDisagrees: false,
      needs,
      drift: snapshot.drift,
      deployedHash: snapshot.hash,
    };
    if (missingPaths.length > 0) explanation.missingPaths = missingPaths;
    if (rule !== undefined) explanation.rule = rule;
    if (Object.keys(context).length > 0) explanation.rtdb = context;
    return { ok: true, explanation };
  }

  const rtdbRecord: LocalRtdbEvaluation = {
    matchedPath: data.matchedPath,
    matchedRule: data.matchedRule,
    rtdbTrace: data.trace as RtdbRuleEvaluation[],
  };
  if (Object.keys(data.pathVariableBindings).length > 0) {
    rtdbRecord.pathVariableBindings = { ...data.pathVariableBindings };
  }
  if (data.reason !== '') {
    rtdbRecord.reason = data.reason;
  }
  if (!data.allowed && data.matchedPath === '') {
    rtdbRecord.errorCode = 'NO_MATCHING_RULE';
  }

  const keptRtdb = boundedRtdbRecord(rtdbRecord);
  const verdict = data.allowed ? 'allow' : 'deny';
  const explanation: MutableDeployedRulesExplanation = {
    source: 'deployed',
    service: 'rtdb',
    target: snapshot.instance,
    verdict,
    productionDisagrees: productionDisagreesWith(call, data.allowed),
    drift: snapshot.drift,
    deployedHash: snapshot.hash,
  };
  if (rule !== undefined) explanation.rule = rule;
  if (keptRtdb !== undefined) explanation.rtdb = keptRtdb;
  return { ok: true, explanation };
}

/**
 * Fetches (via the opt-in store) and evaluates an observed live call against
 * the active deployed ruleset for its service, degrading gracefully to
 * `source: 'local'` when disabled, unauthenticated, or unreadable.
 */
export async function explainLiveCallWithDeployedRules(
  input: ExplainLiveCallWithDeployedRulesInput,
): Promise<DeployedRulesEvaluationOutcome> {
  const { call, store } = input;
  if (!store.enabled) {
    return {
      ok: false,
      source: 'local',
      reason: 'disabled',
      message: 'Deployed rules inspection is off (opt in with --deployed-rules or deployedRules: true).',
    };
  }
  if (call.sdk === 'admin') {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: 'Admin SDK calls bypass Security Rules.',
    };
  }

  if (call.service === 'firestore') {
    const read = await store.getFirestore({
      databaseId: input.firestoreDatabaseId,
      localRulesText: input.localRules?.firestore,
    });
    if (!read.ok) {
      if (read.disabled === true) {
        return { ok: false, source: 'local', reason: 'disabled', message: 'Deployed rules inspection is disabled.' };
      }
      return { ok: false, source: 'local', reason: read.error.code, message: read.error.message };
    }
    return evaluateCallAgainstDeployedFirestore(call, read.snapshot, input.sessionData);
  }

  if (call.service === 'rtdb') {
    const target = input.rtdbUrlOrInstance ?? call.instance;
    const read = await store.getRtdb({
      databaseUrlOrInstance: target,
      localRulesText: input.localRules?.rtdb,
    });
    if (!read.ok) {
      if (read.disabled === true) {
        return { ok: false, source: 'local', reason: 'disabled', message: 'Deployed rules inspection is disabled.' };
      }
      return { ok: false, source: 'local', reason: read.error.code, message: read.error.message };
    }
    return evaluateCallAgainstDeployedRtdb(call, read.snapshot, input.sessionData);
  }

  if (call.service === 'storage') {
    let bucket = input.storageBucket;
    if (bucket === undefined && call.bucket !== undefined && call.bucket !== UNREAD_BUCKET) {
      bucket = call.bucket;
    }
    const read = await store.getStorage({
      bucket,
      localRulesText: input.localRules?.storage,
    });
    if (!read.ok) {
      if (read.disabled === true) {
        return { ok: false, source: 'local', reason: 'disabled', message: 'Deployed rules inspection is disabled.' };
      }
      return { ok: false, source: 'local', reason: read.error.code, message: read.error.message };
    }
    return evaluateCallAgainstDeployedStorage(call, read.snapshot);
  }

  return {
    ok: false,
    source: 'local',
    reason: 'unsupported-call',
    message: `Service "${call.service}" does not use Firebase Security Rules.`,
  };
}
