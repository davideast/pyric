/**
 * The local Firestore rules' verdict on an observed Firestore call.
 *
 * The host runs the call through the deployed rules' simulator with the
 * claim values, written data, call-carried document, and pre-operation
 * `observedSession` documents. A Firestore verdict keeps the simulator's
 * trace, as a sandbox request's `rulesEvidence` does. `pyric verify` replays
 * captured live calls through `evaluateFirestoreCall` with candidate rules.
 */
import {
  EXISTS_ONLY_DOC,
  normalizeDocumentPath,
  projectEvaluatedRule,
  type DocumentLookupMeta,
  type ExprTraceEntry,
  type RuleEvaluation,
  type SimulationContext,
  type TestCase,
  type TestResult,
} from 'pyric/rules/internal';
import { captureRulesEvidence, getInternalEnv, type ObservedMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { ObservedFirestoreDocLookup } from '../../observed-session/coverage.js';
import type { ObservedSessionDataStore } from '../../observed-session/store.js';
import type { HostCtx } from '../host-context.js';
import {
  ALWAYS_OPEN,
  authOf,
  definedOnly,
  gapsIn,
  givenBy,
  isPlainRecord,
  unionOf,
  unionPaths,
  verdictOf,
  type Evaluation,
  type GapPattern,
  type Given,
  type LocalVerdict,
} from './observe-local-evaluation.js';

const LOCAL_TRACE_VERSION = 'local-rules';

const RESOURCE_READ = /(?<![\w.])resource\b/;
const AFTER_LOOKUP = /\b(?:getAfter|existsAfter)\s*\(/;
const WRITE_READ = /\brequest\.resource\b/;
const EMAIL_CLAIM = /\brequest\.auth\.token(?:\.(?:email\b|firebase\.identities\b)|\[['"]email['"]\])/;

/** Gaps checked over non-skipped atomic expressions in the deciding trace entries. */
const FIRESTORE_GAPS: readonly GapPattern[] = [
  ['stored-document', RESOURCE_READ, (given) => !given.document],
  ['stored-document', AFTER_LOOKUP, ALWAYS_OPEN],
  ['write-data', WRITE_READ, (given) => !given.writeData],
  ['stored-document', WRITE_READ, (given) => given.writeData && !given.wholeWrite],
  ['claim-values', /\brequest\.auth\.token\b/, (given) => !given.claims],
  ['claim-values', EMAIL_CLAIM, (given) => !given.emailKnown],
  ['query', /\brequest\.query\b/, ALWAYS_OPEN],
];

interface ResolvedTargetDoc {
  readonly status: ObservedFirestoreDocLookup['status'];
  readonly data?: Record<string, unknown>;
}

function resolveTargetDoc(
  call: ObservedCall,
  path: string,
  method: ObservedMethod,
  observedSession: ObservedSessionDataStore | undefined,
): ResolvedTargetDoc {
  if (call.document !== undefined) {
    return { status: 'complete', data: call.document };
  }
  if (method === 'list' || observedSession === undefined) {
    return { status: 'unobserved' };
  }
  return observedSession.getFirestoreDoc(path);
}

function isKnownFirestoreUpdate(
  method: Exclude<ObservedMethod, 'set'>,
  call: ObservedCall,
  targetDoc: ResolvedTargetDoc,
): boolean {
  return (
    method === 'update' &&
    isPlainRecord(call.writeData) &&
    targetDoc.status === 'complete' &&
    call.method === 'updateDoc'
  );
}

function buildFirestoreTestCase(
  call: ObservedCall,
  path: string,
  method: Exclude<ObservedMethod, 'set'>,
  targetDoc: ResolvedTargetDoc,
): TestCase {
  const isWrite = method === 'create' || method === 'update';
  const hasStoredResource = method !== 'create' && targetDoc.status === 'complete';
  const testCase: TestCase = {
    description: `${method} ${path}`,
    expectation: 'ALLOW',
    method,
    path,
    auth: authOf(call),
    requestTime: new Date(call.at).toISOString(),
  };
  if (isWrite && isPlainRecord(call.writeData)) {
    testCase.data = call.writeData;
  }
  if (hasStoredResource && targetDoc.data !== undefined) {
    testCase.resource = targetDoc.data;
  }
  if (isKnownFirestoreUpdate(method, call, targetDoc)) {
    testCase.writeMode = { kind: 'update' };
  }
  return testCase;
}

function decidingTraceEntries(result: TestResult, allowed: boolean): RuleEvaluation[] {
  if (!allowed) return result.trace;
  return result.trace.filter((entry) => entry.verdict === 'ALLOW').slice(0, 1);
}

function isAtomicTraceNode(node: ExprTraceEntry): boolean {
  if (node.skipped === true) return false;
  return (
    node.kind === 'identifier' ||
    node.kind === 'memberAccess' ||
    node.kind === 'bracketAccess' ||
    node.kind === 'functionCall'
  );
}

function evaluatedExpressionsOf(entries: readonly RuleEvaluation[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const exprTrace = entry.expressionTrace;
    if (exprTrace === undefined || exprTrace.length === 0) {
      if (entry.conditionText !== undefined) out.push(entry.conditionText);
      continue;
    }
    for (const node of exprTrace) {
      if (isAtomicTraceNode(node)) out.push(node.source);
    }
  }
  return out;
}

function hasAppFirestoreRules(ctx: HostCtx, source: string): boolean {
  const loaded = ctx.activeRules?.firestore?.source;
  return typeof loaded === 'string' && loaded === source;
}

/**
 * A Firestore rules simulator with its rules bound: the host's deployed
 * rules' cached parse, or `pyric verify`'s candidate rules.
 */
export type FirestoreSimulate = (
  cases: TestCase[],
  lookups: { getDoc: NonNullable<SimulationContext['getDoc']> },
) => { success: true; data: { results: TestResult[] } } | { success: false };

function evaluateFirestore(
  simulate: FirestoreSimulate,
  call: ObservedCall,
  path: string,
  method: Exclude<ObservedMethod, 'set'>,
  baseGiven: Given,
  observedSession: ObservedSessionDataStore | undefined,
): Evaluation | undefined {
  const targetDoc = resolveTargetDoc(call, path, method, observedSession);
  const targetResourceKnown =
    targetDoc.status === 'complete' || (targetDoc.status === 'absent' && method !== 'update');
  const given: Given = {
    ...baseGiven,
    document: baseGiven.document || targetResourceKnown,
    wholeWrite: baseGiven.wholeWrite || isKnownFirestoreUpdate(method, call, targetDoc),
  };

  const missingByTrace = new WeakMap<readonly ExprTraceEntry[], string[]>();
  let fallbackMissing: string[] = [];

  const recordMissing = (lookupPath: string, lookup: DocumentLookupMeta | undefined): void => {
    const entries = lookup?.trace?.entries;
    if (entries === undefined) {
      fallbackMissing = unionPaths(fallbackMissing, [lookupPath]);
      return;
    }
    const existing = missingByTrace.get(entries);
    missingByTrace.set(entries, unionPaths(existing, [lookupPath]));
  };

  const getDoc: NonNullable<SimulationContext['getDoc']> = (rawLookupPath, lookup) => {
    const normalized = normalizeDocumentPath(rawLookupPath);
    if (observedSession === undefined) {
      recordMissing(normalized, lookup);
      return null;
    }
    const resolved = observedSession.getFirestoreDoc(normalized);
    if (resolved.status === 'complete') return resolved.data;
    if (resolved.status === 'absent') return null;
    if (resolved.status === 'partial' && lookup?.kind === 'exists') {
      return EXISTS_ONLY_DOC;
    }
    recordMissing(normalized, lookup);
    return null;
  };

  const simulated = simulate([buildFirestoreTestCase(call, path, method, targetDoc)], { getDoc });
  if (!simulated.success) return undefined;
  const result = simulated.data.results[0];
  if (result === undefined || result.decision === 'UNSUPPORTED') return undefined;

  const allowed = result.decision === 'ALLOW';
  const entries = decidingTraceEntries(result, allowed);
  const expressions = evaluatedExpressionsOf(entries);

  let lookupMissing = fallbackMissing;
  for (const entry of entries) {
    if (entry.expressionTrace !== undefined) {
      lookupMissing = unionPaths(lookupMissing, missingByTrace.get(entry.expressionTrace));
    }
  }

  let targetMissing: string[] = [];
  if (method !== 'list') {
    const readsUncapturedResource =
      !given.document && expressions.some((text) => RESOURCE_READ.test(text));
    const readsUncapturedUpdateBase =
      given.writeData && !given.wholeWrite && expressions.some((text) => WRITE_READ.test(text));
    if (readsUncapturedResource || readsUncapturedUpdateBase) {
      targetMissing = [normalizeDocumentPath(path)];
    }
  }

  const missingPaths = unionPaths(lookupMissing, targetMissing);
  const exprGaps = gapsIn(expressions, FIRESTORE_GAPS, given);
  let needs = exprGaps;
  if (lookupMissing.length > 0) {
    needs = unionOf(['stored-document'], exprGaps);
  }
  const deciding = projectEvaluatedRule(result);
  let rule: Evaluation['rule'];
  if (deciding !== undefined) {
    rule = definedOnly({ line: deciding.line, expression: deciding.expression });
  }
  return {
    allowed,
    rule,
    needs,
    missingPaths,
    trace: captureRulesEvidence(result, LOCAL_TRACE_VERSION),
  };
}

function evaluateSetDoc(
  simulate: FirestoreSimulate,
  call: ObservedCall,
  path: string,
  observedSession: ObservedSessionDataStore | undefined,
): Evaluation | undefined {
  const given = givenBy(call, 'set');
  const targetDoc = resolveTargetDoc(call, path, 'set', observedSession);
  if (targetDoc.status === 'absent') {
    return evaluateFirestore(simulate, call, path, 'create', given, observedSession);
  }
  if (targetDoc.status === 'complete' || targetDoc.status === 'partial') {
    return evaluateFirestore(simulate, call, path, 'update', given, observedSession);
  }
  const create = evaluateFirestore(simulate, call, path, 'create', given, observedSession);
  const update = evaluateFirestore(simulate, call, path, 'update', given, observedSession);
  if (create === undefined || update === undefined) return undefined;
  const needs = unionOf(create.needs, update.needs);
  const branchMissing = unionPaths(create.missingPaths, update.missingPaths);
  if (create.allowed === update.allowed) {
    return { ...create, needs, missingPaths: branchMissing };
  }
  return {
    allowed: create.allowed,
    rule: undefined,
    needs: unionOf(['stored-document'], needs),
    missingPaths: unionPaths([normalizeDocumentPath(path)], branchMissing),
  };
}

export function evaluateFirestoreCall(
  simulate: FirestoreSimulate,
  call: ObservedCall,
  method: ObservedMethod,
  observedSession?: ObservedSessionDataStore,
): Evaluation | undefined {
  const path = call.path;
  if (path === undefined) return undefined;
  if (method === 'set') return evaluateSetDoc(simulate, call, path, observedSession);
  return evaluateFirestore(simulate, call, path, method, givenBy(call, method), observedSession);
}

export function firestoreVerdict(
  ctx: HostCtx,
  call: ObservedCall,
  method: ObservedMethod,
): LocalVerdict | undefined {
  const env = getInternalEnv(ctx.sandbox);
  if (!hasAppFirestoreRules(ctx, env.getRules())) return undefined;
  const evaluation = evaluateFirestoreCall(
    (cases, lookups) => env.simulateDeployedRules(cases, lookups),
    call,
    method,
    ctx.observedSession,
  );
  if (evaluation === undefined) return undefined;
  return verdictOf(call, evaluation);
}
