import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../src/grammar/FirestoreParser.js';
import {
  firestoreServiceBlock,
  isFirestoreServiceName,
  selectServicesToAnalyze,
  storageServiceBlock,
} from '../../src/grammar/service-blocks.js';
import { firestoreRules, lint, storageRules } from '../../src/index.js';
import { checkServiceDeclarations } from '../../src/linter/service-declarations.js';

const STORAGE_ALLOW_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const UNKNOWN_FOO_BAR = `rules_version = '2';
service foo.bar {
  match /items/{id} {
    allow read, write: if true;
  }
}`;

const HALLUCINATED_FIREBASE_FIRESTORE = `rules_version = '2';
service firebase.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const MULTI_SERVICE_WITH_HALLUCINATED = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if false;
    }
  }
}
service firebase.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

describe('service-blocks and service-declarations linter', () => {
  test('isFirestoreServiceName matches only exact cloud.firestore', () => {
    expect(isFirestoreServiceName('cloud.firestore')).toBe(true);
    expect(isFirestoreServiceName('firebase.firestore')).toBe(false);
    expect(isFirestoreServiceName('foo.firestore')).toBe(false);
    expect(isFirestoreServiceName('firebase.storage')).toBe(false);
    expect(isFirestoreServiceName(undefined)).toBe(false);
  });

  test('firestoreServiceBlock returns the cloud.firestore block or undefined', () => {
    const storageAst = parseToAST(STORAGE_ALLOW_ALL);
    expect(storageAst).not.toBeNull();
    if (storageAst) expect(firestoreServiceBlock(storageAst)).toBeUndefined();

    const hallucinatedAst = parseToAST(HALLUCINATED_FIREBASE_FIRESTORE);
    expect(hallucinatedAst).not.toBeNull();
    if (hallucinatedAst) expect(firestoreServiceBlock(hallucinatedAst)).toBeUndefined();

    const multiAst = parseToAST(MULTI_SERVICE_WITH_HALLUCINATED);
    expect(multiAst).not.toBeNull();
    if (multiAst) {
      expect(firestoreServiceBlock(multiAst)?.name).toBe('cloud.firestore');
      const projected = { ...multiAst.service, functions: [] };
      expect(firestoreServiceBlock({ ...multiAst, service: projected })).toBe(projected);
      expect(selectServicesToAnalyze(multiAst, 'all').map((s) => s.name)).toEqual([
        'cloud.firestore',
      ]);
    }
  });

  test('checkServiceDeclarations warns on unknown services and missing Firestore service without blocking', () => {
    const fooAst = parseToAST(UNKNOWN_FOO_BAR);
    expect(fooAst).not.toBeNull();
    if (fooAst) {
      expect(checkServiceDeclarations(fooAst, 'all')).toEqual([
        expect.objectContaining({
          rule: 'INVALID_SERVICE_NAME',
          severity: 'warning',
          message: 'Invalid service name: foo.bar.',
          location: { line: 2 },
        }),
      ]);
      expect(checkServiceDeclarations(fooAst, 'cloud.firestore').map((w) => w.rule)).toEqual([
        'INVALID_SERVICE_NAME',
        'MISSING_FIRESTORE_SERVICE',
      ]);
      expect(checkServiceDeclarations(fooAst, 'firebase.storage').map((w) => w.rule)).toEqual([
        'INVALID_SERVICE_NAME',
        'MISSING_STORAGE_SERVICE',
      ]);
      expect(storageServiceBlock(fooAst)).toBeUndefined();
    }
    const storageAst = parseToAST(STORAGE_ALLOW_ALL);
    expect(storageAst).not.toBeNull();
    if (storageAst) {
      expect(storageServiceBlock(storageAst)?.name).toBe('firebase.storage');
    }
    const unknownStorageHandle = storageRules(UNKNOWN_FOO_BAR, { bucket: 'demo-app.appspot.com' });
    expect(
      unknownStorageHandle.simulate([
        { description: 'get d1', expectation: 'DENY', method: 'get', path: 'items/d1' },
      ]).passed,
    ).toBe(1);
    expect(unknownStorageHandle.lint().map((i) => i.code)).toEqual([
      'INVALID_SERVICE_NAME',
      'MISSING_STORAGE_SERVICE',
    ]);
  });

  test('public lint() reports INVALID_SERVICE_NAME warning and zero false SEC/QUA errors on unknown services', () => {
    for (const [source, svcName] of [
      [UNKNOWN_FOO_BAR, 'foo.bar'],
      [HALLUCINATED_FIREBASE_FIRESTORE, 'firebase.firestore'],
    ] as const) {
      const issues = lint(source);
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(issues.some((i) => i.code.startsWith('SEC-') || i.code.startsWith('QUA-'))).toBe(false);
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_SERVICE_NAME',
          severity: 'warning',
          line: 2,
          message: `Invalid service name: ${svcName}.`,
        }),
      );
    }
  });

  test('multi-service lint() warns on dead firebase.firestore block without reporting its rules as public Firestore access', () => {
    const issues = lint(MULTI_SERVICE_WITH_HALLUCINATED);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.some((i) => i.code === 'SEC-1' || i.code === 'SEC-2')).toBe(false);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_SERVICE_NAME',
        severity: 'warning',
        message: 'Invalid service name: firebase.firestore.',
      }),
    );
  });

  test('firestoreRules().lint() emits MISSING_FIRESTORE_SERVICE warning on Storage rules and standalone lint() does not', () => {
    const fsLint = firestoreRules(STORAGE_ALLOW_ALL).lint();
    expect(fsLint.filter((i) => i.severity === 'error')).toEqual([]);
    expect(fsLint).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_FIRESTORE_SERVICE',
        severity: 'warning',
        line: 2,
      }),
    );
    expect(lint(STORAGE_ALLOW_ALL).some((i) => i.code === 'MISSING_FIRESTORE_SERVICE')).toBe(false);
  });
});
