/**
 * Evaluates observed Live-mode calls (especially production denials) against
 * fetched deployed Security Rules across Firestore, Realtime Database, and
 * Cloud Storage (`#2363`).
 *
 * Reuses the existing canonical evaluators (`evaluateFirestoreCall`,
 * `rtdbVerdict`, and `storageVerdict`) while tagging every explanation
 * unambiguously with `source: 'deployed'`, `version: 'deployed-rules'` on
 * Firestore traces, and the deployed-vs-local drift report.
 */
import { sandbox as rtdbSandbox } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { compileRtdbRules } from 'pyric/rules/internal/rtdb';
import type { ObservedCall } from 'pyric/sandbox';
import {
  createSandboxRoot,
  observedMethod,
  productionVerdict,
  rtdbRulesMethod,
  UNREAD_BUCKET,
  type LocalRtdbEvaluation,
  type LocalStorageEvaluation,
} from 'pyric/sandbox/internal';
import type { HostCtx } from '../worker/host-context.js';
import type {
  Gap,
  Rule,
  Trace,
} from '../worker/host/observe-local-evaluation.js';
import { evaluateFirestoreCall } from '../worker/host/observe-local-firestore.js';
import { rtdbVerdict } from '../worker/host/observe-local-rtdb.js';
import { rtdbInstance } from '../worker/host/rtdb-instances.js';
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
 * snapshot by delegating to `rtdbVerdict` on an ephemeral sandbox instance,
 * abstaining as `unevaluated` when a rule inspects uncaptured stored state.
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

  try {
    compileRtdbRules(snapshot.parsed);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source: 'local',
      reason: 'compile-error',
      message: `Could not compile deployed Realtime Database rules: ${reason}`,
    };
  }

  let observedSession = sessionData;
  if (sessionData !== undefined && call.instance === undefined) {
    observedSession = {
      ...sessionData,
      getRtdbInstance(instance) {
        return sessionData.getRtdbInstance(instance ?? snapshot.instance);
      },
    };
  }

  const sandbox = createSandboxRoot();
  let evaluated: ReturnType<typeof rtdbVerdict>;
  try {
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'deployed-rules-rtdb-eval',
      subs: new Map(),
      defaultRtdbInstance: snapshot.instance,
      observedSession,
    };
    const entry = rtdbInstance(ctx, call.instance);
    const rulesCopy = structuredClone(snapshot.parsed);
    rtdbSandbox.setRules(entry.live, rulesCopy);
    entry.rules = {
      source: rulesCopy,
      lastKnownGood: structuredClone(snapshot.parsed),
      updatedAt: call.at,
      status: 'active',
      messages: [],
    };
    evaluated = rtdbVerdict(ctx, call, method);
  } finally {
    sandbox.dispose();
  }

  if (evaluated === undefined) {
    return {
      ok: false,
      source: 'local',
      reason: 'compile-error',
      message: 'Could not simulate deployed Realtime Database rules for this call.',
    };
  }

  if (evaluated.result === 'unevaluated') {
    const explanation: MutableDeployedRulesExplanation = {
      source: 'deployed',
      service: 'rtdb',
      target: snapshot.instance,
      verdict: 'unevaluated',
      productionDisagrees: false,
      needs: evaluated.needs,
      drift: snapshot.drift,
      deployedHash: snapshot.hash,
    };
    if (evaluated.missingPaths !== undefined && evaluated.missingPaths.length > 0) {
      explanation.missingPaths = [...evaluated.missingPaths];
    }
    if (evaluated.rule !== undefined) explanation.rule = evaluated.rule;
    if (evaluated.rtdb !== undefined) {
      const kept = boundedRtdbRecord(evaluated.rtdb);
      if (kept !== undefined) explanation.rtdb = kept;
    }
    return { ok: true, explanation };
  }

  const explanation: MutableDeployedRulesExplanation = {
    source: 'deployed',
    service: 'rtdb',
    target: snapshot.instance,
    verdict: evaluated.result,
    productionDisagrees: evaluated.drift === true,
    drift: snapshot.drift,
    deployedHash: snapshot.hash,
  };
  if (evaluated.rule !== undefined) explanation.rule = evaluated.rule;
  if (evaluated.rtdb !== undefined) {
    const kept = boundedRtdbRecord(evaluated.rtdb);
    if (kept !== undefined) explanation.rtdb = kept;
  }
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
