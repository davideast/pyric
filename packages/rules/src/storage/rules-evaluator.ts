import type { ExpressionPosition } from '../grammar/expression-positions.js';
import { EXPRESSION_LIMIT } from '../linter/expression-cost.js';
import { ExpressionBudget, describeExpressionLimit } from '../simulator/expression-budget.js';
import { describeRulesType as describeType } from '../simulator/rules-type.js';
import {
  expandVerb,
  type EvaluationInput,
  type EvaluationResult,
  type Expr,
  type FirestoreLookup,
  type FunctionMap,
  type MatchBlock,
  type StorageRules,
  type StorageVerb,
} from './rules.js';
import {
  RuleEvalError,
  RuleExpressionLimitError,
  RuleResourceLimitError,
} from './rules-evaluation-error.js';
import {
  evalExpr,
  evalOperand,
  evalOperands,
  noteMapEnumerationRead,
  noteMapGetRead,
  trackObject,
  type EvalCtx,
  type TrackedRoot,
} from './rules-expr-eval.js';
import { formatPath, matchSegments, recursiveWildcardMinimum, splitPath, type PathParamValue } from './rules-path-match.js';
import { StoragePath } from './rules-path.js';
import { RuleError, isRuleError as isErr } from './rules-values.js';

export {
  evalExpr,
  evalOperand,
  evalOperands,
  noteMapEnumerationRead,
  noteMapGetRead,
  trackObject,
  type EvalCtx,
  type TrackedRoot,
};

/** The allow rule an evaluation stopped on: its match block's path and the rule's line. */
export interface StorageMatchedRule {
  path: string;
  line?: number;
}

/** One `allow` rule evaluated during a request run, in exact evaluation order. */
export interface StorageEvaluatedAllowRule {
  readonly condition: Expr | null;
  readonly captures: ReadonlySet<string>;
  readonly funcs: FunctionMap;
}

/**
 * What one evaluation read, for a caller that must know which inputs a
 * verdict rested on (a live host deciding whether it had the data to judge
 * production's answer), and the allow rule that decided it.
 */
export interface StorageEvaluationObservation {
  matchedRule?: StorageMatchedRule;
  evaluatedAllows?: StorageEvaluatedAllowRule[];
  readResource: boolean;
  readRequestResource: boolean;
  readFirestore: boolean;
  readAuthToken: boolean;
  readAuthTokenEmail: boolean;
}

/** An observation of an evaluation that has read nothing yet. */
export function emptyStorageObservation(): StorageEvaluationObservation {
  return {
    evaluatedAllows: [],
    readResource: false,
    readRequestResource: false,
    readFirestore: false,
    readAuthToken: false,
    readAuthTokenEmail: false,
  };
}

/** Fold one granular run's reads into the request's: a read in any run is a read, and the latest run's rule decides. */
function mergeObservation(into: StorageEvaluationObservation, run: StorageEvaluationObservation): void {
  into.readResource ||= run.readResource;
  into.readRequestResource ||= run.readRequestResource;
  into.readFirestore ||= run.readFirestore;
  into.readAuthToken ||= run.readAuthToken;
  into.readAuthTokenEmail ||= run.readAuthTokenEmail;
  if (run.matchedRule !== undefined) into.matchedRule = run.matchedRule;
  if (run.evaluatedAllows !== undefined && run.evaluatedAllows.length > 0) {
    into.evaluatedAllows ??= [];
    into.evaluatedAllows.push(...run.evaluatedAllows);
  }
}

export function evaluateStorageRules(
  rules: StorageRules,
  input: EvaluationInput,
  now: Date = new Date(),
  firestoreLookup?: FirestoreLookup,
  observation?: StorageEvaluationObservation,
): EvaluationResult {
  const nowMillis = now.getTime();
  if (!Number.isFinite(nowMillis)) {
    throw new TypeError('evaluateStorageRules: now must be a valid Date');
  }
  let result: EvaluationResult | undefined;
  for (const method of impliedVerbs(input)) {
    let runObservation: StorageEvaluationObservation | undefined;
    if (observation !== undefined) runObservation = emptyStorageObservation();
    result = evaluateGranularRequest(rules, input, method, nowMillis, firestoreLookup, runObservation);
    if (observation !== undefined && runObservation !== undefined) mergeObservation(observation, runObservation);
    if (result.allowed) return result;
  }
  if (result === undefined) throw new Error('a request implies at least one verb');
  return result;
}

function impliedVerbs(input: EvaluationInput): readonly StorageVerb[] {
  const { request } = input;
  if (request.method !== 'write') return expandVerb(request.method);
  return request.resource === undefined ? ['delete'] : ['create'];
}

function withMethod(input: EvaluationInput, method: StorageVerb): EvaluationInput {
  if (input.request.method === method) return input;
  return { ...input, request: { ...input.request, method } };
}

function evaluateGranularRequest(
  rules: StorageRules,
  input: EvaluationInput,
  requestVerb: StorageVerb,
  nowMillis: number,
  firestoreLookup: FirestoreLookup | undefined,
  observation?: StorageEvaluationObservation,
): EvaluationResult {
  const pathSegments = splitPath(input.request.path);
  const boundInput = withMethod(input, requestVerb);
  const reasons: string[] = [];
  const firestoreAccesses = new Set<string>();
  let trackedRoots: WeakMap<object, TrackedRoot> | undefined;
  if (observation) {
    trackedRoots = new WeakMap<object, TrackedRoot>();
  }
  let allowingRule: StorageMatchedRule | undefined;
  let lastCheckedRule: StorageMatchedRule | undefined;
  const expressionBudget = new ExpressionBudget((message, position) => new RuleExpressionLimitError(message, position));
  let expressionLimit: { message: string; position: ExpressionPosition | undefined } | undefined;
  let stopped = false;
  let firstError: string | undefined;

  function visit(
    block: MatchBlock,
    remaining: string[],
    params: Record<string, PathParamValue>,
  ): boolean {
    if (stopped) return false;
    const match = matchSegments(block.segments, remaining, params, rules._version);
    if (!match) return false;
    const newParams = match.params;
    const left = match.left;

    if (left.length === 0) {
      const funcs = block.visibleFuncs ?? new Map();
      const paramNames = new Set(Object.keys(newParams));
      for (const rule of block.allows) {
        const grantVerbs = new Set(rule.verbs.flatMap(expandVerb));
        if (!grantVerbs.has(requestVerb)) continue;
        let candidateRule: StorageMatchedRule | undefined;
        if (observation) {
          candidateRule = { path: `match ${formatPath(block.segments)}` };
          if (rule.line !== undefined) candidateRule.line = rule.line;
          lastCheckedRule = candidateRule;
          observation.evaluatedAllows ??= [];
          observation.evaluatedAllows.push({
            condition: rule.condition,
            captures: paramNames,
            funcs,
          });
        }
        let result: boolean;
        try {
          let value: unknown = true;
          if (rule.condition) {
            value = evalExpr(rule.condition, {
              input: boundInput,
              now: nowMillis,
              params: newParams,
              matchParams: newParams,
              scopeKind: 'match',
              locals: {},
              funcs,
              firestoreLookup,
              firestoreAccesses,
              expressionBudget,
              observation,
              trackedRoots,
            });
          }
          if (typeof value === 'boolean') {
            result = value;
          } else {
            let failure: RuleError;
            if (isErr(value)) {
              failure = value;
            } else {
              failure = new RuleError(`Allow condition expected bool, got ${describeType(value)}.`);
            }
            firstError ??= failure.message;
            reasons.push(
              `match ${formatPath(block.segments)} ${input.request.method}: ${failure.message}`,
            );
            continue;
          }
        } catch (err) {
          if (err instanceof RuleExpressionLimitError) {
            stopped = true;
            if (firstError === undefined) {
              expressionLimit = { message: err.message, position: err.position };
              reasons.push(
                `match ${formatPath(block.segments)} ${input.request.method}: ${describeExpressionLimit(err.message, err.position)}`,
              );
            } else {
              reasons.push(
                `match ${formatPath(block.segments)} ${input.request.method}: ${err.message} `
                + `Reached after an earlier allow rule raised an error; production reports that earlier error: ${firstError}`,
              );
            }
            return false;
          }
          if (err instanceof RuleResourceLimitError) {
            stopped = true;
            reasons.push(
              `match ${formatPath(block.segments)} ${input.request.method}: ${err.message}`,
            );
            return false;
          }
          if (err instanceof RuleEvalError) {
            firstError ??= err.message;
            reasons.push(
              `match ${formatPath(block.segments)} ${input.request.method}: ${err.message}`,
            );
            continue;
          }
          throw err;
        }
        if (result) {
          allowingRule = candidateRule;
          return true;
        }
        reasons.push(
          `match ${formatPath(block.segments)} ${input.request.method}: condition false`,
        );
      }
    }

    const lastSeg = block.segments[block.segments.length - 1];
    if (block.children.length > 0 && lastSeg !== undefined && lastSeg.kind === 'wildcard') {
      const prefixSegments = block.segments.slice(0, -1);
      const prefixMatch = matchSegments(prefixSegments, remaining, params, rules._version);
      if (prefixMatch) {
        const tail = prefixMatch.left;
        const fewest = recursiveWildcardMinimum(rules._version);
        for (let splitLen = tail.length; splitLen >= fewest; splitLen--) {
          const captured = tail.slice(0, splitLen);
          const childLeft = tail.slice(splitLen);
          const childParams: Record<string, PathParamValue> = {
            ...prefixMatch.params,
            [lastSeg.name]: new StoragePath('/' + captured.join('/')),
          };
          for (const child of block.children) {
            if (visit(child, childLeft, childParams)) return true;
          }
        }
        return false;
      }
    }

    for (const child of block.children) {
      if (visit(child, left, newParams)) return true;
    }
    return false;
  }

  const allowed = visit(rules._root, pathSegments, {});
  if (!allowed && reasons.length === 0) {
    reasons.push(`no rule matches ${input.request.method} /${pathSegments.join('/')}`);
  }
  if (observation) {
    const matched = allowingRule ?? lastCheckedRule;
    if (matched) observation.matchedRule = matched;
  }
  const evaluationResult: EvaluationResult = {
    allowed,
    reasons,
    evaluatedExpressions: expressionBudget.evaluated,
  };
  if (expressionLimit !== undefined) {
    const limitRecord: NonNullable<EvaluationResult['resourceLimit']> = {
      kind: 'expressions',
      limit: EXPRESSION_LIMIT,
      message: expressionLimit.message,
    };
    if (expressionLimit.position !== undefined) {
      limitRecord.line = expressionLimit.position.line;
      limitRecord.column = expressionLimit.position.column;
    }
    evaluationResult.resourceLimit = limitRecord;
  }
  return evaluationResult;
}
