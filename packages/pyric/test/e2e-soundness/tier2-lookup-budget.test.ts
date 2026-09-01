import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import { parseToAST } from '../../src/rules/grammar/FirestoreParser.js';
import { validateFirestoreRules } from '../../src/rules/grammar/FirestoreValidator.js';
import { lintFirestoreRules } from '../../src/rules/linter/linter.js';

// ═══════════════════════════════════════════════════════════════
// TIER 2 — F7: Firestore 10-read document-lookup budget
//
// Production hard-limits security-rule document access calls
// (get/exists/getAfter/existsAfter) to 10 per single-document request
// evaluation (20 for multi-document transactions/batched writes — not
// modeled here; each batched op is checked against the per-op 10).
// Repeated reads of the SAME path are cached and do not re-charge the
// budget (site-docs: secure/firestore-rules-limits.md "More than 10
// document access calls"; rules/stdlib-modules.ts spaces guidance).
//
// Three engines must agree at the boundary: production allows exactly
// 10 distinct reads and fails the 11th.
//   - SEM-3 (FirestoreValidator)  — static, per-call-path expansion
//   - GET_COUNT (linter)          — static twin, same boundary
//   - simulator                   — runtime counter, fail-closed DENY
// ═══════════════════════════════════════════════════════════════

const handler = new SimulateFirestoreRulesHandler();

/** getDoc resolver: every path exists with { ok: true }. */
const anyDoc = { getDoc: () => ({ ok: true }) };

function wrap(body: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${body}
  }
}`;
}

/** N inline `get(...).data.ok == true` clauses over N DISTINCT paths. */
function inlineGetsRule(n: number): string {
  const clauses = Array.from({ length: n }, (_, i) =>
    `get(/databases/$(database)/documents/g/p${i}).data.ok == true`);
  return wrap(`    match /items/{id} {
      allow read: if ${clauses.join('\n        && ')};
    }`);
}

/** Helper with ONE get, fanned out across n call sites with distinct args. */
function fanoutRule(n: number): string {
  const calls = Array.from({ length: n }, (_, i) => `ok('p${i}')`);
  return wrap(`    function ok(p) {
      return get(/databases/$(database)/documents/g/$(p)).data.ok == true;
    }
    match /items/{id} {
      allow read: if ${calls.join(' && ')};
    }`);
}

/** N `!existsAfter(...)` clauses over N DISTINCT non-target paths (all true). */
function existsAfterRule(n: number): string {
  const clauses = Array.from({ length: n }, (_, i) =>
    `!existsAfter(/databases/$(database)/documents/g/p${i})`);
  return wrap(`    match /items/{id} {
      allow create: if ${clauses.join('\n        && ')};
    }`);
}

/** Helper whose gets live ONLY in let bindings (n lets, one get each). */
function letBoundRule(n: number): string {
  const lets = Array.from({ length: n }, (_, i) =>
    `      let a${i} = get(/databases/$(database)/documents/g/p${i}).data;`).join('\n');
  const uses = Array.from({ length: n }, (_, i) => `a${i}.ok == true`).join(' && ');
  return wrap(`    function viaLets() {
${lets}
      return ${uses};
    }
    match /items/{id} {
      allow read: if viaLets();
    }`);
}

/** `docs: null` simulates against an empty datastore (no getDoc resolver). */
function simulateDecision(rules: string, method = 'get', docs: object | null = anyDoc): string {
  const res = handler.simulate(rules, [{
    description: 'lookup budget probe',
    expectation: 'ALLOW',
    method,
    path: 'items/x',
    ...(method === 'create' ? { data: { ok: true } } : {}),
  }], docs ?? undefined);
  expect(res.success).toBe(true);
  if (!res.success) throw new Error('simulate failed');
  return res.data.results[0]!.decision;
}

function sem3Findings(rules: string) {
  const ast = parseToAST(rules);
  expect(ast).not.toBeNull();
  return validateFirestoreRules(ast!).filter(f => f.code === 'SEM-3');
}

function getCountErrors(rules: string) {
  const { warnings, parseError } = lintFirestoreRules(rules);
  expect(parseError).toBeUndefined();
  return warnings.filter(w => w.rule === 'GET_COUNT' && w.severity === 'error');
}

describe('F7: Firestore 10-read lookup budget', () => {

  // ─── F7.a: helper fan-out — per-call-path counting ────────────
  describe('F7.a: helper fan-out counts once per call site', () => {
    test('F7.a1: 9 effective gets via fan-out — runtime ALLOW', () => {
      expect(simulateDecision(fanoutRule(9))).toBe('ALLOW');
    });

    test('F7.a2: 11 effective gets via fan-out — runtime DENY (fail-closed)', () => {
      expect(simulateDecision(fanoutRule(11))).toBe('DENY');
    });

    test('F7.a3: SEM-3 counts fan-out per call path (11 effective gets flagged)', () => {
      expect(sem3Findings(fanoutRule(11)).length).toBeGreaterThan(0);
    });

    test('F7.a4: SEM-3 does not flag 9 effective gets via fan-out', () => {
      expect(sem3Findings(fanoutRule(9))).toHaveLength(0);
    });

    test('F7.a5: linter GET_COUNT errors on 11 effective gets via fan-out', () => {
      expect(getCountErrors(fanoutRule(11)).length).toBeGreaterThan(0);
    });
  });

  // ─── F7.b: existsAfter() counts against the budget ────────────
  describe('F7.b: existsAfter() counts', () => {
    // No getDoc resolver here: the probed g/p* docs must NOT exist, so every
    // `!existsAfter(...)` clause is true and the verdict isolates the budget.
    test('F7.b1: 11 distinct existsAfter() calls — runtime DENY', () => {
      expect(simulateDecision(existsAfterRule(11), 'create', null)).toBe('DENY');
    });

    test('F7.b2: 10 distinct existsAfter() calls — runtime ALLOW', () => {
      expect(simulateDecision(existsAfterRule(10), 'create', null)).toBe('ALLOW');
    });

    test('F7.b3: SEM-3 counts existsAfter() (11 calls flagged)', () => {
      expect(sem3Findings(existsAfterRule(11)).length).toBeGreaterThan(0);
    });

    test('F7.b4: linter GET_COUNT counts existsAfter() (11 calls error)', () => {
      expect(getCountErrors(existsAfterRule(11)).length).toBeGreaterThan(0);
    });
  });

  // ─── F7.c: let-bound gets are visible to SEM-3 ────────────────
  describe('F7.c: let-bound get() counts', () => {
    test('F7.c1: SEM-3 counts gets inside let bindings (11 flagged)', () => {
      expect(sem3Findings(letBoundRule(11)).length).toBeGreaterThan(0);
    });

    test('F7.c2: SEM-3 does not flag 10 let-bound gets', () => {
      expect(sem3Findings(letBoundRule(10))).toHaveLength(0);
    });

    test('F7.c3: runtime DENIES 11 let-bound gets', () => {
      expect(simulateDecision(letBoundRule(11))).toBe('DENY');
    });
  });

  // ─── F7.d: exactly-10 boundary parity across all three engines ─
  describe('F7.d: exactly 10 allowed, 11 denied — engine parity', () => {
    const ten = inlineGetsRule(10);
    const eleven = inlineGetsRule(11);

    test('F7.d1: exactly 10 distinct gets — SEM-3 silent, linter no error, runtime ALLOW', () => {
      expect(sem3Findings(ten)).toHaveLength(0);
      expect(getCountErrors(ten)).toHaveLength(0);
      expect(simulateDecision(ten)).toBe('ALLOW');
    });

    test('F7.d2: 11 distinct gets — SEM-3 fires, linter errors, runtime DENY', () => {
      expect(sem3Findings(eleven).length).toBeGreaterThan(0);
      expect(getCountErrors(eleven).length).toBeGreaterThan(0);
      expect(simulateDecision(eleven)).toBe('DENY');
    });
  });

  // ─── F7.e: production budget semantics the counter must honor ──
  describe('F7.e: budget semantics (caching + non-absorption)', () => {
    test('F7.e1: repeated reads of the SAME path are cached — 12 same-path gets ALLOW', () => {
      // site-docs/secure/firestore-rules-limits.md: "Repeated reads of the
      // same path are cached; reads of different paths are not."
      const clauses = Array.from({ length: 12 }, () =>
        `get(/databases/$(database)/documents/g/shared).data.ok == true`);
      const rules = wrap(`    match /items/{id} {
      allow read: if ${clauses.join('\n        && ')};
    }`);
      expect(simulateDecision(rules)).toBe('ALLOW');
    });

    test('F7.e2: budget exhaustion is NOT absorbed by a determining || operand', () => {
      // 10 distinct gets, then the 11th inside `(get(...) || true)`. CEL
      // error absorption would swallow an ordinary eval error here; budget
      // exhaustion fails the whole evaluation closed instead.
      const clauses = Array.from({ length: 10 }, (_, i) =>
        `get(/databases/$(database)/documents/g/p${i}).data.ok == true`);
      const rules = wrap(`    match /items/{id} {
      allow read: if ${clauses.join('\n        && ')}
        && (get(/databases/$(database)/documents/g/p10).data.ok == true || true);
    }`);
      expect(simulateDecision(rules)).toBe('DENY');
    });

    test('F7.e3: budget resets between requests — two sequential 9-get requests both ALLOW', () => {
      const res = handler.simulate(inlineGetsRule(9), [
        { description: 'first', expectation: 'ALLOW', method: 'get', path: 'items/x' },
        { description: 'second', expectation: 'ALLOW', method: 'get', path: 'items/y' },
      ], anyDoc);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results.map(r => r.decision)).toEqual(['ALLOW', 'ALLOW']);
      }
    });
  });
});
