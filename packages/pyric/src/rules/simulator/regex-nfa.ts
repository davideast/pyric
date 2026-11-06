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
  | { kind: 'seq'; items: RegexNode[]; capture?: number }
  | { kind: 'alt'; left: RegexNode; right: RegexNode }
  | { kind: 'rep'; body: RegexNode; min: number; max: number; greedy?: boolean };

/**
 * A `seq` with a `capture` number is that capture group: a search records
 * where it starts and ends in slots `2 * capture` and `2 * capture + 1`.
 */
type NfaState =
  | { kind: 'char'; test: (ch: string) => boolean; out: number }
  | { kind: 'assert'; check: (chars: readonly string[], pos: number) => boolean; out: number }
  | { kind: 'save'; slot: number; out: number }
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
        const { capture } = node;
        let cur = capture === undefined ? out : addState({ kind: 'save', slot: 2 * capture + 1, out });
        for (let i = node.items.length - 1; i >= 0; i--) {
          cur = emit(node.items[i]!, cur);
        }
        return capture === undefined ? cur : addState({ kind: 'save', slot: 2 * capture, out: cur });
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
      } else if (st.kind === 'save') {
        stack.push(st.out);
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


/** Where a match starts or ends: an index into `chars`, or the lead unit's position. */
export type RegexPosition = number | 'lead';

/** Capture slots by number: group `k` starts at slot `2k` and ends at `2k + 1`. */
export type RegexSlots = readonly (RegexPosition | undefined)[];

export interface RegexSpan {
  start: RegexPosition;
  end: RegexPosition;
  slots: RegexSlots;
}

/**
 * One unit read before `chars[from]`, for a search that starts inside the
 * character before it (the low half of a surrogate pair, after `split()` or
 * `replace()` steps one code unit past an empty match). Assertions at its
 * position see `context` at `pos`.
 */
export interface LeadUnit {
  unit: string;
  context: readonly string[];
  pos: number;
}

/**
 * The leftmost match starting at or after `from`, or null. Among matches at
 * that start it returns the one RE2 picks: alternatives in order, a greedy
 * repeat taking as much as it can, a lazy one as little. Its slots hold
 * where each capture group last matched. A caller searches one `chars`
 * array many times without changing it.
 */
export type RegexSearch = (chars: readonly string[], from: number, lead?: LeadUnit) => RegexSpan | null;

/**
 * Compile `ast` for leftmost-first search: a Pike VM that keeps its threads
 * in priority order, so one search costs O(states * chars) however the
 * pattern nests. Before the first search of a subject it marks, from the
 * end backwards, which states can still reach a match at each position, and
 * the VM drops every other thread. A higher-priority thread that cannot
 * match, such as `.*x` in `.*x|a` on a subject with no `x`, then ends where
 * it starts instead of reading to the end of the subject on every search,
 * so a `split()` or `replace()` that searches once per match stays linear
 * in the subject.
 */
export function compileRegexSearch(ast: RegexNode): RegexSearch {
  const nfa = buildNfa(ast);
  const closure = new OrderedClosure(nfa.states);
  const liveness = new Liveness(nfa);
  // Keyed weakly, so a compiled pattern does not keep its last subject alive.
  const liveBySubject = new WeakMap<readonly string[], LiveStates | null>();
  return (chars, from, lead) => {
    let live = liveBySubject.get(chars);
    if (live === undefined) {
      live = liveness.of(chars);
      liveBySubject.set(chars, live);
    }
    return leftmostFirst(nfa, closure, { chars, from, lead, live });
  };
}

interface Thread {
  state: number;
  start: RegexPosition;
  slots: RegexSlots;
}

interface SearchInput {
  chars: readonly string[];
  from: number;
  lead: LeadUnit | undefined;
  live: LiveStates | null;
}

interface StepResult {
  match: RegexSpan | null;
  next: Thread[];
}

const NO_SLOTS: RegexSlots = [];

function leftmostFirst(nfa: Nfa, closure: OrderedClosure, input: SearchInput): RegexSpan | null {
  const { chars, from, lead, live } = input;
  let found: RegexSpan | null = null;
  let threads: Thread[] = [];
  if (lead !== undefined) {
    const seed: Thread = { state: nfa.start, start: 'lead', slots: NO_SLOTS };
    const list = closure.of([seed], { chars: lead.context, pos: lead.pos, at: 'lead', live: null });
    ({ match: found, next: threads } = stepThreads(nfa.states, list, 'lead', lead.unit));
  }
  for (let pos = from; ; pos++) {
    const seeds = found === null ? [...threads, { state: nfa.start, start: pos, slots: NO_SLOTS }] : threads;
    if (seeds.length === 0) return found;
    const list = closure.of(seeds, { chars, pos, at: pos, live });
    const step = stepThreads(nfa.states, list, pos, chars[pos]);
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
    if (st.kind === 'accept') return { match: { start: thread.start, end: pos, slots: thread.slots }, next };
    const reads = st.kind === 'char' && ch !== undefined && st.test(ch);
    if (reads) next.push({ state: st.out, start: thread.start, slots: thread.slots });
  }
  return { match: null, next };
}

/** Where an ordered closure runs: assertions read `chars` at `pos`, captures record `at`. */
interface ClosureInput {
  chars: readonly string[];
  pos: number;
  at: RegexPosition;
  /** The states that can still reach a match from `pos`, or null to keep every thread. */
  live: LiveStates | null;
}

interface PendingState {
  state: number;
  slots: RegexSlots;
}

/**
 * Epsilon closure that keeps priority order: a split's `out1` and all it
 * reaches come before its `out2`, and a state reached twice keeps the
 * thread that reached it first. A state that cannot reach a match is
 * dropped with all it leads to; any other thread reaching it later could
 * not match either.
 */
class OrderedClosure {
  private readonly marks: Uint32Array;
  private mark = 0;

  constructor(private readonly states: readonly NfaState[]) {
    this.marks = new Uint32Array(states.length);
  }

  of(seeds: readonly Thread[], input: ClosureInput): Thread[] {
    this.nextMark();
    const active: Thread[] = [];
    for (const seed of seeds) this.follow(seed, input, active);
    return active;
  }

  private follow(seed: Thread, input: ClosureInput, active: Thread[]): void {
    const stack: PendingState[] = [{ state: seed.state, slots: seed.slots }];
    while (stack.length > 0) {
      const { state: id, slots } = stack.pop()!;
      if (this.marks[id] === this.mark) continue;
      this.marks[id] = this.mark;
      const cannotMatch = input.live !== null && !input.live.has(id, input.pos);
      if (cannotMatch) continue;
      const st = this.states[id]!;
      if (st.kind === 'split') stack.push({ state: st.out2, slots }, { state: st.out1, slots });
      else if (st.kind === 'assert') this.followAssert(st, input, slots, stack);
      else if (st.kind === 'save') stack.push({ state: st.out, slots: withSlot(slots, st.slot, input.at) });
      else active.push({ state: id, start: seed.start, slots });
    }
  }

  private followAssert(
    st: Extract<NfaState, { kind: 'assert' }>,
    input: ClosureInput,
    slots: RegexSlots,
    stack: PendingState[],
  ): void {
    if (st.check(input.chars, input.pos)) stack.push({ state: st.out, slots });
  }

  private nextMark(): void {
    this.mark++;
    if (this.mark !== 0xffffffff) return;
    this.marks.fill(0);
    this.mark = 1;
  }
}

function withSlot(slots: RegexSlots, slot: number, at: RegexPosition): RegexSlots {
  const copy = slots.slice();
  copy[slot] = at;
  return copy;
}

/** Most states times subject positions a `Liveness` pass may visit; past it the VM keeps every thread. */
const LIVENESS_WORK_LIMIT = 1 << 26;

/** Most bytes of live-state sets a `Liveness` pass may keep; past it the VM keeps every thread. */
const LIVENESS_BYTES_LIMIT = 1 << 22;

/** For each position of one subject, the NFA states from which a match can still end. */
interface LiveStates {
  has(state: number, pos: number): boolean;
}

/**
 * Computes `LiveStates` for a subject in one backward pass: a state is live
 * at `pos` when it is the accept state, a char state that reads `chars[pos]`
 * into a state live at `pos + 1`, or an epsilon state (a split, a save, an
 * assertion that holds at `pos`) leading to a live state. Each distinct set
 * is kept once, and for a pattern without assertions the set at `pos`
 * depends only on the set at `pos + 1` and `chars[pos]`, so that step is
 * cached, a reverse DFA built as the pass needs it.
 */
class Liveness {
  private readonly predecessors: number[][];
  private readonly charStates: number[] = [];

  constructor(private readonly nfa: Nfa) {
    const { states } = nfa;
    this.predecessors = states.map(() => []);
    states.forEach((st, id) => {
      if (st.kind === 'char') this.charStates.push(id);
      for (const out of epsilonOuts(st)) this.predecessors[out]!.push(id);
    });
  }

  /** The live states of `chars`, or null when the pass would pass `LIVENESS_WORK_LIMIT` or `LIVENESS_BYTES_LIMIT`. */
  of(chars: readonly string[]): LiveStates | null {
    const size = this.nfa.states.length;
    const tooMuchWork = size * (chars.length + 1) > LIVENESS_WORK_LIMIT;
    if (tooMuchWork) return null;
    const sets = new InternedSets(size);
    const transitions: Map<string, number>[] = [];
    const setAt = new Int32Array(chars.length + 1);
    let after = -1;
    for (let pos = chars.length; pos >= 0; pos--) {
      const ch = chars[pos];
      const cacheable = !this.nfa.hasAsserts && after >= 0 && ch !== undefined;
      let id = cacheable ? transitions[after]!.get(ch) : undefined;
      if (id === undefined) {
        id = sets.intern(this.liveAt(chars, pos, after >= 0 ? sets.get(after) : null));
        if (sets.bytes > LIVENESS_BYTES_LIMIT) return null;
        transitions[id] ??= new Map();
        if (cacheable) transitions[after]!.set(ch, id);
      }
      setAt[pos] = id;
      after = id;
    }
    return { has: (state, pos) => sets.get(setAt[pos]!)[state] === 1 };
  }

  private liveAt(chars: readonly string[], pos: number, after: Uint8Array | null): Uint8Array {
    const { states } = this.nfa;
    const live = new Uint8Array(states.length);
    const work: number[] = [];
    const mark = (id: number): void => {
      if (live[id] === 1) return;
      live[id] = 1;
      work.push(id);
    };
    mark(0);
    const ch = chars[pos];
    if (after !== null && ch !== undefined) {
      for (const id of this.charStates) {
        const st = states[id] as Extract<NfaState, { kind: 'char' }>;
        if (after[st.out] === 1 && st.test(ch)) mark(id);
      }
    }
    while (work.length > 0) {
      for (const pred of this.predecessors[work.pop()!]!) {
        const st = states[pred]!;
        const blocked = st.kind === 'assert' && !st.check(chars, pos);
        if (!blocked) mark(pred);
      }
    }
    return live;
  }
}

/** The states an epsilon state moves to without reading a character. */
function epsilonOuts(st: NfaState): number[] {
  if (st.kind === 'split') return [st.out1, st.out2];
  if (st.kind === 'save' || st.kind === 'assert') return [st.out];
  return [];
}

/** Live-state sets, each distinct set stored once. */
class InternedSets {
  private readonly sets: Uint8Array[] = [];
  private readonly index = new Map<string, number>();

  constructor(private readonly size: number) {}

  get bytes(): number {
    return this.sets.length * this.size;
  }

  get(id: number): Uint8Array {
    return this.sets[id]!;
  }

  intern(set: Uint8Array): number {
    const key = set.join('');
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;
    this.sets.push(set);
    this.index.set(key, this.sets.length - 1);
    return this.sets.length - 1;
  }
}

/** A code-unit span of a subject. */
export interface UnitSpan {
  start: number;
  end: number;
}

/** A match in code-unit offsets, with each capture group's span, or undefined for a group that did not take part. */
export interface UnitMatch extends UnitSpan {
  group(index: number): UnitSpan | undefined;
}

/**
 * A subject read as code points, as RE2 reads it, and searched at code-unit
 * offsets, as `split()` and `replace()` step through it. A search from the
 * low half of a surrogate pair reads that half as a lead unit.
 */
export class CodePointSubject {
  private readonly chars: string[];
  /** The code-unit offset where each code point starts, and the subject's length. */
  private readonly offsets: number[] = [];
  /** For each code-unit offset, the code point starting there, or -1 inside a pair. */
  private readonly charAt: Int32Array;

  constructor(
    readonly text: string,
    private readonly search: RegexSearch,
  ) {
    this.chars = Array.from(text);
    this.charAt = new Int32Array(text.length + 1).fill(-1);
    let offset = 0;
    this.chars.forEach((ch, index) => {
      this.offsets.push(offset);
      this.charAt[offset] = index;
      offset += ch.length;
    });
    this.offsets.push(offset);
    this.charAt[offset] = this.chars.length;
  }

  /** The leftmost match at or after code-unit offset `from`, in code-unit offsets. */
  find(from: number): UnitMatch | null {
    const index = this.charAt[from]!;
    if (index >= 0) return this.toUnits(this.search(this.chars, index), from);
    // `from` is the low half of the pair before the next code point.
    const next = this.charAt[from + 1]!;
    const pair = this.text.slice(from - 1, from + 1);
    const lead: LeadUnit = { unit: pair[1]!, context: [pair[0]!, pair[1]!], pos: 1 };
    return this.toUnits(this.search(this.chars, next, lead), from);
  }

  private toUnits(span: RegexSpan | null, leadOffset: number): UnitMatch | null {
    if (span === null) return null;
    const unit = (pos: RegexPosition): number => (pos === 'lead' ? leadOffset : this.offsets[pos]!);
    const { slots } = span;
    const group = (index: number): UnitSpan | undefined => {
      const start = slots[2 * index];
      const end = slots[2 * index + 1];
      if (start === undefined || end === undefined) return undefined;
      return { start: unit(start), end: unit(end) };
    };
    return { start: unit(span.start), end: unit(span.end), group };
  }
}
