/**
 * `storageRules(source)`: the deep, safe-by-default handle on a Cloud Storage
 * ruleset, shaped like `firestoreRules`.
 *
 * The constructor compiles once, as the live Storage service does, lowering
 * `2+modules` source first. A source that does not compile throws
 * {@link RulesCompileError}; past that point the handle's verbs never throw
 * on a rule outcome. `simulate` runs {@link StorageCase}s, the rules-verb form
 * of the Rules Test API, and takes every binding as given.
 */

import {
  compileStorageRules,
  evaluateStorageRules,
  emptyStorageObservation,
  bindRulesBucket,
  rulesBucketName,
  type EvaluationInput,
  type EvaluationResult,
  type FirestoreLookup,
  type StorageEvaluationObservation,
  type StorageRules,
} from '../internal/storage.js';
import { RulesCompileError } from './errors.js';
import type { RuleIssue } from './issue.js';
import { lintSource } from './lint.js';
import { normalizeAuthState } from '../auth/auth-state.js';
import { parseToAST } from '../grammar/FirestoreParser.js';
import { findModuleErrorImportLine } from '../modules/resolver-browser.js';
import {
  ISO_INSTANT_FORM,
  parseStrictIsoMillis,
  safeErrorMessage,
  safeReadProp,
} from '../test/case-refusals.js';
import { validateCasePayloadValue } from '../test/case-shape.js';
import type {
  StorageCase,
  StorageCaseMethod,
  StorageCaseResult,
  StorageExplanation,
  StorageSimulationSummary,
} from './case-types.js';

export interface StorageRulesOptions {
  /** The bucket name a case that names none runs against, such as
   *  `demo-app.appspot.com`. */
  bucket?: string;
}

export interface StorageRuleset {
  /** Structural, security, and budget findings on the compiled ruleset. */
  lint(): RuleIssue[];
  /** Run every case. Never throws on a rule outcome: a denied or
   *  unsupported case is reported in the returned summary. */
  simulate(cases: StorageCase[]): StorageSimulationSummary;
  /** The structured account of why one case resolved as it did. */
  explain(oneCase: StorageCase): StorageExplanation;
}

const CASE_METHODS: readonly StorageCaseMethod[] = ['read', 'get', 'list', 'create', 'update', 'delete'];

/** The verbs production evaluates with no incoming object: `request.resource` is unset. */
const NO_INCOMING_OBJECT: readonly StorageCaseMethod[] = ['read', 'get', 'list', 'delete'];

const STORAGE_CASE_KEYS: readonly string[] = [
  'description',
  'expectation',
  'method',
  'bucket',
  'path',
  'auth',
  'requestResource',
  'resource',
  'firestore',
  'requestTime',
];

const STORAGE_AUTH_KEYS: readonly string[] = ['uid', 'tenant', 'token'];

const STORAGE_REQUEST_RESOURCE_KEYS: readonly string[] = [
  'size',
  'contentType',
  'metadata',
  'name',
  'bucket',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
  'cacheControl',
  'generation',
  'metageneration',
  'etag',
];

const STORAGE_RESOURCE_KEYS: readonly string[] = [
  'size',
  'contentType',
  'metadata',
  'name',
  'bucket',
  'timeCreated',
  'updated',
  'generation',
  'metageneration',
  'md5Hash',
  'crc32c',
  'etag',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
  'cacheControl',
];

const FULL_FIRESTORE_DOC_PREFIX = /^(?:projects\/[^/]+\/)?databases\/([^/]+)\/documents(?:\/(.*))?$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0
  );
}

/** A case the engine could not evaluate as given, reported as data. */
function unsupportedResult(oneCase: StorageCase, reason: string, bucket?: string): StorageCaseResult {
  const desc = safeReadProp(oneCase, 'description');
  const exp = safeReadProp(oneCase, 'expectation');
  return {
    case: oneCase,
    description: typeof desc === 'string' ? desc : '',
    expectation: exp === 'ALLOW' ? 'ALLOW' : 'DENY',
    service: 'storage',
    ...(bucket === undefined ? {} : { bucket }),
    decision: 'UNSUPPORTED',
    passed: false,
    unsupported: true,
    reasons: [reason],
    evaluatedExpressions: 0,
  };
}

/** The verdict of an evaluation, with the expectation it is checked against. */
function evaluatedResult(
  oneCase: StorageCase,
  bucket: string,
  result: EvaluationResult,
  observation: StorageEvaluationObservation,
): StorageCaseResult {
  const decision = result.allowed ? 'ALLOW' : 'DENY';
  return {
    case: oneCase,
    description: oneCase.description,
    expectation: oneCase.expectation,
    service: 'storage',
    bucket,
    decision,
    passed: decision === oneCase.expectation,
    unsupported: false,
    ...(observation.matchedRule === undefined ? {} : { decidingRule: observation.matchedRule }),
    reasons: result.reasons,
    evaluatedExpressions: result.evaluatedExpressions,
    ...(result.resourceLimit === undefined ? {} : { resourceLimit: result.resourceLimit }),
  };
}

/** The `firestore.get()` / `firestore.exists()` reads a case's documents answer. */
function lookupFor(documents: Record<string, Record<string, unknown>> | undefined): FirestoreLookup | undefined {
  if (documents === undefined) return undefined;
  const has = (path: string) => Object.prototype.hasOwnProperty.call(documents, path);
  return {
    get: (path) => (has(path) ? documents[path] : null),
    exists: has,
  };
}

/** The evaluation instant a case names, or `null` when it names one that is not an ISO-8601 time. */
function requestInstant(oneCase: StorageCase): Date | null {
  if (oneCase.requestTime === undefined) return new Date();
  if (typeof oneCase.requestTime !== 'string') return null;
  const ms = parseStrictIsoMillis(oneCase.requestTime);
  return ms === null ? null : new Date(ms);
}

/** Why a case cannot be evaluated as given before its bucket is known, or `null`. */
function malformedCase(oneCase: StorageCase): string | null {
  if (typeof oneCase !== 'object' || oneCase === null || Array.isArray(oneCase)) return 'A case is an object.';
  if (typeof oneCase.path !== 'string') return 'The case has no path. Pass the object path within the bucket as path.';
  const bucketIsString = oneCase.bucket === undefined || typeof oneCase.bucket === 'string';
  if (!bucketIsString) return 'The bucket on the case is not a string.';
  return null;
}

/** Why a case cannot be evaluated on its bucket as given, or `null`. */
function unevaluableCase(oneCase: StorageCase, bucket: string): string | null {
  if (bucket.includes('/')) {
    return `Bucket ${JSON.stringify(bucket)} holds a "/". A bucket name has none.`;
  }
  if (!CASE_METHODS.includes(oneCase.method)) {
    return `Unknown method ${JSON.stringify(oneCase.method)}. A case names one of ${CASE_METHODS.join(', ')}.`;
  }
  const carriesUnsetIncoming = oneCase.requestResource !== undefined && NO_INCOMING_OBJECT.includes(oneCase.method);
  if (carriesUnsetIncoming) {
    return `requestResource is set on a ${oneCase.method} case. Production leaves request.resource unset for ${oneCase.method}, so omit it.`;
  }
  return null;
}

function validateMetadataMap(value: unknown, field: string): string | null {
  if (!isPlainRecord(value)) return `Case refused: ${field} must be a string map or null.`;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      return `Case refused: ${field}[${JSON.stringify(k)}] must be a string, got ${typeof v}.`;
    }
  }
  return null;
}

function validateRequestResource(value: unknown): string | null {
  if (!isPlainRecord(value)) {
    return 'Case refused: requestResource must be an object when provided on a create or update case.';
  }
  const unknown = Object.keys(value).filter((k) => !STORAGE_REQUEST_RESOURCE_KEYS.includes(k));
  if (unknown.length > 0) {
    return `Case refused: unknown field ${unknown.map((k) => `'${k}'`).join(', ')} on requestResource; accepted fields are ${STORAGE_REQUEST_RESOURCE_KEYS.join(', ')}.`;
  }
  if (!isNonNegativeInt(value.size)) {
    return `Case refused: requestResource.size must be a non-negative integer, got ${String(value.size)}.`;
  }
  for (const strKey of ['name', 'bucket'] as const) {
    if (value[strKey] !== undefined && typeof value[strKey] !== 'string') {
      return `Case refused: requestResource.${strKey} must be a string.`;
    }
  }
  for (const nullableStrKey of [
    'contentType',
    'contentDisposition',
    'contentEncoding',
    'contentLanguage',
    'cacheControl',
  ] as const) {
    const v = value[nullableStrKey];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      return `Case refused: requestResource.${nullableStrKey} must be a string or null.`;
    }
  }
  if (value.metadata !== undefined && value.metadata !== null) {
    const err = validateMetadataMap(value.metadata, 'requestResource.metadata');
    if (err !== null) return err;
  }
  for (const genKey of ['generation', 'metageneration'] as const) {
    const v = value[genKey];
    if (v !== undefined && v !== null && !isNonNegativeInt(v)) {
      return `Case refused: requestResource.${genKey} must be a non-negative integer or null.`;
    }
  }
  if (value.etag !== undefined && value.etag !== null && typeof value.etag !== 'string') {
    return 'Case refused: requestResource.etag must be null or a string.';
  }
  return null;
}

function validateStoredResource(value: unknown): string | null {
  if (!isPlainRecord(value)) {
    return 'Case refused: resource must be an object or null.';
  }
  const unknown = Object.keys(value).filter((k) => !STORAGE_RESOURCE_KEYS.includes(k));
  if (unknown.length > 0) {
    return `Case refused: unknown field ${unknown.map((k) => `'${k}'`).join(', ')} on resource; accepted fields are ${STORAGE_RESOURCE_KEYS.join(', ')}.`;
  }
  if (!isNonNegativeInt(value.size)) {
    return `Case refused: resource.size must be a non-negative integer, got ${String(value.size)}.`;
  }
  for (const tsKey of ['timeCreated', 'updated'] as const) {
    const ts = value[tsKey];
    if (ts !== undefined) {
      if (typeof ts !== 'string' || parseStrictIsoMillis(ts) === null) {
        return `Case refused: resource.${tsKey} is ${JSON.stringify(ts)}, which is not ${ISO_INSTANT_FORM}.`;
      }
    }
  }
  if (value.metadata !== undefined && value.metadata !== null) {
    const err = validateMetadataMap(value.metadata, 'resource.metadata');
    if (err !== null) return err;
  }
  for (const genKey of ['generation', 'metageneration'] as const) {
    const v = value[genKey];
    if (v !== undefined && v !== null && !isNonNegativeInt(v)) {
      return `Case refused: resource.${genKey} must be a non-negative integer.`;
    }
  }
  for (const strKey of [
    'contentType',
    'name',
    'bucket',
    'md5Hash',
    'crc32c',
    'etag',
    'contentDisposition',
    'contentEncoding',
    'contentLanguage',
    'cacheControl',
  ] as const) {
    const v = value[strKey];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      return `Case refused: resource.${strKey} must be a string.`;
    }
  }
  return null;
}

function validateStorageCaseShape(oneCase: StorageCase): string | null {
  const unknown = Object.keys(oneCase as unknown as Record<string, unknown>).filter(
    (k) => !STORAGE_CASE_KEYS.includes(k),
  );
  if (unknown.length > 0) {
    return `Case refused: unknown field ${unknown.map((k) => `'${k}'`).join(', ')}; a Storage rules case takes ${STORAGE_CASE_KEYS.join(', ')}.`;
  }
  if (typeof oneCase.description !== 'string') {
    return 'Case refused: description must be a string.';
  }
  if (oneCase.expectation !== 'ALLOW' && oneCase.expectation !== 'DENY') {
    return `Case refused: expectation must be 'ALLOW' or 'DENY', got ${JSON.stringify(oneCase.expectation)}.`;
  }
  if (oneCase.auth !== undefined && oneCase.auth !== null) {
    if (!isPlainRecord(oneCase.auth)) {
      return 'Case refused: auth must be an object or null.';
    }
    const unknownAuth = Object.keys(oneCase.auth).filter((k) => !STORAGE_AUTH_KEYS.includes(k));
    if (unknownAuth.length > 0) {
      return `Case refused: unknown field ${unknownAuth.map((k) => `'${k}'`).join(', ')} on auth; accepted fields are ${STORAGE_AUTH_KEYS.join(', ')}.`;
    }
    if (typeof oneCase.auth.uid !== 'string') {
      return 'Case refused: auth.uid must be a string.';
    }
    if (oneCase.auth.tenant !== undefined && typeof oneCase.auth.tenant !== 'string') {
      return 'Case refused: auth.tenant must be a string.';
    }
    if (oneCase.auth.token !== undefined && !isPlainRecord(oneCase.auth.token)) {
      return 'Case refused: auth.token must be a plain object.';
    }
    try {
      normalizeAuthState(oneCase.auth);
    } catch (error) {
      return `Case refused: auth.token: ${safeErrorMessage(error)}`;
    }
  }
  if (oneCase.requestResource !== undefined) {
    const err = validateRequestResource(oneCase.requestResource);
    if (err !== null) return err;
  }
  if (oneCase.resource !== undefined && oneCase.resource !== null) {
    const err = validateStoredResource(oneCase.resource);
    if (err !== null) return err;
  }
  return null;
}

function normalizeFirestoreDocKey(rawKey: string): { ok: true; key: string } | { ok: false; reason: string } {
  if (rawKey.endsWith('/')) {
    return {
      ok: false,
      reason: `Case refused: firestore document path ${JSON.stringify(rawKey)} must not end with '/'.`,
    };
  }
  const trimmed = rawKey.replace(/^\/+/, '');
  let relativePath = trimmed;
  const fullMatch = FULL_FIRESTORE_DOC_PREFIX.exec(trimmed);
  if (fullMatch) {
    const db = fullMatch[1]!;
    if (db !== '(default)') {
      return {
        ok: false,
        reason: `Case refused: Storage rules may access only the default Firestore database, got ${JSON.stringify(db)} in firestore[${JSON.stringify(rawKey)}].`,
      };
    }
    relativePath = fullMatch[2] ?? '';
  } else {
    const rawSegments = trimmed.split('/');
    if (rawSegments[0] === 'databases' && rawSegments.length >= 3 && rawSegments[2] !== 'documents') {
      return {
        ok: false,
        reason: `Case refused: malformed Firestore document path ${JSON.stringify(rawKey)}.`,
      };
    }
  }
  const segments = relativePath.length === 0 ? [] : relativePath.split('/');
  if (segments.length < 2 || segments.length % 2 !== 0 || segments.some((s) => s.length === 0)) {
    return {
      ok: false,
      reason: `Case refused: firestore document path ${JSON.stringify(rawKey)} must point at a document (even non-zero segment count, such as "users/alice").`,
    };
  }
  return { ok: true, key: segments.join('/') };
}

function normalizeStorageFirestoreDocs(
  rawFirestore: unknown,
): { ok: true; documents: Record<string, Record<string, unknown>> | undefined } | { ok: false; reason: string } {
  if (rawFirestore === undefined) return { ok: true, documents: undefined };
  if (!isPlainRecord(rawFirestore)) {
    return { ok: false, reason: 'Case refused: firestore must be an object mapping document paths to document data.' };
  }
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [rawKey, docValue] of Object.entries(rawFirestore)) {
    const keyResult = normalizeFirestoreDocKey(rawKey);
    if (!keyResult.ok) return keyResult;
    if (Object.prototype.hasOwnProperty.call(normalized, keyResult.key)) {
      return {
        ok: false,
        reason: `Case refused: duplicate Firestore document path ${JSON.stringify(keyResult.key)} in firestore map.`,
      };
    }
    if (!isPlainRecord(docValue)) {
      return {
        ok: false,
        reason: `Case refused: firestore[${JSON.stringify(rawKey)}] must be a document object; omit a key to model a missing document.`,
      };
    }
    const fieldErr = validateCasePayloadValue(docValue, `firestore[${JSON.stringify(rawKey)}]`, {
      allowUndefined: false,
      rejectStoredWriteSentinels: true,
    });
    if (fieldErr !== undefined) return { ok: false, reason: fieldErr };
    Object.defineProperty(normalized, keyResult.key, {
      value: docValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, documents: normalized };
}

/** The evaluator's input for a case on a bucket: the path rooted at `b/<bucket>/o`. */
function evaluationInput(oneCase: StorageCase, bucket: string): EvaluationInput {
  const input: EvaluationInput = {
    request: {
      auth: oneCase.auth ?? null,
      method: oneCase.method,
      path: oneCase.path,
      ...(oneCase.requestResource === undefined ? {} : { resource: oneCase.requestResource }),
    },
    resource: oneCase.resource ?? null,
  };
  return bindRulesBucket(input, bucket, bucket);
}

class StorageRulesetImpl implements StorageRuleset {
  constructor(
    private readonly source: string,
    private readonly rules: StorageRules,
    private readonly options: StorageRulesOptions,
  ) {}

  lint(): RuleIssue[] {
    return lintSource(this.source, 'firebase.storage');
  }

  simulate(cases: StorageCase[]): StorageSimulationSummary {
    const results = cases.map((oneCase) => this.run(oneCase));
    const unsupported = results.filter((r) => r.unsupported).length;
    const passed = results.filter((r) => r.passed).length;
    return { passed, failed: results.length - passed - unsupported, unsupported, cases: results };
  }

  explain(oneCase: StorageCase): StorageExplanation {
    const { case: _case, description: _description, ...explanation } = this.run(oneCase);
    return explanation;
  }

  private run(oneCase: StorageCase): StorageCaseResult {
    let resolvedBucket: string | undefined;
    try {
      const malformed = malformedCase(oneCase);
      if (malformed !== null) return unsupportedResult(oneCase ?? ({} as StorageCase), malformed);
      const named = oneCase.bucket ?? this.options.bucket;
      if (named === undefined || named === '') {
        return unsupportedResult(oneCase, 'The case names no bucket. Pass bucket on the case or as an option to storageRules().');
      }
      const bucket = rulesBucketName(named, named);
      resolvedBucket = bucket;
      const unevaluable = unevaluableCase(oneCase, bucket);
      if (unevaluable !== null) return unsupportedResult(oneCase, unevaluable, bucket);
      const now = requestInstant(oneCase);
      if (now === null) {
        return unsupportedResult(oneCase, `requestTime ${JSON.stringify(oneCase.requestTime)} is not an ISO-8601 time.`, bucket);
      }
      const shapeError = validateStorageCaseShape(oneCase);
      if (shapeError !== null) return unsupportedResult(oneCase, shapeError, bucket);
      const firestoreDocs = normalizeStorageFirestoreDocs(oneCase.firestore);
      if (!firestoreDocs.ok) return unsupportedResult(oneCase, firestoreDocs.reason, bucket);

      const observation = emptyStorageObservation();
      const lookup = lookupFor(firestoreDocs.documents);
      const result = evaluateStorageRules(this.rules, evaluationInput(oneCase, bucket), now, lookup, observation);
      const readsUnsuppliedDocument = observation.readFirestore && lookup === undefined;
      if (readsUnsuppliedDocument) {
        return unsupportedResult(
          oneCase,
          'The rules read a Firestore document. Pass the documents they read as firestore on the case.',
          bucket,
        );
      }
      return evaluatedResult(oneCase, bucket, result, observation);
    } catch (error) {
      return unsupportedResult(
        oneCase ?? ({} as StorageCase),
        `Case refused: ${safeErrorMessage(error)}`,
        resolvedBucket,
      );
    }
  }
}

/**
 * Compile Storage rules source into a deep, safe-by-default handle.
 *
 * @throws {RulesCompileError} when the source does not parse, names a
 *   service other than `firebase.storage`, declares one service twice,
 *   breaks one of production's compile limits, or imports a module that
 *   does not resolve. The thrown error carries the compile-blocking issues
 *   on `.issues`.
 */
export function storageRules(source: string, options: StorageRulesOptions = {}): StorageRuleset {
  let rules: StorageRules;
  try {
    rules = compileStorageRules(source).rules;
  } catch (error) {
    throw compileError(source, error);
  }
  return new StorageRulesetImpl(source, rules, options);
}

const MODULE_RESOLUTION_ERROR_PREFIX = /^Storage rules module resolution failed \(([A-Z_]+)\): (.*)$/s;

/** The error `storageRules()` throws, with the parse-stage errors lint finds, or the compiler's message as one. */
function compileError(source: string, error: unknown): RulesCompileError {
  const message = safeErrorMessage(error);
  const scopedParseIssues = lintSource(source, 'firebase.storage').filter(
    (issue) => issue.origin === 'parse' && issue.severity === 'error',
  );
  const parseIssues =
    scopedParseIssues.length > 0
      ? scopedParseIssues
      : lintSource(source).filter((issue) => issue.origin === 'parse' && issue.severity === 'error');
  if (parseIssues.length > 0) {
    return new RulesCompileError(`Storage rules source failed to compile: ${message}`, parseIssues);
  }
  const ast = parseToAST(source);
  const modMatch = MODULE_RESOLUTION_ERROR_PREFIX.exec(message);
  if (modMatch) {
    const [, code, detail] = modMatch;
    const line = findModuleErrorImportLine(ast?.imports, detail!, ast?.loc?.line ?? 1);
    return new RulesCompileError(`Storage rules source failed to compile: ${message}`, [
      { code: code!, severity: 'error', message: detail!, line, origin: 'parse' },
    ]);
  }
  const fallbackIssue: RuleIssue = {
    code: 'PARSE_ERROR',
    severity: 'error',
    message,
    origin: 'parse',
    ...(ast?.service?.loc?.line !== undefined ? { line: ast.service.loc.line } : {}),
  };
  return new RulesCompileError(`Storage rules source failed to compile: ${message}`, [fallbackIssue]);
}
