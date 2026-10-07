import { describe, test, expect } from 'bun:test';
import { compileRtdbRules } from '../../../src/rules/rtdb/compiled-rules.js';
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
