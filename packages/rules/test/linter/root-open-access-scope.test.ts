import { describe, expect, test } from 'bun:test';
import { lint } from '../../src/index.js';
import { lintFirestoreRules } from '../../src/linter/linter.js';

describe('Root-aware open-access lint scoping (#1396)', () => {
  test('a root naming another database does not trigger RECURSIVE_WILDCARD_OPEN, PERMISSIVE_RULE, SEC-1, SEC-2, or SEC-5', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/other/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;
    const linted = lintFirestoreRules(source);
    expect(linted.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(linted.warnings.some((w) => w.rule === 'RECURSIVE_WILDCARD_OPEN')).toBe(false);
    expect(linted.warnings.some((w) => w.rule === 'PERMISSIVE_RULE')).toBe(false);

    const unmatched = linted.warnings.find((w) => w.rule === 'UNMATCHED_ROOT_PATH');
    expect(unmatched?.severity).toBe('warning');
    expect(unmatched?.message).toContain("Root match '/databases/other/documents'");
    expect(unmatched?.message).toContain('production grants nothing under it');

    const unified = lint(source);
    expect(unified.filter((i) => i.severity === 'error')).toEqual([]);
    expect(unified.some((i) => i.code === 'SEC-1')).toBe(false);
    expect(unified.some((i) => i.code === 'SEC-2')).toBe(false);
    expect(unified.some((i) => i.code === 'SEC-5')).toBe(false);
    expect(unified.some((i) => i.code === 'UNMATCHED_ROOT_PATH' && i.severity === 'warning')).toBe(true);
  });

  test('a root naming another database with a trailing recursive wildcard still matches nothing in (default)', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/other/{rest=**} {
    allow read, write: if true;
  }
}`;
    const linted = lintFirestoreRules(source);
    expect(linted.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(linted.warnings.some((w) => w.rule === 'UNMATCHED_ROOT_PATH')).toBe(true);
  });

  test('a root with extra literals (/databases/{db}/documents/z) scopes open-access messages to /z', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents/z {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;
    const linted = lintFirestoreRules(source);
    expect(linted.warnings.some((w) => w.rule === 'UNMATCHED_ROOT_PATH')).toBe(false);

    const recursiveOpen = linted.warnings.find((w) => w.rule === 'RECURSIVE_WILDCARD_OPEN');
    expect(recursiveOpen?.severity).toBe('error');
    expect(recursiveOpen?.location?.matchPath).toBe('/z/{document=**}');
    expect(recursiveOpen?.message).toBe(
      'match /z/{document=**} allows read, write on every document under /z with an always-true condition.',
    );

    const permissive = linted.warnings.find((w) => w.rule === 'PERMISSIVE_RULE');
    expect(permissive?.severity).toBe('warning');
    expect(permissive?.location?.matchPath).toBe('/z/{document=**}');
    expect(permissive?.message).toContain('every document under /z');

    const unified = lint(source);
    const sec2 = unified.find((i) => i.code === 'SEC-2');
    expect(sec2?.message).toBe('Public read at /z/{document=**}: every document under /z is readable');
    const sec5 = unified.find((i) => i.code === 'SEC-5');
    expect(sec5?.message).toContain('grants read, write on every document under /z');
  });

  test('a root match /{path=**} with own allow read, write: if true still flags the whole database', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /{path=**} {
    allow read, write: if true;
  }
}`;
    const linted = lintFirestoreRules(source);
    const recursiveOpen = linted.warnings.find((w) => w.rule === 'RECURSIVE_WILDCARD_OPEN');
    expect(recursiveOpen?.severity).toBe('error');
    expect(recursiveOpen?.message).toBe(
      'match /{path=**} allows read, write on every document in the database with an always-true condition.',
    );

    const unified = lint(source);
    expect(unified.some((i) => i.code === 'SEC-1' && i.severity === 'error')).toBe(true);
    expect(unified.some((i) => i.code === 'SEC-2' && i.severity === 'error')).toBe(true);
  });

  test('Storage rules under /b/{bucket}/o/public scope recursive open-access messages to /public', () => {
    const source = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o/public {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;
    const linted = lintFirestoreRules(source, { targetService: 'firebase.storage' });
    const recursiveOpen = linted.warnings.find((w) => w.rule === 'RECURSIVE_WILDCARD_OPEN');
    expect(recursiveOpen?.severity).toBe('error');
    expect(recursiveOpen?.message).toBe(
      'match /public/{allPaths=**} allows read, write on every document under /public with an always-true condition.',
    );
  });
});
