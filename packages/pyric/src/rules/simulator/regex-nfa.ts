/**
 * Linear-time regular expression matching: a Thompson NFA state-set
 * simulation over a parsed pattern. A rules dialect parses its own syntax
 * into a `RegexNode` tree (the Firestore and Storage RE2 dialect does so in
 * `rules-type.ts`) and matches it here, so nested quantifiers like `(a+)+`
 * never backtrack.
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

  const startState = emit(ast, 0);
  let current = epsilonClosure([startState], states, chars, 0);
  for (let pos = 0; pos < chars.length && current.length > 0; pos++) {
    const ch = chars[pos]!;
    const nextSeeds: number[] = [];
    for (const id of current) {
      const st = states[id]!;
      if (st.kind === 'char' && st.test(ch)) {
        nextSeeds.push(st.out);
      }
    }
    current = epsilonClosure(nextSeeds, states, chars, pos + 1);
  }
  return current.includes(0);
}

function epsilonClosure(
  seeds: readonly number[],
  states: readonly NfaState[],
  chars: readonly string[],
  pos: number,
): number[] {
  const visited = new Uint8Array(states.length);
  const stack = [...seeds];
  const active: number[] = [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited[id]) continue;
    visited[id] = 1;
    const st = states[id]!;
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
