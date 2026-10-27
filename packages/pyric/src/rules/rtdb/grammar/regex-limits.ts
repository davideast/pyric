/**
 * Bounds on an RTDB regex literal, checked while it parses and before any
 * matcher is built, so a short pattern such as `((a{1000}){1000}){1000}`
 * cannot exhaust memory or the stack on the CLI host, Studio or the sandbox.
 *
 * Two follow production's deploy check:
 *   - a repeat count past 2^31 - 1 fails as Java's `Integer.parseInt` fails,
 *     `For input string: "2147483648"` (r58);
 *   - a pattern too large to determinize fails "Illegal regular expression,
 *     could not determinize efficiently": `a{100000}` (r59) and
 *     `(a{1000}){1000}` (r60) do, and every accepted corpus pattern (12
 *     positions at most) does not. Production's exact threshold is
 *     unobserved; pyric refuses a pattern with more than `MAX_REGEX_POSITIONS`
 *     character positions once repeats are expanded.
 *
 * Two are pyric's own, with messages that say so: the NFA state count (a
 * repeat of an empty group has no positions but still expands), and the
 * nesting depth. Production timed out after 300 s on 3,000 nested groups
 * (r61), so its verdict there is unobserved.
 */
import type { RegexNode } from '../../simulator/regex-nfa.js';

/** The largest repeat count, `2^31 - 1`. */
export const MAX_REPEAT_COUNT = 2147483647;

/** The most character positions a pattern may expand to: `a{10000}` fits, `a{100000}` (r59) does not. */
export const MAX_REGEX_POSITIONS = 10000;

/** The most matcher states a pattern may expand to, a limit of pyric. */
export const MAX_REGEX_STATES = 200000;

/** How deep groups and chained quantifiers may nest, a limit of pyric. */
export const MAX_REGEX_NESTING = 1000;

/** Production's text for a repeat count `Integer.parseInt` cannot read (r58). */
export function repeatCountMessage(digits: string): string {
  return `For input string: "${digits}"`;
}

/** Production's text for a pattern too large to determinize (r59, r60). */
export const DETERMINIZE_MESSAGE = 'Illegal regular expression, could not determinize efficiently';

export const STATES_MESSAGE =
  `Regular expression expands to more than ${MAX_REGEX_STATES} matcher states: ` +
  `pyric matches at most ${MAX_REGEX_STATES}, a limit of pyric, not of production.`;

export const NESTING_MESSAGE =
  `Regular expression groups and quantifiers nest more than ${MAX_REGEX_NESTING} levels deep: ` +
  `pyric reads at most ${MAX_REGEX_NESTING}, a limit of pyric, not of production.`;

/** The first limit `node` passes, as its refusal message, or null. */
export function sizeProblem(node: RegexNode): string | null {
  if (positionCount(node) > MAX_REGEX_POSITIONS) return DETERMINIZE_MESSAGE;
  if (stateCount(node) > MAX_REGEX_STATES) return STATES_MESSAGE;
  return null;
}

/**
 * How many character positions `node` has once its repeats are expanded,
 * the size of the position automaton. Stops counting past `MAX_REGEX_POSITIONS`.
 */
export function positionCount(node: RegexNode): number {
  switch (node.kind) {
    case 'empty':
      return 0;
    case 'char':
    case 'assert':
      return 1;
    case 'seq':
      return boundedSum(node.items.map(positionCount), MAX_REGEX_POSITIONS);
    case 'alt':
      return boundedSum([positionCount(node.left), positionCount(node.right)], MAX_REGEX_POSITIONS);
    case 'rep':
      return repeatPositions(positionCount(node.body), node.min, node.max);
  }
}

function repeatPositions(body: number, min: number, max: number): number {
  if (max === 0 || body === 0) return 0;
  if (body === Infinity) return Infinity;
  const copies = max === Infinity ? min + 1 : max;
  return boundedSum([body * copies], MAX_REGEX_POSITIONS);
}

/**
 * How many NFA states `node` expands to, counted as `regex-nfa.ts` emits
 * them. Stops counting once the total passes `MAX_REGEX_STATES`.
 */
export function stateCount(node: RegexNode): number {
  switch (node.kind) {
    case 'empty':
      return 0;
    case 'char':
    case 'assert':
      return 1;
    case 'seq':
      return boundedSum(node.items.map(stateCount), MAX_REGEX_STATES);
    case 'alt':
      return boundedSum([stateCount(node.left), stateCount(node.right), 1], MAX_REGEX_STATES);
    case 'rep':
      return repeatStates(stateCount(node.body), node.min, node.max);
  }
}

function repeatStates(body: number, min: number, max: number): number {
  if (max === 0) return 0;
  if (body === Infinity) return Infinity;
  const unbounded = max === Infinity;
  if (unbounded) return boundedSum([body * (min + 1), 1], MAX_REGEX_STATES);
  return boundedSum([(max - min) * (body + 1), min * body], MAX_REGEX_STATES);
}

function boundedSum(counts: readonly number[], limit: number): number {
  let total = 0;
  for (const count of counts) {
    total += count;
    if (total > limit) return Infinity;
  }
  return total;
}
