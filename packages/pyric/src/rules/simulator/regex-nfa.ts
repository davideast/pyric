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
  | { kind: 'rep'; body: RegexNode; min: number; max: number };

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
        let tail = out;
        if (node.max === Infinity) {
          const splitId = addState({ kind: 'split', out1: 0, out2: out });
          const loopBody = emit(node.body, splitId);
          states[splitId] = { kind: 'split', out1: loopBody, out2: out };
          tail = splitId;
        } else {
          for (let k = node.min; k < node.max; k++) {
            const optBody = emit(node.body, tail);
            tail = addState({ kind: 'split', out1: optBody, out2: tail });
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
