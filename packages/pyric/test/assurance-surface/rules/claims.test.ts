import { describe, expect, test } from 'bun:test';
import { firestoreRequiredClaims, rtdbRequiredClaims } from '../../../src/assurance-surface/rules/claims.js';

describe('firestoreRequiredClaims', () => {
  test('scopes required claims per template and never grants escape-hatch claims from other paths', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /adminLogs/{logId} {
      allow read, write: if request.auth.token.admin == true;
    }
    match /posts/{postId} {
      allow create: if request.auth.token.hasAccess != null
        && request.resource.data.author == request.auth.uid;
      allow delete: if request.auth.token.hasAccess != null
        && (resource.data.author == request.auth.uid || request.auth.token.admin == true);
    }
  }
}`;

    expect(firestoreRequiredClaims(rules, { path: 'posts/{postId}', op: 'delete' })).toEqual({
      hasAccess: true,
    });
    expect(firestoreRequiredClaims(rules, { path: 'adminLogs/{logId}', op: 'create' })).toEqual({
      admin: true,
    });
  });

  test('intersects across multiple matching allow rules including recursive admin rules', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth.token.superAdmin == true;
    }
    match /posts/{postId} {
      allow delete: if resource.data.author == request.auth.uid;
    }
  }
}`;

    expect(firestoreRequiredClaims(rules, { path: 'posts/p-1', op: 'delete' })).toEqual({});
    expect(firestoreRequiredClaims(rules, { path: 'audit/a-1', op: 'delete' })).toEqual({
      superAdmin: true,
    });
  });

  test('does not inline parameterized helpers as parameterless and isolates match-scoped functions', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function checkRole(expected) {
      return request.auth.token.role == 'admin' && expected != '';
    }
    match /alpha/{docId} {
      function gate() {
        return request.auth.token.alphaMember == true;
      }
      allow create: if gate() && checkRole('reader');
    }
    match /beta/{docId} {
      function gate() {
        return request.auth.token.betaMember == true;
      }
      allow create: if gate();
    }
  }
}`;

    expect(firestoreRequiredClaims(rules, { path: 'alpha/a1', op: 'create' })).toEqual({
      alphaMember: true,
    });
    expect(firestoreRequiredClaims(rules, { path: 'beta/b1', op: 'create' })).toEqual({
      betaMember: true,
    });
  });
});

describe('rtdbRequiredClaims', () => {
  test('scopes required claims to the target path and excludes sibling and disjunctive admin claims', () => {
    const rules = {
      rules: {
        adminLogs: {
          $logId: {
            '.write': 'auth.token.admin === true',
          },
        },
        posts: {
          $postId: {
            '.write': 'auth.token.member === true && (data.child("author").val() === auth.uid || auth.token.admin === true)',
            '.validate': 'auth.token.org === "acme"',
          },
        },
      },
    };

    expect(rtdbRequiredClaims(rules, { path: 'posts/p-1', op: 'delete' })).toEqual({
      member: true,
    });
    expect(rtdbRequiredClaims(rules, { path: 'posts/p-1', op: 'create' })).toEqual({
      member: true,
      org: 'acme',
    });
    expect(rtdbRequiredClaims(rules, { path: 'adminLogs/l-1', op: 'create' })).toEqual({
      admin: true,
    });
  });
});
