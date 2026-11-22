import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../src/grammar/FirestoreParser.js';
import { validateFirestoreRules } from '../../src/grammar/FirestoreValidator.js';
import { lint } from '../../src/index.js';

function validateSource(source: string) {
  const ast = parseToAST(source);
  if (!ast) throw new Error('expected valid AST');
  return validateFirestoreRules(ast, { rawSource: source });
}

describe('SEC-5 owner-scoped recursive wildcard severity and Firebase Storage doc fixtures (#1518)', () => {
  test('downgrades SEC-5 to medium (warning) in both Firestore and Storage when recursive wildcard sits under a path variable checked against request.auth.uid', () => {
    const firestoreOwnerSubtree = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if request.auth != null && userId == request.auth['uid'] && request.resource.data.keys().size() > 0;
    }
  }
}`;
    const fsFindings = validateSource(firestoreOwnerSubtree).filter((f) => f.code === 'SEC-5');
    expect(fsFindings).toHaveLength(2);
    expect(fsFindings.map((f) => f.severity)).toEqual(['medium', 'medium']);
    const fsIssues = lint(firestoreOwnerSubtree);
    expect(fsIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(fsIssues.filter((i) => i.code === 'SEC-5').map((i) => i.severity)).toEqual([
      'warning',
      'warning',
    ]);

    const storageOwnerValidated = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function isOwner(uid) {
      return request.auth != null && !(request.auth.uid != uid);
    }
    match /users/{userId}/{allPaths=**} {
      allow read: if isOwner(userId);
      allow write: if isOwner(userId) && request.resource.size < 5 * 1024 * 1024;
    }
  }
}`;
    const stFindings = validateSource(storageOwnerValidated).filter((f) => f.code === 'SEC-5');
    expect(stFindings).toHaveLength(2);
    expect(stFindings.map((f) => f.severity)).toEqual(['medium', 'medium']);
    const stIssues = lint(storageOwnerValidated);
    expect(stIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(stIssues.filter((i) => i.code === 'SEC-5').map((i) => i.severity)).toEqual([
      'warning',
      'warning',
    ]);
  });

  test('keeps SEC-5 high (error) when recursive wildcard is not gated on an enclosing path variable matching request.auth.uid', () => {
    const cases: ReadonlyArray<readonly [label: string, source: string]> = [
      [
        'root recursive wildcard with signed-in check only',
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if request.auth != null;
    }
  }
}`,
      ],
      [
        'disjunction bypasses owner check',
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/{allPaths=**} {
      allow read: if request.auth.uid == userId || request.auth != null;
    }
  }
}`,
      ],
      [
        'helper parameter shadows userId with non-owner argument',
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function checkUid(userId) {
      return request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/{allPaths=**} {
      allow read: if checkUid('admin');
    }
  }
}`,
      ],
      [
        'comparison against the recursive wildcard itself rather than an enclosing prefix wildcard',
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if request.auth != null && request.auth.uid == string(allPaths);
    }
  }
}`,
      ],
    ];

    for (const [label, source] of cases) {
      const sec5 = validateSource(source).filter((f) => f.code === 'SEC-5');
      expect([label, sec5.map((f) => f.severity)]).toEqual([label, ['high']]);
    }
  });

  test('pins Firebase documented Storage rules samples as lint fixtures (#1518)', () => {
    const ownerRecursiveReadOnly = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/{allPaths=**} {
      allow read: if request.auth != null && request.auth.uid == userId;
    }
  }
}`;
    expect(lint(ownerRecursiveReadOnly).filter((i) => i.severity === 'error')).toEqual([]);

    const ownerRecursiveReadWrite = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}`;
    const ownerIssues = lint(ownerRecursiveReadWrite);
    expect(ownerIssues.find((i) => i.code === 'SEC-5')?.severity).toBe('warning');
    expect(ownerIssues.find((i) => i.code === 'SEC-6')?.severity).toBe('error');

    const ownerFileReadWrite = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/{fileName} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}`;
    const ownerFileIssues = lint(ownerFileReadWrite);
    expect(ownerFileIssues.some((i) => i.code === 'SEC-5')).toBe(false);
    expect(ownerFileIssues.find((i) => i.code === 'SEC-6')?.severity).toBe('error');

    const signedInAllPaths = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;
    const signedInIssues = lint(signedInAllPaths);
    expect(signedInIssues.find((i) => i.code === 'SEC-5')?.severity).toBe('error');
    expect(signedInIssues.find((i) => i.code === 'SEC-6')?.severity).toBe('error');

    const consoleTestMode = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.time < timestamp.date(2026, 12, 1);
    }
  }
}`;
    const testModeErrors = lint(consoleTestMode)
      .filter((i) => i.severity === 'error')
      .map((i) => i.code);
    expect(testModeErrors).toContain('SEC-3');
    expect(testModeErrors).toContain('SEC-5');
    expect(testModeErrors).toContain('SEC-6');

    const consoleLocked = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}`;
    expect(lint(consoleLocked).filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('wrong-arity helper call does not leak parameter name into enclosing path wildcard scope', () => {
    const wrongArity = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function check(userId) {
      return request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/{allPaths=**} {
      allow read: if check();
    }
  }
}`;
    const issues = lint(wrongArity);
    expect(issues.find((i) => i.code === 'SEC-5')?.severity).toBe('error');
  });
});
