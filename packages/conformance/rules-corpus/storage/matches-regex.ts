/**
 * ─── Pack 4: matches-regex ──────────────────────────────────────────────────
 * string.matches() — whole-string anchoring (a partial match denies) and RE2
 * inexpressibility (a lookaround pattern production's RE2 rejects → deny).
 */
import type { StoragePackRecord } from './types.ts';

export const pack: StoragePackRecord = {
  fm: 'STORAGE-MATCHES',
  rationale:
    'string.matches() whole-string anchoring: a partial match denies. (RE2-inexpressible patterns are rejected at ruleset compile time by production, so they are covered by evaluator unit tests, not oracle capture.)',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /typed/{fileId} {
      allow create: if request.resource.contentType.matches('image/.*');
    }
  }
}`,
  cases: [
    { description: 'matches whole string: image/png accepted', expectation: 'ALLOW', method: 'create', path: 'typed/a.png', resource: { size: 100, contentType: 'image/png' } },
    { description: 'matches whole string: text/plain rejected', expectation: 'DENY', method: 'create', path: 'typed/a.txt', resource: { size: 100, contentType: 'text/plain' } },
    { description: 'anchoring: leading-prefixed ximage/png rejected (not a partial match)', expectation: 'DENY', method: 'create', path: 'typed/a.png', resource: { size: 100, contentType: 'ximage/png' } },
  ],
};
