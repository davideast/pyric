/**
 * Distinguishing witness for nested Firestore match composition.
 *
 * A nested match resolves relative to its parent. Where a recursive wildcard
 * sits in a match path decides what it matches. The collection-group rule
 * shape Firebase documents for `rules_version = '2'` puts the recursive
 * wildcard first and a collection id and a document wildcard after it:
 * `match /{path=**}/items/{id}`. The recursive segment matches zero or more
 * leading segments, so the rule governs every document in a collection named
 * `items` at any depth, including the root `items` collection, and nothing
 * else. A match nested inside a block of that shape matches no request.
 *
 * A recursive wildcard in the last position of a block's path matches zero or
 * more segments, and a nested match continues after it at any depth. The
 * wildcard binds the longest prefix that leaves the nested match's segments,
 * so in `notes/n1/notes/n2` the nested document wildcard binds `n2`.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'CDD: hierarchical match cascade',
  rationale:
    'A nested match must resolve relative to its parent: the exact child path allows while the parent, a sibling, and an extra descendant deny. A recursive wildcard followed by further segments matches zero or more leading segments and reaches no nested match, while one in the last position lets a nested match resolve at any depth.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /parents/{parentId} {
      match /children/{childId} {
        allow get: if true;
      }
    }
    match /{path=**}/items/{id} {
      allow read: if request.auth != null;
    }
    match /{prefix=**}/tagged/{tagId} {
      allow get: if tagId == 'x1';
    }
    match /{group=**}/groups/{groupId} {
      match /members/{memberId} {
        allow get: if true;
      }
    }
    match /{document=**} {
      match /notes/{noteId} {
        allow get: if noteId == 'n1';
      }
    }
  }
}`,
  cases: [
    {
      description: 'exact nested child path ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'parents/p1/children/c1',
      resource: { value: 1 },
    },
    {
      description: 'parent path without child DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'parents/p1',
      resource: { value: 1 },
    },
    {
      description: 'sibling path outside nested match DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'parents/p1/siblings/s1',
      resource: { value: 1 },
    },
    {
      description: 'descendant beyond exact nested match DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'parents/p1/children/c1/grandchildren/g1',
      resource: { value: 1 },
    },
    {
      description: 'get in a subcollection items ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'users/u1/items/i1',
      auth: { uid: 'alice' },
      resource: { value: 1 },
    },
    {
      description: 'get in the root items collection ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/i1',
      auth: { uid: 'alice' },
      resource: { value: 1 },
    },
    {
      description: 'get in a deeply nested items collection ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'a/b/c/d/items/i1',
      auth: { uid: 'alice' },
      resource: { value: 1 },
    },
    {
      description: 'get in an items collection under an items document ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/i1/items/i2',
      auth: { uid: 'alice' },
      resource: { value: 1 },
    },
    {
      description: 'get in an items collection under a document with id items ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/items/items/i3',
      auth: { uid: 'alice' },
      resource: { value: 1 },
    },
    {
      description: 'anonymous get in items DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'users/u1/items/i1',
      auth: null,
      resource: { value: 1 },
    },
    {
      description: 'get in a sibling collection DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'users/u1/other/o1',
      auth: { uid: 'alice' },
      resource: { value: 1 },
    },
    {
      description: 'get under an items document DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'users/u1/items/i1/sub/s1',
      auth: { uid: 'alice' },
      resource: { value: 1 },
    },
    {
      description: 'get of the parent document DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'users/u1',
      auth: { uid: 'alice' },
      resource: { value: 1 },
    },
    {
      description: 'list a subcollection items ALLOW',
      expectation: 'ALLOW',
      method: 'list',
      path: 'users/u1/items/i1',
      auth: { uid: 'alice' },
    },
    {
      description: 'list the root items collection ALLOW',
      expectation: 'ALLOW',
      method: 'list',
      path: 'items/i1',
      auth: { uid: 'alice' },
    },
    {
      description: 'anonymous list of items DENY',
      expectation: 'DENY',
      method: 'list',
      path: 'users/u1/items/i1',
      auth: null,
    },
    {
      description: 'trailing wildcard binds the document id ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'shops/s1/tagged/x1',
      resource: { value: 1 },
    },
    {
      description: 'trailing wildcard rejects another document id DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'shops/s1/tagged/x2',
      resource: { value: 1 },
    },
    {
      description: 'nested match under a nested groups document DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'orgs/o1/groups/g1/members/m1',
      resource: { value: 1 },
    },
    {
      description: 'nested match under a root groups document DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'groups/g1/members/m1',
      resource: { value: 1 },
    },
    {
      description: 'groups document without the nested segment DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'orgs/o1/groups/g1',
      resource: { value: 1 },
    },
    {
      description: 'nested match after a final recursive wildcard at the root ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'notes/n1',
      resource: { value: 1 },
    },
    {
      description: 'nested match after a final recursive wildcard at depth ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'a/1/b/2/notes/n1',
      resource: { value: 1 },
    },
    {
      description: 'nested wildcard binds the last notes document DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'notes/n1/notes/n2',
      resource: { value: 1 },
    },
    {
      description: 'nested wildcard binds the last notes document ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'notes/n2/notes/n1',
      resource: { value: 1 },
    },
  ],
  group: 'fix-class',
};
