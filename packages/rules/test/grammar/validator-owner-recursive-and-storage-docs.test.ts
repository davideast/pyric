import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../src/grammar/FirestoreParser.js';
import { validateFirestoreRules } from '../../src/grammar/FirestoreValidator.js';
import { lint } from '../../src/index.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

function validateSource(source: string) {
  const ast = parseToAST(source);
  if (!ast) throw new Error('expected valid AST');
  return validateFirestoreRules(ast, { rawSource: source });
}

describe('SEC-5 auth-guarded recursive wildcards, SEC-6 Storage payload fields, and Firebase Storage doc fixtures (#1518)', () => {
  test('downgrades SEC-5 to medium (warning) for signed-in and owner-scoped recursive wildcards in both Firestore and Storage', () => {
    const firestoreSignedIn = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;
    const fsSignedInFindings = validateSource(firestoreSignedIn);
    expect(fsSignedInFindings.filter((f) => f.code === 'SEC-5').map((f) => f.severity)).toEqual(['medium']);
    expect(fsSignedInFindings.filter((f) => f.code === 'SEC-6').map((f) => f.severity)).toEqual(['medium']);
    const fsSignedInIssues = lint(firestoreSignedIn);
    expect(fsSignedInIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(fsSignedInIssues.find((i) => i.code === 'SEC-5')?.severity).toBe('warning');
    expect(fsSignedInIssues.find((i) => i.code === 'SEC-6')?.severity).toBe('warning');

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
    const stFindings = validateSource(storageOwnerValidated);
    expect(stFindings.filter((f) => f.code === 'SEC-5').map((f) => f.severity)).toEqual([
      'medium',
      'medium',
    ]);
    expect(stFindings.filter((f) => f.code === 'SEC-6')).toEqual([]);
    const stIssues = lint(storageOwnerValidated);
    expect(stIssues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('keeps SEC-5 and SEC-6 high (error) when recursive wildcards or unvalidated writes are open or bypass auth', () => {
    const cases: ReadonlyArray<readonly [label: string, source: string, expectedHighCodes: readonly string[]]> = [
      [
        'Firestore open recursive read and write',
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`,
        ['SEC-5', 'SEC-6'],
      ],
      [
        'Storage open recursive read and write',
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`,
        ['SEC-5', 'SEC-6'],
      ],
      [
        'Firestore auth disjunction bypass',
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null || resource.data.public == true;
    }
  }
}`,
        ['SEC-3', 'SEC-5', 'SEC-6'],
      ],
      [
        'Storage null auth check',
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth == null;
    }
  }
}`,
        ['SEC-3', 'SEC-5', 'SEC-6'],
      ],
      [
        'wrong-arity helper call does not satisfy auth guard',
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function check(userId) {
      return request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/{allPaths=**} {
      allow read, write: if check();
    }
  }
}`,
        ['SEC-3', 'SEC-5', 'SEC-6'],
      ],
    ];

    for (const [label, source, expectedHighCodes] of cases) {
      const highCodes = validateSource(source)
        .filter((f) => f.severity === 'high')
        .map((f) => f.code);
      for (const expected of expectedHighCodes) {
        expect([label, highCodes.includes(expected)]).toEqual([label, true]);
      }
      const errorCodes = lint(source)
        .filter((i) => i.severity === 'error')
        .map((i) => i.code);
      for (const expected of expectedHighCodes) {
        expect([label, errorCodes.includes(expected)]).toEqual([label, true]);
      }
    }
  });

  test('Storage SEC-6 accepts size, contentType, and metadata while rejecting bare request.resource, and Firestore keeps requiring request.resource.data', () => {
    const satisfiedStorageCases: ReadonlyArray<readonly [label: string, expr: string]> = [
      ['size dot access', 'request.resource.size < 5242880'],
      ['contentType dot access', "request.resource.contentType.matches('image/.*')"],
      ['metadata nested access', 'request.resource.metadata.owner == request.auth.uid'],
      ['bracket access on payload fields', "request.resource['size'] < 1024 && request.resource['contentType'] == 'text/plain'"],
    ];

    for (const [label, expr] of satisfiedStorageCases) {
      const source = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} {
      allow write: if request.auth != null && (${expr});
    }
  }
}`;
      const sec6 = validateSource(source).filter((f) => f.code === 'SEC-6');
      expect([label, sec6]).toEqual([label, []]);
    }

    const storageHelper = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function validUpload(res) {
      let meta = res['metadata'];
      return meta != null;
    }
    match /uploads/{fileName} {
      allow write: if request.auth != null && validUpload(request.resource);
    }
  }
}`;
    expect(validateSource(storageHelper).filter((f) => f.code === 'SEC-6')).toEqual([]);

    const unsatisfiedStorageCases: ReadonlyArray<readonly [label: string, expr: string]> = [
      ['bare request.resource != null', 'request.resource != null'],
      ['non-Storage request.resource.data field', 'request.resource.data.title is string'],
      ['disjunction bypass on payload check', 'request.auth != null || request.resource.size < 1024'],
    ];

    for (const [label, expr] of unsatisfiedStorageCases) {
      const source = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} {
      allow write: if request.auth != null && (${expr});
    }
  }
}`;
      const sec6 = validateSource(source).filter((f) => f.code === 'SEC-6');
      expect([label, sec6.map((f) => f.severity)]).toEqual([label, ['medium']]);
      expect(sec6[0]?.message).toContain('(size, contentType, or metadata)');
    }

    const firestoreWithStorageFields = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow create: if request.auth != null
        && request.resource.size < 1024
        && request.resource.contentType == 'application/json'
        && request.resource.metadata != null;
    }
  }
}`;
    const fsSec6 = validateSource(firestoreWithStorageFields).filter((f) => f.code === 'SEC-6');
    expect(fsSec6.map((f) => f.severity)).toEqual(['medium']);
    expect(fsSec6[0]?.message).toContain('request.resource.data');
  });

  test('pins all Firebase documented Storage rules samples and repo Storage rules with zero lint errors (#1518)', () => {
    // 1. Firebase docs: signed-in only {allPaths=**}
    const signedInAllPaths = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;
    const signedInIssues = lint(signedInAllPaths);
    expect(signedInIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(signedInIssues.find((i) => i.code === 'SEC-5')?.severity).toBe('warning');
    expect(signedInIssues.find((i) => i.code === 'SEC-6')?.severity).toBe('warning');

    // 2. Firebase docs: owner-only {fileName}
    const ownerFileReadWrite = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /user/{userId}/{fileName} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}`;
    const ownerFileIssues = lint(ownerFileReadWrite);
    expect(ownerFileIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(ownerFileIssues.some((i) => i.code === 'SEC-5')).toBe(false);
    expect(ownerFileIssues.find((i) => i.code === 'SEC-6')?.severity).toBe('warning');

    // 3. Firebase docs: owner-only {allPaths=**}
    const ownerRecursiveReadWrite = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /user/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}`;
    const ownerRecursiveIssues = lint(ownerRecursiveReadWrite);
    expect(ownerRecursiveIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(ownerRecursiveIssues.find((i) => i.code === 'SEC-5')?.severity).toBe('warning');
    expect(ownerRecursiveIssues.find((i) => i.code === 'SEC-6')?.severity).toBe('warning');

    // 4. Firebase Console test mode (unauthenticated time gate): must still fail with errors
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

    // 5. examples/teams-workspace/storage.rules on disk
    const teamsStorageRules = readFileSync(
      resolve(REPO_ROOT, 'examples/teams-workspace/storage.rules'),
      'utf8',
    );
    const teamsIssues = lint(teamsStorageRules);
    expect(teamsIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(teamsIssues.filter((i) => i.code === 'SEC-5').map((i) => i.severity)).toEqual([
      'warning',
      'warning',
    ]);
    expect(teamsIssues.some((i) => i.code === 'SEC-6')).toBe(false);

    // 6. Console locked and packages/create-pyric/templates/chat/storage.rules on disk
    const consoleLocked = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}`;
    expect(lint(consoleLocked).filter((i) => i.severity === 'error')).toEqual([]);

    const chatTemplateStorageRules = readFileSync(
      resolve(REPO_ROOT, 'packages/create-pyric/templates/chat/storage.rules'),
      'utf8',
    );
    const chatIssues = lint(chatTemplateStorageRules);
    expect(chatIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(chatIssues.some((i) => i.code === 'SEC-5')).toBe(false);
    expect(chatIssues.some((i) => i.code === 'SEC-6')).toBe(false);
  });
});
