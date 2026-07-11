/**
 * ─── Pack 4: matches-full-string-regex (RULES-B4) ─────────────────────────
 * Production's matches() requires the RE2 pattern to consume the ENTIRE
 * string (implicit anchoring). Pre-fix the simulator used JS RegExp.test()
 * partial matching, so any substring hit allowed. The discriminating cases
 * are patterns that match a SUBSTRING but not the full string — JS-partial
 * says true, prod says false.
 */
import type { PackRecord } from './types.ts';

export const pack: PackRecord = {
  fm: 'RULES-B4',
  rationale: 'matches() is an anchored full-string RE2 match; a pattern matching only a substring must be false (JS partial-match said true).',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // substring pattern does NOT full-match → DENY
    match /partialNoMatchDeny/{id} {
      allow create: if 'hello world'.matches('world');
    }
    // exact pattern full-matches → ALLOW
    match /exactMatchAllow/{id} {
      allow create: if 'hello'.matches('hello');
    }
    // wildcard prefix makes it consume the whole string → ALLOW
    match /wildcardAllow/{id} {
      allow create: if 'hello world'.matches('.*world');
    }
    // class pattern consuming the full string → ALLOW
    match /classFullAllow/{id} {
      allow create: if 'abc123'.matches('[a-z]+[0-9]+');
    }
    // same pattern, one trailing char unconsumed → DENY (partial would hit)
    match /classTrailingDeny/{id} {
      allow create: if 'abc123!'.matches('[a-z]+[0-9]+');
    }
    // email domain check with escaped dot, full string → ALLOW
    match /emailFullAllow/{id} {
      allow create: if request.auth.token.email.matches('[a-z]+@acme\\\\.com');
    }
    // leading char outside the class → full match fails → DENY
    // (the substring 'alice@acme.com' WOULD partial-match)
    match /emailPrefixedDeny/{id} {
      allow create: if request.auth.token.email.matches('[a-z]+@acme\\\\.com');
    }
  }
}`,
  cases: [
    {
      description: "'hello world'.matches('world') → DENY (no partial match)",
      expectation: 'DENY',
      method: 'create',
      path: 'partialNoMatchDeny/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "'hello'.matches('hello') → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'exactMatchAllow/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "'hello world'.matches('.*world') → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'wildcardAllow/d3',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "'abc123'.matches('[a-z]+[0-9]+') → ALLOW (full consume)",
      expectation: 'ALLOW',
      method: 'create',
      path: 'classFullAllow/d4',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "'abc123!'.matches('[a-z]+[0-9]+') → DENY (trailing char)",
      expectation: 'DENY',
      method: 'create',
      path: 'classTrailingDeny/d5',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'alice@acme.com vs full-string email pattern → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'emailFullAllow/d6',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
      data: { _: 1 },
    },
    {
      description: '1alice@acme.com vs same pattern → DENY (substring would partial-match)',
      expectation: 'DENY',
      method: 'create',
      path: 'emailPrefixedDeny/d7',
      auth: { uid: 'bob', token: { email: '1alice@acme.com' } },
      data: { _: 1 },
    },
  ],
  group: 'fix-class',
};
