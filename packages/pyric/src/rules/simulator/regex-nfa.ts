/**
 * Linear-time regular expression matching: a Thompson NFA state-set
 * simulation over a parsed pattern. A rules dialect parses its own syntax
 * into a `RegexNode` tree (the Firestore and Storage RE2 dialect in
 * `rules-type.ts`, the RTDB dialect in `rules/rtdb/grammar/regex.ts`) and
 * matches it here, so nested quantifiers like `(a+)+` never backtrack.
 */

export type RegexNode =
  | { kind: 'empty' }
  | { kind: 'char'; test: (ch: string) => boolean }
  | { kind: 'assert'; check: (chars: readonly string[], pos: number) => boolean }
  | { kind: 'seq'; items: RegexNode[] }
  | { kind: 'alt'; left: RegexNode; right: RegexNode }
  | { kind: 'rep'; body: RegexNode; min: number; max: number; greedy?: boolean };

type NfaState =
  | { kind: 'char'; test: (ch: string) => boolean; out: number }
  | { kind: 'assert'; check: (chars: readonly string[], pos: number) => boolean; out: number }
  | { kind: 'split'; out1: number; out2: number }
  | { kind: 'accept' };

/**
 * Whether `chars` as a whole matches `ast`, in O(states * chars) time. The
 * caller splits the subject into the units its dialect matches one at a time
 * (code points for RE2, UTF-16 code units for RTDB).
 */
export function matchesRegexNode(ast: RegexNode, chars: readonly string[]): boolean {
  return simulateNfa(buildNfa(ast), chars);
}

/** A compiled pattern: whether `chars` as a whole matches it. */
export type RegexMatcher = (chars: readonly string[]) => boolean;

/**
 * Build the NFA for `ast` once, for a caller that matches one pattern many
 * times. A pattern without assertions also caches the state sets it reaches
 * (a lazily built DFA), so a match costs one lookup per character once its
 * transitions are known, and never more than O(states) per character.
 */
export function compileRegexNode(ast: RegexNode): RegexMatcher {
  const nfa = buildNfa(ast);
  if (nfa.hasAsserts) return (chars) => simulateNfa(nfa, chars);
  const dfa = new LazyDfa(nfa);
  return (chars) => dfa.matches(chars);
}

interface Nfa {
  states: NfaState[];
  start: number;
  hasAsserts: boolean;
}

function buildNfa(ast: RegexNode): Nfa {
  const states: NfaState[] = [{ kind: 'accept' }];
  const addState = (st: NfaState): number => {
    const id = states.length;
    states.push(st);
    return id;
  };
  const emit = (node: RegexNode, out: number): number => {
    switch (node.kind) {
      case 'empty':
        return out;
      case 'char':
        return addState({ kind: 'char', test: node.test, out });
      case 'assert':
        return addState({ kind: 'assert', check: node.check, out });
      case 'seq': {
        let cur = out;
        for (let i = node.items.length - 1; i >= 0; i--) {
          cur = emit(node.items[i]!, cur);
        }
        return cur;
      }
      case 'alt': {
        const a = emit(node.left, out);
        const b = emit(node.right, out);
        return addState({ kind: 'split', out1: a, out2: b });
      }
      case 'rep': {
        // `out1` is the branch a leftmost-first search prefers: one more
        // repeat when greedy, the exit when not.
        const choose = (more: number, exit: number): NfaState =>
          node.greedy === false ? { kind: 'split', out1: exit, out2: more } : { kind: 'split', out1: more, out2: exit };
        let tail = out;
        if (node.max === Infinity) {
          const splitId = addState(choose(0, out));
          const loopBody = emit(node.body, splitId);
          states[splitId] = choose(loopBody, out);
          tail = splitId;
        } else {
          for (let k = node.min; k < node.max; k++) {
            const optBody = emit(node.body, tail);
            tail = addState(choose(optBody, tail));
          }
        }
        for (let k = node.min - 1; k >= 0; k--) {
          tail = emit(node.body, tail);
        }
        return tail;
      }
    }
  };
  const start = emit(ast, 0);
  const hasAsserts = states.some((st) => st.kind === 'assert');
  return { states, start, hasAsserts };
}

function simulateNfa(nfa: Nfa, chars: readonly string[]): boolean {
  const closure = new Closure(nfa.states);
  let current = closure.of([nfa.start], chars, 0);
  for (let pos = 0; pos < chars.length && current.length > 0; pos++) {
    current = closure.of(stepSeeds(nfa.states, current, chars[pos]!), chars, pos + 1);
  }
  return current.includes(0);
}

/** The states each char state in `current` moves to on `ch`. */
function stepSeeds(states: readonly NfaState[], current: readonly number[], ch: string): number[] {
  const seeds: number[] = [];
  for (const id of current) {
    const st = states[id]!;
    if (st.kind === 'char' && st.test(ch)) seeds.push(st.out);
  }
  return seeds;
}

/**
 * Epsilon closure with one visited-mark array per matcher: a closure costs
 * the states it reaches, not a fresh array the size of the NFA.
 */
class Closure {
  private readonly marks: Uint32Array;
  private mark = 0;

  constructor(private readonly states: readonly NfaState[]) {
    this.marks = new Uint32Array(states.length);
  }

  /** The char and accept states reachable from `seeds` without reading a character. */
  of(seeds: readonly number[], chars: readonly string[], pos: number): number[] {
    this.nextMark();
    const stack = [...seeds];
    const active: number[] = [];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (this.marks[id] === this.mark) continue;
      this.marks[id] = this.mark;
      const st = this.states[id]!;
      if (st.kind === 'split') {
        stack.push(st.out1, st.out2);
      } else if (st.kind === 'assert') {
        if (st.check(chars, pos)) stack.push(st.out);
      } else {
        active.push(id);
      }
    }
    return active;
  }

  private nextMark(): void {
    this.mark++;
    if (this.mark !== 0xffffffff) return;
    this.marks.fill(0);
    this.mark = 1;
  }
}

/** Upper bound on state ids plus transitions a `LazyDfa` keeps before it starts over. */
const DFA_CACHE_ENTRIES = 1 << 22;
const NO_CHARS: readonly string[] = [];

/**
 * A DFA built on demand from an assertion-free NFA: each set of NFA states
 * reached is interned once, and each (set, character) transition is cached.
 * The cache is dropped and rebuilt when it holds more than
 * `DFA_CACHE_ENTRIES` state ids and transitions, so memory stays bounded and a match never
 * costs more than the plain NFA simulation per character.
 */
class LazyDfa {
  private readonly closure: Closure;
  private sets: number[][] = [];
  private accepting: boolean[] = [];
  private transitions: Map<string, number>[] = [];
  private index = new Map<string, number>();
  private stored = 0;
  private start = 0;

  constructor(private readonly nfa: Nfa) {
    this.closure = new Closure(nfa.states);
    this.reset();
  }

  matches(chars: readonly string[]): boolean {
    let current = this.start;
    for (const ch of chars) {
      current = this.step(current, ch);
      const dead = this.sets[current]!.length === 0;
      if (dead) return false;
    }
    return this.accepting[current]!;
  }

  private step(from: number, ch: string): number {
    const known = this.transitions[from]!.get(ch);
    if (known !== undefined) return known;
    const next = this.closure.of(stepSeeds(this.nfa.states, this.sets[from]!, ch), NO_CHARS, 0);
    if (this.stored + next.length + 1 > DFA_CACHE_ENTRIES) {
      this.reset();
      return this.intern(next);
    }
    const target = this.intern(next);
    this.transitions[from]!.set(ch, target);
    this.stored++;
    return target;
  }

  private intern(set: number[]): number {
    set.sort((a, b) => a - b);
    const key = set.join(',');
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;
    const id = this.sets.length;
    this.sets.push(set);
    this.accepting.push(set.includes(0));
    this.transitions.push(new Map());
    this.index.set(key, id);
    this.stored += set.length;
    return id;
  }

  private reset(): void {
    this.sets = [];
    this.accepting = [];
    this.transitions = [];
    this.index = new Map();
    this.stored = 0;
    this.start = this.intern(this.closure.of([this.nfa.start], NO_CHARS, 0));
  }
}

/**
 * `ast` with each repeat's greediness set from `greedy`, given in the order
 * the parser built the repeats: a repeat's body before the repeat, a
 * sequence left to right, an alternation's left side first. A list whose
 * length is not the tree's repeat count leaves `ast` unchanged.
 */
export function withRepeatGreediness(ast: RegexNode, greedy: readonly boolean[]): RegexNode {
  let next = 0;
  const annotate = (node: RegexNode): RegexNode => {
    switch (node.kind) {
      case 'seq':
        return { kind: 'seq', items: node.items.map(annotate) };
      case 'alt': {
        const left = annotate(node.left);
        return { kind: 'alt', left, right: annotate(node.right) };
      }
      case 'rep': {
        const body = annotate(node.body);
        return { ...node, body, greedy: greedy[next++] ?? true };
      }
      default:
        return node;
    }
  };
  const annotated = annotate(ast);
  return next === greedy.length ? annotated : ast;
}

/** Where a match starts or ends: an index into `chars`, or the lead unit's position. */
export type RegexPosition = number | 'lead';

export interface RegexSpan {
  start: RegexPosition;
  end: RegexPosition;
}

/**
 * One unit read before `chars[from]`, for a search that starts inside the
 * character before it (the low half of a surrogate pair, after `split()`
 * steps one code unit past an empty match). Assertions at its position see
 * `context` at `pos`.
 */
export interface LeadUnit {
  unit: string;
  context: readonly string[];
  pos: number;
}

/**
 * The leftmost match starting at or after `from`, or null. Among matches at
 * that start it returns the one RE2 picks: alternatives in order, a greedy
 * repeat taking as much as it can, a lazy one as little.
 */
export type RegexSearch = (chars: readonly string[], from: number, lead?: LeadUnit) => RegexSpan | null;

/**
 * Compile `ast` for leftmost-first search: a Pike VM that keeps its threads
 * in priority order, so one search costs O(states * chars) however the
 * pattern nests.
 */
export function compileRegexSearch(ast: RegexNode): RegexSearch {
  const nfa = buildNfa(ast);
  const closure = new OrderedClosure(nfa.states);
  return (chars, from, lead) => leftmostFirst(nfa, closure, { chars, from, lead });
}

interface Thread {
  state: number;
  start: RegexPosition;
}

interface SearchInput {
  chars: readonly string[];
  from: number;
  lead: LeadUnit | undefined;
}

interface StepResult {
  match: RegexSpan | null;
  next: Thread[];
}

function leftmostFirst(nfa: Nfa, closure: OrderedClosure, input: SearchInput): RegexSpan | null {
  const { chars, from, lead } = input;
  let found: RegexSpan | null = null;
  let threads: Thread[] = [];
  if (lead !== undefined) {
    const list = closure.of([{ state: nfa.start, start: 'lead' }], lead.context, lead.pos);
    ({ match: found, next: threads } = stepThreads(nfa.states, list, 'lead', lead.unit));
  }
  for (let pos = from; ; pos++) {
    const seeds = found === null ? [...threads, { state: nfa.start, start: pos }] : threads;
    if (seeds.length === 0) return found;
    const step = stepThreads(nfa.states, closure.of(seeds, chars, pos), pos, chars[pos]);
    if (step.match !== null) found = step.match;
    const atEnd = pos >= chars.length;
    if (atEnd) return found;
    threads = step.next;
  }
}

/**
 * Move each thread of `list`, in priority order, across `ch`. A thread at
 * the accept state is a match, and every thread after it has lower
 * priority, so it is dropped.
 */
function stepThreads(
  states: readonly NfaState[],
  list: readonly Thread[],
  pos: RegexPosition,
  ch: string | undefined,
): StepResult {
  const next: Thread[] = [];
  for (const thread of list) {
    const st = states[thread.state]!;
    if (st.kind === 'accept') return { match: { start: thread.start, end: pos }, next };
    const reads = st.kind === 'char' && ch !== undefined && st.test(ch);
    if (reads) next.push({ state: st.out, start: thread.start });
  }
  return { match: null, next };
}

/**
 * Epsilon closure that keeps priority order: a split's `out1` and all it
 * reaches come before its `out2`, and a state reached twice keeps the
 * thread that reached it first.
 */
class OrderedClosure {
  private readonly marks: Uint32Array;
  private mark = 0;

  constructor(private readonly states: readonly NfaState[]) {
    this.marks = new Uint32Array(states.length);
  }

  of(seeds: readonly Thread[], chars: readonly string[], pos: number): Thread[] {
    this.nextMark();
    const active: Thread[] = [];
    for (const seed of seeds) this.follow(seed, chars, pos, active);
    return active;
  }

  private follow(seed: Thread, chars: readonly string[], pos: number, active: Thread[]): void {
    const stack = [seed.state];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (this.marks[id] === this.mark) continue;
      this.marks[id] = this.mark;
      const st = this.states[id]!;
      if (st.kind === 'split') stack.push(st.out2, st.out1);
      else if (st.kind === 'assert') this.followAssert(st, chars, pos, stack);
      else active.push({ state: id, start: seed.start });
    }
  }

  private followAssert(
    st: Extract<NfaState, { kind: 'assert' }>,
    chars: readonly string[],
    pos: number,
    stack: number[],
  ): void {
    if (st.check(chars, pos)) stack.push(st.out);
  }

  private nextMark(): void {
    this.mark++;
    if (this.mark !== 0xffffffff) return;
    this.marks.fill(0);
    this.mark = 1;
  }
}
