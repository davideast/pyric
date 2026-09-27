/**
 * Padding measurement of production Security Rules evaluation cost.
 *
 * Production stops an evaluation when it reaches "the maximum of 1000
 * expressions to evaluate" and reports it as a debug message on the denied
 * test result. It does not report how many expressions a request that stays
 * under the limit evaluated. The Rules Test API's `expressionReports` omit
 * literals and do not count what the limit counts, so they cannot stand in
 * for it.
 *
 * Padding recovers the count. A padding rule is inserted as the first
 * `allow` of the block a request resolves to. It is always false and its
 * cost grows by a fixed step with an integer the test case supplies as
 * `request.auth.token.pyric_pad`. The smallest padding that makes the
 * request reach the limit bounds the cost of everything else the request
 * evaluated: `P(n* - 1) + X < 1000 <= P(n*) + X`.
 *
 * The padding cost `P(n)` is itself measured, not assumed: anchor requests
 * evaluate the padding followed by a second padding of known length, and
 * `fitPadCost` solves for the linear model below from their thresholds.
 */

import { EXPRESSION_LIMIT } from '../../pyric/src/rules/linter/expression-cost.ts';

export { EXPRESSION_LIMIT };
export const PAD_TOKEN = 'pyric_pad';
export const PAD_SECOND_TOKEN = 'pyric_pad_second';
const SEGMENT = 40;
const SEGMENTS = 6;
/** Largest padding step. The padding is false for every n below it. */
export const PAD_MAX = SEGMENT * SEGMENTS - 1;
const PAD_FN = '__pyricPad';

/**
 * Right-nested segments of `n > k` terms. Production rejects a ruleset whose
 * expression nesting depth reaches roughly 50 ("Expression is too complex to
 * evaluate safely."), so each function nests 40 terms and calls the next
 * segment from its innermost position. Evaluation stops at the first false
 * term, `n > n`, so the cost grows by one term and one `&&` per step, plus
 * one segment call every 40 steps.
 */
export function padFunctions(): string {
  const out: string[] = [];
  for (let s = 0; s < SEGMENTS; s++) {
    let inner = s + 1 < SEGMENTS ? `${PAD_FN}${s + 1}(n)` : 'false';
    for (let i = SEGMENT - 1; i >= 0; i--) inner = `n > ${s * SEGMENT + i} && (${inner})`;
    out.push(`    function ${PAD_FN}${s}(n) {\n      return ${inner};\n    }`);
  }
  return out.join('\n');
}

export function padRule(method: string, token = PAD_TOKEN): string {
  return `allow ${method}: if ${PAD_FN}0(request.auth.token.${token});`;
}

const DOCUMENTS_BLOCK = /match\s+\/databases\/\{database\}\/documents\s*\{/;

/**
 * Insert the padding functions into the documents block and one padding rule
 * as the first statement of each anchored block. Each anchor must occur
 * exactly once in `rules`.
 */
export function injectPadding(rules: string, anchors: readonly { anchor: string; method: string }[]): string {
  const documents = DOCUMENTS_BLOCK.exec(rules);
  if (!documents) throw new Error('ruleset lacks a `match /databases/{database}/documents` block');
  const seen = new Set<string>();
  let out = rules;
  for (const { anchor, method } of anchors) {
    const key = `${anchor}\0${method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const first = out.indexOf(anchor);
    if (first === -1) throw new Error(`anchor not found: ${anchor}`);
    if (out.indexOf(anchor, first + 1) !== -1) throw new Error(`anchor occurs more than once: ${anchor}`);
    const at = first + anchor.length;
    out = `${out.slice(0, at)}\n      ${padRule(method)}${out.slice(at)}`;
  }
  const doc = DOCUMENTS_BLOCK.exec(out)!;
  const at = doc.index + doc[0].length;
  return `${out.slice(0, at)}\n${padFunctions()}${out.slice(at)}`;
}

/** Cost of the padding rule at step n: `base + perStep * (n + 1) + perSegment * floor(n / 40)`. */
export interface PadCostModel {
  base: number;
  perStep: number;
  perSegment: number;
}

export function padCost(model: PadCostModel, n: number): number {
  return model.base + model.perStep * (n + 1) + model.perSegment * Math.floor(n / SEGMENT);
}

/** Threshold of one measured request: the smallest n that reached the limit. */
export interface Threshold {
  /** Largest n observed below the limit, or -1. */
  below: number;
  /** Smallest n observed at the limit, or PAD_MAX + 1 when none did. */
  at: number;
}

/**
 * Anchor equation: padding(n) followed by padding(second) in the same block
 * reaches the limit between `below` and `at`. `second === null` means the
 * padding is followed by `allow ...: if false`, whose single literal is
 * counted as one expression.
 */
export interface PadAnchor {
  second: number | null;
  threshold: Threshold;
}

/**
 * Least-squares fit of the padding model to the anchor thresholds. Each
 * anchor contributes `mid(P(below), P(at)) + X = 1000`, where X is either the
 * second padding's cost or one expression.
 */
export function fitPadCost(anchors: readonly PadAnchor[]): PadCostModel {
  // Unknowns: base, perStep, perSegment. Build normal equations.
  const rows: { coef: [number, number, number]; rhs: number }[] = [];
  for (const { second, threshold } of anchors) {
    const { below, at } = threshold;
    if (below < 0 || at > PAD_MAX) continue;
    const mid = (f: (n: number) => number) => (f(below) + f(at)) / 2;
    const coef: [number, number, number] = [1, mid((n) => n + 1), mid((n) => Math.floor(n / SEGMENT))];
    let rhs = EXPRESSION_LIMIT;
    if (second === null) rhs -= 1;
    else {
      coef[0] += 1;
      coef[1] += second + 1;
      coef[2] += Math.floor(second / SEGMENT);
    }
    rows.push({ coef, rhs });
  }
  if (rows.length < 3) throw new Error('pad fit needs at least three bounded anchors');
  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const atb = [0, 0, 0];
  for (const { coef, rhs } of rows) {
    for (let i = 0; i < 3; i++) {
      atb[i] += coef[i] * rhs;
      for (let j = 0; j < 3; j++) ata[i][j] += coef[i] * coef[j];
    }
  }
  const [base, perStep, perSegment] = solve3(ata, atb);
  return { base, perStep, perSegment };
}

function solve3(a: number[][], b: number[]): [number, number, number] {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    if (Math.abs(m[col][col]) < 1e-9) throw new Error('pad fit is singular; anchors do not constrain the model');
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** Bounds on a request's cost from its threshold and the fitted padding. */
export function costBounds(model: PadCostModel, threshold: Threshold): { low: number; high: number } | null {
  const { below, at } = threshold;
  if (at > PAD_MAX) return null;
  const low = EXPRESSION_LIMIT - padCost(model, at);
  const high = below < 0 ? Infinity : EXPRESSION_LIMIT - padCost(model, below);
  return { low: Math.round(low * 10) / 10, high: Math.round(high * 10) / 10 };
}

/**
 * Candidate paddings for the next probe round of one request, or [] when its
 * threshold is resolved to adjacent steps. The first round centres on the
 * predicted step when one is given.
 */
export function nextCandidates(threshold: Threshold, points: number, predicted?: number): number[] {
  const { below, at } = threshold;
  if (at - below <= 1) return [];
  const lo = below + 1;
  const hi = Math.min(at - 1, PAD_MAX);
  if (hi < lo) return [];
  if (predicted !== undefined && below === -1 && at === PAD_MAX + 1) {
    const spread = 6;
    return [...new Set(Array.from({ length: points }, (_, i) => {
      const n = Math.round(predicted + (i - (points - 1) / 2) * spread);
      return Math.min(hi, Math.max(lo, n));
    }))];
  }
  const span = hi - lo + 1;
  if (span <= points) return Array.from({ length: span }, (_, i) => lo + i);
  return [...new Set(Array.from({ length: points }, (_, i) => lo + Math.floor(((i + 1) * span) / (points + 1))))];
}

/** Fold one probe result into a threshold. */
export function observe(threshold: Threshold, n: number, reachedLimit: boolean): Threshold {
  if (reachedLimit) return { below: threshold.below, at: Math.min(threshold.at, n) };
  return { below: Math.max(threshold.below, n), at: threshold.at };
}

export function isLimitMessage(notes: readonly string[]): boolean {
  return notes.some((note) => note.includes(`maximum of ${EXPRESSION_LIMIT} expressions`));
}

/** Anchor ruleset: padding then a false rule, and padding then a second padding. */
export function anchorRules(): string {
  return [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    padFunctions(),
    '    match /anchor-false/{id} {',
    `      ${padRule('get')}`,
    '      allow get: if false;',
    '    }',
    '    match /anchor-pad/{id} {',
    `      ${padRule('get')}`,
    `      ${padRule('get', PAD_SECOND_TOKEN)}`,
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}
