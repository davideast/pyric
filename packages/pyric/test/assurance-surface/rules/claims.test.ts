import { describe, expect, test } from 'bun:test';
import {
  firestoreRequiredClaims,
  rtdbRequiredClaims,
  storageRequiredClaims,
} from '../../../src/assurance-surface/rules/claims.js';

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

  test('inlines literal-argument parameterized helpers, skips dynamic arguments and wrong arity, and isolates match-scoped functions', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function checkRole(expected) {
      return request.auth.token.role == expected;
    }
    match /alpha/{docId} {
      function gate() {
        return request.auth.token.alphaMember == true;
      }
      allow create: if gate() && checkRole('reader') && checkRole(resource.data.requiredRole);
    }
    match /beta/{docId} {
      function gate() {
        return request.auth.token.betaMember == true;
      }
      allow create: if gate() && checkRole();
    }
  }
}`;

    expect(firestoreRequiredClaims(rules, { path: 'alpha/a1', op: 'create' })).toEqual({
      alphaMember: true,
      role: 'reader',
    });
    expect(firestoreRequiredClaims(rules, { path: 'beta/b1', op: 'create' })).toEqual({
      betaMember: true,
    });
  });

  test('extracts bracket indexing, value in list, key in token map, and preserves own __proto__ claim keys', () => {
    const bracketRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow create: if request.auth.token['org_role'] == 'member'
        && request.auth.token.role in ['editor', 'admin']
        && 'org_member' in request.auth.token
        && request.auth.token.__proto__ == 'member';
    }
  }
}`;
    const claims = firestoreRequiredClaims(bracketRules, { path: 'items/1', op: 'create' });
    expect(claims.org_role).toBe('member');
    expect(claims.role).toBe('editor');
    expect(claims.org_member).toBe(true);
    expect(Object.hasOwn(claims, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(claims, '__proto__')?.value).toBe('member');
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
        bracketed: {
          $id: {
            '.write': "auth.token['org_role'] === 'member' && auth.token['__proto__'] === 'tenant'",
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
    const rtdbBracket = rtdbRequiredClaims(rules, { path: 'bracketed/1', op: 'create' });
    expect(rtdbBracket.org_role).toBe('member');
    expect(Object.hasOwn(rtdbBracket, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(rtdbBracket, '__proto__')?.value).toBe('tenant');
  });
});

describe('storageRequiredClaims', () => {
  test('scopes required custom claims to the target Storage bucket and path without granting escape-hatch claims', () => {
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /adminExports/{fileId} {
      allow read, write: if request.auth.token.staff == true;
    }
    match /files/{uid}/{fileId} {
      allow read, write: if request.auth.token.appMember == true
        && (request.auth.uid == uid || request.auth.token.staff == true);
    }
  }
}`;

    expect(storageRequiredClaims(storageRules, { path: 'files/u-1/doc.png', op: 'create' })).toEqual({
      appMember: true,
    });
    expect(storageRequiredClaims(storageRules, { path: 'adminExports/e-1.csv', op: 'get' })).toEqual({
      staff: true,
    });
  });

  test('extracts Map.get(key, default) and keys().hasAll / hasAny / in claims commutatively across Firestore and Storage', () => {
    const fsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow write: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.keys().hasAll(['role', 'orgMember'])
        && request.auth.token.get('role', '') == 'editor'
        && request.auth.token.get(['scope', 'tier'], 'free') == 'pro'
        && 'featureFlag' in request.auth.token.keys();
    }
  }
}`;
    expect(firestoreRequiredClaims(fsRules, { path: 'users/u1', op: 'create' })).toEqual({
      role: 'editor',
      orgMember: true,
      scope: { tier: 'pro' },
      featureFlag: true,
    });

    const stRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/doc.txt {
      allow write: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.get('role', '') in ['reviewer', 'admin']
        && request.auth.token.keys().hasAny(['workspaceMember', 'staff']);
    }
  }
}`;
    expect(storageRequiredClaims(stRules, { path: 'users/u1/doc.txt', op: 'create' })).toEqual({
      role: 'reviewer',
      workspaceMember: true,
    });
  });

  test('extracts email_verified == true across Firestore, Storage, and RTDB while keeping other standard ID-token fields excluded', () => {
    const fsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{uid} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.email == 'u1@example.test'
        && request.auth.token.email_verified == true;
    }
  }
}`;
    expect(firestoreRequiredClaims(fsRules, { path: 'notes/u1', op: 'create' })).toEqual({
      email_verified: true,
    });

    const stEmailRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow write: if request.auth != null && request.auth.token.email_verified == true;
    }
  }
}`;
    expect(storageRequiredClaims(stEmailRules, { path: 'files/u1/a.png', op: 'create' })).toEqual({
      email_verified: true,
    });

    const rtdbJson = {
      rules: {
        notes: {
          $uid: {
            '.write': 'auth != null && auth.token.email_verified === true',
          },
        },
      },
    };
    expect(rtdbRequiredClaims(rtdbJson, { path: 'notes/u1', op: 'set' })).toEqual({
      email_verified: true,
    });

    const unverifiedFsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /pending/{uid} {
      allow write: if request.auth != null && !request.auth.token.email_verified;
    }
    match /unconfirmed/{uid} {
      allow write: if request.auth != null && request.auth.token.email_verified != true;
    }
  }
}`;
    expect(firestoreRequiredClaims(unverifiedFsRules, { path: 'pending/u1', op: 'create' })).toEqual({
      email_verified: false,
    });
    expect(
      firestoreRequiredClaims(unverifiedFsRules, { path: 'unconfirmed/u1', op: 'create' }),
    ).toEqual({
      email_verified: false,
    });
  });
});
