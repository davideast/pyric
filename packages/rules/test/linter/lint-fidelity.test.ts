import { describe, expect, test } from 'bun:test';
import { firestoreRules, lint, storageRules, type RuleIssue } from '../../src/index.js';
import { UNRESOLVED_MODULES_LINT_MESSAGE } from '../../src/linter/compile-limit-warnings.js';
import { DEBUG_UNAVAILABLE_MESSAGE } from '../../src/linter/hallucinations.js';
import { lintFirestoreRules } from '../../src/linter/linter.js';
import { STDLIB_MODULES } from '../../src/stdlib-modules.js';

function firestoreWriteSource(condition: string, helperDecls = ''): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    ${helperDecls}
    match /items/{id} {
      allow create: if ${condition} && request.resource.data.ok == true;
    }
  }
}`;
}

function storageWriteSource(condition: string, helperDecls = ''): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if false; }
    ${helperDecls}
    match /items/{id} {
      allow create: if ${condition} && request.resource.size < 1024;
    }
  }
}`;
}

describe('SEC-3 semantic auth-requirement checks (#1349 FS2-LNT-1)', () => {
  const unauthenticatedShapes: ReadonlyArray<readonly [label: string, cond: string, helper?: string]> = [
    ['isSignedIn() == false', 'isSignedIn() == false', 'function isSignedIn() { return request.auth != null; }'],
    ['(request.auth == null) == true', '(request.auth == null) == true'],
    ['request.auth in [null]', 'request.auth in [null]'],
    ['request.auth == null || true', 'request.auth == null || true'],
    ['!isSignedIn()', '!isSignedIn()', 'function isSignedIn() { return request.auth != null; }'],
    ['request.auth != "abc" (null != string is true)', 'request.auth != "abc"'],
    ['!(request.auth.uid == "a" && resource.data.flag) (false absorption)', '!(request.auth.uid == "a" && resource.data.flag)'],
    ['parameterized helper negated', 'checkAuth(request.auth) == false', 'function checkAuth(a) { return a != null; }'],
    ['ternary scalar fallback on signed-out', '(request.auth == null ? "anon" : request.auth.uid) == "anon"'],
  ];

  for (const [label, cond, helper] of unauthenticatedShapes) {
    test(`Firestore flags SEC-3 when signed-out write can grant: ${label}`, () => {
      const issues = lint(firestoreWriteSource(cond, helper ?? ''));
      expect(issues.some((i) => i.code === 'SEC-3' && i.severity === 'error')).toBe(true);
    });

    test(`Storage flags SEC-3 when signed-out write can grant: ${label}`, () => {
      const issues = lint(storageWriteSource(cond, helper ?? ''));
      expect(issues.some((i) => i.code === 'SEC-3' && i.severity === 'error')).toBe(true);
    });
  }

  const authenticatedControls: ReadonlyArray<readonly [label: string, cond: string, helper?: string]> = [
    ['(request.auth != null) == true', '(request.auth != null) == true'],
    ['(request.auth == null) == false', '(request.auth == null) == false'],
    ['!(request.auth == null)', '!(request.auth == null)'],
    ['isSignedIn() == true', 'isSignedIn() == true', 'function isSignedIn() { return request.auth != null; }'],
    ['request.auth is map', 'request.auth is map'],
    ['request.auth in []', 'request.auth in []'],
    ['parameterized helper positive', 'checkAuth(request.auth)', 'function checkAuth(a) { return a != null; }'],
    ['let-bound request.auth.uid', 'validUid()', 'function validUid() { let u = request.auth.uid; return u == "u1"; }'],
    ['ternary null fallback guarded by != null', '(request.auth != null ? request.auth.uid : null) != null'],
    ['helper returning ternary null fallback', 'authUid() != null', 'function authUid() { return request.auth != null ? request.auth.uid : null; }'],
    ['error && bool compared against null', '(request.auth.uid == "a" && true) != null'],
  ];

  for (const [label, cond, helper] of authenticatedControls) {
    test(`does not false-positive SEC-3 on genuine auth guard: ${label}`, () => {
      const fsIssues = lint(firestoreWriteSource(cond, helper ?? ''));
      expect(fsIssues.some((i) => i.code === 'SEC-3')).toBe(false);

      const stIssues = lint(storageWriteSource(cond, helper ?? ''));
      expect(stIssues.some((i) => i.code === 'SEC-3')).toBe(false);
    });
  }

  test('all bundled stdlib module exports keep exact SEC-3 classification with zero regressions', () => {
    const bundledModules = STDLIB_MODULES.filter((m) => m.kind === 'user-module');
    const exportedCount = bundledModules.reduce((sum, m) => sum + m.entries.length, 0);
    expect(exportedCount).toBeGreaterThanOrEqual(58);

    const dummyArgFor = (paramDecl: string): string => {
      const colonIdx = paramDecl.indexOf(':');
      const pType = colonIdx >= 0 ? paramDecl.slice(colonIdx + 1).trim() : '';
      if (pType === 'path') return '/databases/(default)/documents/meta/doc1';
      if (pType.startsWith('list')) return "['a']";
      if (pType === 'map') return "{'a': 1}";
      if (pType === 'int' || pType === 'number' || pType === 'float') return '1';
      if (pType === 'bool') return 'true';
      if (pType === 'duration') return "duration.value(1, 's')";
      if (pType === 'timestamp') return 'request.time';
      return "'x'";
    };

    // Auth-checking stdlib exports must satisfy SEC-3 on their own without any outer `request.auth != null`.
    const authExports: ReadonlyArray<readonly [mod: string, fn: string, service: 'firestore' | 'storage']> = [
      ['auth', 'isAuthenticated', 'firestore'],
      ['auth', 'isOwner', 'firestore'],
      ['membership', 'hasClaim', 'firestore'],
      ['membership', 'hasClaimRole', 'firestore'],
      ['membership', 'isMemberOf', 'firestore'],
      ['membership', 'hasRole', 'firestore'],
      ['content', 'validAuthorCreate', 'firestore'],
      ['content', 'isAuthor', 'firestore'],
      ['spaces', 'isSpaceMember', 'firestore'],
      ['spaces', 'hasSpaceRole', 'firestore'],
      ['spaces', 'validMemberCreate', 'firestore'],
      ['storage/metadata', 'incomingMetadataOwner', 'storage'],
      ['storage/metadata', 'existingMetadataOwner', 'storage'],
      ['storage/objects', 'matchesDocument', 'storage'],
    ];

    for (const [modName, fnName, svc] of authExports) {
      const mod = bundledModules.find((m) => m.key === modName);
      const entry = mod?.entries.find((e) => e.signature.startsWith(`${fnName}(`));
      expect(entry).toBeDefined();
      if (!entry) continue;
      const openParen = entry.signature.indexOf('(');
      const closeParen = entry.signature.indexOf(')');
      const paramStr = entry.signature.slice(openParen + 1, closeParen).trim();
      let args = '';
      if (paramStr.length > 0) {
        args = paramStr
          .split(',')
          .map((p) => dummyArgFor(p.trim()))
          .join(', ');
      }
      const callExpr = `${fnName}(${args})`;
      let issues: RuleIssue[];
      if (svc === 'storage') {
        issues = storageRules(
          `rules_version = '2+modules';\nimport { ${fnName} } from '${modName}';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /items/{id} {\n      allow update: if ${callExpr} && request.resource.size < 1024;\n    }\n  }\n}`,
        ).lint();
      } else {
        issues = firestoreRules(
          `rules_version = '2+modules';\nimport { ${fnName} } from '${modName}';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /items/{id} {\n      allow update: if ${callExpr} && request.resource.data.ok == true;\n    }\n  }\n}`,
        ).lint();
      }
      const sec3 = issues.filter((i) => i.code === 'SEC-3');
      expect([`${modName}.${fnName}`, sec3]).toEqual([`${modName}.${fnName}`, []]);
    }

    // Also verify all 58 user-module exports lint without throwing or emitting UNRESOLVED_MODULES.
    for (const mod of bundledModules) {
      let svc: 'firestore' | 'storage' = 'firestore';
      if (mod.services.includes('storage') && !mod.services.includes('firestore')) {
        svc = 'storage';
      }
      for (const entry of mod.entries) {
        const openParen = entry.signature.indexOf('(');
        const closeParen = entry.signature.indexOf(')');
        const fnName = entry.signature.slice(0, openParen).trim();
        const paramStr = entry.signature.slice(openParen + 1, closeParen).trim();
        let args = '';
        if (paramStr.length > 0) {
          args = paramStr
            .split(',')
            .map((p) => dummyArgFor(p.trim()))
            .join(', ');
        }
        const callExpr = `${fnName}(${args})`;
        let issues: RuleIssue[];
        if (svc === 'storage') {
          issues = lint(
            `rules_version = '2+modules';\nimport { ${fnName} } from '${mod.key}';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /items/{id} {\n      allow read: if ${callExpr} == ${callExpr};\n    }\n  }\n}`,
          );
        } else {
          issues = lint(
            `rules_version = '2+modules';\nimport { ${fnName} } from '${mod.key}';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /items/{id} {\n      allow read: if ${callExpr} == ${callExpr};\n    }\n  }\n}`,
          );
        }
        const unresolved = issues.filter((i) => i.code === 'UNRESOLVED_MODULES');
        expect([`${mod.key}.${fnName}`, unresolved]).toEqual([`${mod.key}.${fnName}`, []]);
      }
    }
  });
});

describe('debug() runtime message, service declarations, unresolved 2+modules, and Storage wording (#1349)', () => {
  test('FS2-LNT-2: debug() lint finding states runtime Function not found and || true absorption', () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if debug(request.auth != null);
    }
  }
}`;
    const issue = lint(src).find((i) => i.code === 'HALLUCINATED_GLOBAL');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toBe(DEBUG_UNAVAILABLE_MESSAGE);
  });

  test('FS2-CON-9: service-targeted lint reports MISSING_FIRESTORE_SERVICE and MISSING_STORAGE_SERVICE', () => {
    const storageOnFirestore = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if request.auth != null;
    }
  }
}`;
    expect(firestoreRules(storageOnFirestore).lint()).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_FIRESTORE_SERVICE',
        severity: 'warning',
      }),
    );

    const firestoreOnStorage = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if request.auth != null;
    }
  }
}`;
    expect(storageRules(firestoreOnStorage, { bucket: 'demo.appspot.com' }).lint()).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_STORAGE_SERVICE',
        severity: 'warning',
      }),
    );
  });

  test('FS2-CON-11: unresolved 2+modules relative imports emit one warning and zero parse errors', () => {
    const unresolvedEntry = `rules_version = '2+modules';
import { customGate } from './custom-gate';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    match /items/{id} {
      allow get: if customGate();
    }
  }
}`;
    const rawLint = lintFirestoreRules(unresolvedEntry);
    expect(rawLint.parseError).toBeUndefined();
    const modWarnings = rawLint.warnings.filter((w) => w.rule === 'UNRESOLVED_MODULES');
    expect(modWarnings).toEqual([
      expect.objectContaining({
        rule: 'UNRESOLVED_MODULES',
        severity: 'warning',
        message: UNRESOLVED_MODULES_LINT_MESSAGE,
        location: { line: 2 },
      }),
    ]);

    const unified = lint(unresolvedEntry);
    expect(unified.filter((i) => i.origin === 'parse')).toEqual([]);
    expect(unified.filter((i) => i.code === 'UNRESOLVED_MODULES')).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_MODULES',
        severity: 'warning',
        origin: 'lint',
        line: 2,
        message: UNRESOLVED_MODULES_LINT_MESSAGE,
      }),
    ]);

    // Service-mismatched 2+modules rulesets (0 matching services for targetService) still warn on relative imports.
    const storageModularEntry = `rules_version = '2+modules';
import { helperFn } from './shared';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if helperFn();
    }
  }
}`;
    const mismatched = lintFirestoreRules(storageModularEntry, { targetService: 'cloud.firestore' });
    expect(mismatched.warnings.filter((w) => w.rule === 'UNRESOLVED_MODULES')).toEqual([
      expect.objectContaining({
        rule: 'UNRESOLVED_MODULES',
        severity: 'warning',
        message: UNRESOLVED_MODULES_LINT_MESSAGE,
        location: { line: 2 },
      }),
    ]);

    // Bundled stdlib imports resolve in memory, so they emit no UNRESOLVED_MODULES warning.
    const bundledOnly = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    match /items/{id} {
      allow get: if isAuthenticated();
    }
  }
}`;
    expect(lint(bundledOnly).some((i) => i.code === 'UNRESOLVED_MODULES')).toBe(false);
  });

  test('ST-H3-9: Storage lint findings use object/bucket and request.resource wording without document/database leaks', () => {
    const storageRuleset = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /singleton {
      allow get: if request.resource.size > 0 && request.auth.uid.toLowerCase() == 'a';
    }
    match /folder/{id} {
      match /nested/{fileId} {
        allow get: if request.auth != null;
      }
    }
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;
    const issues = lint(storageRuleset);
    const byCode = (code: string) => issues.find((i) => i.code === code);

    expect(byCode('SEC-2')?.message).toBe(
      'Public read at /{allPaths=**}: every object in the bucket is readable',
    );
    expect(byCode('SEC-4')?.message).toBe(
      'No default deny rule (match /{allPaths=**} { allow read, write: if false; })',
    );
    expect(byCode('SEC-5')?.message).toContain('grants read, write on every object in the bucket');
    expect(byCode('SEC-6')?.message).toContain('request.resource (size, contentType, or metadata)');
    expect(byCode('SEM-1')?.message).toBe(
      'Read rule at /singleton references request.resource which is not available on reads',
    );
    expect(byCode('STR-1')?.message).toBe(
      'Match at /singleton has no wildcard -- matches exactly one object',
    );
    expect(byCode('STR-2')?.message).toBe(
      'Match at /folder/{id} has nested children but no allows -- parent path is locked',
    );
    expect(byCode('PERMISSIVE_RULE')?.message).toContain('every object in the bucket');
    expect(byCode('PERMISSIVE_RULE')?.message).not.toContain('diff');
    expect(byCode('RECURSIVE_WILDCARD_OPEN')?.message).toBe(
      'match /{allPaths=**} allows read, write on every object in the bucket with an always-true condition.',
    );
    expect(byCode('HALLUCINATED_METHOD')?.message).toContain('Storage rules');

    for (const issue of issues) {
      expect(issue.message).not.toContain('request.resource.data');
      expect(issue.message).not.toContain('every document');
    }

    // Also verify storage/objects stdlib `nameSegment` in `allow get` does NOT false-positive SEM-1.
    const storageObjectsGet = `rules_version = '2+modules';
import { nameSegment } from 'storage/objects';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if false; }
    match /scores/{userId}/{file} {
      allow get: if request.auth != null && nameSegment(1) == request.auth.uid;
    }
  }
}`;
    expect(lint(storageObjectsGet).filter((i) => i.severity === 'error')).toEqual([]);
  });
});
