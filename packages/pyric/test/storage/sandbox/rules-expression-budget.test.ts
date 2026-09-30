import { describe, expect, it } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { EXPRESSION_LIMIT, EXPRESSION_LIMIT_MESSAGE } from '../../../src/rules/simulator/expression-budget.js';

// ─── The 1000-expression budget in Storage rules ─────────────────
//
// Production Storage rules run on the same rules evaluator as Firestore and
// stop a request at the same 1000 evaluated expressions. The Storage
// evaluator charges the shared ExpressionBudget, so a condition costs the
// same count in both services; the unit itself is measured against
// Firestore in test/rules/simulator/expression-budget-fixture.test.ts.

const path = 'b/pyric-default/o/docs/d1.json';

function storage(body: string, functions = '') {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    ${functions}
    ${body}
  }
}`);
  return evaluateStorageRules(rules, {
    request: { auth: { uid: 'alice' }, method: 'read', path },
    resource: { size: 10, name: 'docs/d1.json', metadata: {} },
  });
}

function firestoreCount(condition: string, functions = ''): number {
  const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${functions}
    match /docs/{id} { allow get: if ${condition}; }
  }
}`;
  const result = new SimulateFirestoreRulesHandler().simulate(source, [{
    description: 'count', expectation: 'ALLOW', method: 'get', path: 'docs/d1',
    auth: { uid: 'alice' }, resource: { size: 10 },
  }]);
  if (!result.success) throw new Error(result.error.message);
  return result.data.results[0]!.evaluatedExpressions!;
}

const trues = (n: number) => Array.from({ length: n }, () => 'true').join(' && ');

describe('evaluateStorageRules: expression budget', () => {
  it('counts a condition as the Firestore simulator does', () => {
    const fn = 'function f(x) { let unused = x == 1; return x > 0; }';
    const conditions = [
      'true',
      'true && true',
      'false || true',
      'request.auth.uid == \'alice\'',
      'false ? false : true',
      'f(1) && f(2)',
      'timestamp.date(2020, 1, 1) == timestamp.date(2020, 1, 1)',
    ];
    for (const condition of conditions) {
      const r = storage(`match /docs/{docId} { allow read: if ${condition}; }`, fn);
      expect(r.allowed).toBe(true);
      expect(r.evaluatedExpressions).toBe(firestoreCount(condition, fn));
    }
  });

  it('counts a firestore.get() path literal as 1 plus 1 per literal segment', () => {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} { allow read: if firestore.exists(/databases/(default)/documents/users/$(request.auth.uid)); }
  }
}`);
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 10, name: 'docs/d1.json', metadata: {} },
    }, new Date(), { get: () => null, exists: () => true });
    expect(r.allowed).toBe(true);
    // call(1) + firestore(1) + path(1) + databases, (default), documents,
    // users (4) + request.auth.uid (3)
    expect(r.evaluatedExpressions).toBe(10);
  });

  it('spans every allow rule the request evaluates', () => {
    const r = storage(`match /docs/{docId} {
      allow read: if false;
      allow read: if 1 == 2;
      allow read: if true;
    }`);
    expect(r.allowed).toBe(true);
    expect(r.evaluatedExpressions).toBe(5);
  });

  it(`allows exactly ${EXPRESSION_LIMIT} expressions and denies the next one with production's message`, () => {
    // f() is 90 trues (268) and the call (1); see the Firestore tests.
    const f = `function f() { return ${trues(90)}; }`;
    const atLimit = storage(`match /docs/{docId} { allow read: if f() && f() && f() && ${trues(63)}; }`, f);
    expect(atLimit.allowed).toBe(true);
    expect(atLimit.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
    expect(atLimit.resourceLimit).toBeUndefined();

    const over = storage(`match /docs/{docId} { allow read: if f() && f() && f() && ${trues(63)} && true; }`, f);
    expect(over.allowed).toBe(false);
    expect(over.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
    expect(over.resourceLimit).toMatchObject({ kind: 'expressions', limit: EXPRESSION_LIMIT, message: EXPRESSION_LIMIT_MESSAGE });
    expect(over.reasons.join(' ')).toContain(EXPRESSION_LIMIT_MESSAGE);
  });

  it('places the limit at the expression the budget ran out on, as the Firestore simulator does', () => {
    // Production reports the limit at a line and column. The same condition
    // runs out at the same expression in both engines, so the position
    // relative to the condition is the same.
    const f = `function f() { return ${trues(90)}; }`;
    const condition = `f() && f() && f() && ${trues(63)} && false`;
    const storageSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    ${f}
    match /docs/{docId} { allow read: if ${condition}; }
  }
}`;
    const r = evaluateStorageRules(parseStorageRules(storageSource), {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 10, name: 'docs/d1.json', metadata: {} },
    });
    expect(r.allowed).toBe(false);
    const limit = r.resourceLimit!;
    expect(limit.line).toBe(5);
    // Without `&& false` the condition costs exactly 1000. A node is charged
    // as it completes, so that conjunction has spent the 1000 when the last
    // `&&` goes on to its right operand, and that second unit is the 1001st.
    const storageLine = storageSource.split('\n')[4]!;
    expect(limit.column).toBe(storageLine.lastIndexOf('&&') + 1);
    expect(r.reasons).toEqual([
      `match /docs/{docId} read: line 5, column ${limit.column}: ${EXPRESSION_LIMIT_MESSAGE}`,
    ]);

    const firestoreSource = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${f}
    match /docs/{id} { allow get: if ${condition}; }
  }
}`;
    const simulated = new SimulateFirestoreRulesHandler().simulate(firestoreSource, [{
      description: 'limit', expectation: 'DENY', method: 'get', path: 'docs/d1', auth: { uid: 'alice' },
    }]);
    if (!simulated.success) throw new Error(simulated.error.message);
    const firestoreLimit = simulated.data.results[0]!.resourceLimit!;
    const firestoreLine = firestoreSource.split('\n')[4]!;
    expect(firestoreLimit.line).toBe(5);
    expect(firestoreLimit.column! - firestoreLine.indexOf(condition))
      .toBe(limit.column! - storageLine.indexOf(condition));
  });

  it('ends the request at the limit: no later rule or match block grants, and || true does not absorb it', () => {
    const f = `function f() { return ${trues(90)}; }`;
    const r = storage(`match /docs/{docId} {
      allow read: if (f() && f() && f() && f()) || true;
      allow read: if true;
    }
    match /{allPaths=**} { allow read: if true; }`, f);
    expect(r.allowed).toBe(false);
    expect(r.resourceLimit?.kind).toBe('expressions');
    expect(r.reasons).toHaveLength(1);
  });

  // Production evaluates a method's later allow rules after one raises an
  // error, and they count toward the limit. A limit reached after that error
  // is reported as the error. Captured in the error-absorption-and-direction
  // scenario of the Storage rules corpus.
  const ERR = '(1 / 0 == 0)';

  it('evaluates and counts a later rule after an error, which can grant', () => {
    const r = storage(`match /docs/{docId} {
      allow read: if ${ERR};
      allow read: if true;
    }`);
    expect(r.allowed).toBe(true);
    // == (1), / (1), 1 (1), 0 (1), and the right operand 0 (1): production
    // evaluates the right operand of == after the left one errors.
    expect(r.evaluatedExpressions).toBe(5 + 1);
  });

  it('reports a limit reached after an earlier rule raised an error as that error', () => {
    const f = `function f() { return ${trues(90)}; }`;
    const r = storage(`match /docs/{docId} {
      allow read: if ${ERR};
      allow read: if f() && f() && f() && f();
    }`, f);
    expect(r.allowed).toBe(false);
    expect(r.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
    expect(r.resourceLimit).toBeUndefined();
    expect(r.reasons[0]).toContain('Divide by zero error.');
    expect(r.reasons.some((reason) => reason.includes(EXPRESSION_LIMIT_MESSAGE) && reason.includes('earlier'))).toBe(true);
  });

  it('reports the same across match blocks', () => {
    const f = `function f() { return ${trues(90)}; }`;
    const r = storage(`match /docs/{docId} { allow read: if ${ERR}; }
    match /{allPaths=**} { allow read: if f() && f() && f() && f(); }`, f);
    expect(r.allowed).toBe(false);
    expect(r.resourceLimit).toBeUndefined();
  });
});
