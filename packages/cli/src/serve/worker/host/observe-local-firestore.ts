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
  SimulateFirestoreRulesHandler,
  type DocumentLookupMeta,
  type ExprTraceEntry,
  type SimulationContext,
  type TestCase,
  type TestResult,
} from 'pyric/rules/internal';
import { captureRulesEvidence, getInternalEnv, type ObservedMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { ObservedSessionDataStore } from '../../observed-session/store.js';
import type { HostCtx } from '../host-context.js';
import {
  authOf,
  definedOnly,
  gapsIn,
  givenBy,
  isPlainRecord,
  unionOf,
  unionPaths,
  verdictOf,
  type Evaluation,
  type Given,
  type LocalVerdict,
} from './observe-local-evaluation.js';
import {
  decidingTraceEntries,
  evaluatedExpressionsOf,
  FIRESTORE_GAPS,
  parsedRulesOf,
  RESOURCE_READ,
  WRITE_READ,
  type ParsedRulesEntry,
} from './observe-local-firestore-trace.js';
import {
  prepareCallMapForRules,
  projectCollectionGroupRules,
  rehydrateSessionDocForRules,
  resolveTargetDoc,
  type ResolvedTargetDoc,
} from './observe-local-firestore-values.js';

const LOCAL_TRACE_VERSION = 'local-rules';
const SYNTHETIC_LIST_DOC_SEGMENTS: ReadonlySet<string> = new Set([
  '__hypothetical_doc__',
  '__listPlaceholder__',
]);

const collectionGroupSimulator = new SimulateFirestoreRulesHandler();

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
    testCase.data = prepareCallMapForRules(call.writeData);
  }
  if (hasStoredResource && targetDoc.data !== undefined) {
    testCase.resource = targetDoc.data;
  }
  if (isKnownFirestoreUpdate(method, call, targetDoc)) {
    testCase.writeMode = { kind: 'update' };
  }
  return testCase;
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
  parsed: ParsedRulesEntry | null,
): Evaluation | undefined {
  const isCollectionGroup = method === 'list' && call.query?.scope === 'collection-group';
  let effectivePath = path;
  let effectiveSimulate = simulate;

  if (isCollectionGroup && parsed !== null) {
    if (parsed.ast === null) return undefined;
    if (path.includes('/')) {
      return { allowed: false, rule: undefined, needs: [], missingPaths: [] };
    }
    const projectedAst = projectCollectionGroupRules(parsed.ast, path);
    if (projectedAst === null) {
      return { allowed: false, rule: undefined, needs: [], missingPaths: [] };
    }
    effectivePath = `${path}/__listPlaceholder__`;
    effectiveSimulate = (cases, lookups) =>
      collectionGroupSimulator.simulateParsed(projectedAst, parsed.source, cases, {
        ...lookups,
        sourceMap: parsed.sourceMap,
        skipQueryProof: true,
      });
  }

  const targetDoc = resolveTargetDoc(call, effectivePath, method, observedSession);
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
    if (
      method === 'list' &&
      normalized.split('/').some((seg) => SYNTHETIC_LIST_DOC_SEGMENTS.has(seg))
    ) {
      return null;
    }
    if (observedSession === undefined) {
      recordMissing(normalized, lookup);
      return null;
    }
    const resolved = observedSession.getFirestoreDoc(normalized);
    if (resolved.status === 'complete') return rehydrateSessionDocForRules(resolved.data);
    if (resolved.status === 'absent') return null;
    if (resolved.status === 'partial' && lookup?.kind === 'exists') {
      return EXISTS_ONLY_DOC;
    }
    recordMissing(normalized, lookup);
    return null;
  };

  const simulated = effectiveSimulate(
    [buildFirestoreTestCase(call, effectivePath, method, targetDoc)],
    { getDoc },
  );
  if (!simulated.success) return undefined;
  const result = simulated.data.results[0];
  if (result === undefined || result.decision === 'UNSUPPORTED') return undefined;

  const listUnprovable =
    method === 'list' && !isCollectionGroup && result.queryProof?.provable === false;
  const allowed = !listUnprovable && result.decision === 'ALLOW';
  const entries = decidingTraceEntries(result, allowed);
  const expressions = evaluatedExpressionsOf(entries, parsed);

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
  const hasUncapturedListFilters =
    call.query === undefined || (call.query.filters?.length ?? 0) > 0;
  if (listUnprovable && result.queryProof?.kind !== 'no-rule' && hasUncapturedListFilters) {
    needs = unionOf(['query'], needs);
  }
  const deciding = projectEvaluatedRule(result) ?? result.queryProof?.rule;
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
  parsed: ParsedRulesEntry | null,
): Evaluation | undefined {
  const given = givenBy(call, 'set');
  const targetDoc = resolveTargetDoc(call, path, 'set', observedSession);
  if (targetDoc.status === 'absent') {
    return evaluateFirestore(simulate, call, path, 'create', given, observedSession, parsed);
  }
  if (targetDoc.status === 'complete' || targetDoc.status === 'partial') {
    return evaluateFirestore(simulate, call, path, 'update', given, observedSession, parsed);
  }
  const create = evaluateFirestore(simulate, call, path, 'create', given, observedSession, parsed);
  const update = evaluateFirestore(simulate, call, path, 'update', given, observedSession, parsed);
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
  rulesSource?: string,
): Evaluation | undefined {
  const path = call.path;
  if (path === undefined) return undefined;
  const parsed = parsedRulesOf(rulesSource);
  if (method === 'set') return evaluateSetDoc(simulate, call, path, observedSession, parsed);
  return evaluateFirestore(
    simulate,
    call,
    path,
    method,
    givenBy(call, method),
    observedSession,
    parsed,
  );
}

export function firestoreVerdict(
  ctx: HostCtx,
  call: ObservedCall,
  method: ObservedMethod,
): LocalVerdict | undefined {
  const env = getInternalEnv(ctx.sandbox);
  const rulesSource = env.getRules();
  if (!hasAppFirestoreRules(ctx, rulesSource)) return undefined;
  const evaluation = evaluateFirestoreCall(
    (cases, lookups) => env.simulateDeployedRules(cases, lookups),
    call,
    method,
    ctx.observedSession,
    rulesSource,
  );
  if (evaluation === undefined) return undefined;
  return verdictOf(call, evaluation);
}
