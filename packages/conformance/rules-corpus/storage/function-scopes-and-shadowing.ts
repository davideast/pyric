/**
 * ─── Scenario: global-and-service-scope-functions ────────────────────────────
 * Function declarations at GLOBAL scope (above `service`) and SERVICE scope
 * (inside `service`, outside any `match`) — the grammar previously only
 * allowed match-scope functions; production allows all three (PR #333 / #150).
 * Includes inner-shadows-outer resolution: a match-scope function with the
 * same name as a global one must win.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: function scopes (global, service, match), shadowing',
  rationale:
    'Production accepts functions declared at global and service scope and resolves inner scopes over outer ones; the old grammar rejected both placements at parse.',
  rules: `rules_version = '2';
function isPng(t) {
  return t == 'image/png';
}
function scopeTag() {
  return 'global';
}
service firebase.storage {
  function isSignedIn() {
    return request.auth != null;
  }
  match /b/{bucket}/o {
    match /fns/{fileId} {
      // match-scope shadow of the global scopeTag()
      function scopeTag() {
        return 'match';
      }
      allow create: if isSignedIn() && isPng(request.resource.contentType);
      allow read: if isSignedIn() && scopeTag() == 'match';
    }
    match /outer/{fileId} {
      // no shadow here — the global function resolves
      allow read: if isSignedIn() && scopeTag() == 'global';
    }
  }
}`,
  cases: [
    {
      description: 'global + service scope functions evaluate → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'fns/pic.png',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'image/png' },
    },
    {
      description: 'global function denies non-png → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'fns/pic.gif',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'image/gif' },
    },
    {
      description: 'anonymous fails service-scope isSignedIn() → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'fns/pic.png',
      resource: { size: 100, contentType: 'image/png' },
    },
    {
      description: 'match-scope function shadows the global → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'fns/pic.png',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
    {
      description: 'unshadowed call resolves the global → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'outer/pic.png',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
  ],
};
