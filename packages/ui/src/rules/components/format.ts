import type { RuleEvaluation, ExprTraceEntry, LineVerdict, FirestoreMethod } from '../types.js';
import { truncateVectorsForDisplay } from '../../firestore/index.js';

/** Operations a request method satisfies — `update` matches `update` and
 *  `write`, etc. Mirrors the simulator's `methodToOperations`. */
export function methodOperations(method: FirestoreMethod): string[] {
  switch (method) {
    case 'get': return ['get', 'read'];
    case 'list': return ['list', 'read'];
    case 'create': return ['create', 'write'];
    case 'update': return ['update', 'write'];
    case 'delete': return ['delete', 'write'];
    default: return [method];
  }
}

/**
 * The allow rule that decided the denial: the last rule actually
 * evaluated (DENY/ERROR). Under OR semantics the simulator stops at the
 * first ALLOW; on a denial no rule allowed, so the deciding rule is the
 * last evaluated one — the closest miss the user should reason about.
 */
export function decidingEvaluation(evaluation: RuleEvaluation[]): RuleEvaluation | undefined {
  if (evaluation.length === 0) return undefined;
  // Prefer the last non-skipped (i.e. actually-evaluated) entry. Every
  // entry in `evaluation` was matched by method, so they're all
  // evaluated; the last is the deciding one.
  return evaluation[evaluation.length - 1];
}

/**
 * A plain-language reason for the denial, derived from the deciding
 * `RuleEvaluation`. Falls back to a no-match explanation when no allow
 * rule was evaluated.
 */
export function denialReason(
  evaluation: RuleEvaluation[],
  method: FirestoreMethod,
  path: string,
): string {
  const deciding = decidingEvaluation(evaluation);
  if (!deciding) {
    return `No security rule matched ${method} ${path}, so the request was denied by default.`;
  }
  if (deciding.verdict === 'UNSUPPORTED') {
    return (
      `The simulator couldn't evaluate the ${deciding.operations.join('/')} rule` +
      (deciding.message ? ` (${deciding.message})` : '') +
      ' — this is a gap in the local simulator, not necessarily your rule.'
    );
  }
  if (deciding.verdict === 'ERROR') {
    return (
      `The ${deciding.operations.join('/')} rule threw while evaluating` +
      (deciding.message ? `: ${deciding.message}` : '') +
      ', which denies the request.'
    );
  }
  const cond = deciding.conditionText
    ? `The ${deciding.operations.join('/')} rule requires ${deciding.conditionText}, which evaluated to false`
    : `The ${deciding.operations.join('/')} rule's condition evaluated to false`;
  return `${cond}, so the request was denied.`;
}

export interface RuleLine {
  number: number;
  text: string;
  verdict?: LineVerdict;
  /** A short note for skipped lines, e.g. "not checked, this is an update". */
  note?: string;
}

/**
 * Split the rules source into numbered lines and mark each `allow` line
 * with a verdict per the spec:
 *   - the deciding rule's line  → `deny`
 *   - an allow line whose operations don't include the method → `skip`
 *   - any other allow line      → `allow`
 *
 * Verdicts are matched to source lines via `RuleEvaluation.line` (1-indexed
 * `allow` keyword). Lines without a matching evaluation entry get no verdict.
 */
export function markRuleLines(
  rulesSource: string,
  evaluation: RuleEvaluation[],
  method: FirestoreMethod,
): RuleLine[] {
  const deciding = decidingEvaluation(evaluation);
  const ops = methodOperations(method);
  // line → verdict, from the evaluated rules.
  const byLine = new Map<number, LineVerdict>();
  const noteByLine = new Map<number, string>();
  for (const e of evaluation) {
    if (e.line == null) continue;
    if (e === deciding) byLine.set(e.line, 'deny');
    else byLine.set(e.line, 'allow');
  }
  // Detect skipped allow lines by scanning the source for `allow <ops>:`
  // declarations whose operations don't intersect the request method.
  const rawLines = rulesSource.split('\n');
  const allowRe = /^\s*allow\s+([a-z,\s]+?)\s*:/;
  return rawLines.map((text, i) => {
    const number = i + 1;
    const line: RuleLine = { number, text };
    const fromEval = byLine.get(number);
    if (fromEval) {
      line.verdict = fromEval;
      return line;
    }
    const m = allowRe.exec(text);
    if (m) {
      const declared = m[1].split(',').map(s => s.trim()).filter(Boolean);
      const matches = declared.some(op => ops.includes(op));
      if (!matches) {
        line.verdict = 'skip';
        line.note = `not checked, this is a ${method}`;
      } else {
        // Declared for this method but not in the evaluation trace
        // (e.g. a different match block). Treat as a normal allow line.
        line.verdict = 'allow';
      }
    }
    return line;
  });
}

/** Render a trace value the way the mock shows it: JSON-ish, quoted
 *  strings, `false`/`true`/`null` bare. */
export function formatValue(value: unknown): string {
  if (value === undefined) return '∅';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  try {
    // Truncate vectors so a real embedding never dumps its full array into a trace.
    return JSON.stringify(truncateVectorsForDisplay(value));
  } catch {
    return String(value);
  }
}

/** Depth of a trace node from its `parent` chain (0 for roots). */
export function traceDepth(entries: ExprTraceEntry[], index: number): number {
  let depth = 0;
  let cur = entries[index]?.parent ?? null;
  // Guard against malformed chains.
  let guard = 0;
  while (cur != null && guard < entries.length + 1) {
    depth++;
    cur = entries[cur]?.parent ?? null;
    guard++;
  }
  return depth;
}

/**
 * The set of scope variable roots whose deciding values appear in the
 * trace — `request.auth`, `request.resource.data`, `resource.data`.
 * Used to underline the values the rule actually read.
 */
export interface ScopeVar {
  /** The dotted path, e.g. `request.auth`. */
  name: string;
  /** A short human tag, e.g. "who made the request". */
  tag: string;
  /** The value to render. */
  value: unknown;
  /** Leaf keys whose values the rule read (for the `hit` underline). */
  hits: string[];
}
