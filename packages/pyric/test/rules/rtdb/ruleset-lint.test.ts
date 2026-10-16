import { describe, test, expect } from 'bun:test';
import { compileRtdbRules } from '../../../src/rules/rtdb/compiled-rules.js';
import { lintExpression } from '../../../src/rules/rtdb/grammar/linter.js';
import {
  lintRtdbRuleset,
  type RtdbSecurityCode,
} from '../../../src/rules/rtdb/grammar/ruleset-lint.js';
import { rtdbRules } from '../../../src/rules/api/rtdb.js';
import airHockey from './fixtures/air-hockey.database.rules.json' with { type: 'json' };

const lint = (rules: Record<string, unknown>) => lintRtdbRuleset(compileRtdbRules({ rules }));

/** The findings of one code, as path and rule. */
const found = (rules: Record<string, unknown>, code: RtdbSecurityCode) =>
  lint(rules)
    .filter((f) => f.code === code)
    .map(({ path, rule }) => ({ path, rule }));

describe('RTDB-SEC-1: a .write that is true for every request', () => {
  test('a .write of true is a critical public write', () => {
    const [finding] = lint({ board: { '.write': true } }).filter((f) => f.code === 'RTDB-SEC-1');
    expect(finding).toMatchObject({ path: '/board', rule: '.write', severity: 'critical' });
    expect(finding!.message).toContain('signed in or not');
    expect(finding!.fix.length).toBeGreaterThan(0);
  });

  test('a .write that folds to true is a public write: true || X, true && true', () => {
    expect(found({ a: { '.write': 'true || auth != null' } }, 'RTDB-SEC-1')).toEqual([{ path: '/a', rule: '.write' }]);
    expect(found({ a: { '.write': '(true && (true))' } }, 'RTDB-SEC-1')).toEqual([{ path: '/a', rule: '.write' }]);
  });

  test('near miss: X || true is not always true, because an error on the left denies (r26)', () => {
    expect(found({ a: { '.write': "newData.val().toUpperCase() == 'OK' || true" } }, 'RTDB-SEC-1')).toEqual([]);
  });

  test('near miss: a .write that requires auth is not a public write', () => {
    expect(found({ a: { '.write': 'auth != null' } }, 'RTDB-SEC-1')).toEqual([]);
  });
});

describe('RTDB-SEC-2: a .read that is true for every request', () => {
  test('a .read of true at the root is critical: the whole database is readable', () => {
    const [finding] = lint({ '.read': true }).filter((f) => f.code === 'RTDB-SEC-2');
    expect(finding).toMatchObject({ path: '/', rule: '.read', severity: 'critical' });
    expect(finding!.message).toContain('entire database');
  });

  test('a .read of true below the root exposes that subtree', () => {
    const [finding] = lint({ scores: { '.read': true } }).filter((f) => f.code === 'RTDB-SEC-2');
    expect(finding).toMatchObject({ path: '/scores', rule: '.read', severity: 'medium' });
    expect(finding!.message).toContain('/scores');
  });

  test('near miss: a .read that requires auth, or a .read of false, is not public', () => {
    expect(found({ '.read': 'auth != null', a: { '.read': false } }, 'RTDB-SEC-2')).toEqual([]);
  });
});

describe('RTDB-SEC-3: a .write that never reads auth', () => {
  test('a conditional .write with no auth reference admits signed-out clients', () => {
    const [finding] = lint({ posts: { $id: { '.write': '!data.exists()', '.validate': 'newData.isString()' } } })
      .filter((f) => f.code === 'RTDB-SEC-3');
    expect(finding).toMatchObject({ path: '/posts/$id', rule: '.write', severity: 'high' });
    expect(finding!.message).toContain('signed-out');
  });

  test('near miss: the same .write with an auth condition is not reported', () => {
    expect(found({ posts: { $id: { '.write': 'auth != null && !data.exists()' } } }, 'RTDB-SEC-3')).toEqual([]);
  });

  test('near miss: a .write of true or false is SEC-1 or a denial, not SEC-3', () => {
    expect(found({ a: { '.write': true }, b: { '.write': false } }, 'RTDB-SEC-3')).toEqual([]);
  });

  test('an auth reference inside a string or as a member name does not count', () => {
    expect(found({ a: { '.write': "newData.child('auth').val() == 'auth'" } }, 'RTDB-SEC-3'))
      .toEqual([{ path: '/a', rule: '.write' }]);
  });
});

describe('RTDB-SEC-4: an ancestor grant cannot be revoked by a deeper rule', () => {
  test('a deeper .write of false under an ancestor .write grant does not revoke it (r5)', () => {
    const [finding] = lint({ '.write': 'auth != null', inner: { '.write': false } })
      .filter((f) => f.code === 'RTDB-SEC-4');
    expect(finding).toMatchObject({ path: '/inner', rule: '.write', severity: 'high' });
    expect(finding!.message).toContain('/ .write');
    expect(finding!.fix).toContain('/inner');
  });

  test('a deeper .read condition under an ancestor .read of true is never consulted', () => {
    expect(found({ rooms: { '.read': true, $id: { '.read': 'auth != null' } } }, 'RTDB-SEC-4'))
      .toEqual([{ path: '/rooms/$id', rule: '.read' }]);
  });

  test('near miss: a root that denies grants nothing to revoke; only the grant at /inner counts', () => {
    expect(found({ '.write': false, inner: { '.write': 'auth != null', deep: { '.write': false } } }, 'RTDB-SEC-4'))
      .toEqual([{ path: '/inner/deep', rule: '.write' }]);
    expect(found({ '.read': false, a: { '.read': 'auth != null' } }, 'RTDB-SEC-4')).toEqual([]);
  });

  test('near miss: a grant on a sibling does not cascade', () => {
    expect(found({ a: { '.write': 'auth != null' }, b: { '.write': false } }, 'RTDB-SEC-4')).toEqual([]);
  });

  test('a rule of the other kind is not shadowed', () => {
    expect(found({ '.read': true, a: { '.write': false } }, 'RTDB-SEC-4')).toEqual([]);
  });
});

describe('RTDB-SEC-5: a delete skips .validate', () => {
  test('a transition .validate under a .write that never checks newData is bypassed by a delete (r21)', () => {
    const [finding] = lint({
      scores: {
        $uid: {
          '.write': 'auth.uid == $uid',
          '.validate': 'newData.isNumber() && newData.val() >= data.val()',
        },
      },
    }).filter((f) => f.code === 'RTDB-SEC-5');
    expect(finding).toMatchObject({ path: '/scores/$uid', rule: '.validate', severity: 'high' });
    expect(finding!.message).toContain('/scores/$uid .write');
    expect(finding!.fix).toContain('newData.exists()');
  });

  test('an ancestor .write without a newData check deletes the node too', () => {
    expect(found({
      rooms: {
        $room: {
          '.write': 'auth != null',
          count: { '.validate': 'newData.val() == data.val() + 1' },
        },
      },
    }, 'RTDB-SEC-5')).toEqual([{ path: '/rooms/$room/count', rule: '.validate' }]);
  });

  test('a .validate that checks newData.exists() is reported: it never sees a null value', () => {
    expect(found({ a: { '.write': 'auth != null', '.validate': 'newData.exists()' } }, 'RTDB-SEC-5'))
      .toEqual([{ path: '/a', rule: '.validate' }]);
  });

  test('near miss: the .write requires newData.exists(), so deletes are denied', () => {
    expect(found({
      scores: {
        $uid: {
          '.write': 'auth.uid == $uid && newData.exists()',
          '.validate': 'newData.isNumber() && newData.val() >= data.val()',
        },
      },
    }, 'RTDB-SEC-5')).toEqual([]);
  });

  test('near miss: a type-only .validate is not violated by a delete', () => {
    expect(found({ a: { $id: { '.write': 'auth != null', '.validate': 'newData.isString()' } } }, 'RTDB-SEC-5')).toEqual([]);
  });
});

describe('RTDB-SEC-6: a .write with no shape or size validation', () => {
  test('a user-writable node with no .validate at or below it accepts any value', () => {
    const [finding] = lint({ users: { $uid: { '.write': 'auth.uid == $uid' } } })
      .filter((f) => f.code === 'RTDB-SEC-6');
    expect(finding).toMatchObject({ path: '/users/$uid', rule: '.write', severity: 'high' });
    expect(finding!.message).toContain('any shape and size');
  });

  test('a newData.exists() check alone is not shape validation', () => {
    expect(found({ users: { $uid: { '.write': 'auth.uid == $uid && newData.exists()' } } }, 'RTDB-SEC-6'))
      .toEqual([{ path: '/users/$uid', rule: '.write' }]);
  });

  test('only the shallowest unvalidated write is reported', () => {
    expect(found({ p: { '.write': 'auth != null', sub: { $k: { '.write': 'auth != null' } } } }, 'RTDB-SEC-6'))
      .toEqual([{ path: '/p', rule: '.write' }]);
  });

  test('near miss: a .validate below the write bounds it', () => {
    expect(found({ users: { $uid: { '.write': 'auth.uid == $uid', '.validate': 'newData.isString() && newData.val().length < 100' } } }, 'RTDB-SEC-6')).toEqual([]);
  });

  test('near miss: a .write that checks newData is validation in the write rule', () => {
    expect(found({ users: { $uid: { '.write': "auth.uid == $uid && newData.isString()" } } }, 'RTDB-SEC-6')).toEqual([]);
  });

  test('near miss: a .write of false grants nothing', () => {
    expect(found({ users: { '.write': false } }, 'RTDB-SEC-6')).toEqual([]);
  });
});

describe('RTDB-SEC-7: a validated node with no $other rule', () => {
  test('named children with .validate and no $other accept any other key (r15)', () => {
    const [finding] = lint({
      rooms: {
        $room: {
          '.write': 'auth != null',
          title: { '.validate': 'newData.isString()' },
          count: { '.validate': 'newData.isNumber()' },
        },
      },
    }).filter((f) => f.code === 'RTDB-SEC-7');
    expect(finding).toMatchObject({ path: '/rooms/$room', rule: '.validate', severity: 'medium' });
    expect(finding!.message).toContain('title, count');
    expect(finding!.fix).toContain('"$other": { ".validate": false }');
  });

  test('a hasChildren shape check with no $other still accepts extra keys', () => {
    expect(found({ entry: { '.write': 'auth != null', '.validate': "newData.hasChildren(['title', 'body'])" } }, 'RTDB-SEC-7'))
      .toEqual([{ path: '/entry', rule: '.validate' }]);
  });

  test('near miss: an $other child with .validate false rejects unknown keys (r19)', () => {
    expect(found({
      rooms: {
        $room: {
          '.write': 'auth != null',
          title: { '.validate': 'newData.isString()' },
          $other: { '.validate': false },
        },
      },
    }, 'RTDB-SEC-7')).toEqual([]);
  });

  test('near miss: no write grant at or above the node means no key can be added there', () => {
    expect(found({
      rooms: { $room: { title: { '.write': 'auth != null', '.validate': 'newData.isString()' } } },
    }, 'RTDB-SEC-7')).toEqual([]);
  });

  test('near miss: a leaf type check has no children to constrain', () => {
    expect(found({ a: { '.write': 'auth != null', '.validate': 'newData.isString()' } }, 'RTDB-SEC-7')).toEqual([]);
  });
});

describe('lintRtdbRuleset on rules it cannot read', () => {
  test('an expression that does not parse produces no security finding', () => {
    expect(lint({ a: { '.write': 'auth != null && (' } })).toEqual([]);
  });
});

describe('Air Hockey, a real consumer', () => {
  test('its generated database.rules.json has no security findings', () => {
    expect(lintRtdbRuleset(compileRtdbRules(airHockey))).toEqual([]);
  });
});

describe('rtdbRules().lint() carries the security findings as rule issues', () => {
  test('a public write is an error-severity validate issue with its fix', () => {
    const issues = rtdbRules({ rules: { board: { '.write': true } } }).lint()
      .filter((issue) => issue.code === 'RTDB-SEC-1');
    expect(issues).toEqual([expect.objectContaining({
      code: 'RTDB-SEC-1',
      severity: 'error',
      origin: 'validate',
      path: '/board',
      rule: '.write',
      fix: expect.any(String),
    })]);
  });

  test('a medium finding is a warning', () => {
    const issues = rtdbRules({ rules: { scores: { '.read': true } } }).lint()
      .filter((issue) => issue.code === 'RTDB-SEC-2');
    expect(issues).toEqual([expect.objectContaining({ severity: 'warning', origin: 'validate' })]);
  });

  test('a ruleset that does not compile reports only the compile error', () => {
    const issues = rtdbRules({ rules: 5 as unknown as Record<string, unknown> }).lint();
    expect(issues.map((issue) => issue.code)).toEqual(['COMPILE_ERROR']);
  });
});

describe('QUOTED_REFERENCE: comparisons against a string literal that looks like a rule reference', () => {
  test('reports QUOTED_REFERENCE across comparison operators and reference forms', () => {
    const cases = [
      { expr: "data.child('owner').val() == 'auth.uid'", literal: 'auth.uid' },
      { expr: "'auth.uid' == data.child('owner').val()", literal: 'auth.uid' },
      { expr: `newData.child('author').val() != "data.child('author').val()"`, literal: "data.child('author').val()" },
      { expr: "newData.val() === 'newData.parent().val()'", literal: 'newData.parent().val()' },
      { expr: `data.val() !== "root.child('admins').val()"`, literal: "root.child('admins').val()" },
      { expr: "data.child('uid').val() == '$uid'", literal: '$uid' },
      { expr: "newData.child('createdAt').val() <= 'now'", literal: 'now' },
      { expr: "data.child('count').val() < 'query.limitToFirst'", literal: 'query.limitToFirst' },
      { expr: `data.child('owner').val() == ("auth['uid']")`, literal: "auth['uid']" },
    ];

    for (const { expr, literal } of cases) {
      const warnings = lintExpression(expr, 'validate').filter((w) => w.code === 'QUOTED_REFERENCE');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain(literal);
      expect(warnings[0]!.message).toMatch(/literal/i);
    }
  });

  test('near misses: constant comparisons, ordinary string literals, and unquoted references are not reported as QUOTED_REFERENCE', () => {
    const bothLiterals = lintExpression("auth != null && 'auth.uid' == 'auth.uid'", 'read');
    expect(bothLiterals.map((w) => w.code)).toEqual(['CONSTANT_COMPARISON']);

    expect(lintExpression("data.child('status').val() == 'open'", 'read')).toEqual([]);
    expect(lintExpression("data.child('role').val() == 'auth'", 'read')).toEqual([]);
    expect(lintExpression("data.child('tag').val() == 'nowhere'", 'read')).toEqual([]);
    expect(lintExpression("data.child('price').val() == '$100'", 'read')).toEqual([]);
    expect(lintExpression("data.child('owner').val() == auth.uid", 'read')).toEqual([]);
  });

  test('rtdbRules().lint() surfaces QUOTED_REFERENCE on ruleset expressions', () => {
    const issues = rtdbRules({
      rules: {
        posts: {
          $postId: {
            '.read': "data.child('owner').val() == '$postId'",
            '.write': "auth != null && data.child('author').val() != 'auth.uid'",
            '.validate': `newData.child('author').val() == "data.child('author').val()"`,
          },
        },
      },
    }).lint().filter((issue) => issue.code === 'QUOTED_REFERENCE');

    expect(issues.map(({ path, rule, code }) => ({ path, rule, code }))).toEqual([
      { path: '/posts/$postId', rule: '.read', code: 'QUOTED_REFERENCE' },
      { path: '/posts/$postId', rule: '.write', code: 'QUOTED_REFERENCE' },
      { path: '/posts/$postId', rule: '.validate', code: 'QUOTED_REFERENCE' },
    ]);
  });
});

describe('LNT-1: X && false must never fold to false when X is non-constant (corpus r41)', () => {
  test('negating or combining (X && false) does not fold to constant true', () => {
    expect(found({ a: { '.write': '!(data.val() + 1 == 2 && false)' } }, 'RTDB-SEC-1')).toEqual([]);
    expect(found({ a: { '.write': '(data.val() + 1 == 2 && false) || true' } }, 'RTDB-SEC-1')).toEqual([]);
    expect(found({ a: { '.write': '(data.val() + 1 == 2 && false) ? false : true' } }, 'RTDB-SEC-1')).toEqual([]);
    expect(found({ a: { '.read': "!(auth.uid == 'admin' && false)" } }, 'RTDB-SEC-2')).toEqual([]);
  });

  test('left-hand short-circuiting constants still fold', () => {
    expect(found({ a: { '.write': '!(false && data.val() + 1 == 2)' } }, 'RTDB-SEC-1'))
      .toEqual([{ path: '/a', rule: '.write' }]);
    expect(found({ a: { '.write': 'true || (data.val() + 1 == 2)' } }, 'RTDB-SEC-1'))
      .toEqual([{ path: '/a', rule: '.write' }]);
  });
});

describe('LNT-2 & COV-2: literal comparisons and arithmetic fold as constants', () => {
  test('literal tautologies fold to true for RTDB-SEC-1, RTDB-SEC-2, and RTDB-SEC-4', () => {
    for (const expr of [
      '1 == 1',
      "'a' == 'a'",
      '2 > 1',
      'true == 1 < 2',
      '1 + 2 * 3 == 7',
      '-1 + 2 == 1',
      '"\\0" == "\\u0000"',
      '"\\v" == "\\x0b"',
      '"\\\'" == "\'"',
    ]) {
      expect(found({ a: { '.write': expr } }, 'RTDB-SEC-1')).toEqual([{ path: '/a', rule: '.write' }]);
      expect(found({ a: { '.read': expr } }, 'RTDB-SEC-2')).toEqual([{ path: '/a', rule: '.read' }]);
    }
    expect(found({ a: { '.write': '"\\0" == "0"' } }, 'RTDB-SEC-1')).toEqual([]);
    expect(found({ a: { '.write': '"\\v" == "v"' } }, 'RTDB-SEC-1')).toEqual([]);

    expect(
      found({ '.write': '1 == 1', sub: { '.write': "auth.uid == 'admin'" } }, 'RTDB-SEC-4'),
    ).toEqual([{ path: '/sub', rule: '.write' }]);
  });

  test('literal contradictions fold to false for RTDB-SEC-4 and do not grant', () => {
    expect(
      found({ '.write': 'auth != null', sub: { '.write': '1 != 1' } }, 'RTDB-SEC-4'),
    ).toEqual([{ path: '/sub', rule: '.write' }]);
    expect(found({ a: { '.write': '1 != 1' } }, 'RTDB-SEC-3')).toEqual([]);
    expect(found({ a: { '.write': '1 != 1' } }, 'RTDB-SEC-6')).toEqual([]);
  });

  test('COV-2: non-finite 1e309 == 2e309 does not fold to constant true', () => {
    expect(found({ a: { '.write': '1e309 == 2e309' } }, 'RTDB-SEC-1')).toEqual([]);
  });
});

describe('LNT-5: RTDB-SEC-5 delete bypass detection and fix', () => {
  test('ancestor .write with newData.exists() does not suppress RTDB-SEC-5 on child, and its fix closes the bypass', () => {
    const findings = lint({
      posts: {
        $id: {
          '.write': 'auth != null && newData.exists()',
          count: { '.validate': 'newData.val() >= data.val()' },
        },
      },
    }).filter((f) => f.code === 'RTDB-SEC-5');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe('/posts/$id/count');
    expect(findings[0]!.fix).toContain("newData.child('count').exists()");

    // Applying the suggested fix closes the child delete bypass.
    expect(
      found(
        {
          posts: {
            $id: {
              '.write': "auth != null && newData.child('count').exists()",
              count: { '.validate': 'newData.val() >= data.val()' },
            },
          },
        },
        'RTDB-SEC-5',
      ),
    ).toEqual([]);
  });

  test('.write that mentions newData while unintentionally admitting deletes reports RTDB-SEC-5, while an explicit delete condition does not', () => {
    for (const writeExpr of [
      'auth != null && (data.exists() || newData.exists())',
      'auth != null && !newData.isNumber()',
    ]) {
      expect(
        found(
          { posts: { $id: { '.write': writeExpr, '.validate': 'newData.val() >= data.val()' } } },
          'RTDB-SEC-5',
        ),
      ).toEqual([{ path: '/posts/$id', rule: '.validate' }]);
    }

    // A deliberate delete condition (such as !newData.exists() || ...) is intentional.
    expect(
      found(
        {
          notes: {
            $noteId: {
              '.write':
                "auth != null && ((!data.exists() && newData.child('owner').val() == auth.uid) || (data.exists() && data.child('owner').val() == auth.uid && (!newData.exists() || newData.child('owner').val() == auth.uid)))",
              '.validate': "!data.exists() || newData.child('createdAt').val() == data.child('createdAt').val()",
            },
          },
        },
        'RTDB-SEC-5',
      ),
    ).toEqual([]);
  });

  test('(newData).exists(), newData.val() != null, and root reads in .validate report RTDB-SEC-5', () => {
    for (const validateExpr of [
      '(newData).exists()',
      'newData.val() != null',
      "root.child('locks').child($id).exists() == false && newData.isString()",
    ]) {
      expect(
        found(
          { items: { $id: { '.write': 'auth != null', '.validate': validateExpr } } },
          'RTDB-SEC-5',
        ),
      ).toEqual([{ path: '/items/$id', rule: '.validate' }]);
    }
  });

  test('safe: .write requiring newData.val() != null on the same node refuses deletes', () => {
    expect(
      found(
        {
          items: {
            $id: {
              '.write': 'auth != null && newData.val() != null',
              '.validate': 'newData.val() >= data.val()',
            },
          },
        },
        'RTDB-SEC-5',
      ),
    ).toEqual([]);
  });
});

describe('LNT-6: RTDB-SEC-6 and RTDB-SEC-7 soundness against vacuous validation and incomplete child coverage', () => {
  test('confirmed repro: .validate: true does not silence RTDB-SEC-6', () => {
    expect(
      found(
        { '.read': false, '.write': false, posts: { '.write': 'auth != null', '.validate': true } },
        'RTDB-SEC-6',
      ),
    ).toEqual([{ path: '/posts', rule: '.write' }]);
  });

  test('existence-only checks and parenthesized (newData).exists() do not silence RTDB-SEC-6', () => {
    expect(
      found({ posts: { '.write': 'auth != null', '.validate': 'newData.exists()' } }, 'RTDB-SEC-6'),
    ).toEqual([{ path: '/posts', rule: '.write' }]);
    expect(
      found({ posts: { '.write': 'auth != null', '.validate': 'newData.val() != null' } }, 'RTDB-SEC-6'),
    ).toEqual([{ path: '/posts', rule: '.write' }]);
    expect(
      found({ posts: { '.write': 'auth != null && (newData).exists()' } }, 'RTDB-SEC-6'),
    ).toEqual([{ path: '/posts', rule: '.write' }]);
    expect(
      found({ posts: { '.write': 'auth != null && newData.val() != null' } }, 'RTDB-SEC-6'),
    ).toEqual([{ path: '/posts', rule: '.write' }]);
  });

  test('unvalidated literal sibling next to $other: { .validate: false } reports RTDB-SEC-6', () => {
    expect(
      found(
        {
          posts: {
            $postId: {
              '.write': 'auth != null',
              title: { '.validate': 'newData.isString()' },
              unvalidatedBlob: { '.read': true },
              $other: { '.validate': false },
            },
          },
        },
        'RTDB-SEC-6',
      ),
    ).toEqual([{ path: '/posts/$postId', rule: '.write' }]);
  });

  test('grandchild validation, non-rejecting $other, and newData.child() in .validate report RTDB-SEC-7', () => {
    expect(
      found(
        {
          users: {
            $uid: {
              '.write': 'auth.uid == $uid',
              profile: {
                name: { '.validate': 'newData.isString()' },
              },
            },
          },
        },
        'RTDB-SEC-7',
      ),
    ).toEqual([
      { path: '/users/$uid', rule: '.validate' },
      { path: '/users/$uid/profile', rule: '.validate' },
    ]);

    expect(
      found(
        {
          posts: {
            $postId: {
              '.write': 'auth != null',
              title: { '.validate': 'newData.isString()' },
              $other: { '.read': false },
            },
          },
        },
        'RTDB-SEC-7',
      ),
    ).toEqual([{ path: '/posts/$postId', rule: '.validate' }]);

    expect(
      found(
        {
          posts: {
            $postId: {
              '.write': 'auth != null',
              title: { '.validate': 'newData.isString()' },
              $other: { '.validate': true },
            },
          },
        },
        'RTDB-SEC-7',
      ),
    ).toEqual([{ path: '/posts/$postId', rule: '.validate' }]);

    expect(
      found(
        {
          posts: {
            $postId: {
              '.write': 'auth != null',
              '.validate': "newData.child('title').isString()",
            },
          },
        },
        'RTDB-SEC-7',
      ),
    ).toEqual([{ path: '/posts/$postId', rule: '.validate' }]);
  });

  test('safe: fully validated children with $other: { .validate: false } report neither RTDB-SEC-6 nor RTDB-SEC-7', () => {
    const clean = {
      posts: {
        $postId: {
          '.write': 'auth != null',
          title: { '.validate': 'newData.isString()' },
          $other: { '.validate': false },
        },
      },
    };
    expect(found(clean, 'RTDB-SEC-6')).toEqual([]);
    expect(found(clean, 'RTDB-SEC-7')).toEqual([]);
  });
});
