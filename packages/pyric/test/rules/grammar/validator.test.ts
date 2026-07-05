import { describe, test, expect } from 'bun:test';
import { validateFirestoreRules } from '../../../src/rules/grammar/FirestoreValidator.js';
import {
  makeRules, makeMatch, makeAllow, makeFunction,
  TRUE, FALSE, NULL, ident, member, method, call, binOp, unaryOp,
  AUTH, AUTH_CHECK, AUTH_UID, REQ_DATA, RES_DATA, withAuthCheck,
} from './helpers.js';
import type { Expression } from '../../../src/rules/grammar/FirestoreAST.js';

function findCode(ast: ReturnType<typeof makeRules>, code: string) {
  return validateFirestoreRules(ast).filter(f => f.code === code);
}

describe('Firestore Validator', () => {
  // ================================================================
  // SECURITY CHECKS
  // ================================================================
  describe('SEC-1: Public write', () => {
    test('detects allow write: if true', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], TRUE)],
      })]);
      expect(findCode(ast, 'SEC-1').length).toBeGreaterThan(0);
      expect(findCode(ast, 'SEC-1')[0].severity).toBe('critical');
    });

    test('detects allow create: if true', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['create'], TRUE)],
      })]);
      expect(findCode(ast, 'SEC-1').length).toBeGreaterThan(0);
    });

    test('does not flag auth-gated write', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], AUTH_CHECK)],
      })]);
      expect(findCode(ast, 'SEC-1')).toHaveLength(0);
    });

    test('does not flag read: if true', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], TRUE)],
      })]);
      expect(findCode(ast, 'SEC-1')).toHaveLength(0);
    });
  });

  describe('SEC-2: Public read at recursive wildcard', () => {
    test('detects allow read: if true at {doc=**}', () => {
      const ast = makeRules([makeMatch('/{document=**}', {
        allows: [makeAllow(['read'], TRUE)],
      })]);
      expect(findCode(ast, 'SEC-2').length).toBeGreaterThan(0);
      expect(findCode(ast, 'SEC-2')[0].severity).toBe('critical');
    });

    test('does not flag public read at specific collection', () => {
      const ast = makeRules([makeMatch('/posts/{postId}', {
        allows: [makeAllow(['read'], TRUE)],
      })]);
      expect(findCode(ast, 'SEC-2')).toHaveLength(0);
    });
  });

  describe('SEC-3: No auth check on write', () => {
    test('detects write without auth reference', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['create'], binOp('is', member(REQ_DATA, 'title'), ident('string')))],
      })]);
      expect(findCode(ast, 'SEC-3').length).toBeGreaterThan(0);
    });

    test('does not flag write with auth check', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['create'], withAuthCheck(binOp('is', member(REQ_DATA, 'title'), ident('string'))))],
      })]);
      expect(findCode(ast, 'SEC-3')).toHaveLength(0);
    });

    test('detects nested write without auth', () => {
      const condition = binOp('&&',
        binOp('is', member(REQ_DATA, 'title'), ident('string')),
        binOp('>', method(member(REQ_DATA, 'title'), 'size'), { type: 'literal', value: 0, raw: '0' }),
      );
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['update'], condition)],
      })]);
      expect(findCode(ast, 'SEC-3').length).toBeGreaterThan(0);
    });
  });

  describe('SEC-4: Default deny missing', () => {
    test('detects when no recursive wildcard deny exists', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], TRUE)],
      })]);
      expect(findCode(ast, 'SEC-4').length).toBeGreaterThan(0);
    });

    test('does not flag when default deny present', () => {
      const ast = makeRules([
        makeMatch('/{document=**}', { allows: [makeAllow(['read', 'write'], FALSE)] }),
        makeMatch('/items/{id}', { allows: [makeAllow(['read'], TRUE)] }),
      ]);
      expect(findCode(ast, 'SEC-4')).toHaveLength(0);
    });
  });

  describe('SEC-5: Overly permissive recursive wildcard', () => {
    test('detects non-false allow at recursive wildcard', () => {
      const ast = makeRules([makeMatch('/{document=**}', {
        allows: [makeAllow(['read', 'write'], TRUE)],
      })]);
      expect(findCode(ast, 'SEC-5').length).toBeGreaterThan(0);
    });

    test('does not flag false deny at recursive wildcard', () => {
      const ast = makeRules([makeMatch('/{document=**}', {
        allows: [makeAllow(['read', 'write'], FALSE)],
      })]);
      expect(findCode(ast, 'SEC-5')).toHaveLength(0);
    });
  });

  describe('SEC-6: Write without data validation', () => {
    test('detects create without request.resource.data reference', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['create'], AUTH_CHECK)],
      })]);
      expect(findCode(ast, 'SEC-6').length).toBeGreaterThan(0);
    });

    test('does not flag create that validates data', () => {
      const condition = withAuthCheck(binOp('is', member(REQ_DATA, 'title'), ident('string')));
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['create'], condition)],
      })]);
      expect(findCode(ast, 'SEC-6')).toHaveLength(0);
    });

    test('does not flag delete (no incoming data)', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['delete'], AUTH_CHECK)],
      })]);
      expect(findCode(ast, 'SEC-6')).toHaveLength(0);
    });
  });

  // ================================================================
  // CONSTANT FOLDING — tautological / short-circuit conditions (#763)
  // ================================================================
  describe('Constant folding of tautological conditions', () => {
    test('SEC-1 flags `request.auth != null || true` write as public', () => {
      const cond = binOp('||', AUTH_CHECK, TRUE);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], cond)],
      })]);
      expect(findCode(ast, 'SEC-1').length).toBeGreaterThan(0);
      expect(findCode(ast, 'SEC-1')[0].severity).toBe('critical');
    });

    test('SEC-1 flags `true || X` (left literal-true) write as public', () => {
      const cond = binOp('||', TRUE, AUTH_CHECK);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['create'], cond)],
      })]);
      expect(findCode(ast, 'SEC-1').length).toBeGreaterThan(0);
    });

    test('SEC-2 flags `request.auth != null || true` read at recursive wildcard', () => {
      const cond = binOp('||', AUTH_CHECK, TRUE);
      const ast = makeRules([makeMatch('/{document=**}', {
        allows: [makeAllow(['read'], cond)],
      })]);
      expect(findCode(ast, 'SEC-2').length).toBeGreaterThan(0);
      expect(findCode(ast, 'SEC-2')[0].severity).toBe('critical');
    });

    test('QUA-1 flags a nested tautology (`X || (Y || true)`)', () => {
      const cond = binOp('||', AUTH_CHECK, binOp('||', AUTH_UID, TRUE));
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], cond)],
      })]);
      expect(findCode(ast, 'QUA-1').length).toBeGreaterThan(0);
    });

    test('folds `!false` to true (SEC-1)', () => {
      const cond = unaryOp('!', FALSE);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], cond)],
      })]);
      expect(findCode(ast, 'SEC-1').length).toBeGreaterThan(0);
    });

    test('folds ternary with literal-true condition to its taken branch', () => {
      const cond = { type: 'ternary' as const, condition: TRUE, consequent: TRUE, alternate: AUTH_CHECK };
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], cond)],
      })]);
      expect(findCode(ast, 'SEC-1').length).toBeGreaterThan(0);
    });

    test('SEC-3: `X && false` write folds to deny (no missing-auth finding)', () => {
      const cond = binOp('&&', binOp('is', member(REQ_DATA, 'title'), ident('string')), FALSE);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], cond)],
      })]);
      // Folds to `false` -> a deny, so no SEC-1 and no SEC-3.
      expect(findCode(ast, 'SEC-1')).toHaveLength(0);
      expect(findCode(ast, 'SEC-3')).toHaveLength(0);
    });

    test('no false positive: real auth check `request.auth != null` is not flagged', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], AUTH_CHECK)],
      })]);
      expect(findCode(ast, 'SEC-1')).toHaveLength(0);
      expect(findCode(ast, 'QUA-1')).toHaveLength(0);
    });

    test('no false positive: `request.auth.uid == userId` is not flagged', () => {
      const cond = binOp('==', AUTH_UID, ident('userId'));
      const ast = makeRules([makeMatch('/items/{userId}', {
        allows: [makeAllow(['write'], cond)],
      })]);
      expect(findCode(ast, 'SEC-1')).toHaveLength(0);
      expect(findCode(ast, 'QUA-1')).toHaveLength(0);
    });

    test('no false positive: `X || false` preserves the real auth operand (SEC-3 clean)', () => {
      const cond = binOp('||', AUTH_CHECK, FALSE);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], cond)],
      })]);
      // Folds to `request.auth != null` — still an auth check, not public.
      expect(findCode(ast, 'SEC-1')).toHaveLength(0);
      expect(findCode(ast, 'SEC-3')).toHaveLength(0);
    });
  });

  // ================================================================
  // SEMANTIC CHECKS
  // ================================================================
  describe('SEM-1: request.resource.data in read rule', () => {
    test('detects request.resource.data in read condition', () => {
      const condition = binOp('is', member(REQ_DATA, 'title'), ident('string'));
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], condition)],
      })]);
      expect(findCode(ast, 'SEM-1').length).toBeGreaterThan(0);
    });

    test('detects in get condition', () => {
      const condition = binOp('==', member(REQ_DATA, 'uid'), AUTH_UID);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['get'], condition)],
      })]);
      expect(findCode(ast, 'SEM-1').length).toBeGreaterThan(0);
    });

    test('does not flag resource.data in read (that is valid)', () => {
      const condition = binOp('==', member(RES_DATA, 'published'), TRUE);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], condition)],
      })]);
      expect(findCode(ast, 'SEM-1')).toHaveLength(0);
    });
  });

  describe('SEM-2: resource.data in create rule', () => {
    test('detects resource.data in create condition', () => {
      const condition = withAuthCheck(binOp('==', member(RES_DATA, 'author'), AUTH_UID));
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['create'], condition)],
      })]);
      expect(findCode(ast, 'SEM-2').length).toBeGreaterThan(0);
    });

    test('does not flag resource.data in update (valid)', () => {
      const condition = withAuthCheck(binOp('==', member(RES_DATA, 'author'), AUTH_UID));
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['update'], condition)],
      })]);
      expect(findCode(ast, 'SEM-2')).toHaveLength(0);
    });
  });

  describe('SEM-3: get()/exists() budget exceeded', () => {
    test('detects > 10 doc reads', () => {
      // Build a condition with 11 exists() calls
      let condition: Expression = call('exists', [{ type: 'pathLiteral', raw: '/a/b', segments: ['a', 'b'] }]);
      for (let i = 0; i < 10; i++) {
        condition = binOp('&&', condition,
          call('exists', [{ type: 'pathLiteral', raw: `/a/${i}`, segments: ['a', String(i)] }]));
      }
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], condition)],
      })]);
      expect(findCode(ast, 'SEM-3').length).toBeGreaterThan(0);
    });

    test('does not flag <= 10 doc reads', () => {
      let condition: Expression = call('exists', [{ type: 'pathLiteral', raw: '/a/b', segments: ['a', 'b'] }]);
      for (let i = 0; i < 2; i++) {
        condition = binOp('&&', condition,
          call('exists', [{ type: 'pathLiteral', raw: `/a/${i}`, segments: ['a', String(i)] }]));
      }
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], condition)],
      })]);
      expect(findCode(ast, 'SEM-3')).toHaveLength(0);
    });
  });

  describe('SEM-4: Undefined function call', () => {
    test('detects call to undefined function', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], call('nonExistent'))],
      })]);
      expect(findCode(ast, 'SEM-4').length).toBeGreaterThan(0);
    });

    test('does not flag call to defined function', () => {
      const fn = makeFunction('isAuth', [], AUTH_CHECK);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], call('isAuth'))],
      })], [fn]);
      expect(findCode(ast, 'SEM-4')).toHaveLength(0);
    });

    test('does not flag built-in functions', () => {
      const condition = call('exists', [{ type: 'pathLiteral', raw: '/a/b', segments: ['a', 'b'] }]);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], condition)],
      })]);
      expect(findCode(ast, 'SEM-4')).toHaveLength(0);
    });

    test('finds function in parent scope', () => {
      const fn = makeFunction('isAuth', [], AUTH_CHECK);
      const child = makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], call('isAuth'))],
      });
      const ast = makeRules([child], [fn]);
      expect(findCode(ast, 'SEM-4')).toHaveLength(0);
    });
  });

  // ================================================================
  // QUALITY CHECKS
  // ================================================================
  describe('QUA-1: Hardcoded true', () => {
    test('write: if true → critical', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['write'], TRUE)],
      })]);
      const findings = findCode(ast, 'QUA-1');
      expect(findings.length).toBeGreaterThan(0);
    });

    test('read: if true at collection → low', () => {
      const ast = makeRules([makeMatch('/posts/{postId}', {
        allows: [makeAllow(['read'], TRUE)],
      })]);
      const findings = findCode(ast, 'QUA-1');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].severity).toBe('low');
    });

    test('non-literal condition not flagged', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], AUTH_CHECK)],
      })]);
      expect(findCode(ast, 'QUA-1')).toHaveLength(0);
    });
  });

  describe('QUA-2: Empty match block', () => {
    test('detects match with no allows and no children', () => {
      const ast = makeRules([makeMatch('/empty/{id}', {})]);
      expect(findCode(ast, 'QUA-2').length).toBeGreaterThan(0);
    });

    test('does not flag match with allows', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], TRUE)],
      })]);
      expect(findCode(ast, 'QUA-2')).toHaveLength(0);
    });

    test('does not flag match with children', () => {
      const ast = makeRules([makeMatch('/parent/{id}', {
        children: [makeMatch('/parent/{id}/child/{cid}', {
          allows: [makeAllow(['read'], TRUE)],
        })],
      })]);
      expect(findCode(ast, 'QUA-2')).toHaveLength(0);
    });
  });

  describe('QUA-3: Duplicate function names', () => {
    test('detects same name in same scope', () => {
      const fn1 = makeFunction('helper', [], AUTH_CHECK);
      const fn2 = makeFunction('helper', ['x'], binOp('==', ident('x'), TRUE));
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], TRUE)],
      })], [fn1, fn2]);
      expect(findCode(ast, 'QUA-3').length).toBeGreaterThan(0);
    });

    test('does not flag different names', () => {
      const fn1 = makeFunction('isAuth', [], AUTH_CHECK);
      const fn2 = makeFunction('isOwner', ['uid'], binOp('==', AUTH_UID, ident('uid')));
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], TRUE)],
      })], [fn1, fn2]);
      expect(findCode(ast, 'QUA-3')).toHaveLength(0);
    });
  });

  describe('QUA-4: Unused function', () => {
    test('detects function never called', () => {
      const fn = makeFunction('unused', [], AUTH_CHECK);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], TRUE)],
      })], [fn]);
      expect(findCode(ast, 'QUA-4').length).toBeGreaterThan(0);
    });

    test('does not flag function that is called', () => {
      const fn = makeFunction('isAuth', [], AUTH_CHECK);
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], call('isAuth'))],
      })], [fn]);
      expect(findCode(ast, 'QUA-4')).toHaveLength(0);
    });
  });

  describe('QUA-5: Complex condition', () => {
    test('detects deeply nested expression (depth > 10)', () => {
      // Build a deeply nested expression
      let expr: Expression = TRUE;
      for (let i = 0; i < 12; i++) {
        expr = binOp('&&', expr, binOp('||', AUTH_CHECK, binOp('==', ident('x'), { type: 'literal', value: i, raw: String(i) })));
      }
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], expr)],
      })]);
      expect(findCode(ast, 'QUA-5').length).toBeGreaterThan(0);
    });

    test('does not flag simple expression', () => {
      const ast = makeRules([makeMatch('/items/{id}', {
        allows: [makeAllow(['read'], AUTH_CHECK)],
      })]);
      expect(findCode(ast, 'QUA-5')).toHaveLength(0);
    });
  });

  // ================================================================
  // STRUCTURE CHECKS
  // ================================================================
  describe('STR-1: Match without wildcard', () => {
    test('detects all-literal path', () => {
      const ast = makeRules([makeMatch('/admin', {
        allows: [makeAllow(['read'], TRUE)],
      })]);
      expect(findCode(ast, 'STR-1').length).toBeGreaterThan(0);
    });

    test('does not flag path with wildcard', () => {
      const ast = makeRules([makeMatch('/users/{userId}', {
        allows: [makeAllow(['read'], TRUE)],
      })]);
      expect(findCode(ast, 'STR-1')).toHaveLength(0);
    });
  });

  describe('STR-2: Nested match without parent rules', () => {
    test('detects child match when parent has no allows', () => {
      const ast = makeRules([makeMatch('/parent/{id}', {
        children: [makeMatch('/parent/{id}/child/{cid}', {
          allows: [makeAllow(['read'], TRUE)],
        })],
      })]);
      expect(findCode(ast, 'STR-2').length).toBeGreaterThan(0);
    });

    test('does not flag when parent has allows', () => {
      const ast = makeRules([makeMatch('/parent/{id}', {
        allows: [makeAllow(['read'], TRUE)],
        children: [makeMatch('/parent/{id}/child/{cid}', {
          allows: [makeAllow(['read'], TRUE)],
        })],
      })]);
      expect(findCode(ast, 'STR-2')).toHaveLength(0);
    });
  });

  describe('STR-3: Overlapping match paths', () => {
    test('detects wildcard + specific at same level', () => {
      const ast = makeRules([
        makeMatch('/{docId}', { allows: [makeAllow(['read'], TRUE)] }),
        makeMatch('/specific', { allows: [makeAllow(['read'], TRUE)] }),
      ]);
      expect(findCode(ast, 'STR-3').length).toBeGreaterThan(0);
    });

    test('does not flag non-overlapping paths', () => {
      const ast = makeRules([
        makeMatch('/users/{userId}', { allows: [makeAllow(['read'], TRUE)] }),
        makeMatch('/posts/{postId}', { allows: [makeAllow(['read'], TRUE)] }),
      ]);
      expect(findCode(ast, 'STR-3')).toHaveLength(0);
    });
  });
});
