import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';

// ═══════════════════════════════════════════════════════════════
// CEL commutative error absorption for && and ||
//
// Per the CEL spec (and captured production behavior:
// rules-firestore-error-absorption-and-or,
// rules-storage-ternary-and-error-absorption), && and || are
// COMMUTATIVE error-absorbing operators: if either operand uniquely
// determines the result (false for &&, true for ||), an error produced
// by the OTHER operand is ignored, regardless of position. JS-style
// left-to-right short-circuit gets `error && false` wrong (it errors
// instead of evaluating to false).
//
// Both local engines must agree:
//   - Firestore simulator (rules/simulator/evaluator.ts), the
//     reference: tri-state via evaluate-both-sides
//   - Storage evaluator (storage/sandbox/rules-evaluator.ts)
//
// Top-level `error && false` is DENY either way (false also denies), so
// every distinguishing case CONSUMES the operator result: `!(...)` or
// `(...) == false`.
//
// Absorption covers genuine rule-evaluation errors only. Two classes
// stay unabsorbable and fail the evaluation closed even under a
// determining operand (the lookup-budget precedent):
//   - resource-limit exhaustion (Firestore lookup caps, call depth)
//   - unsupported / compile-reject constructs (undefined function, etc.)
// ═══════════════════════════════════════════════════════════════

const fsHandler = new SimulateFirestoreRulesHandler();

/** Firestore: one rule with the given condition; `resource.data.missing`
 *  is the error generator (doc has no such field → error value). */
function fsDecision(cond: string): string {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if ${cond};
    }
  }
}`;
  const res = fsHandler.simulate(rules, [{
    description: 'absorption probe',
    expectation: 'ALLOW',
    method: 'get',
    path: 'items/x',
  }], { getDoc: () => ({ present: true }) });
  expect(res.success).toBe(true);
  if (!res.success) throw new Error('simulate failed');
  return res.data.results[0]!.decision;
}

/** Storage: one rule with the given condition; `request.nope` is the
 *  error generator (absent property → error value). */
function storageAllowed(
  cond: string,
  docs?: Record<string, Record<string, unknown>>,
): boolean {
  const rules = parseStorageRules(`service firebase.storage {
    match /b/{bucket}/o {
      match /docs/{docId} { allow read: if ${cond}; }
    }
  }`);
  const lookup = docs
    ? {
        get(p: string) { return p in docs ? docs[p]! : null; },
        exists(p: string) { return p in docs; },
      }
    : undefined;
  return evaluateStorageRules(
    rules,
    {
      request: { auth: { uid: 'alice' }, method: 'read' as never, path: 'b/pyric-default/o/docs/d1.json' },
      resource: { size: 1 },
    },
    undefined,
    lookup,
  ).allowed;
}

describe('CEL commutative error absorption for && and ||', () => {

  // ─── Firestore simulator: the reference engine ────────────────
  describe('Firestore simulator pins the captured shapes', () => {
    const err = 'resource.data.missing == true';

    test('!(error && false) → ALLOW', () => {
      expect(fsDecision(`!(${err} && false)`)).toBe('ALLOW');
    });

    test('(error && false) == false → ALLOW', () => {
      expect(fsDecision(`(${err} && false) == false`)).toBe('ALLOW');
    });

    test('!(false && error) → ALLOW (short-circuit control)', () => {
      expect(fsDecision(`!(false && ${err})`)).toBe('ALLOW');
    });

    test('error || true → ALLOW; true || error → ALLOW', () => {
      expect(fsDecision(`${err} || true`)).toBe('ALLOW');
      expect(fsDecision(`true || ${err}`)).toBe('ALLOW');
    });

    test('undetermined operands propagate: !(error && true) → DENY', () => {
      expect(fsDecision(`!(${err} && true)`)).toBe('DENY');
    });
  });

  // ─── Storage evaluator: commutative && absorption ─────────────
  describe('Storage && absorbs commutatively', () => {
    test('!(error && false) → ALLOW', () => {
      expect(storageAllowed('!(request.nope && false)')).toBe(true);
    });

    test('(error && false) == false → ALLOW', () => {
      expect(storageAllowed('(request.nope && false) == false')).toBe(true);
    });

    test('!(false && error) → ALLOW (pin: LHS determines)', () => {
      expect(storageAllowed('!(false && request.nope)')).toBe(true);
    });

    test('error || true → ALLOW; true || error → ALLOW (pins)', () => {
      expect(storageAllowed('request.nope || true')).toBe(true);
      expect(storageAllowed('true || request.nope')).toBe(true);
    });

    test('undetermined operands propagate: !(error && true) → DENY, (error || false) consumer → DENY', () => {
      expect(storageAllowed('!(request.nope && true)')).toBe(false);
      expect(storageAllowed('(request.nope || false) == false')).toBe(false);
    });

    test('nested absorption: (error && false) || true → ALLOW', () => {
      expect(storageAllowed('(request.nope && false) || true')).toBe(true);
    });
  });

  // ─── thrown-error routing at the operand boundary ─────────────
  describe('a thrown RuleEvalError participates in Storage absorption', () => {
    test('firestore.exists without a capability, absorbed by && false → ALLOW', () => {
      expect(storageAllowed(
        '!(firestore.exists(/databases/(default)/documents/users/alice) && false)',
      )).toBe(true);
    });

    test('same throw with no determining operand → DENY', () => {
      expect(storageAllowed(
        '!(firestore.exists(/databases/(default)/documents/users/alice) && true)',
      )).toBe(false);
    });
  });

  // ─── unabsorbable classes fail closed (budget precedent) ──────
  describe('resource-limit and compile-reject errors are never absorbed', () => {
    test('Storage 2-lookup cap exhaustion inside (lookup && false) → DENY', () => {
      const docs = { 'g/p0': { ok: true }, 'g/p1': { ok: true }, 'g/p2': { ok: true } };
      expect(storageAllowed(
        'firestore.exists(/databases/(default)/documents/g/p0)'
        + ' && firestore.exists(/databases/(default)/documents/g/p1)'
        + ' && !(firestore.exists(/databases/(default)/documents/g/p2) && false)',
        docs,
      )).toBe(false);
    });

    test('undefined function inside (call && false) → DENY', () => {
      expect(storageAllowed('!(missing() && false)')).toBe(false);
    });

    test('Firestore 10-read budget inside (get && false) → DENY', () => {
      const clauses = Array.from({ length: 10 }, (_, i) =>
        `get(/databases/$(database)/documents/g/p${i}).data.present == true`);
      const cond = `${clauses.join('\n        && ')}
        && !(get(/databases/$(database)/documents/g/p10).data.present == true && false)`;
      expect(fsDecision(cond)).toBe('DENY');
    });
  });

  // ─── strict-boolean operands (RULES-B6 capture) ───────────────
  describe('non-boolean &&/|| operands are absorbable type errors', () => {
    test('Firestore: !(1 && false) → ALLOW; discriminator (1 && true) || !(1 && true) → DENY', () => {
      expect(fsDecision('!(1 && false)')).toBe('ALLOW');
      expect(fsDecision('(1 && true) || !(1 && true)')).toBe('DENY');
    });

    test('Storage: !(1 && false) → ALLOW; discriminator (1 && true) || !(1 && true) → DENY', () => {
      expect(storageAllowed('!(1 && false)')).toBe(true);
      expect(storageAllowed('(1 && true) || !(1 && true)')).toBe(false);
    });
  });
});
