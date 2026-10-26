/**
 * `||` and `&&` chains match flat and are folded in a loop (LD-7, #1247).
 * The fold must evaluate exactly as the left-nested pairs did: left to right,
 * stopping at the first deciding term, with an error or a non-boolean
 * operand failing the whole rule wherever the evaluation reaches it. An error
 * is never absorbed: `error || true` and `error && false` fail (corpus r26,
 * r41), while `true || error` and `false && error` never reach the error.
 *
 * Every chain of up to four terms drawn from a true, a false, an erroring and
 * a non-boolean operand, joined by every mix of `||` and `&&`, is checked
 * against a reference evaluator of the old left-nested semantics and against
 * the same chain written with every pair in explicit parentheses.
 */
import { describe, expect, test } from 'bun:test';
import { DataSnapshot, evaluateRtdbExpression } from '../../../../src/rules/rtdb/grammar/simulator.js';
import { validateExpression } from '../../../../src/rules/rtdb/grammar/validator.js';

const ctx = {
  auth: null,
  data: new DataSnapshot(null),
  newData: new DataSnapshot(null),
  root: new DataSnapshot({}),
  now: 0,
  pathVariableBindings: {},
};

type Term = 'T' | 'F' | 'E' | 'N';
type Op = '||' | '&&';

/** `E` takes the parent of the root, a runtime error; `N` is a number. */
const SOURCE: Record<Term, string> = { T: 'true', F: 'false', E: 'root.parent() == 1', N: '1' };

type Outcome = { value: boolean } | { error: string };

function outcome(run: () => unknown): Outcome {
  try {
    return { value: run() as boolean };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** A parse tree with the grammar's precedence: `&&` binds tighter than `||`, both left-associative. */
type Tree = Term | { op: Op; left: Tree; right: Tree };

function treeOf(terms: Term[], ops: Op[]): Tree {
  const disjuncts: Tree[] = [];
  let current: Tree = terms[0]!;
  ops.forEach((op, i) => {
    const next = terms[i + 1]!;
    if (op === '&&') current = { op: '&&', left: current, right: next };
    else {
      disjuncts.push(current);
      current = next;
    }
  });
  disjuncts.push(current);
  return disjuncts.reduce((left, right) => ({ op: '||', left, right }));
}

function parenthesized(tree: Tree): string {
  return typeof tree === 'string' ? SOURCE[tree] : `(${parenthesized(tree.left)} ${tree.op} ${parenthesized(tree.right)})`;
}

/** The left-nested evaluation the grammar's binary actions performed before chains matched flat. */
function reference(tree: Tree): boolean {
  if (typeof tree === 'string') {
    if (tree === 'E') throw new Error(outcomeOfE);
    return (tree === 'N' ? 1 : tree === 'T') as boolean;
  }
  const l = reference(tree.left);
  if (typeof l !== 'boolean') throw new Error(`Left operand of ${tree.op} must be boolean.`);
  if (tree.op === '||' ? l : !l) return l;
  const r = reference(tree.right);
  if (typeof r !== 'boolean') throw new Error(`Right operand of ${tree.op} must be boolean.`);
  return r;
}

const outcomeOfE = (() => {
  const e = outcome(() => evaluateRtdbExpression(SOURCE.E, ctx as never));
  if (!('error' in e)) throw new Error('the erroring term must error');
  return e.error;
})();

function* chains(maxTerms: number): Generator<{ terms: Term[]; ops: Op[] }> {
  const all: Term[] = ['T', 'F', 'E', 'N'];
  for (let n = 2; n <= maxTerms; n++) {
    for (let t = 0; t < all.length ** n; t++) {
      const terms = Array.from({ length: n }, (_, i) => all[Math.floor(t / all.length ** i) % all.length]!);
      for (let o = 0; o < 2 ** (n - 1); o++) {
        const ops = Array.from({ length: n - 1 }, (_, i) => ((o >> i) & 1 ? '&&' : '||') as Op);
        yield { terms, ops };
      }
    }
  }
}

function flat(terms: Term[], ops: Op[]): string {
  return terms.map((term, i) => (i === 0 ? SOURCE[term] : `${ops[i - 1]} ${SOURCE[term]}`)).join(' ');
}

describe('RTDB || and && chains fold as the left-nested pairs evaluate', () => {
  test('the absorption cases the rules language fixes', () => {
    const run = (source: string) => outcome(() => evaluateRtdbExpression(source, ctx as never));
    expect(run(`${SOURCE.E} || true`)).toEqual({ error: outcomeOfE });
    expect(run(`${SOURCE.E} && false`)).toEqual({ error: outcomeOfE });
    expect(run(`true || ${SOURCE.E}`)).toEqual({ value: true });
    expect(run(`false && ${SOURCE.E}`)).toEqual({ value: false });
    expect(run(`false || false || ${SOURCE.E} || true`)).toEqual({ error: outcomeOfE });
    expect(run(`true && true && ${SOURCE.E} && false`)).toEqual({ error: outcomeOfE });
    expect(run(`false || true || ${SOURCE.E}`)).toEqual({ value: true });
    expect(run(`true && false && ${SOURCE.E}`)).toEqual({ value: false });
    expect(run('1 || true')).toEqual({ error: 'Left operand of || must be boolean.' });
    expect(run('false || false || 1')).toEqual({ error: 'Right operand of || must be boolean.' });
    expect(run('true && true && 1')).toEqual({ error: 'Right operand of && must be boolean.' });
  });

  test('every mixed chain of up to four terms evaluates as its reference and its parenthesized form', () => {
    let checked = 0;
    for (const { terms, ops } of chains(4)) {
      const tree = treeOf(terms, ops);
      const source = flat(terms, ops);
      const expected = outcome(() => reference(tree));
      expect(outcome(() => evaluateRtdbExpression(source, ctx as never)), source).toEqual(expected);
      expect(outcome(() => evaluateRtdbExpression(parenthesized(tree), ctx as never)), parenthesized(tree)).toEqual(expected);
      checked++;
    }
    expect(checked).toBe(16 * 2 + 64 * 4 + 256 * 8);
  });

  test('the static check reports the same operand errors for a chain and its parenthesized form', () => {
    for (const { terms, ops } of chains(4)) {
      const tree = treeOf(terms, ops);
      expect(validateExpression(flat(terms, ops), 'read'), flat(terms, ops)).toEqual(validateExpression(parenthesized(tree), 'read'));
    }
  });
});
