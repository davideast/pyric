import { normalizeAuthState } from '../auth/auth-state.js';
import type { FunctionDef } from '../grammar/FirestoreAST.js';
import type { TestCase } from '../test/spec.js';
import { normalizeDocumentPath } from './document-lookups.js';
import type { SimulationContext } from './evaluator.js';
import type { ExpressionBudget } from './expression-budget.js';
import { requestQuery, reviveFirestoreNumbers } from './firestore-values.js';
import type { LookupBudget } from './lookup-budget.js';
import type { FunctionScopeBindings } from './match-resolution.js';
import { projectAfterState } from './project-after-state.js';
import { documentRelativePath } from './request-path.js';
import { typeClaimNumbers } from './rules-int.js';
import { Path } from './wrappers/path.js';
import { Timestamp } from './wrappers/timestamp.js';

/** Reads a case's values into the simulator's value model. */
export type CaseReviver = (value: unknown) => unknown;

function isPlainCaseObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function resolveCaseServerTimestamps(
  value: unknown,
  serverTime: Timestamp,
  wrapUnescapedAsEnvelope: boolean,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveCaseServerTimestamps(item, serverTime, wrapUnescapedAsEnvelope));
  }
  if (value === null || typeof value !== 'object') return value;
  const unescapedTag = Symbol.for('pyric.unescapedMap');
  const isUnescaped = (value as Record<symbol, unknown>)[unescapedTag] === true;
  const rec = value as Record<string, unknown>;
  if (
    !isUnescaped &&
    (rec.__type === 'serverTimestamp' ||
      rec._methodName === 'serverTimestamp' ||
      rec._methodName === 'FieldValue.serverTimestamp')
  ) {
    return serverTime;
  }
  if (!isPlainCaseObject(value)) return value;
  if (
    !isUnescaped &&
    wrapUnescapedAsEnvelope &&
    Object.keys(rec).length === 2 &&
    Object.hasOwn(rec, 'type') &&
    rec.type === 'pyric/map/1.0' &&
    isPlainCaseObject(rec.fields)
  ) {
    const fieldsOut: Record<string, unknown> = {};
    for (const [fk, fv] of Object.entries(rec.fields)) {
      Object.defineProperty(fieldsOut, fk, {
        value: resolveCaseServerTimestamps(fv, serverTime, wrapUnescapedAsEnvelope),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { type: 'pyric/map/1.0', fields: fieldsOut };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    Object.defineProperty(out, k, {
      value: resolveCaseServerTimestamps(v, serverTime, wrapUnescapedAsEnvelope),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (isUnescaped) {
    if (wrapUnescapedAsEnvelope) return { type: 'pyric/map/1.0', fields: out };
    Object.defineProperty(out, unescapedTag, { value: true });
  }
  return out;
}

function bindPathVariables(
  pathVariables: Record<string, string>,
  recursiveVariables?: readonly string[],
): Record<string, string | Path> {
  const recSet = new Set(recursiveVariables ?? []);
  const boundPathVariables: Record<string, string | Path> = Object.create(null);
  for (const [k, v] of Object.entries(pathVariables)) {
    if (recSet.has(k)) {
      boundPathVariables[k] = Path.fromString(v);
    } else {
      boundPathVariables[k] = v;
    }
  }
  return boundPathVariables;
}

export function buildContext(
  tc: TestCase,
  functions: FunctionDef[],
  pathVariables: Record<string, string>,
  getDoc?: SimulationContext['getDoc'],
  batchProjection?: Map<string, Record<string, unknown> | null>,
  lookupBudget?: LookupBudget,
  expressionBudget?: ExpressionBudget,
  revive: CaseReviver = reviveFirestoreNumbers,
  recursiveVariables?: readonly string[],
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
  rootBindings?: Readonly<Record<string, string>>,
): SimulationContext {
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of functions) fnMap.set(fn.name, fn);

  // `get` and `exists` are separate Rules Test API functions with separate
  // mocks (FS-CON-6): a get mock seeds get()'s document, an exists mock only
  // answers exists(). Both key on the normalized document path, the form
  // lookups resolve and `buildFunctionMock` sends to production, so mock
  // order and path spelling do not change the verdict.
  const mockDocs = new Map<string, Record<string, unknown>>();
  const identitylessFunctionMocks = new Set<string>();
  const existsMocks = new Map<string, boolean>();
  for (const mock of tc.functionMocks ?? []) {
    const mockPath = normalizeDocumentPath(mock.path);
    if (mock.function === 'get' && typeof mock.result === 'object' && mock.result !== null) {
      mockDocs.set(mockPath, revive(mock.result) as Record<string, unknown>);
      identitylessFunctionMocks.add(mockPath);
    } else if (mock.function === 'exists') {
      existsMocks.set(mockPath, mock.result === true);
    }
  }

  // request.time defaults to wallclock; tc.requestTime lets tests pin a
  // deterministic value for date-gated rules. Intake has already refused one
  // that is not an ISO-8601 instant with an offset.
  let serverTime: Timestamp;
  if (tc.requestTime) {
    serverTime = Timestamp.fromIsoString(tc.requestTime);
  } else {
    serverTime = Timestamp.fromMillis(Date.now());
  }

  // Build the full document path for request.path / __name__.
  // tc.path arrives as a relative path like "users/alice" or as the full
  // resource name; both name one document, so both give the single spec
  // form /databases/(default)/documents/<rel> (FS2-CON-1).
  const relPath = documentRelativePath(tc.path);
  const fullPathSegs = ['databases', '(default)', 'documents', ...relPath.split('/').filter(Boolean)];
  // Pass pathVariables as bindings so `request.path.<name>` (where <name> is
  // a wildcard from the matched rule, e.g. {uid}) returns the bound segment
  // value instead of null.
  const fullPath = new Path(fullPathSegs, pathVariables);

  const payload = revive(tc.data ?? {}) as Record<string, unknown>;
  let existing: Record<string, unknown> | null = null;
  if (tc.resource !== undefined && tc.resource !== null) {
    existing = revive(tc.resource) as Record<string, unknown>;
  }
  let afterState: Record<string, unknown> | null;
  let existsAfter: boolean;
  if (batchProjection?.has(relPath)) {
    const projectedTarget = batchProjection.get(relPath) ?? null;
    if (projectedTarget !== null) {
      afterState = revive(projectedTarget) as Record<string, unknown>;
    } else {
      afterState = null;
    }
    existsAfter = afterState !== null;
  } else if (tc.writeMode) {
    afterState = projectAfterState(tc.writeMode, existing, payload);
    existsAfter = afterState !== null;
  } else {
    switch (tc.method) {
      case 'create':
      case 'update':
        afterState = payload;
        existsAfter = true;
        break;
      case 'delete':
        afterState = null;
        existsAfter = false;
        break;
      case 'get':
      case 'list':
      default:
        afterState = existing;
        existsAfter = existing !== null;
        break;
    }
  }
  const wrapUnescapedAsEnvelope = revive === reviveFirestoreNumbers;
  let projectedAfter: Record<string, unknown> | null = null;
  if (afterState !== null) {
    projectedAfter = revive(
      resolveCaseServerTimestamps(afterState, serverTime, wrapUnescapedAsEnvelope),
    ) as Record<string, unknown>;
  }

  // request.resource is populated on create/update (from projectedAfter ?? {})
  // and on get/list/delete only when the caller explicitly supplied `tc.data`
  // (matching the Rules Test API wire format `if (tc.data) request.resource = { data }`).
  // On normal get, list, and delete requests (no `tc.data`), `resource` is absent
  // from `request` ("Property resource is undefined on object.").
  let reqResource: { data: Record<string, unknown> } | undefined;
  if (tc.method === 'create' || tc.method === 'update') {
    reqResource = { data: projectedAfter ?? {} };
  } else if (tc.data !== undefined) {
    const revivedTcData = revive(
      resolveCaseServerTimestamps(tc.data, serverTime, wrapUnescapedAsEnvelope),
    ) as Record<string, unknown>;
    reqResource = { data: revivedTcData };
  }

  const normalizedAuth = tc.auth ? normalizeAuthState(tc.auth) : null;
  let simAuth: { uid: string; token: Record<string, unknown> } | null = null;
  if (normalizedAuth) {
    simAuth = {
      uid: normalizedAuth.uid,
      token: typeClaimNumbers(normalizedAuth.token ?? {}) as Record<string, unknown>,
    };
  }
  const reqQuery = requestQuery(tc);
  const request: SimulationContext['request'] = {
    auth: simAuth,
    method: tc.method,
    path: fullPath,
    ...(reqQuery ? { query: reqQuery } : {}),
    time: serverTime,
  } as SimulationContext['request'];
  if (reqResource !== undefined) {
    request.resource = reqResource;
  }

  const boundPathVariables = bindPathVariables(pathVariables, recursiveVariables);
  let functionPathVariables: Map<FunctionDef, Record<string, string | Path>> | undefined;
  if (functionScopes && functionScopes.size > 0) {
    functionPathVariables = new Map();
    for (const [fn, fnScope] of functionScopes) {
      let mergedVars = fnScope.pathVariables;
      if (rootBindings) {
        mergedVars = { ...rootBindings, ...fnScope.pathVariables };
      }
      functionPathVariables.set(fn, bindPathVariables(mergedVars, fnScope.recursiveVariables));
    }
  }

  // `resource` is the PRE-WRITE stored document (`{ data }` only, or `null`
  // when creating or when the document does not exist).
  let simResource: { data: Record<string, unknown> } | null = null;
  if (tc.method !== 'create' && existing !== null) {
    simResource = { data: revive(existing) as Record<string, unknown> };
  }

  const context: SimulationContext = {
    request,
    resource: simResource,
    mockDocuments: mockDocs,
    identitylessFunctionMocks,
    existsMocks,
    getDoc,
    pathVariables: boundPathVariables,
    functions: fnMap,
    database: '(default)',
    afterStatePath: fullPath,
    afterState: projectedAfter,
    existsAfter,
    ...(batchProjection ? { batchProjection } : {}),
    lookupBudget,
    expressionBudget,
  };
  if (functionPathVariables !== undefined) {
    context.functionPathVariables = functionPathVariables;
  }
  return context;
}
