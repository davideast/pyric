import {
  rulesDispositionFor,
  type RequestEvent,
  type SandboxEvent,
} from 'pyric/sandbox';
import type {
  FirestoreMethod,
  FunctionMock,
  TestCase,
} from 'pyric/rules/internal';
import {
  parseVerifyFixture,
  type PyricVerifyFixture,
} from './fixture.js';
import {
  rulesSourceUsesLookups,
  textContainsDocumentLookupCall,
} from './rules-lookup-analysis.js';
import {
  buildCommittedGroupFinalStates,
  buildUncommittedGroupProjections,
  clonePlainMap,
  extractMergeFields,
  needsDeniedCandidateProjection,
  projectDeniedWriteCandidate,
  rebuildUpdateMaskPayload,
  unwrapEscapedCaseValue,
} from './write-projection.js';

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
  includeListenerReads?: boolean;
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
  readonly cases?: TestCase[];
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
  const includeListenerReads = opts.includeListenerReads ?? true;
  const mockReads = opts.mockReads ?? 'strict';
  const derived: DerivedRulesTestCase[] = [];
  const warnings: VerifyFixtureWarning[] = [];
  const unsupportedEvents: VerifyUnsupportedEvent[] = [];
  const committedGroupFinalStates = buildCommittedGroupFinalStates(fixture.events);
  const committedGroupIds = new Set(committedGroupFinalStates.keys());
  const uncommittedGroupProjections = buildUncommittedGroupProjections(
    fixture.events,
    committedGroupIds,
    classifyRulesRequestEvent,
  );
  const fixtureRulesUsesLookups = rulesSourceUsesLookups(
    fixture.services.firestore?.rules?.source,
  );

  for (const event of fixture.events) {
    if (!isFirestoreRequestEvent(event)) continue;
    if (event.origin === 'listener') {
      const isInitialListenerRead =
        includeListenerReads &&
        (event.method === 'get' || event.method === 'list') &&
        (event as { triggeredBy?: unknown }).triggeredBy === undefined;
      if (!isInitialListenerRead) continue;
    }
    if (isNonRulesFirestoreRequestEvent(event)) continue;
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

    const functionMocks = extractFunctionMocks(event, fixtureRulesUsesLookups);
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
    if (mockReads === 'omit' && eventMayNeedFunctionMocks(event, fixtureRulesUsesLookups)) {
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
      testCase: buildTestCase(
        event,
        method,
        functionMocks ?? [],
        committedGroupFinalStates,
        uncommittedGroupProjections,
      ),
    });
  }

  const result: DeriveRulesTestCasesResult = {
    ok: unsupportedEvents.length === 0,
    service: 'firestore',
    testCases: derived.map((item) => item.testCase),
    derived,
    warnings,
    unsupportedEvents,
  };
  Object.defineProperty(result, 'cases', {
    get: () => result.testCases,
    configurable: true,
  });
  return result;
}

function classifyRulesRequestEvent(
  event: SandboxEvent,
): { request: RequestEvent; method: FirestoreMethod } | null {
  if (!isFirestoreRequestEvent(event)) return null;
  if (isNonRulesFirestoreRequestEvent(event)) return null;
  const method = lowerFirestoreMethod(event);
  if (!method) return null;
  return { request: event, method };
}

function isFirestoreRequestEvent(event: unknown): event is RequestEvent {
  if (!isCapturedRecord(event) || event.kind !== 'request') return false;
  const service = event.service;
  return service === undefined || service === 'firestore';
}

function lowerFirestoreMethod(event: RequestEvent): FirestoreMethod | null {
  if (
    event.method === 'get' ||
    event.method === 'list' ||
    event.method === 'create' ||
    event.method === 'update' ||
    event.method === 'delete'
  ) {
    return event.method;
  }
  if (event.method === 'set') {
    return event.resourceBefore?.exists ? 'update' : 'create';
  }
  return null;
}

function isNonRulesFirestoreRequestEvent(event: RequestEvent): boolean {
  const disposition = rulesDispositionFor(event);
  if (disposition.kind === 'bypassed') return true;
  if (disposition.kind === 'not-evaluated' && disposition.reason !== 'unsupported') {
    return true;
  }
  return false;
}

function buildTestCase(
  event: RequestEvent,
  method: FirestoreMethod,
  functionMocks: FunctionMock[],
  committedGroupFinalStates: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown> | null>>,
  uncommittedGroupProjections: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown> | null>>,
): TestCase {
  const testCase: TestCase = {
    description: `${event.result === 'allow' ? 'allow' : 'deny'} ${method} ${event.path}`,
    expectation: event.result === 'allow' ? 'ALLOW' : 'DENY',
    method,
    path: event.path,
    auth: event.auth,
    requestTime: new Date(event.at).toISOString(),
  };

  // A create's rules see no existing resource, as the simulator and the
  // bridge bind it, even when the recorded create hit an existing document.
  // The Rules Test API would bind one, so a case carrying it is refused.
  const rawExisting = event.resourceBefore?.exists ? event.resourceBefore.data : null;
  let existing: Record<string, unknown> | null = null;
  if (rawExisting !== null) {
    existing = unwrapEscapedCaseValue(
      rawExisting,
      event.resourceBefore?.unescapedPaths,
    ) as Record<string, unknown>;
  }
  if (existing !== null && method !== 'create') {
    testCase.resource = existing;
  }

  if (isWriteMethod(method)) {
    const eventGroupId = (event as { groupId?: unknown }).groupId;
    const isRolledBackGroupRequest =
      typeof eventGroupId === 'string' && !committedGroupFinalStates.has(eventGroupId);
    let groupProjection: ReadonlyMap<string, Record<string, unknown> | null> | undefined;
    if (isRolledBackGroupRequest && typeof eventGroupId === 'string') {
      groupProjection = uncommittedGroupProjections.get(eventGroupId);
    }

    if (isRolledBackGroupRequest && groupProjection?.has(event.path)) {
      const projectedFinal = groupProjection.get(event.path) ?? null;
      if (method === 'delete') {
        if (projectedFinal !== null) {
          testCase.data = clonePlainMap(projectedFinal);
        }
        testCase.writeMode = writeModeForEvent(event, method);
      } else if (projectedFinal !== null) {
        testCase.data = clonePlainMap(projectedFinal);
        testCase.writeMode =
          method === 'create' ? { kind: 'create' } : { kind: 'set', merge: false };
      } else {
        testCase.writeMode = writeModeForEvent(event, method);
      }
    } else if (method !== 'delete') {
      const hasResolvedAfter =
        event.result === 'allow' &&
        !isRolledBackGroupRequest &&
        isCapturedRecord(event.resourceAfter?.data);
      if (hasResolvedAfter) {
        testCase.data = unwrapEscapedCaseValue(
          event.resourceAfter!.data!,
          event.resourceAfter!.unescapedPaths,
        ) as Record<string, unknown>;
        if (method !== 'update') {
          testCase.writeMode = writeModeForEvent(event, method);
        }
      } else {
        let sourceRawData: unknown = event.resourceAfter?.data;
        let sourceUnescapedPaths = event.resourceAfter?.unescapedPaths;
        if (event.request?.resourceData !== undefined) {
          sourceRawData = event.request.resourceData;
          sourceUnescapedPaths = event.request.unescapedPaths;
        }
        let rawData: unknown = sourceRawData;
        if (isCapturedRecord(sourceRawData)) {
          rawData = unwrapEscapedCaseValue(sourceRawData, sourceUnescapedPaths);
        }
        const reqObj = event.request as { updateMask?: unknown; merge?: unknown } | undefined;
        const updateMask = reqObj?.updateMask;
        const reqMerge = reqObj?.merge;
        const mergeFields = extractMergeFields(reqMerge);
        if (isCapturedRecord(rawData)) {
          if (
            isRolledBackGroupRequest ||
            needsDeniedCandidateProjection(rawData, existing, updateMask, mergeFields)
          ) {
            const prior = method === 'create' ? null : existing;
            testCase.data = projectDeniedWriteCandidate(
              rawData,
              prior,
              method,
              event.method,
              reqMerge,
              mergeFields,
              updateMask,
            );
            testCase.writeMode =
              method === 'create' ? { kind: 'create' } : { kind: 'set', merge: false };
          } else {
            testCase.data = Array.isArray(updateMask)
              ? rebuildUpdateMaskPayload(rawData, updateMask)
              : rawData;
            testCase.writeMode = writeModeForEvent(event, method);
          }
        } else {
          testCase.writeMode = writeModeForEvent(event, method);
        }
      }
    } else {
      let committedFinal: Record<string, unknown> | null = null;
      if (typeof eventGroupId === 'string') {
        committedFinal = committedGroupFinalStates.get(eventGroupId)?.get(event.path) ?? null;
      }
      if (committedFinal !== null) {
        testCase.data = clonePlainMap(committedFinal);
      } else if (event.result === 'allow' && isCapturedRecord(event.resourceAfter?.data)) {
        testCase.data = unwrapEscapedCaseValue(
          event.resourceAfter!.data!,
          event.resourceAfter!.unescapedPaths,
        ) as Record<string, unknown>;
      }
      testCase.writeMode = writeModeForEvent(event, method);
    }
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

function writeModeForEvent(
  event: RequestEvent,
  method: FirestoreMethod,
): TestCase['writeMode'] | undefined {
  if (method === 'create') return { kind: 'create' };
  if (method === 'delete') return { kind: 'delete' };
  if (method === 'update') {
    const reqObj = event.request as { updateMask?: unknown; merge?: unknown } | undefined;
    if (event.method === 'set' || reqObj?.merge === false) {
      return { kind: 'set', merge: false };
    }
    if (!Array.isArray(reqObj?.updateMask)) return { kind: 'set', merge: true };
    return { kind: 'update' };
  }
  return undefined;
}

function isWriteMethod(method: FirestoreMethod): boolean {
  return method === 'create' || method === 'update' || method === 'delete';
}

function extractFunctionMocks(
  event: RequestEvent,
  fixtureRulesUsesLookups: boolean,
): FunctionMock[] | null {
  const detail = event.detail as { functionMocks?: unknown } | undefined;
  if (Array.isArray(detail?.functionMocks)) {
    return detail.functionMocks.filter(isFunctionMock);
  }
  return eventMayNeedFunctionMocks(event, fixtureRulesUsesLookups) ? null : [];
}

function isFunctionMock(value: unknown): value is FunctionMock {
  if (!isCapturedRecord(value)) return false;
  if (value.function !== 'get' && value.function !== 'exists') return false;
  return typeof value.path === 'string' && 'result' in value;
}

function isListQueryOrderBy(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (!isCapturedRecord(value)) return false;
  for (const direction of Object.values(value)) {
    if (direction !== 'ASC' && direction !== 'DESC') return false;
  }
  return true;
}

function isListQuery(value: unknown): value is NonNullable<TestCase['query']> {
  if (!isCapturedRecord(value)) return false;
  if ('where' in value && value.where !== undefined) {
    if (!Array.isArray(value.where)) return false;
    for (const clause of value.where) {
      if (!isCapturedRecord(clause)) return false;
      if (typeof clause.field !== 'string' || typeof clause.op !== 'string' || !('value' in clause)) {
        return false;
      }
    }
  }
  if ('limit' in value && value.limit !== undefined && typeof value.limit !== 'number') return false;
  if ('offset' in value && value.offset !== undefined && typeof value.offset !== 'number') return false;
  if ('orderBy' in value && value.orderBy !== undefined && !isListQueryOrderBy(value.orderBy)) return false;
  return true;
}

function traceEntryExpressionText(entry: { source?: unknown; expression?: unknown }): string {
  if (typeof entry.source === 'string') return entry.source;
  if (typeof entry.expression === 'string') return entry.expression;
  return '';
}

function eventMayNeedFunctionMocks(
  event: RequestEvent,
  fixtureRulesUsesLookups: boolean,
): boolean {
  if (event.reasons.some((reason) => textContainsDocumentLookupCall(reason))) {
    return true;
  }
  if (
    typeof event.evaluatedRule?.expression === 'string' &&
    textContainsDocumentLookupCall(event.evaluatedRule.expression)
  ) {
    return true;
  }
  if (
    event.evaluatedRule?.expressionTrace?.some((entry) => {
      const exprText = traceEntryExpressionText(entry as { source?: unknown; expression?: unknown });
      return exprText.length > 0 && textContainsDocumentLookupCall(exprText);
    })
  ) {
    return true;
  }
  if (
    event.rulesEvidence?.rules?.some(
      (rule) =>
        textContainsDocumentLookupCall(rule.expression) ||
        rule.checks.some((check) => textContainsDocumentLookupCall(check.expression)),
    )
  ) {
    return true;
  }
  const rulesObj = (event as { rules?: { expression?: unknown; reason?: unknown } }).rules;
  if (
    (typeof rulesObj?.expression === 'string' && textContainsDocumentLookupCall(rulesObj.expression)) ||
    (typeof rulesObj?.reason === 'string' && textContainsDocumentLookupCall(rulesObj.reason))
  ) {
    return true;
  }
  return fixtureRulesUsesLookups;
}

function isCapturedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
