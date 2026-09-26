/**
 * ─── Scenario: global-and-service-scope-functions ────────────────────────────
 * Function declarations at GLOBAL scope (above `service`) and SERVICE scope
 * (inside `service`, outside the documents match), with match-scope
 * shadowing. The simulator seeds each match walk with global, then service,
 * then match functions, so an inner declaration shadows an outer one.
 *
 * The `chains` cases call a 98-operand `&&` chain declared at global scope
 * and a 98-operand `||` chain declared at service scope. 98 operands is the
 * largest flat chain production compiles; a 99-operand chain at any scope is
 * rejected before evaluation with "Expression is too complex to evaluate
 * safely.", so it cannot be a verdict case. The linter's CHAIN_DEPTH limit
 * error fires above 98 operands at every scope.
 */
import type { ScenarioRecord } from './types.ts';

/** 98 operands, the largest flat chain production compiles. */
const CHAIN_OPERANDS = 98;
const andChain = Array.from({ length: CHAIN_OPERANDS }, (_, i) => `id != 'x${i}'`).join(' && ');
const orChain = Array.from({ length: CHAIN_OPERANDS }, (_, i) => `id == 'y${i}'`).join(' || ');

export const scenario: ScenarioRecord = {
  fm: 'Coverage: function scopes (global, service), shadowing',
  rationale:
    'Production accepts and resolves functions declared at global and service scope, with match-scope shadowing, and compiles a 98-operand && or || chain declared at either scope.',
  rules: `rules_version = '2';
function scopeTag() {
  return 'global';
}
function isAlice(uid) {
  return uid == 'alice';
}
function andChain98(id) {
  return ${andChain};
}
service cloud.firestore {
  function isSignedIn() {
    return request.auth != null;
  }
  function orChain98(id) {
    return ${orChain};
  }
  match /databases/{database}/documents {
    match /docs/{docId} {
      function scopeTag() {
        return 'match';
      }
      allow read: if isSignedIn() && scopeTag() == 'match';
      allow create: if isSignedIn() && isAlice(request.auth.uid);
    }
    match /outer/{docId} {
      allow read: if isSignedIn() && scopeTag() == 'global';
    }
    match /chains/{docId} {
      allow read: if andChain98(docId);
      allow create: if orChain98(docId);
    }
  }
}`,
  cases: [
    {
      description: 'service-scope fn + match shadow of global → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'alice' },
      resource: { title: 'X' },
    },
    {
      description: 'global fn gates create (alice) → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'docs/d2',
      auth: { uid: 'alice' },
      data: { title: 'X' },
    },
    {
      description: 'global fn gates create (bob) → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'docs/d2',
      auth: { uid: 'bob' },
      data: { title: 'X' },
    },
    {
      description: 'unshadowed call resolves the global fn → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'outer/d1',
      auth: { uid: 'alice' },
      resource: { title: 'X' },
    },
    {
      description: 'anonymous fails service-scope isSignedIn() → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'docs/d1',
      resource: { title: 'X' },
    },
    {
      description: 'global-scope 98-operand && chain holds for every operand → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'chains/c1',
      resource: { title: 'X' },
    },
    {
      description: 'global-scope 98-operand && chain fails on its last operand → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'chains/x97',
      resource: { title: 'X' },
    },
    {
      description: 'service-scope 98-operand || chain matches its last operand → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'chains/y97',
      data: { title: 'X' },
    },
    {
      description: 'service-scope 98-operand || chain matches no operand → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'chains/c1',
      data: { title: 'X' },
    },
  ],
  group: 'fix-class',
};
