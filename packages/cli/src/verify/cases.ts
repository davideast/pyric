import type { RequestEvent } from 'pyric/sandbox';
import {
  parseToASTOrError,
  resolveModulesBrowser,
  reviveFirestoreNumbers,
  RulesValue,
  type Expression,
  type FirestoreMethod,
  type FirestoreRules,
  type FunctionDef,
  type FunctionMock,
  type MatchBlock,
  type TestCase,
} from 'pyric/rules/internal';
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
  const committedGroupIds = new Set<string>();
  for (const event of fixture.events) {
    if (event.kind === 'write' && typeof event.groupId === 'string') {
      committedGroupIds.add(event.groupId);
    }
  }
  const uncommittedGroupProjections = buildUncommittedGroupProjections(
    fixture.events,
    committedGroupIds,
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
        committedGroupIds,
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

function isNonRulesFirestoreRequestEvent(event: RequestEvent): boolean {
  if (event.detail?.admin === true) return true;
  if (event.rulesDisposition?.kind === 'bypassed') return true;
  if (
    event.rulesDisposition?.kind === 'not-evaluated' &&
    event.rulesDisposition.reason !== 'unsupported'
  ) {
    return true;
  }
  if (
    event.result === 'deny' &&
    event.rulesEvidence === undefined &&
    event.evaluatedRule === undefined &&
    event.reasons.some(
      (reason) =>
        reason.startsWith('Write preparation error:') ||
        reason.startsWith('FieldValue resolve error:') ||
        reason.startsWith('Simulation error:'),
    )
  ) {
    return true;
  }
  return false;
}

function buildUncommittedGroupProjections(
  events: readonly PyricVerifyFixture['events'][number][],
  committedGroupIds: ReadonlySet<string>,
): Map<string, Map<string, Record<string, unknown> | null>> {
  const byGroup = new Map<string, Map<string, Record<string, unknown> | null>>();
  for (const event of events) {
    if (!isFirestoreRequestEvent(event)) continue;
    if (isNonRulesFirestoreRequestEvent(event)) continue;
    const groupId = (event as { groupId?: unknown }).groupId;
    if (typeof groupId !== 'string' || committedGroupIds.has(groupId)) continue;
    const method = lowerFirestoreMethod(event);
    if (!method || !isWriteMethod(method)) continue;

    let proj = byGroup.get(groupId);
    if (!proj) {
      proj = new Map();
      byGroup.set(groupId, proj);
    }

    const rawExisting = event.resourceBefore?.exists ? event.resourceBefore.data : null;
    const preBatchExisting =
      rawExisting !== null
        ? (unwrapEscapedCaseValue(rawExisting) as Record<string, unknown>)
        : null;
    const intraPrior = proj.has(event.path)
      ? (proj.get(event.path) ?? null)
      : (method === 'create' ? null : preBatchExisting);

    const sourceRawData = event.request?.resourceData;
    if (event.method === 'delete' && sourceRawData === undefined) {
      proj.set(event.path, null);
      continue;
    }

    const rawData = isFirestoreWriteData(sourceRawData)
      ? (unwrapEscapedCaseValue(sourceRawData) as Record<string, unknown>)
      : undefined;
    if (!rawData) {
      if (method === 'delete') proj.set(event.path, null);
      continue;
    }

    const reqObj = event.request as { updateMask?: unknown; merge?: unknown } | undefined;
    const updateMask = reqObj?.updateMask;
    const reqMerge = reqObj?.merge;
    const mergeFields = extractMergeFields(reqMerge);
    const effectiveMethod: FirestoreMethod =
      method === 'delete' ? (intraPrior !== null ? 'update' : 'create') : method;
    const projected = projectDeniedWriteCandidate(
      rawData,
      intraPrior,
      effectiveMethod,
      event.method,
      reqMerge,
      mergeFields,
      updateMask,
    );
    proj.set(event.path, projected);
  }
  return byGroup;
}

function buildTestCase(
  event: RequestEvent,
  method: FirestoreMethod,
  functionMocks: FunctionMock[],
  committedGroupIds: ReadonlySet<string>,
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
  const existing = rawExisting !== null ? (unwrapEscapedCaseValue(rawExisting) as Record<string, unknown>) : null;
  const bindsExisting = existing !== null && method !== 'create';
  if (bindsExisting) testCase.resource = existing;

  if (isWriteMethod(method)) {
    const eventGroupId = (event as { groupId?: unknown }).groupId;
    const isRolledBackGroupRequest =
      typeof eventGroupId === 'string' && !committedGroupIds.has(eventGroupId);
    const groupProjection =
      isRolledBackGroupRequest && typeof eventGroupId === 'string'
        ? uncommittedGroupProjections.get(eventGroupId)
        : undefined;

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
        isFirestoreWriteData(event.resourceAfter?.data);
      if (hasResolvedAfter) {
        testCase.data = unwrapEscapedCaseValue(event.resourceAfter!.data!) as Record<string, unknown>;
        if (method !== 'update') {
          testCase.writeMode = writeModeForEvent(event, method);
        }
      } else {
        const sourceRawData = event.request?.resourceData ?? event.resourceAfter?.data;
        const rawData = isFirestoreWriteData(sourceRawData)
          ? (unwrapEscapedCaseValue(sourceRawData) as Record<string, unknown>)
          : sourceRawData;
        const reqObj = event.request as { updateMask?: unknown; merge?: unknown } | undefined;
        const updateMask = reqObj?.updateMask;
        const reqMerge = reqObj?.merge;
        const mergeFields = extractMergeFields(reqMerge);
        if (isFirestoreWriteData(rawData)) {
          if (
            isRolledBackGroupRequest ||
            needsDeniedCandidateProjection(rawData, updateMask, mergeFields)
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
            testCase.writeMode = method === 'create' ? { kind: 'create' } : { kind: 'set', merge: false };
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

function defineOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function rebuildUpdateMaskPayload(
  tree: Record<string, unknown>,
  mask: readonly unknown[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawPath of mask) {
    if (!Array.isArray(rawPath) || !rawPath.every((seg): seg is string => typeof seg === 'string')) {
      continue;
    }
    let cursor: unknown = tree;
    for (const seg of rawPath) {
      cursor =
        typeof cursor === 'object' && cursor !== null && Object.hasOwn(cursor, seg)
          ? (cursor as Record<string, unknown>)[seg]
          : undefined;
    }
    defineOwnProperty(out, rawPath.join('.'), cursor);
  }
  return out;
}

function parseEncodedFieldSegments(field: string): string[] {
  if (!field.includes('`')) return field.split('.');
  const segments: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < field.length; i++) {
    const ch = field[i]!;
    if (quoted) {
      if (ch === '\\' && i + 1 < field.length) {
        current += field[++i]!;
      } else if (ch === '`') {
        quoted = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '`') {
      quoted = true;
    } else if (ch === '.') {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}
const DELETE_FIELD_SYM: unique symbol = Symbol('verify:deleteField');
const ABSENT_SYM: unique symbol = Symbol('verify:absent');

function extractMergeFields(merge: unknown): string[] | undefined {
  if (typeof merge !== 'object' || merge === null || Array.isArray(merge)) return undefined;
  const raw = (merge as { mergeFields?: unknown }).mergeFields;
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((item): item is string => typeof item === 'string');
}

function maskHasLiteralDotSegment(mask: readonly unknown[]): boolean {
  return mask.some(
    (entry) =>
      Array.isArray(entry) &&
      entry.some((seg) => typeof seg === 'string' && seg.includes('.')),
  );
}

const UNESCAPED_MAP_TAG = Symbol.for('pyric.unescapedMap');

function isUnescapedCaseMap(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[UNESCAPED_MAP_TAG] === true
  );
}

function copyUnescapedTag<T extends Record<string, unknown>>(source: unknown, target: T): T {
  if (isUnescapedCaseMap(source)) {
    Object.defineProperty(target, UNESCAPED_MAP_TAG, { value: true });
  }
  return target;
}

function isPlainObjectProto(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof RulesValue) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSerializedScalarMarker(value: Record<string, unknown>): boolean {
  if (typeof value.__type === 'string') {
    return (
      value.__type === 'reference' ||
      value.__type === 'timestamp' ||
      value.__type === 'bytes' ||
      value.__type === 'latlng' ||
      value.__type === 'duration' ||
      value.__type === 'path' ||
      value.__type === 'float'
    );
  }
  if (value.__type__ === '__vector__' && Array.isArray(value.value)) return true;
  if (typeof value.type === 'string') {
    return (
      value.type === 'pyric/number/1.0' ||
      value.type.startsWith('firestore/')
    );
  }
  return false;
}

function unwrapEscapedCaseValue(value: unknown, insideUnescaped = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => unwrapEscapedCaseValue(item, insideUnescaped));
  }
  if (!isPlainObjectProto(value)) return value;
  const alreadyUnescaped = isUnescapedCaseMap(value);
  if (
    !alreadyUnescaped &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, 'type') &&
    value.type === 'pyric/map/1.0' &&
    isPlainObjectProto(value.fields)
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.fields)) {
      defineOwnProperty(out, k, unwrapEscapedCaseValue(v, true));
    }
    Object.defineProperty(out, UNESCAPED_MAP_TAG, { value: true });
    return out;
  }
  if (!alreadyUnescaped && insideUnescaped && isSerializedScalarMarker(value)) {
    return reviveFirestoreNumbers(value);
  }
  const childInsideUnescaped = insideUnescaped || alreadyUnescaped;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    defineOwnProperty(out, k, unwrapEscapedCaseValue(v, childInsideUnescaped));
  }
  return copyUnescapedTag(value, out);
}

function isPlainFirestoreMap(value: unknown): value is Record<string, unknown> {
  if (!isPlainObjectProto(value)) return false;
  if (isUnescapedCaseMap(value)) return true;
  const obj = value as Record<string, unknown>;
  if (typeof obj.__type === 'string') return false;
  if (typeof obj._methodName === 'string') return false;
  if (obj.__type__ === '__vector__') return false;
  if (
    typeof obj.type === 'string' &&
    (obj.type.startsWith('firestore/') || obj.type.startsWith('pyric/'))
  ) {
    return false;
  }
  return true;
}

function containsNonPassthroughSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsNonPassthroughSentinel);
  const obj = value as Record<string, unknown>;
  if (
    !isUnescapedCaseMap(value) &&
    (obj.__type === 'deleteField' ||
      obj.__type === 'increment' ||
      obj.__type === 'arrayUnion' ||
      obj.__type === 'arrayRemove' ||
      typeof obj._methodName === 'string')
  ) {
    return true;
  }
  if (!isPlainFirestoreMap(value)) return false;
  return Object.values(obj).some(containsNonPassthroughSentinel);
}

function needsDeniedCandidateProjection(
  rawData: Record<string, unknown>,
  updateMask: unknown,
  mergeFields: string[] | undefined,
): boolean {
  if (mergeFields !== undefined) return true;
  if (Array.isArray(updateMask) && maskHasLiteralDotSegment(updateMask)) return true;
  return containsNonPassthroughSentinel(rawData);
}

function readBySegments(
  root: Record<string, unknown> | null,
  segments: readonly (string | number)[],
): unknown {
  if (root === null) return ABSENT_SYM;
  let cursor: unknown = root;
  for (const seg of segments) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cursor) || seg < 0 || seg >= cursor.length) return ABSENT_SYM;
      cursor = cursor[seg];
      continue;
    }
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return ABSENT_SYM;
    if (!Object.hasOwn(cursor, seg)) return ABSENT_SYM;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function numericValueOf(val: unknown): number | undefined {
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && val !== null && (val as { __type?: unknown }).__type === 'float') {
    const inner = (val as { value?: unknown }).value;
    if (typeof inner === 'number') return inner;
  }
  return undefined;
}

function deepFirestoreEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return (Number.isNaN(a) && Number.isNaN(b)) || a === b;
  }
  if (a === b) return true;
  if (a instanceof RulesValue && b instanceof RulesValue) return a.equals(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, idx) => deepFirestoreEqual(item, b[idx]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b) &&
    !(a instanceof RulesValue) &&
    !(b instanceof RulesValue)
  ) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;
    return keysA.every((k) => Object.hasOwn(recB, k) && deepFirestoreEqual(recA[k], recB[k]));
  }
  return false;
}

function resolveFieldTree(
  value: unknown,
  priorRoot: Record<string, unknown> | null,
  fieldSegments: readonly (string | number)[],
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .map((item, idx) => resolveFieldTree(item, priorRoot, [...fieldSegments, idx]))
      .filter((item) => item !== DELETE_FIELD_SYM);
  }
  const obj = value as Record<string, unknown>;
  const isUnescaped = isUnescapedCaseMap(value);
  if (!isUnescaped) {
    const methodName = typeof obj._methodName === 'string' ? obj._methodName : undefined;
    if (
      obj.__type === 'deleteField' ||
      methodName === 'deleteField' ||
      methodName === 'FieldValue.deleteField'
    ) {
      return DELETE_FIELD_SYM;
    }
    if (
      obj.__type === 'serverTimestamp' ||
      methodName === 'serverTimestamp' ||
      methodName === 'FieldValue.serverTimestamp'
    ) {
      return { __type: 'serverTimestamp' };
    }
    if (
      (obj.__type === 'increment' && typeof obj.value === 'number') ||
      ((methodName === 'increment' || methodName === 'FieldValue.increment') &&
        typeof obj._operand === 'number')
    ) {
      const delta = typeof obj.value === 'number' ? obj.value : (obj._operand as number);
      const priorVal = readBySegments(priorRoot, fieldSegments);
      const base = numericValueOf(priorVal) ?? 0;
      return base + delta;
    }
    if (
      (obj.__type === 'arrayUnion' && Array.isArray(obj.values)) ||
      ((methodName === 'arrayUnion' || methodName === 'FieldValue.arrayUnion') &&
        Array.isArray(obj._elements))
    ) {
      const rawItems = (Array.isArray(obj.values) ? obj.values : (obj._elements as unknown[])).map(
        (item) => resolveFieldTree(item, priorRoot, fieldSegments),
      );
      const priorVal = readBySegments(priorRoot, fieldSegments);
      const base = Array.isArray(priorVal) ? priorVal.slice() : [];
      for (const item of rawItems) {
        if (item === DELETE_FIELD_SYM) continue;
        if (!base.some((existing) => deepFirestoreEqual(existing, item))) {
          base.push(item);
        }
      }
      return base;
    }
    if (
      (obj.__type === 'arrayRemove' && Array.isArray(obj.values)) ||
      ((methodName === 'arrayRemove' || methodName === 'FieldValue.arrayRemove') &&
        Array.isArray(obj._elements))
    ) {
      const rawItems = (Array.isArray(obj.values) ? obj.values : (obj._elements as unknown[])).map(
        (item) => resolveFieldTree(item, priorRoot, fieldSegments),
      );
      const priorVal = readBySegments(priorRoot, fieldSegments);
      if (!Array.isArray(priorVal)) return [];
      return priorVal.filter(
        (existing) => !rawItems.some((item) => deepFirestoreEqual(existing, item)),
      );
    }
  }
  if (!isPlainFirestoreMap(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    defineOwnProperty(out, k, resolveFieldTree(v, priorRoot, [...fieldSegments, k]));
  }
  return copyUnescapedTag(value, out);
}

function stripDeleteSymbols(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== DELETE_FIELD_SYM).map(stripDeleteSymbols);
  }
  if (!isPlainFirestoreMap(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === DELETE_FIELD_SYM) continue;
    defineOwnProperty(out, k, stripDeleteSymbols(v));
  }
  return copyUnescapedTag(value, out);
}

function clonePlainMap(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    defineOwnProperty(
      out,
      k,
      isPlainFirestoreMap(v) ? clonePlainMap(v) : Array.isArray(v) ? v.slice() : v,
    );
  }
  return copyUnescapedTag(src, out);
}

function applyPathLeaf(
  root: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  if (segments.length === 0) return;
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const existing = Object.hasOwn(cursor, seg) ? cursor[seg] : undefined;
    if (!isPlainFirestoreMap(existing)) {
      const fresh: Record<string, unknown> = {};
      defineOwnProperty(cursor, seg, fresh);
      cursor = fresh;
    } else {
      cursor = existing;
    }
  }
  const leaf = segments[segments.length - 1]!;
  if (value === DELETE_FIELD_SYM) {
    if (Object.hasOwn(cursor, leaf)) delete cursor[leaf];
  } else {
    defineOwnProperty(cursor, leaf, stripDeleteSymbols(value));
  }
  if (
    segments.length > 1 &&
    (Object.hasOwn(cursor, '__type') ||
      Object.hasOwn(cursor, 'type') ||
      Object.hasOwn(cursor, '__type__') ||
      (Object.hasOwn(cursor, 'id') && Object.hasOwn(cursor, 'path')))
  ) {
    Object.defineProperty(cursor, UNESCAPED_MAP_TAG, { value: true });
  }
}

function collectMergeLeaves(
  data: Record<string, unknown>,
  prefix: readonly string[],
  out: Array<{ segments: readonly string[]; value: unknown }>,
): void {
  const keys = Object.keys(data);
  if (keys.length === 0 && prefix.length > 0) {
    out.push({ segments: prefix, value: {} });
    return;
  }
  for (const key of keys) {
    const value = data[key];
    const segments = [...prefix, key];
    if (isPlainFirestoreMap(value)) {
      collectMergeLeaves(value, segments, out);
    } else {
      out.push({ segments, value });
    }
  }
}

function projectDeniedWriteCandidate(
  rawData: Record<string, unknown>,
  prior: Record<string, unknown> | null,
  method: FirestoreMethod,
  rawEventMethod: RequestEvent['method'],
  reqMerge: unknown,
  mergeFields: string[] | undefined,
  updateMask: unknown,
): Record<string, unknown> {
  if (Array.isArray(updateMask)) {
    const out = clonePlainMap(prior ?? {});
    for (const rawPath of updateMask) {
      if (
        !Array.isArray(rawPath) ||
        rawPath.length === 0 ||
        !rawPath.every((seg): seg is string => typeof seg === 'string')
      ) {
        continue;
      }
      const rawLeaf = readBySegments(rawData, rawPath);
      if (rawLeaf === ABSENT_SYM) continue;
      const resolvedLeaf = resolveFieldTree(rawLeaf, prior, rawPath);
      applyPathLeaf(out, rawPath, resolvedLeaf);
    }
    return out;
  }

  if (mergeFields !== undefined) {
    const out = clonePlainMap(prior ?? {});
    for (const field of mergeFields) {
      const segments = parseEncodedFieldSegments(field);
      const rawLeaf = readBySegments(rawData, segments);
      if (rawLeaf === ABSENT_SYM) continue;
      const resolvedLeaf = resolveFieldTree(rawLeaf, prior, segments);
      applyPathLeaf(out, segments, resolvedLeaf);
    }
    return out;
  }

  const isMergeTrue =
    reqMerge === true ||
    (method === 'update' && rawEventMethod === 'update' && reqMerge === undefined);
  if (isMergeTrue) {
    const out = clonePlainMap(prior ?? {});
    const resolvedTree = resolveFieldTree(rawData, prior, []) as Record<string, unknown>;
    const leaves: Array<{ segments: readonly string[]; value: unknown }> = [];
    collectMergeLeaves(resolvedTree, [], leaves);
    for (const leaf of leaves) {
      applyPathLeaf(out, leaf.segments, leaf.value);
    }
    return out;
  }

  const resolved = resolveFieldTree(rawData, prior, []);
  return stripDeleteSymbols(resolved) as Record<string, unknown>;
}

function isWriteMethod(method: FirestoreMethod): boolean {
  return method === 'create' || method === 'update' || method === 'delete';
}

const DOCUMENT_LOOKUP_NAMES = new Set(['get', 'exists', 'getAfter', 'existsAfter']);

function isLookupIdentStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

function isLookupIdentPart(ch: string): boolean {
  return isLookupIdentStart(ch) || (ch.charCodeAt(0) >= 48 && ch.charCodeAt(0) <= 57);
}

function nextNonTriviaChar(source: string, start: number): string | undefined {
  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    return ch;
  }
  return undefined;
}

type LookupScanToken =
  | { kind: 'ident'; value: string }
  | { kind: 'dot' }
  | { kind: 'other' };

function textContainsDocumentLookupCall(source: string): boolean {
  let prev3: LookupScanToken | undefined;
  let prev2: LookupScanToken | undefined;
  let prev1: LookupScanToken | undefined;
  const pushToken = (tok: LookupScanToken): void => {
    prev3 = prev2;
    prev2 = prev1;
    prev1 = tok;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 2;
        else i++;
      }
      if (i < source.length) i++;
      pushToken({ kind: 'other' });
      continue;
    }
    if (isLookupIdentStart(ch)) {
      const start = i;
      i++;
      while (i < source.length && isLookupIdentPart(source[i]!)) i++;
      const word = source.slice(start, i);
      if (DOCUMENT_LOOKUP_NAMES.has(word) && nextNonTriviaChar(source, i) === '(') {
        const isFnDecl = prev1?.kind === 'ident' && prev1.value === 'function';
        if (!isFnDecl) {
          if (prev1?.kind !== 'dot') {
            return true;
          }
          const isTopLevelFirestoreReceiver =
            prev2?.kind === 'ident' &&
            prev2.value === 'firestore' &&
            prev3?.kind !== 'dot' &&
            !(prev3?.kind === 'ident' && prev3.value === 'function');
          if (isTopLevelFirestoreReceiver) {
            return true;
          }
        }
      }
      pushToken({ kind: 'ident', value: word });
      continue;
    }
    if (ch === '.') {
      pushToken({ kind: 'dot' });
      i++;
      continue;
    }
    pushToken({ kind: 'other' });
    i++;
  }
  return false;
}

function expressionUsesDocumentLookup(
  expr: Expression,
  shadowedLocals: ReadonlySet<string>,
): boolean {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return false;
    case 'functionCall':
      if (DOCUMENT_LOOKUP_NAMES.has(expr.name)) return true;
      return expr.args.some((arg) => expressionUsesDocumentLookup(arg, shadowedLocals));
    case 'methodCall':
      if (
        DOCUMENT_LOOKUP_NAMES.has(expr.method) &&
        expr.object.type === 'identifier' &&
        expr.object.name === 'firestore' &&
        !shadowedLocals.has('firestore')
      ) {
        return true;
      }
      return (
        expressionUsesDocumentLookup(expr.object, shadowedLocals) ||
        expr.args.some((arg) => expressionUsesDocumentLookup(arg, shadowedLocals))
      );
    case 'memberAccess':
      return expressionUsesDocumentLookup(expr.object, shadowedLocals);
    case 'bracketAccess':
      return (
        expressionUsesDocumentLookup(expr.object, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.index, shadowedLocals)
      );
    case 'sliceAccess':
      return (
        expressionUsesDocumentLookup(expr.object, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.start, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.end, shadowedLocals)
      );
    case 'binaryOp':
      return (
        expressionUsesDocumentLookup(expr.left, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.right, shadowedLocals)
      );
    case 'unaryOp':
      return expressionUsesDocumentLookup(expr.operand, shadowedLocals);
    case 'ternary':
      return (
        expressionUsesDocumentLookup(expr.condition, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.consequent, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.alternate, shadowedLocals)
      );
    case 'inExpr':
      return (
        expressionUsesDocumentLookup(expr.element, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.collection, shadowedLocals)
      );
    case 'isExpr':
      return expressionUsesDocumentLookup(expr.value, shadowedLocals);
    case 'listLiteral':
      return expr.elements.some((el) => expressionUsesDocumentLookup(el, shadowedLocals));
    case 'mapLiteral':
      return expr.entries.some(
        (entry) =>
          expressionUsesDocumentLookup(entry.key, shadowedLocals) ||
          expressionUsesDocumentLookup(entry.value, shadowedLocals),
      );
    case 'pathLiteral':
      return expr.segments.some(
        (seg) => typeof seg !== 'string' && expressionUsesDocumentLookup(seg, shadowedLocals),
      );
  }
}

function functionDefUsesDocumentLookup(
  fn: FunctionDef,
  parentLocals: ReadonlySet<string>,
): boolean {
  const locals = new Set(parentLocals);
  for (const param of fn.parameters) locals.add(param);
  for (const binding of fn.lets) {
    if (expressionUsesDocumentLookup(binding.value, locals)) return true;
    locals.add(binding.name);
  }
  return expressionUsesDocumentLookup(fn.body, locals);
}

function matchBlockUsesDocumentLookup(
  block: MatchBlock,
  locals: ReadonlySet<string>,
): boolean {
  if (block.functions.some((fn) => functionDefUsesDocumentLookup(fn, locals))) return true;
  if (block.allows.some((allow) => expressionUsesDocumentLookup(allow.condition, locals))) {
    return true;
  }
  return block.children.some((child) => matchBlockUsesDocumentLookup(child, locals));
}

function astUsesDocumentLookups(ast: FirestoreRules): boolean {
  const emptyLocals = new Set<string>();
  if ((ast.functions ?? []).some((fn) => functionDefUsesDocumentLookup(fn, emptyLocals))) {
    return true;
  }
  const services = ast.services ?? (ast.service ? [ast.service] : []);
  for (const svc of services) {
    if ((svc.functions ?? []).some((fn) => functionDefUsesDocumentLookup(fn, emptyLocals))) {
      return true;
    }
    const matches = svc.matches ?? (svc.match ? [svc.match] : []);
    if (matches.some((m) => matchBlockUsesDocumentLookup(m, emptyLocals))) {
      return true;
    }
  }
  return false;
}

function rulesSourceUsesLookups(source: string | undefined): boolean {
  if (typeof source !== 'string' || source.trim().length === 0) return false;
  let candidate = source;
  const parsedInitial = parseToASTOrError(candidate);
  if (parsedInitial.ok) {
    if (parsedInitial.ast.version === '2+modules' && parsedInitial.ast.imports.length > 0) {
      const resolved = resolveModulesBrowser(candidate, { targetService: 'cloud.firestore' });
      if (resolved.success) {
        candidate = resolved.data.resolved;
        const parsedResolved = parseToASTOrError(candidate);
        if (parsedResolved.ok) return astUsesDocumentLookups(parsedResolved.ast);
      }
    }
    return astUsesDocumentLookups(parsedInitial.ast);
  }
  return textContainsDocumentLookupCall(source);
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
  if (!isFunctionMockCandidate(value)) return false;
  if (value.function !== 'get' && value.function !== 'exists') return false;
  return typeof value.path === 'string' && 'result' in value;
}

function isListQueryOrderBy(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const direction of Object.values(value)) {
    if (direction !== 'ASC' && direction !== 'DESC') return false;
  }
  return true;
}

function isListQuery(value: unknown): value is NonNullable<TestCase['query']> {
  if (!isListQueryCandidate(value)) return false;
  if ('where' in value && value.where !== undefined) {
    if (!Array.isArray(value.where)) return false;
    for (const clause of value.where) {
      if (typeof clause !== 'object' || clause === null || Array.isArray(clause)) return false;
      const c = clause as Record<string, unknown>;
      if (typeof c.field !== 'string' || typeof c.op !== 'string' || !('value' in c)) return false;
    }
  }
  if ('limit' in value && value.limit !== undefined && typeof value.limit !== 'number') return false;
  if ('offset' in value && value.offset !== undefined && typeof value.offset !== 'number') return false;
  if ('orderBy' in value && value.orderBy !== undefined && !isListQueryOrderBy(value.orderBy)) return false;
  return true;
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
      const exprText =
        typeof entry.source === 'string'
          ? entry.source
          : typeof (entry as { expression?: unknown }).expression === 'string'
            ? ((entry as { expression?: string }).expression ?? '')
            : '';
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
