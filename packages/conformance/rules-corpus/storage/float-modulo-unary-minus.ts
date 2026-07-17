/**
 * ─── Scenario: float-modulo-unary-minus ──────────────────────────────────────
 * Float literals, `%`, and unary minus — newly evaluable in storage rules
 * (PR #333 / #150). Reuses the arithmetic truth the Firestore engine already
 * pinned (rules-firestore-int-float-and-division): int ÷ int truncates toward
 * zero, mixed operands promote to float, `10 % 3 == 1`. Negative-operand
 * modulo (`-7 % 2`) is NOT yet production-pinned anywhere — the capture is
 * the authority; the authored expectation follows CEL (result takes the
 * dividend's sign → -1).
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: float literals, %, unary minus, negative modulo',
  rationale:
    'Float multiplication/division, modulo, and unary minus must evaluate with production numeric semantics, including truncating int division and dividend-signed negative modulo.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /math/{fileId} {
      // the PR-333 motivating shape: float scaling of size, plus % and unary -
      allow create: if request.resource.size * 0.5 < 1048576.0
        && request.resource.size % 2 == 0
        && -request.resource.size < 0
        && 10.0 / 4.0 == 2.5
        && 10 % 3 == 1;
      // int ÷ int truncates in production; the value-typed evaluator divides
      // as floats (documented divergence, same root cause as 1.0 is float)
      allow read: if 10 / 4 == 2;
      // truncation toward zero on negative int division (production-pinned)
      allow update: if -7 / 2 == -3;
      // negative-dividend modulo: CEL gives the dividend's sign
      allow delete: if -7 % 2 == -1;
    }
  }
}`,
  cases: [
    {
      description: 'even size passes float/modulo/unary-minus chain → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'math/data.bin',
      auth: { uid: 'alice' },
      resource: { size: 2048, contentType: 'application/octet-stream' },
    },
    {
      description: 'odd size fails size % 2 == 0 → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'math/data.bin',
      auth: { uid: 'alice' },
      resource: { size: 2049, contentType: 'application/octet-stream' },
    },
    {
      description: 'oversized float product fails bound → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'math/data.bin',
      auth: { uid: 'alice' },
      resource: { size: 4194304, contentType: 'application/octet-stream' },
    },
    {
      description: 'int / int truncates (10 / 4 == 2) → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'math/data.bin',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
    {
      description: '-7 / 2 truncates toward zero (== -3) → ALLOW',
      expectation: 'ALLOW',
      method: 'update',
      path: 'math/data.bin',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'application/octet-stream' },
      existingResource: { size: 100 },
    },
    {
      description: '-7 % 2 == -1 (dividend sign) → ALLOW',
      expectation: 'ALLOW',
      method: 'delete',
      path: 'math/data.bin',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
  ],
};
