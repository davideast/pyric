/**
 * ─── Scenario: required-fields-and-mapdiff ────────────────────────────────────
 * The everyday required-fields validation idiom, verified against production:
 * `request.resource.data.keys().hasAll([...])` / `.hasOnly([...])` on create,
 * and the `request.resource.data.diff(resource.data)` MapDiff family on update
 * (addedKeys / removedKeys / changedKeys / affectedKeys / unchangedKeys) to
 * constrain which fields a mutation may touch. An owner-scoped `articles`
 * collection: create requires the exact field set and self-ownership; update may
 * only change `title`/`body` and must leave `ownerId` intact.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Coverage: List/Set + MapDiff required-fields idiom',
  rationale:
    'Production must accept the keys().hasAll/hasOnly required-fields pattern and the diff().*Keys() MapDiff family used to gate field-level mutations.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /articles/{articleId} {
      // create: exact required field set, self-owned
      allow create: if request.auth != null
        && request.resource.data.keys().hasAll(['title', 'body', 'ownerId', 'tags'])
        && request.resource.data.keys().hasOnly(['title', 'body', 'ownerId', 'tags'])
        && request.resource.data.ownerId == request.auth.uid;
      // update: only title/body may change; ownerId immutable, no add/remove
      allow update: if request.auth != null
        && resource.data.ownerId == request.auth.uid
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['title', 'body'])
        && request.resource.data.diff(resource.data).changedKeys().hasAny(['title', 'body'])
        && request.resource.data.diff(resource.data).addedKeys().size() == 0
        && request.resource.data.diff(resource.data).removedKeys().size() == 0
        && request.resource.data.diff(resource.data).unchangedKeys().hasAll(['ownerId']);
    }
  }
}`,
  cases: [
    {
      description: 'create with exact required fields, self-owned ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'articles/a1',
      auth: { uid: 'alice' },
      data: { title: 'Hello', body: 'World', ownerId: 'alice', tags: ['x'] },
    },
    {
      description: 'create missing a required field DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'articles/a2',
      auth: { uid: 'alice' },
      data: { title: 'Hello', ownerId: 'alice', tags: ['x'] },
    },
    {
      description: 'create with an extra field DENY (hasOnly)',
      expectation: 'DENY',
      method: 'create',
      path: 'articles/a3',
      auth: { uid: 'alice' },
      data: { title: 'Hello', body: 'World', ownerId: 'alice', tags: ['x'], extra: 1 },
    },
    {
      description: 'create where ownerId != caller DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'articles/a4',
      auth: { uid: 'alice' },
      data: { title: 'Hello', body: 'World', ownerId: 'bob', tags: ['x'] },
    },
    {
      description: 'update changing only title ALLOW',
      expectation: 'ALLOW',
      method: 'update',
      path: 'articles/a5',
      auth: { uid: 'alice' },
      resource: { title: 'Old', body: 'Body', ownerId: 'alice', tags: ['x'] },
      data: { title: 'New', body: 'Body', ownerId: 'alice', tags: ['x'] },
    },
    {
      description: 'update touching ownerId DENY (affectedKeys hasOnly)',
      expectation: 'DENY',
      method: 'update',
      path: 'articles/a6',
      auth: { uid: 'alice' },
      resource: { title: 'Old', body: 'Body', ownerId: 'alice', tags: ['x'] },
      data: { title: 'New', body: 'Body', ownerId: 'bob', tags: ['x'] },
    },
    {
      description: 'update adding a new field DENY (addedKeys size 0)',
      expectation: 'DENY',
      method: 'update',
      path: 'articles/a7',
      auth: { uid: 'alice' },
      resource: { title: 'Old', body: 'Body', ownerId: 'alice', tags: ['x'] },
      data: { title: 'New', body: 'Body', ownerId: 'alice', tags: ['x'], pinned: true },
    },
  ],
  group: 'stress',
};
