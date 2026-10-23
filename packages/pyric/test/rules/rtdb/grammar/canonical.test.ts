import { describe, expect, test } from 'bun:test';
import {
  RtdbExpressionSyntaxError,
  canonicalRtdbExpression as canonical,
} from '../../../../src/rules/rtdb/grammar/canonical.js';
import {
  parseRtdbExpressionTree,
  printRtdbExpressionTree,
} from '../../../../src/rules/rtdb/grammar/expression-tree.js';
import { findCounterexample, outcomeSpread, rng } from './equivalence-harness.js';

const same = (a: string, b: string) => expect(canonical(a)).toBe(canonical(b));
const differ = (a: string, b: string) => expect(canonical(a)).not.toBe(canonical(b));

describe('parseRtdbExpressionTree', () => {
  test('builds a typed tree that keeps === apart from ==', () => {
    const parsed = parseRtdbExpressionTree("auth.uid === $uid");
    expect(parsed).toEqual({
      ok: true,
      tree: {
        type: 'binary',
        operator: '===',
        left: { type: 'member', object: { type: 'identifier', name: 'auth' }, property: 'uid' },
        right: { type: 'identifier', name: '$uid' },
      },
    });
  });

  test('refuses what the parser refuses', () => {
    expect(parseRtdbExpressionTree('auth.uid = 1').ok).toBe(false);
    expect(parseRtdbExpressionTree("'a\nb' == 'c'").ok).toBe(false);
    expect(parseRtdbExpressionTree('(').ok).toBe(false);
    expect(() => canonical('auth.uid = 1')).toThrow(RtdbExpressionSyntaxError);
  });

  test('printing parses back to the same tree', () => {
    const sources = [
      "a && (b || c) && !(d == e)",
      "(a ? b : c) ? d : e ? f : g",
      "1 - (2 - 3) * -(4 % 5)",
      "root.child('x').val()[0].length > 2 == true",
      "\"q'uote\" + 'x\\ty' == [1, 'a', null]",
      "newData.val().matches(/^[a-z/]+$/i)",
    ];
    for (const source of sources) {
      const parsed = parseRtdbExpressionTree(source);
      if (!parsed.ok) throw new Error(parsed.message);
      const reparsed = parseRtdbExpressionTree(printRtdbExpressionTree(parsed.tree));
      expect(reparsed).toEqual(parsed);
    }
  });
});

describe('canonicalRtdbExpression: rewrites', () => {
  test('1. whitespace and redundant parentheses', () => {
    same("auth != null&&(data.exists())", "auth != null && data.exists()");
    same("a\n  && b", "(a && b)");
    same("a && (b && c)", "(a && b) && c");
    same("a || (b || c)", "a || b || c");
    same("'x' == \"x\"", "'x' == 'x'");
  });

  test('2. === is ==, !== is !=', () => {
    same("data.val() === 1", "data.val() == 1");
    same("data.val() !== 1", "data.val() != 1");
  });

  test('3. auth.uid compared with null is auth compared with null', () => {
    same("auth.uid != null", "auth != null");
    same("auth.uid !== null", "auth != null");
    same("null != auth.uid", "auth != null");
    same("auth.uid == null", "auth == null");
  });

  test("4. child('a/' + $v + '/b') is child('a').child($v).child('b')", () => {
    same("root.child('a/b/' + $x + '/c')", "root.child('a').child('b').child($x).child('c')");
    same("root.child('a/b').child($x)", "root.child('a').child('b').child($x)");
    same("root.child('a/' + $x + '/' + $y)", "root.child('a').child($x).child($y)");
  });

  test('5. a != b is !(a == b)', () => {
    same("data.val() != true", "!(data.val() == true)");
  });

  test('6. operand order of == and !=', () => {
    same("$uid === auth.uid", "auth.uid == $uid");
    same("newData.child('role').val() != 'admin'", "'admin' !== newData.child('role').val()");
  });

  test('the spaces legacy and compiled metadata rule canonicalize identically', () => {
    same(
      "auth.uid !== null && root.child('spaces_app/spaces/' + $spaceid + '/metadata/members').child(auth.uid).exists() && root.child('spaces_app/spaces/' + $spaceid + '/metadata/members').child(auth.uid).child('removed').val() !== true",
      "auth != null && root.child('spaces_app').child('spaces').child($spaceid).child('metadata').child('members').child(auth.uid).exists() && !(root.child('spaces_app').child('spaces').child($spaceid).child('metadata').child('members').child(auth.uid).child('removed').val() == true)",
    );
  });
});

describe('canonicalRtdbExpression: what is NOT treated as equivalent', () => {
  test('a different rule stays different', () => {
    differ("a || b", "a && b");
    differ("data.val() >= 1", "data.val() > 1");
    differ("data.val() == 1", "data.val() == 2");
    differ("$uid == auth.uid", "$tabid == auth.uid");
    differ("root.child('a').child($x)", "root.child('a').child($y)");
    differ("data.val() != true", "data.val() == true");
  });

  test('auth.uid != null is not any other claim != null', () => {
    differ("auth.uid != null", "auth.token.x != null");
    differ("auth.token.uid != null", "auth != null");
    differ("auth.uid != 'x'", "auth != 'x'");
  });

  test('a concatenated part that is not a literal or a $ variable is not split', () => {
    differ("root.child('a/' + someVar)", "root.child('a').child(someVar)");
    differ("root.child('a/' + auth.uid)", "root.child('a').child(auth.uid)");
    differ("root.child('a/' + data.val())", "root.child('a').child(data.val())");
    differ("root.child('a/' + 1)", "root.child('a').child(1)");
  });

  test('a segment that is glued, empty, or holds a key-invalid character is not split', () => {
    differ("root.child('users_' + $x)", "root.child('users_').child($x)");
    differ("root.child('/a/' + $x)", "root.child('a').child($x)");
    differ("root.child('a//b')", "root.child('a').child('b')");
    differ("root.child('a/b/')", "root.child('a').child('b')");
    differ("root.child('a.b/c')", "root.child('a.b').child('c')");
    differ("root.child($x + $y)", "root.child($x).child($y)");
  });

  test('operand order of && and || is kept', () => {
    differ("a && b", "b && a");
    differ("a || b", "b || a");
  });

  test('operand order of == is kept when an operand can stop evaluation with an unsupported construct', () => {
    // `data.toUpperCase()` is not a snapshot method: the simulator reports it as
    // a construct it does not evaluate, so its position relative to a failing
    // operand is observable.
    expect(canonical("data.toUpperCase() == root.val().x")).toBe("data.toUpperCase() == root.val().x");
    expect(canonical("root.val().x == data.toUpperCase()")).toBe("root.val().x == data.toUpperCase()");
  });

  test('double negation is kept', () => {
    differ("!!data.val()", "data.val()");
  });
});

describe('canonicalRtdbExpression: deterministic and idempotent', () => {
  test('canonical(canonical(x)) === canonical(x) over generated expressions', () => {
    for (const source of generateExpressions(400, 7)) {
      const once = canonical(source);
      expect(canonical(once)).toBe(once);
    }
  });
});

// ─── Evaluation equivalence ────────────────────────────────────────

/** A random rule expression built from the shapes the rewrites target, with errors and nulls in reach. */
function generateExpressions(count: number, seed: number): string[] {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const value = () => pick(["true", "'admin'", "1", "null", "'u1'", "$a"]);
  const eqOp = () => pick(['==', '===', '!=', '!==']);
  const snapshot = () => pick([
    "root.child('p/' + $a + '/q')",
    "root.child('p').child($a).child('q')",
    "root.child('p/' + $a)",
    "root.child('p/q/' + $b + '/' + $a)",
    "root.child('p').child('q').child($b).child($a)",
    "data.child('removed')",
    "newData.child('role')",
    "data",
  ]);
  const atom = (): string => pick([
    () => `auth.uid ${eqOp()} null`,
    () => `null ${eqOp()} auth.uid`,
    () => `auth ${eqOp()} null`,
    () => `$a ${eqOp()} auth.uid`,
    () => `auth.uid ${eqOp()} $b`,
    () => `${snapshot()}.val() ${eqOp()} ${value()}`,
    () => `${value()} ${eqOp()} ${snapshot()}.val()`,
    () => `${snapshot()}.exists()`,
    () => `${snapshot()}.val().toUpperCase() ${eqOp()} 'ADMIN'`,
    () => `${snapshot()}.val() + 1 ${eqOp()} 2`,
    () => `auth.token.admin ${eqOp()} ${pick(['true', 'null'])}`,
    () => `null ${eqOp()} auth.token.admin`,
    () => `root.child('p_' + $a).exists()`,
    () => `root.child('p/' + $a + '_q').val() ${eqOp()} ${value()}`,
    () => `root.child('m/' + auth.uid).val() ${eqOp()} true`,
    () => `${snapshot()}.val() > 0`,
  ])();
  const expr = (depth: number): string => {
    if (depth === 0 || random() < 0.3) return atom();
    const sub = () => (random() < 0.5 ? `(${expr(depth - 1)})` : expr(depth - 1));
    return pick([
      () => `${sub()} && ${sub()}`,
      () => `${sub()} || ${sub()}`,
      () => `!(${expr(depth - 1)})`,
      () => `${sub()} ? ${sub()} : ${sub()}`,
      () => `(${expr(depth - 1)}) ${eqOp()} ${pick(['true', 'false'])}`,
    ])();
  };
  return Array.from({ length: count }, () => expr(3));
}

describe('evaluation equivalence: canonical forms decide like the original', () => {
  const cases: Array<[string, string]> = [
    ['1 parentheses', "(auth != null) && ((data.exists()))"],
    ['1 regrouping', "auth != null && (data.child('removed').val() == true && newData.exists())"],
    ['2 strict equality', "data.child('removed').val() === true || newData.child('role').val() !== 'admin'"],
    ['3 auth.uid null', "auth.uid !== null && auth.uid != null || null == auth.uid"],
    ['4 child split', "root.child('p/q/' + $b + '/r').val() == true && root.child('p/' + $a).exists()"],
    ['5 != under errors', "newData.child('role').val().toUpperCase() != 'ADMIN' || data.val() + 1 != 1"],
    ['6 operand order', "$a === auth.uid && 'admin' == root.child('p/' + $a + '/role').val()"],
  ];
  for (const [name, source] of cases) {
    test(`rewrite ${name}`, () => {
      const rewritten = canonical(source);
      expect(rewritten).not.toBe(source);
      expect(findCounterexample(source, rewritten, { count: 400 })).toBeUndefined();
    });
  }

  test('the generated contexts reach true, false, and rule errors', () => {
    const spread = outcomeSpread("newData.child('role').val().toUpperCase() != 'ADMIN' && root.child('p/' + $a).val() == true", { count: 400 });
    expect(spread['true']).toBeGreaterThan(0);
    expect(spread['false']).toBeGreaterThan(0);
    expect(spread['rule-error']).toBeGreaterThan(0);
  });

  test('250 generated expressions decide like their canonical forms', () => {
    let rewrittenCount = 0;
    for (const [i, source] of generateExpressions(250, 11).entries()) {
      const rewritten = canonical(source);
      if (rewritten !== source) rewrittenCount++;
      const counterexample = findCounterexample(source, rewritten, { count: 40, seed: i + 1 });
      if (counterexample) {
        throw new Error(`not equivalent:\n  ${source}\n  ${rewritten}\n${JSON.stringify(counterexample, null, 2)}`);
      }
    }
    expect(rewrittenCount).toBeGreaterThan(200);
  }, 60_000);
});

describe('the equivalence check catches unsound rewrites', () => {
  // Each pair is a rewrite a careless canonicalizer could make. The harness
  // must find a context where the two decide differently; if it ever stops
  // finding one, the property tests above stop being evidence.
  const unsound: Array<[string, string, string]> = [
    ['auth.uid rewrite widened to any claim', "auth.token.admin != null", "auth != null"],
    ['child split across a glued segment', "root.child('users_' + $a).exists()", "root.child('users_').child($a).exists()"],
    ['&& operands reordered (error vs short circuit)', "auth != null && auth.uid.toUpperCase() == 'U1'", "auth.uid.toUpperCase() == 'U1' && auth != null"],
    ['!= rewritten as ==', "data.child('removed').val() != true", "data.child('removed').val() == true"],
    ['>= rewritten as >', "data.child('n').val() >= 1", "data.child('n').val() > 1"],
    ['error dropped: != rewritten to a guard that cannot fail', "newData.val().toUpperCase() != 'X'", "newData.val() != 'X'"],
  ];
  for (const [name, original, rewritten] of unsound) {
    test(name, () => {
      expect(findCounterexample(original, rewritten, { count: 400 })).toBeDefined();
    });
  }
});
