/**
 * ─── Scenario: type-checks-is ────────────────────────────────────────────────
 * The `is` operator — newly evaluable in storage rules (PR #333 / #150) — over
 * the storage bindings (size is int, contentType is string, metadata is map,
 * split() result is list) plus the int/float LITERAL distinction the Firestore
 * engine already pinned (rules-firestore-int-float-and-division): `1.0 is
 * float` and `1 is int` are true, the cross checks false. pyric's storage
 * evaluator types by VALUE (integral number → int), a documented divergence
 * this scenario exists to pin against production.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: is (int/float/string/map/list), literal typing',
  rationale:
    '`is` must type storage bindings correctly, and literal 1.0 must be float / 1 must be int (distinct types) per captured Firestore engine truth — the value-typed evaluator diverges on 1.0 is float.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /types/{fileId} {
      allow create: if request.resource.size is int
        && request.resource.contentType is string
        && request.resource.metadata is map
        && fileId.split('-') is list;
      // literal typing: 1.0 is float, 1 is int, and NOT vice versa
      allow update: if 1.0 is float
        && 1 is int
        && !(1 is float)
        && !(1.0 is int);
      // a path wildcard is a string, never an int
      allow delete: if fileId is int;
    }
  }
}`,
  cases: [
    {
      description: 'storage bindings type as int/string/map/list → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'types/a-b.png',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'image/png', metadata: { owner: 'alice' } },
    },
    {
      description: '1.0 is float / 1 is int, cross checks false → ALLOW',
      expectation: 'ALLOW',
      method: 'update',
      path: 'types/a-b.png',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'image/png' },
      existingResource: { size: 100 },
    },
    {
      description: 'path wildcard is int → DENY',
      expectation: 'DENY',
      method: 'delete',
      path: 'types/a-b.png',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
  ],
};
