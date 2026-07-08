import type { RequestEvent } from 'pyric/sandbox';
import type { FirestoreMethod, FunctionMock, TestCase } from 'pyric/rules';
import {
  parseVerifyFixture,
  type PyricVerifyFixture,
} from './fixture.js';

export type VerifyFixtureWarning = {
  service: 'firestore';
  eventId?: string;
  path?: string;
  method?: string;
  code: string;
  message: string;
};

export type VerifyUnsupportedEvent = {
  service: 'firestore';
  eventId?: string;
  path?: string;
  method?: string;
  reason: string;
};

export interface DeriveRulesTestCasesOptions {
  service?: 'firestore';
  includeAllowed?: boolean;
  includeDenied?: boolean;
  mockReads?: 'strict' | 'omit';
}

export interface DerivedRulesTestCase {
  eventId: string;
  testCase: TestCase;
}

export interface DeriveRulesTestCasesResult {
  ok: boolean;
  service: 'firestore';
  testCases: TestCase[];
  derived: DerivedRulesTestCase[];
  warnings: VerifyFixtureWarning[];
  unsupportedEvents: VerifyUnsupportedEvent[];
}

export function deriveRulesTestCases(
  fixtureInput: PyricVerifyFixture | unknown,
  opts: DeriveRulesTestCasesOptions = {},
): DeriveRulesTestCasesResult {
  const fixture = parseVerifyFixture(fixtureInput);
  const includeAllowed = opts.includeAllowed ?? true;
  const includeDenied = opts.includeDenied ?? true;
  const mockReads = opts.mockReads ?? 'strict';
  const derived: DerivedRulesTestCase[] = [];
  const warnings: VerifyFixtureWarning[] = [];
  const unsupportedEvents: VerifyUnsupportedEvent[] = [];

  for (const event of fixture.events) {
    if (!isFirestoreRequestEvent(event)) continue;
    if (event.origin === 'listener') continue;
    if (event.detail?.admin === true) continue;
    if (event.result === 'allow' && !includeAllowed) continue;
    if (event.result === 'deny' && !includeDenied) continue;

    if (event.result === 'unsupported') {
      unsupportedEvents.push({
        service: 'firestore',
        eventId: event.id,
        path: event.path,
        method: event.method,
        reason: event.reasons.join('\n') || 'captured Firestore request was unsupported locally.',
      });
      continue;
    }

    const method = lowerFirestoreMethod(event);
    if (!method) {
      unsupportedEvents.push({
        service: 'firestore',
        eventId: event.id,
        path: event.path,
        method: event.method,
        reason: `cannot derive a Rules Test API case for Firestore method '${event.method}'.`,
      });
      continue;
    }

    const functionMocks = extractFunctionMocks(event);
    if (mockReads === 'strict' && functionMocks === null) {
      unsupportedEvents.push({
        service: 'firestore',
        eventId: event.id,
        path: event.path,
        method: event.method,
        reason:
          'captured request appears to depend on get()/exists(), but the fixture does not contain exact rule-read mocks.',
      });
      continue;
    }
    if (mockReads === 'omit' && eventMayNeedFunctionMocks(event)) {
      warnings.push({
        service: 'firestore',
        eventId: event.id,
        path: event.path,
        method: event.method,
        code: 'READ_MOCKS_OMITTED',
        message:
          'captured request may depend on get()/exists(); deriving the case without functionMocks may change hosted Rules Test API behavior.',
      });
    }

    derived.push({
      eventId: event.id,
      testCase: buildTestCase(event, method, functionMocks ?? []),
    });
  }

  return {
    ok: unsupportedEvents.length === 0,
    service: 'firestore',
    testCases: derived.map((item) => item.testCase),
    derived,
    warnings,
    unsupportedEvents,
  };
}

function isFirestoreRequestEvent(event: unknown): event is RequestEvent {
  if (!isCapturedRequestEvent(event) || event.kind !== 'request') return false;
  const service = event.service;
  return service === undefined || service === 'firestore';
}

function lowerFirestoreMethod(event: RequestEvent): FirestoreMethod | null {
  if (event.method === 'get' || event.method === 'list' || event.method === 'create' || event.method === 'update' || event.method === 'delete') {
    return event.method;
  }
  if (event.method === 'set') {
    return event.resourceBefore?.exists ? 'update' : 'create';
  }
  return null;
}

function buildTestCase(
  event: RequestEvent,
  method: FirestoreMethod,
  functionMocks: FunctionMock[],
): TestCase {
  const testCase: TestCase = {
    description: `${event.result === 'allow' ? 'allow' : 'deny'} ${method} ${event.path}`,
    expectation: event.result === 'allow' ? 'ALLOW' : 'DENY',
    method,
    path: event.path,
    auth: event.auth,
    requestTime: new Date(event.at).toISOString(),
  };

  if (event.resourceBefore?.exists && event.resourceBefore.data !== null) {
    testCase.resource = event.resourceBefore.data;
  }

  if (isWriteMethod(method)) {
    if (method !== 'delete') {
      const data = event.resourceAfter?.data ?? event.request?.resourceData;
      if (isFirestoreWriteData(data)) testCase.data = data;
    }
    testCase.writeMode = writeModeFor(method);
  }

  if (functionMocks.length > 0) {
    testCase.functionMocks = functionMocks;
  }

  const query = (event.detail as { query?: unknown } | undefined)?.query;
  if (isListQuery(query)) {
    testCase.query = query;
  }

  return testCase;
}

function writeModeFor(method: FirestoreMethod): TestCase['writeMode'] | undefined {
  if (method === 'create') return { kind: 'create' };
  if (method === 'update') return { kind: 'update' };
  if (method === 'delete') return { kind: 'delete' };
  return undefined;
}

function isWriteMethod(method: FirestoreMethod): boolean {
  return method === 'create' || method === 'update' || method === 'delete';
}

function extractFunctionMocks(event: RequestEvent): FunctionMock[] | null {
  const detail = event.detail as { functionMocks?: unknown } | undefined;
  if (Array.isArray(detail?.functionMocks)) {
    return detail.functionMocks.filter(isFunctionMock);
  }
  return eventMayNeedFunctionMocks(event) ? null : [];
}

function isFunctionMock(value: unknown): value is FunctionMock {
  if (!isFunctionMockCandidate(value)) return false;
  if (value.function !== 'get' && value.function !== 'exists') return false;
  return typeof value.path === 'string' && 'result' in value;
}

function isListQuery(value: unknown): value is NonNullable<TestCase['query']> {
  if (!isListQueryCandidate(value)) return false;
  if ('limit' in value && value.limit !== undefined && typeof value.limit !== 'number') return false;
  if ('offset' in value && value.offset !== undefined && typeof value.offset !== 'number') return false;
  if ('orderBy' in value && value.orderBy !== undefined && typeof value.orderBy !== 'string') return false;
  return true;
}

function eventMayNeedFunctionMocks(event: RequestEvent): boolean {
  return event.reasons.some((reason) => /\b(get|exists)\s*\(/.test(reason));
}

function isCapturedRequestEvent(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFirestoreWriteData(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFunctionMockCandidate(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isListQueryCandidate(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
