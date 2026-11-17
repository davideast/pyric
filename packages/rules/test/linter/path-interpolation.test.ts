import { describe, expect, test } from 'bun:test';
import { firestoreRules, lint } from '../../src/index.js';
import { lintFirestoreRules } from '../../src/linter/linter.js';

describe('INVALID_PATH_INTERPOLATION path-literal template vs lookup rules', () => {
  test('accepts {x} placeholders on direct (/a/{x}).bind(...) receivers with zero findings', () => {
    const directBind = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if request.auth != null && (/a/{x}).bind({'x': '1'}) == path('/a/1');
    }
  }
}`;
    expect(lint(directBind).filter((i) => i.code === 'INVALID_PATH_INTERPOLATION')).toEqual([]);
    expect(firestoreRules(directBind).lint().filter((i) => i.code === 'INVALID_PATH_INTERPOLATION')).toEqual([]);
  });

  test('accepts {x} placeholders bound indirectly through a let variable without error findings', () => {
    const indirectLetBind = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function matchesBound() {
      let t = /a/{x};
      return t.bind({'x': '1'}) == path('/a/1');
    }
    match /items/{id} {
      allow get: if request.auth != null && matchesBound();
    }
  }
}`;
    const raw = lintFirestoreRules(indirectLetBind, { targetService: 'cloud.firestore' });
    expect(raw.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(raw.warnings.filter((w) => w.rule === 'INVALID_PATH_INTERPOLATION')).toEqual([]);
    expect(firestoreRules(indirectLetBind).lint().filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('keeps severity error on unbound {var} segments inside get/exists/getAfter/existsAfter and Storage firestore.get/exists', () => {
    const fsLookup = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if request.auth != null && exists(/databases/{database}/documents/items/{id});
    }
  }
}`;
    const fsFindings = lint(fsLookup).filter((i) => i.code === 'INVALID_PATH_INTERPOLATION');
    expect(fsFindings).toHaveLength(2);
    expect(fsFindings.every((f) => f.severity === 'error')).toBe(true);

    const storageLookup = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if request.auth != null && firestore.exists(/databases/(default)/documents/items/{id});
    }
  }
}`;
    const storageFindings = lint(storageLookup).filter((i) => i.code === 'INVALID_PATH_INTERPOLATION');
    expect(storageFindings).toHaveLength(1);
    expect(storageFindings[0]?.severity).toBe('error');
  });

  test('downgrades unbound non-lookup path literals with {var} to warning so compile/prepare paths do not fail', () => {
    const nonLookupComparison = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if request.auth != null && request.path == /databases/{database}/documents/items/{id};
    }
  }
}`;
    const findings = lintFirestoreRules(nonLookupComparison, { targetService: 'cloud.firestore' }).warnings
      .filter((w) => w.rule === 'INVALID_PATH_INTERPOLATION');
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === 'warning')).toBe(true);
  });
});
