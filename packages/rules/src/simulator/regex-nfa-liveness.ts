/**
 * Backward liveness analysis for `compileRegexSearch` in `regex-nfa.ts`.
 *
 * Computes `LiveStates` for a subject in one backward pass so the Pike VM can
 * drop threads that can no longer reach the accept state.
 */

export type NfaState =
  | { kind: 'char'; test: (ch: string) => boolean; out: number }
  | { kind: 'assert'; check: (chars: readonly string[], pos: number) => boolean; out: number }
  | { kind: 'save'; slot: number; out: number }
  | { kind: 'split'; out1: number; out2: number }
  | { kind: 'accept' };

export interface Nfa {
  states: NfaState[];
  start: number;
  hasAsserts: boolean;
}

/** Most states times subject positions a `Liveness` pass may visit; past it the VM keeps every thread. */
const LIVENESS_WORK_LIMIT = 1 << 26;

/** Most bytes of live-state sets a `Liveness` pass may keep; past it the VM keeps every thread. */
const LIVENESS_BYTES_LIMIT = 1 << 22;

/** For each position of one subject, the NFA states from which a match can still end. */
export interface LiveStates {
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
export class Liveness {
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
