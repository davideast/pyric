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
import { lint } from './lint.js';
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

/** An ISO-8601 date and time with its offset, such as `2026-01-02T03:04:05Z`. */
const ISO_8601_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** A case the engine could not evaluate as given, reported as data. */
function unsupportedResult(oneCase: StorageCase, reason: string, bucket?: string): StorageCaseResult {
  return {
    case: oneCase,
    description: oneCase.description,
    expectation: oneCase.expectation,
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
  const isIsoTime = typeof oneCase.requestTime === 'string' && ISO_8601_TIME.test(oneCase.requestTime);
  if (!isIsoTime) return null;
  const instant = new Date(oneCase.requestTime);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

/** Why a case cannot be evaluated as given before its bucket is known, or `null`. */
function malformedCase(oneCase: StorageCase): string | null {
  if (typeof oneCase !== 'object' || oneCase === null) return 'A case is an object.';
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
    return lint(this.source);
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
    const malformed = malformedCase(oneCase);
    if (malformed !== null) return unsupportedResult(oneCase ?? ({} as StorageCase), malformed);
    const named = oneCase.bucket ?? this.options.bucket;
    if (named === undefined || named === '') {
      return unsupportedResult(oneCase, 'The case names no bucket. Pass bucket on the case or as an option to storageRules().');
    }
    const bucket = rulesBucketName(named, named);
    const unevaluable = unevaluableCase(oneCase, bucket);
    if (unevaluable !== null) return unsupportedResult(oneCase, unevaluable, bucket);
    const now = requestInstant(oneCase);
    if (now === null) {
      return unsupportedResult(oneCase, `requestTime ${JSON.stringify(oneCase.requestTime)} is not an ISO-8601 time.`, bucket);
    }
    const observation = emptyStorageObservation();
    const lookup = lookupFor(oneCase.firestore);
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

/** The error `storageRules()` throws, with the parse-stage errors lint finds, or the compiler's message as one. */
function compileError(source: string, error: unknown): RulesCompileError {
  const message = error instanceof Error ? error.message : String(error);
  const parseIssues = lint(source).filter((issue) => issue.origin === 'parse' && issue.severity === 'error');
  const issues: RuleIssue[] =
    parseIssues.length > 0 ? parseIssues : [{ code: 'PARSE_ERROR', severity: 'error', message, origin: 'parse' }];
  return new RulesCompileError(`Storage rules source failed to compile: ${message}`, issues);
}
