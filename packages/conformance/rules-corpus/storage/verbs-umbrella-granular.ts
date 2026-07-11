/**
 * ─── Pack 1: verbs-umbrella-granular ────────────────────────────────────────
 * The stale storage matrix (#96/#104) claims granular verbs are unsupported.
 * This pack proves the evaluator's read→{get,list} / write→{create,update,
 * delete} expansion, granular single-verb grants, comma-separated verbs,
 * per-verb deny-by-default, and create-vs-update keyed on object existence.
 */
import type { StoragePackRecord } from './types.ts';

export const pack: StoragePackRecord = {
  fm: 'STORAGE-VERBS',
  rationale:
    'Umbrella read/write expansion, granular verb grants, comma-separated verbs, per-verb default-deny, and create-vs-update on resource existence.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /readonly/{fileId} {
      allow read: if true;
    }
    match /writeonly/{fileId} {
      allow write: if true;
    }
    match /getonly/{fileId} {
      allow get: if true;
    }
    match /pair/{fileId} {
      allow get, delete: if true;
    }
    match /existence/{fileId} {
      allow create: if resource == null;
      allow update: if resource != null;
    }
  }
}`,
  cases: [
    // read → get + list
    { description: 'read grant covers get', expectation: 'ALLOW', method: 'get', path: 'readonly/a.txt' },
    { description: 'read grant covers list', expectation: 'ALLOW', method: 'list', path: 'readonly/a.txt' },
    { description: 'read grant denies create (no write grant)', expectation: 'DENY', method: 'create', path: 'readonly/a.txt', resource: { size: 1024, contentType: 'text/plain' } },
    { description: 'read grant denies delete', expectation: 'DENY', method: 'delete', path: 'readonly/a.txt', existingResource: { size: 1024 } },
    // write → create + update + delete
    { description: 'write grant covers create', expectation: 'ALLOW', method: 'create', path: 'writeonly/b.png', resource: { size: 2048, contentType: 'image/png' } },
    { description: 'write grant covers update', expectation: 'ALLOW', method: 'update', path: 'writeonly/b.png', resource: { size: 2048, contentType: 'image/png' }, existingResource: { size: 1000 } },
    { description: 'write grant covers delete', expectation: 'ALLOW', method: 'delete', path: 'writeonly/b.png', existingResource: { size: 1000 } },
    { description: 'write grant denies get', expectation: 'DENY', method: 'get', path: 'writeonly/b.png', existingResource: { size: 1000 } },
    // granular single verb
    { description: 'get grant covers get', expectation: 'ALLOW', method: 'get', path: 'getonly/c.txt', existingResource: { size: 5 } },
    { description: 'get grant denies list (get is not read)', expectation: 'DENY', method: 'list', path: 'getonly/c.txt' },
    // comma-separated verbs
    { description: 'comma verbs grant get', expectation: 'ALLOW', method: 'get', path: 'pair/d.txt', existingResource: { size: 5 } },
    { description: 'comma verbs grant delete', expectation: 'ALLOW', method: 'delete', path: 'pair/d.txt', existingResource: { size: 5 } },
    { description: 'comma verbs deny create (not listed)', expectation: 'DENY', method: 'create', path: 'pair/d.txt', resource: { size: 5, contentType: 'text/plain' } },
    // create-vs-update keyed on existence
    // KNOWN DIVERGENCE (pinned in test/storage/rules-oracle-conformance.test.ts
    // KNOWN_DIVERGENCES, issue #134): the capture disagrees with this
    // `expectation`. Production throws a "Null value error" referencing
    // `resource` on a create where no object exists yet (live-probed with
    // both an omitted resource field and an explicit null — identical
    // result), and denies, instead of evaluating `resource == null` as
    // documented. The evaluator models resource as null on create and
    // allows, matching the documented semantics. Left as `expectation:
    // 'ALLOW'` — the pre-capture belief this pack was written from — per the
    // Firestore stress-pack convention of not rewriting expectations after
    // a divergence is captured and pinned.
    { description: 'create allowed when object does not exist (resource == null)', expectation: 'ALLOW', method: 'create', path: 'existence/e.txt', resource: { size: 10, contentType: 'text/plain' }, existingResource: null },
    { description: 'update allowed when object exists (resource != null)', expectation: 'ALLOW', method: 'update', path: 'existence/e.txt', resource: { size: 20, contentType: 'text/plain' }, existingResource: { size: 10 } },
    { description: 'create denied when object already exists (create rule requires resource == null)', expectation: 'DENY', method: 'create', path: 'existence/e.txt', resource: { size: 20, contentType: 'text/plain' }, existingResource: { size: 10 } },
  ],
};
