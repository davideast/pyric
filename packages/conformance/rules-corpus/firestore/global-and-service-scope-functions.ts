/**
 * ─── Scenario: global-and-service-scope-functions ────────────────────────────
 * Function declarations at GLOBAL scope (above `service`) and SERVICE scope
 * (inside `service`, outside the documents match) — newly parseable in the
 * shared grammar (PR #333 / #150); production has always accepted them.
 *
 * KNOWN SIMULATOR GAP: the Firestore simulator does not yet RESOLVE global/
 * service-scope functions (PR #333 defers the wiring) — calling one fails
 * evaluation. Once this scenario is captured, any replay mismatch must be
 * pinned as a KNOWN_DIVERGENCE in test/rules/oracle-conformance.test.ts and
 * tracked with the wiring follow-up; the scenario exists precisely to keep
 * that gap loud.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Coverage: function scopes (global, service), shadowing',
  rationale:
    'Production accepts and resolves functions declared at global and service scope, with match-scope shadowing; the old grammar rejected both placements and the simulator cannot yet resolve them.',
  rules: `rules_version = '2';
function scopeTag() {
  return 'global';
}
function isAlice(uid) {
  return uid == 'alice';
}
service cloud.firestore {
  function isSignedIn() {
    return request.auth != null;
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
  ],
  group: 'fix-class',
};
