import { assembleExpression } from '../grammar/FirestoreAssembler.js';
import type { AllowRule, ImportDecl, MatchBlock } from '../grammar/FirestoreAST.js';
import { AUTHORED_ROOT_SOURCE_FILE, findModuleErrorImportLine } from '../modules/resolver-browser.js';
import { resolveAuthoredLoc, type AuthoredSourceMap } from '../modules/resolver-core.js';
import type { RuleEvaluation, RulesResourceLimit } from '../test/spec.js';
import { ExpressionLimitError, ResourceLimitError } from './eval-error.js';
import { evaluate, requireBoolean, TraceRecorder, UnsupportedError, type SimulationContext } from './evaluator.js';
import { describeExpressionLimit, EXPRESSION_LIMIT } from './expression-budget.js';
import { getListBlockSteps, type ListBlockStep } from './list-proof-budget.js';
import { DOCUMENT_LOOKUP_LIMIT } from './lookup-budget.js';

export type Decision = 'ALLOW' | 'DENY' | 'UNSUPPORTED';

/**
 * One match block's contribution to the request verdict. `resourceLimit`
 * carries a per-request resource limit (the document access budget or the
 * expression budget) that the block ran into: it is not this block's
 * private failure, so the caller stops evaluating siblings and denies the
 * whole request.
 */
export interface RuleBlockOutcome {
  decision: Decision;
  trace: RuleEvaluation[];
  notes: string[];
  resourceLimit?: RulesResourceLimit;
}

function methodToOperations(method: string): string[] {
  switch (method) {
    case 'get': return ['get', 'read'];
    case 'list': return ['list', 'read'];
    case 'create': return ['create', 'write'];
    case 'update': return ['update', 'write'];
    case 'delete': return ['delete', 'write'];
    default: return [method];
  }
}

function describeResourceLimit(e: ResourceLimitError): RulesResourceLimit {
  if (e instanceof ExpressionLimitError) {
    return {
      kind: 'expressions',
      limit: EXPRESSION_LIMIT,
      message: e.message,
      ...(e.position === undefined ? {} : { line: e.position.line, column: e.position.column }),
    };
  }
  return { kind: 'document-lookups', limit: DOCUMENT_LOOKUP_LIMIT, message: e.message };
}

/**
 * Evaluate all allow rules in a match block for a given operation.
 * Uses OR semantics -- if any matching rule allows, access is granted.
 *
 * Decision logic:
 *   - any rule ALLOW -> ALLOW (short-circuit)
 *   - else if any rule hit a per-request resource limit -> DENY, and the
 *     caller stops: the limit ends the request, not just this block
 *   - else if any rule threw UnsupportedError -> UNSUPPORTED (sim abstains)
 *   - else -> DENY
 *
 * Real evaluation errors (EvalError, type mismatches) are *not* lifted to
 * UNSUPPORTED -- they are caught and counted as deny, matching production's
 * "runtime errors deny the request" behavior.
 */
export function evaluateRules(
  block: MatchBlock,
  operation: string,
  ctx: SimulationContext,
  sourceMap?: AuthoredSourceMap,
  authoredImports?: readonly ImportDecl[],
): RuleBlockOutcome {
  const ops = methodToOperations(operation);
  const trace: RuleEvaluation[] = [];
  const notes: string[] = [];

  const listSteps = operation === 'list' ? getListBlockSteps(block) : undefined;
  const matchingRules: ListBlockStep[] = listSteps ? [...listSteps] : [];
  if (!listSteps) {
    for (let i = 0; i < block.allows.length; i++) {
      const rule = block.allows[i];
      if (rule === undefined) continue;
      const hasOp = rule.operations.some((op) => ops.includes(op));
      if (hasOp) {
        matchingRules.push({ kind: 'grant', rule, index: i });
      }
    }
  }

  if (matchingRules.length === 0) {
    notes.push(`No allow rules found for operation '${operation}'`);
    return { decision: 'DENY', trace, notes };
  }

  // Evaluate each matching rule (OR semantics). Each rule gets its own
  // TraceRecorder so the per-rule expressionTrace stays isolated even
  // when multiple rules evaluate before a verdict lands. We attach via
  // mutation+restore on the shared ctx -- cheaper than cloning ctx for
  // every rule and keeps wrappers' identity (Timestamp etc.) stable
  // across the loop.
  let sawUnsupported = false;
  const priorRecorder = ctx.trace;
  // Each entry records the request's running expression count at the point
  // its rule's evaluation ended.
  const record = (entry: RuleEvaluation) => {
    if (ctx.expressionBudget) entry.evaluatedExpressions = ctx.expressionBudget.evaluated;
    trace.push(entry);
  };
  const abortOnResourceLimit = (err: ResourceLimitError, entry: RuleEvaluation): RuleBlockOutcome => {
    entry.verdict = 'ERROR';
    entry.message = err.message;
    record(entry);
    ctx.trace = priorRecorder;
    const resourceLimit = describeResourceLimit(err);
    if (sourceMap && sourceMap.size > 0 && resourceLimit.line !== undefined) {
      const mapped = sourceMap.get(resourceLimit.line);
      if (mapped !== undefined) {
        if (mapped.authoredFile === AUTHORED_ROOT_SOURCE_FILE) {
          resourceLimit.line = mapped.authoredLine;
        } else if (authoredImports !== undefined) {
          resourceLimit.line = findModuleErrorImportLine(authoredImports, `'${mapped.authoredFile}'`, 1);
          delete resourceLimit.column;
        }
      }
    }
    // Production reports the expression limit at the expression the
    // budget ran out on, so the note cites that position.
    let position: { line: number; column: number } | undefined;
    if (resourceLimit.line !== undefined && resourceLimit.column !== undefined) {
      position = { line: resourceLimit.line, column: resourceLimit.column };
    }
    const cited = describeExpressionLimit(resourceLimit.message, position);
    const citedSentence = cited.endsWith('.') ? cited : `${cited}.`;
    notes.push(
      `Request denied by a rules resource limit: ${citedSentence} `
      + 'The limit is per request, so no other allow rule or match block was evaluated.',
    );
    return {
      decision: 'DENY',
      trace,
      notes,
      resourceLimit,
    };
  };
  for (const { kind, rule, index } of matchingRules) {
    if (kind === 'budget') {
      ctx.trace = undefined;
      try {
        evaluate(rule.condition, ctx);
      } catch (e) {
        if (e instanceof ResourceLimitError) {
          return abortOnResourceLimit(e, newEntry(rule, index, sourceMap));
        }
      }
      continue;
    }
    const entry = newEntry(rule, index, sourceMap);
    const recorder = new TraceRecorder();
    ctx.trace = recorder;
    try {
      // The condition must be a bool: any other value is a type error, which
      // the catch below records as this rule's ERROR verdict.
      const isAllowed = requireBoolean(evaluate(rule.condition, ctx), rule.condition);
      entry.expressionTrace = recorder.entries;
      if (isAllowed) {
        entry.verdict = 'ALLOW';
        record(entry);
        ctx.trace = priorRecorder;
        return { decision: 'ALLOW', trace, notes };
      }
      entry.verdict = 'DENY';
      record(entry);
    } catch (e) {
      entry.expressionTrace = recorder.entries;
      // A per-request resource limit (the document access budget) is not a
      // failure of THIS rule: production stops the whole request there, so
      // no sibling allow rule and no other match block gets a chance to
      // grant. Abandon the loop and report the limit up to the caller.
      if (e instanceof ResourceLimitError) {
        return abortOnResourceLimit(e, entry);
      }
      if (e instanceof UnsupportedError) {
        sawUnsupported = true;
        entry.verdict = 'UNSUPPORTED';
        entry.message = e.message;
      } else {
        entry.verdict = 'ERROR';
        if (e instanceof Error) {
          entry.message = e.message;
        } else {
          entry.message = String(e);
        }
      }
      record(entry);
    }
  }
  ctx.trace = priorRecorder;

  // No rule allowed. If at least one rule abstained on a sim gap, escalate
  // to UNSUPPORTED so the agent sees "sim couldn't decide" rather than a
  // misleading DENY. If every failure was a real eval error, return DENY
  // (production would also deny on runtime errors).
  let finalDecision: Decision = 'DENY';
  if (sawUnsupported) {
    finalDecision = 'UNSUPPORTED';
  }
  return { decision: finalDecision, trace, notes };
}

function newEntry(rule: AllowRule, index: number, sourceMap?: AuthoredSourceMap): RuleEvaluation {
  const condText = assembleExpression(rule.condition);
  const entry: RuleEvaluation = {
    ruleIndex: index,
    operations: [...rule.operations],
    verdict: 'DENY',
    conditionText: condText,
  };
  const loc = rule.loc;
  if (loc !== undefined) {
    entry.line = loc.line;
    entry.col = loc.col;
    entry.column = loc.col;
    if (loc.file !== undefined) {
      entry.file = loc.file;
      entry.citation = `${loc.file}:${loc.line}:${loc.col}`;
    } else {
      entry.file = 'firestore.rules';
      entry.citation = `firestore.rules:${loc.line}:${loc.col}`;
    }
    if (sourceMap !== undefined) {
      const authored = resolveAuthoredLoc(sourceMap, loc.line, loc.col, loc.file, condText);
      if (authored !== undefined) {
        entry.line = authored.line;
        entry.col = authored.col;
        entry.column = authored.col;
        entry.file = authored.file;
        entry.citation = authored.citation;
        if (authored.expression !== undefined) {
          entry.conditionText = authored.expression;
        }
      }
    }
  }
  return entry;
}
