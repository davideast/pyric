import type { TestCase } from '../test/spec.js';
import type { FunctionDef } from '../grammar/FirestoreAST.js';
import { Timestamp } from './wrappers/timestamp.js';
import { Path } from './wrappers/path.js';
import { LookupBudget } from './lookup-budget.js';
import { projectAfterState } from './project-after-state.js';
import { normalizeAuthTokenClaims } from '../../sandbox/sandbox-context.js';
import type { AuthState } from '../../sandbox/types/auth-state.js';
import {
  requestQuery,
  resolveServerTimestamps,
  reviveFirestoreNumbers,
} from './firestore-values.js';
import type { SimulationContext, SimRequest, SimAuth } from './evaluation-context.js';

export function buildSimulatedAuth(auth: TestCase['auth']): Record<string, unknown> | null {
  if (!auth) return null;
  return normalizeAuthTokenClaims(auth as AuthState);
}

export function buildContext(
  tc: TestCase,
  functions: FunctionDef[],
  pathVariables: Record<string, string>,
  getDoc?: (path: string) => Record<string, unknown> | null,
  batchProjection?: Map<string, Record<string, unknown> | null>,
  lookupBudget?: LookupBudget,
): SimulationContext {
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of functions) fnMap.set(fn.name, fn);

  const mockDocs = new Map<string, Record<string, unknown>>();
  const identitylessFunctionMocks = new Set<string>();
  if (tc.functionMocks) {
    for (const mock of tc.functionMocks) {
      if (mock.function === 'get' && typeof mock.result === 'object' && mock.result !== null) {
        mockDocs.set(mock.path, reviveFirestoreNumbers(mock.result) as Record<string, unknown>);
        identitylessFunctionMocks.add(mock.path);
      } else if (mock.function === 'exists') {
        if (mock.result === true) {
          mockDocs.set(mock.path, {});
          identitylessFunctionMocks.add(mock.path);
        }
      }
    }
  }

  // request.time defaults to wallclock; tc.requestTime lets tests pin
  // a deterministic value for date-gated rules.
  const serverTime = tc.requestTime
    ? Timestamp.fromIsoString(tc.requestTime)
    : Timestamp.fromMillis(Date.now());

  // build the full document path for request.path / __name__.
  const relPath = tc.path.startsWith('/') ? tc.path.slice(1) : tc.path;
  const fullPathSegs = ['databases', '(default)', 'documents', ...relPath.split('/').filter(Boolean)];
  const fullPath = new Path(fullPathSegs, pathVariables);

  // Project the after-state.
  const payload = reviveFirestoreNumbers(tc.data ?? {}) as Record<string, unknown>;
  const existing = tc.resource === undefined || tc.resource === null
    ? null
    : reviveFirestoreNumbers(tc.resource) as Record<string, unknown>;
  let afterState: Record<string, unknown> | null;
  let existsAfter: boolean;
  if (tc.writeMode) {
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
  const projectedAfter = afterState !== null
    ? reviveFirestoreNumbers(resolveServerTimestamps(afterState, serverTime)) as Record<string, unknown>
    : null;

  const reqResourceData = projectedAfter ?? {};

  const request: SimRequest = {
    auth: buildSimulatedAuth(tc.auth) as SimAuth | null,
    resource: { data: reqResourceData },
    method: tc.method,
    path: fullPath,
    time: serverTime,
  };
  const query = requestQuery(tc);
  if (query !== undefined) {
    request.query = query;
  }

  const context: SimulationContext = {
    request,
    resource: tc.method === 'create' || existing === null
      ? null
      : { data: reviveFirestoreNumbers(existing) as Record<string, unknown> },
    mockDocuments: mockDocs,
    identitylessFunctionMocks,
    getDoc,
    pathVariables,
    functions: fnMap,
    database: '(default)',
    afterStatePath: fullPath,
    afterState: projectedAfter,
    existsAfter,
    lookupBudget,
  };
  if (batchProjection !== undefined) {
    context.batchProjection = batchProjection;
  }

  return context;
}
