/**
 * ─── resource-document-identity ─────────────────────────────────────────────────
 * RULES-B12 — resource identity is ABSENT in production, on an EXISTING document.
 *
 * The neighbouring `globals-request-path-and-resource-id` scenario only covers
 * `create`, where `resource` is null because the target does not exist yet.
 * That left the dangerous case uncovered: on get/update/delete the document DOES
 * exist, `resource` is a real object — and the simulator used to attach an `id`
 * and `__name__` derived from the request path. Production does not. It builds
 * `resource` from the stored document alone, so the identity keys are simply not
 * there, and reading one is a runtime error:
 *
 *   Error: firestore.rules line [L], column [C]. Property id is undefined on object.
 *   Error: firestore.rules line [L], column [C]. Property __name__ is undefined on object.
 *
 * So `resource.id == id` DENIES in production and used to ALLOW in the
 * simulator — over-permissive, the dangerous direction of wrong.
 *
 * The error is a propagating value, not a false: it SURVIVES NEGATION
 * (`resource.id != 'zzz'` DENIES — it does not become `true` the way a JS
 * `undefined != 'zzz'` would) and is absorbed only by a determining `||`
 * operand. Both directions are pinned below, because "model absent as
 * undefined" passes the equality case and silently false-ALLOWS the negation.
 *
 * `request.resource.id` gets the same treatment: production's `request.resource`
 * is `{ data }` too.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-B12',
  rationale:
    'On an EXISTING doc, production leaves resource.id/__name__ absent — reading one errors → DENY, and the error survives negation. The simulator synthesized them from the request path, so `resource.id == id` ALLOWed where production DENIES (over-permissive). request.resource.id is absent in production likewise.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // ── resource.id on an EXISTING doc: absent in prod → error → DENY.
    match /idEq/{id} {
      allow get, update, delete: if resource.id == id;
    }
    // Type test does not rescue it — the property read errors first.
    match /idIsString/{id} {
      allow get: if resource.id is string;
    }
    // ── resource.__name__ on an EXISTING doc: absent in prod → error → DENY.
    match /nameEq/{id} {
      allow get: if resource.__name__ == request.path;
    }
    // ── NEGATION: the error PROPAGATES, it does not flip to true.
    // Modeling absent-as-undefined would ALLOW here (undefined != 'zzz').
    match /idNotEq/{id} {
      allow get: if resource.id != 'zzz';
    }
    match /idBangEq/{id} {
      allow get: if !(resource.id == 'zzz');
    }
    // ── ABSORPTION: a determining || operand absorbs the error → ALLOW.
    match /idOrTrue/{id} {
      allow get: if resource.id == 'zzz' || true;
    }
    // ── && does NOT absorb it (no false operand to determine the result).
    match /idAndTrue/{id} {
      allow get: if resource.id == 'zzz' && true;
    }
    // ── resource.data still works — this fix must not regress the real field.
    match /dataWorks/{id} {
      allow get: if resource.data.owner == 'alice';
    }
    // ── request.resource identity is absent in prod too.
    match /reqIdEq/{id} {
      allow update: if request.resource.id == id;
    }
    match /reqIdNotEq/{id} {
      allow update: if request.resource.id != 'zzz';
    }
    // ── request.resource.data still works (the incoming payload).
    match /reqDataWorks/{id} {
      allow update: if request.resource.data.owner == 'alice';
    }
  }
}`,
  cases: [
    // The document EXISTS in every case below (`resource` is supplied), which
    // is exactly what makes these different from the create-path scenario.
    {
      description: 'resource.id == id on existing doc (get) → DENY (identity absent in prod)',
      expectation: 'DENY',
      method: 'get',
      path: 'idEq/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
    },
    {
      description: 'resource.id == id on existing doc (update) → DENY (identity absent in prod)',
      expectation: 'DENY',
      method: 'update',
      path: 'idEq/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
      data: { owner: 'alice' },
    },
    {
      description: 'resource.id == id on existing doc (delete) → DENY (identity absent in prod)',
      expectation: 'DENY',
      method: 'delete',
      path: 'idEq/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
    },
    {
      description: 'resource.id is string on existing doc → DENY (read errors before the type test)',
      expectation: 'DENY',
      method: 'get',
      path: 'idIsString/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
    },
    {
      description: 'resource.__name__ == request.path on existing doc → DENY (identity absent in prod)',
      expectation: 'DENY',
      method: 'get',
      path: 'nameEq/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
    },
    {
      // The load-bearing case: an absent-as-undefined model ALLOWs this.
      description: "resource.id != 'zzz' on existing doc → DENY (error survives negation)",
      expectation: 'DENY',
      method: 'get',
      path: 'idNotEq/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
    },
    {
      description: "!(resource.id == 'zzz') on existing doc → DENY (error survives negation)",
      expectation: 'DENY',
      method: 'get',
      path: 'idBangEq/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
    },
    {
      description: "resource.id == 'zzz' || true → ALLOW (determining || operand absorbs the error)",
      expectation: 'ALLOW',
      method: 'get',
      path: 'idOrTrue/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
    },
    {
      description: "resource.id == 'zzz' && true → DENY (no false operand to absorb the error)",
      expectation: 'DENY',
      method: 'get',
      path: 'idAndTrue/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
    },
    {
      description: "resource.data.owner == 'alice' on existing doc → ALLOW (control: data is unaffected)",
      expectation: 'ALLOW',
      method: 'get',
      path: 'dataWorks/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
    },
    {
      description: 'request.resource.id == id on update → DENY (identity absent in prod)',
      expectation: 'DENY',
      method: 'update',
      path: 'reqIdEq/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
      data: { owner: 'alice' },
    },
    {
      description: "request.resource.id != 'zzz' on update → DENY (error survives negation)",
      expectation: 'DENY',
      method: 'update',
      path: 'reqIdNotEq/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice' },
      data: { owner: 'alice' },
    },
    {
      description: "request.resource.data.owner == 'alice' on update → ALLOW (control: incoming data is unaffected)",
      expectation: 'ALLOW',
      method: 'update',
      path: 'reqDataWorks/doc1',
      auth: { uid: 'alice' },
      resource: { owner: 'bob' },
      data: { owner: 'alice' },
    },
  ],
  group: 'fix-class',
};
