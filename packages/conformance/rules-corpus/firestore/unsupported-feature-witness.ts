/**
 * ─── Scenario 3: unsupported-feature-witness ──────────────────────────────────
 * Targets Item 0.A — proves the SIM_NOT_SUPPORTED path in the harness.
 * `hashing.crc32` is a real Firestore Rules built-in we have not yet
 * implemented. Production evaluates it; the simulator must abstain
 * (state: UNSUPPORTED) instead of silently denying. This scenario is the
 * regression gate for "did we forget to plumb UNSUPPORTED end-to-end?"
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Item 0.A',
  rationale: 'Sim must report UNSUPPORTED (not silently DENY) when it hits a real built-in it has not implemented.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if hashing.crc32(request.auth.token.email).toBase64() != '';
    }
  }
}`,
  cases: [
    {
      description: 'hashing.crc32(...) — sim should ABSTAIN, prod should ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
    },
  ],
  group: 'stress',
};
