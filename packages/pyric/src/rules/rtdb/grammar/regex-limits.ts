/**
 * Bounds on an RTDB regex literal, checked while it parses and before any
 * matcher is built, so a short pattern such as `((a{1000}){1000}){1000}`
 * cannot exhaust memory or the stack on the CLI host, Studio or the sandbox.
 *
 * `MAX_REPEAT_COUNT` is the largest count Java's `Integer.parseInt` reads,
 * the call dk.brics.automaton makes for a repeat count. The other two are
 * limits of pyric, not of production; every pattern in the RTDB corpus is
 * far inside them.
 */
import type { RegexNode } from '../../simulator/regex-nfa.js';

/** The largest repeat count, `2^31 - 1`. */
export const MAX_REPEAT_COUNT = 2147483647;

/** The most matcher states a pattern may expand to. `a{100000}` fits; `a{10000000}` does not. */
export const MAX_REGEX_STATES = 200000;

/** How deep groups and chained quantifiers may nest. */
export const MAX_REGEX_NESTING = 1000;

export function repeatCountMessage(digits: string): string {
  return `Regular expression repeat count ${digits} is larger than ${MAX_REPEAT_COUNT}, the largest count pyric reads.`;
}

export const STATES_MESSAGE =
  `Regular expression expands to more than ${MAX_REGEX_STATES} matcher states: ` +
  `pyric matches at most ${MAX_REGEX_STATES}, a limit of pyric, not of production.`;

export const NESTING_MESSAGE =
  `Regular expression groups and quantifiers nest more than ${MAX_REGEX_NESTING} levels deep: ` +
  `pyric reads at most ${MAX_REGEX_NESTING}, a limit of pyric, not of production.`;

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
      return boundedSum(node.items.map(stateCount));
    case 'alt':
      return boundedSum([stateCount(node.left), stateCount(node.right), 1]);
    case 'rep':
      return repeatStates(stateCount(node.body), node.min, node.max);
  }
}

function repeatStates(body: number, min: number, max: number): number {
  if (max === 0) return 0;
  if (body === Infinity) return Infinity;
  const unbounded = max === Infinity;
  if (unbounded) return boundedSum([body * (min + 1), 1]);
  return boundedSum([(max - min) * (body + 1), min * body]);
}

function boundedSum(counts: readonly number[]): number {
  let total = 0;
  for (const count of counts) {
    total += count;
    if (total > MAX_REGEX_STATES) return Infinity;
  }
  return total;
}
