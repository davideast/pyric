import { describe, expect, test } from 'bun:test';
import { firestoreOwnerConditions } from '../../../src/assurance-surface/rules/firestore-owners.js';
import type { OwnerCondition } from '../../../src/assurance-surface/rules/types.js';

function briefItem(c: OwnerCondition): Record<string, unknown> {
  const item: Record<string, unknown> = {
    path: c.path,
    ops: c.ops,
    kind: c.kind,
    field: c.field,
    relation: c.relation,
    required: c.required,
    source: c.source,
  };
  if (c.varIndex !== undefined) item.varIndex = c.varIndex;
  return item;
}

const brief = (source: string) => firestoreOwnerConditions(source, 'firestore.rules').map(briefItem);

describe('firestoreOwnerConditions', () => {
  test('path variable, stored and incoming fields, per operation', () => {
    const out = brief(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
    }
    match /posts/{postId} {
      allow create: if request.resource.data.author == request.auth.uid;
      allow update, delete: if resource.data['author'] == request.auth.uid || request.auth.token.admin == true;
    }
  }
}`);
    expect(out).toEqual([
      { path: 'users/{userId}', ops: ['get', 'list', 'create', 'update', 'delete'], kind: 'pathVar', field: '{userId}', relation: 'equals', required: true, source: 'firestore.rules:5', varIndex: 1 },
      { path: 'posts/{postId}', ops: ['create'], kind: 'incomingField', field: 'author', relation: 'equals', required: true, source: 'firestore.rules:8' },
      { path: 'posts/{postId}', ops: ['update', 'delete'], kind: 'storedField', field: 'author', relation: 'equals', required: false, source: 'firestore.rules:9' },
    ]);
  });

  test('helper functions are inlined with arguments bound, and lets resolve', () => {
    const out = brief(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner(uid) { return request.auth != null && request.auth.uid == uid; }
    function ownsDoc() { let owner = resource.data.ownerId; return isOwner(owner); }
    match /notes/{noteId} {
      allow update: if ownsDoc();
      allow create: if isOwner(request.resource.data.ownerId);
    }
    match /teams/{teamId}/docs/{docId} {
      allow read: if request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.members;
      allow write: if exists(/databases/$(database)/documents/teams/$(teamId)/admins/$(request.auth.uid));
    }
  }
}`);
    expect(out.map((c) => [c.path, c.kind, c.field, c.relation])).toEqual([
      ['notes/{noteId}', 'storedField', 'ownerId', 'equals'],
      ['notes/{noteId}', 'incomingField', 'ownerId', 'equals'],
      ['teams/{teamId}/docs/{docId}', 'lookup', 'teams/{teamId}#members', 'contains'],
      ['teams/{teamId}/docs/{docId}', 'lookup', 'teams/{teamId}/admins/{auth.uid}', 'exists'],
    ]);
  });

  test('negated lookups, blocklists, and inequalities do not emit positive owner conditions', () => {
    const out = brief(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isBanned(roomId) {
      return exists(/databases/$(database)/documents/rooms/$(roomId)/banned/$(request.auth.uid));
    }
    match /rooms/{roomId}/messages/{msgId} {
      allow create: if !isBanned(roomId)
        && exists(/databases/$(database)/documents/rooms/$(roomId)/suspended/$(request.auth.uid)) == false
        && exists(/databases/$(database)/documents/rooms/$(roomId)/muted/$(request.auth.uid)) != true
        && !(request.auth.uid in get(/databases/$(database)/documents/rooms/$(roomId)).data.blocked)
        && !(request.resource.data.reviewerId == request.auth.uid)
        && request.resource.data.approverId != request.auth.uid
        && !!exists(/databases/$(database)/documents/rooms/$(roomId)/members/$(request.auth.uid))
        && request.resource.data.authorId == request.auth.uid;
    }
  }
}`);
    expect(out.map((c) => [c.kind, c.field, c.relation, c.required])).toEqual([
      ['lookup', 'rooms/{roomId}/members/{auth.uid}', 'exists', true],
      ['incomingField', 'authorId', 'equals', true],
    ]);
  });

  test('recursive wildcards keep their template; unparsable rules give nothing', () => {
    const out = brief(`rules_version = '2';
service cloud.firestore { match /databases/{database}/documents { match /u/{uid}/{rest=**} { allow read: if request.auth.uid == uid; } } }`);
    expect(out.map((c) => [c.path, c.field, c.varIndex])).toEqual([['u/{uid}/{rest=**}', '{uid}', 1]]);
    expect(brief('not rules')).toEqual([]);
  });

  test('auth-keyed get(...).data field boolean/scalar checks and lexically shadowed wildcards emit lookup conditions', () => {
    const conds = firestoreOwnerConditions(
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{id} {
      match /items/{id} {
        allow read, write: if request.auth != null
          && request.resource.data.ownerId == request.auth.uid
          && get(/databases/$(database)/documents/members/$(request.auth.uid)).data.active == true
          && get(/databases/$(database)/documents/members/$(request.auth.uid)).data.role == 'editor';
      }
      match /users/{id} {
        allow read: if request.auth.uid == id;
      }
    }
  }
}`,
      'firestore.rules',
    );
    expect(conds.map((c) => [c.path, c.kind, c.field, c.relation, c.seedValue, c.varIndex])).toEqual([
      ['orgs/{id}/items/{id}', 'incomingField', 'ownerId', 'equals', undefined, undefined],
      ['orgs/{id}/items/{id}', 'lookup', 'members/{auth.uid}#active', 'exists', true, undefined],
      ['orgs/{id}/items/{id}', 'lookup', 'members/{auth.uid}#role', 'exists', 'editor', undefined],
      ['orgs/{id}/users/{id}', 'pathVar', '{id}', 'equals', undefined, 3],
    ]);
  });
});
