/**
 * ─── Pack 2: string-literals-and-regex ────────────────────────────────────
 * Targets Class B (matches-string-escape) — surfaced 2026-05-02 by
 * email_domain_validation × gemma4:26b. Models writing `.matches('...\\.com')`
 * expect production semantics: `\\` escapes to `\`, then `\.` is a literal-dot
 * regex pattern. Pre-fix the simulator did not process string escapes, so
 * `\\.` reached `new RegExp()` as `\\.` (literal backslash + any char) and
 * silently denied every email-domain check.
 * We restrict this pack to escape forms production *accepts* (`\\` and no
 * escape). The lone-backslash forms `\.` and `@acme\.com` are syntax errors
 * in production — those are tracked separately as Bug 2 in REBUILD_PLAN.md
 * (sim accepts unknown escapes that prod rejects); they cannot be exercised
 * here without making the entire pack throw at the prod call boundary.
 */
import type { PackRecord } from './types.ts';

export const pack: PackRecord = {
  fm: 'Class B',
  rationale: 'Pre-fix the simulator forwarded raw `\\\\.` to RegExp without unescaping; production-style `.matches(\'...\\\\.com\')` denied silently.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /escapedAllow/{id} {
      allow read: if request.auth.token.email.matches('.*@acme\\\\.com');
    }
    match /escapedDeny/{id} {
      allow read: if request.auth.token.email.matches('.*@acme\\\\.com');
    }
    match /unescapedAllow/{id} {
      allow read: if request.auth.token.email.matches('.*@acme.com');
    }
    match /tabReject/{id} {
      allow read: if !request.auth.token.name.matches('.*\\t.*');
    }
  }
}`,
  cases: [
    {
      description: "matches('.*@acme\\\\.com') vs alice@acme.com → ALLOW",
      expectation: 'ALLOW',
      method: 'get',
      path: 'escapedAllow/d1',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
    },
    {
      description: "matches('.*@acme\\\\.com') vs bob@other.com → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'escapedDeny/d2',
      auth: { uid: 'bob', token: { email: 'bob@other.com' } },
    },
    {
      description: "matches('.*@acme.com') vs alice@acme.com → ALLOW (no-escape control)",
      expectation: 'ALLOW',
      method: 'get',
      path: 'unescapedAllow/d3',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
    },
    {
      description: "!matches('.*\\t.*') vs name without tab → ALLOW (tab escape literal)",
      expectation: 'ALLOW',
      method: 'get',
      path: 'tabReject/d4',
      auth: { uid: 'alice', token: { name: 'Alice Smith' } },
    },
  ],
  group: 'stress',
};
