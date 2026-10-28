import { describe, expect, it } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// Under `rules_version = '1'`, the default when the source declares none, a
// recursive wildcard matches one or more segments. Under version 2 it matches
// zero or more. Capture `rules-storage-h1-v1-recursive-wildcard` (row
// storage-rules#206) and the Storage docs: "In version 1, recursive wildcards
// match one or more filename elements, not zero or more elements."

function reads(source: string, objectPath: string): boolean {
  return evaluateStorageRules(parseStorageRules(source), {
    request: { auth: null, method: 'get', path: `b/pyric-default/o/${objectPath}` },
    resource: { size: 1 },
  }).allowed;
}

const body = `service firebase.storage {
  match /b/{bucket}/o {
    match /images/{prefix}/{file=**} {
      allow read: if true;
    }
    match /uploads/{rest=**} {
      allow read: if true;
    }
  }
}`;
const nested = `service firebase.storage {
  match /b/{bucket}/o {
    match /tree/{rest=**} {
      match /leaf.txt {
        allow read: if true;
      }
    }
  }
}`;

describe('Storage rules version 1 recursive wildcard', () => {
  const v1 = body;
  const v1Explicit = `rules_version = '1';\n${body}`;

  it('denies the zero-segment path when no version is declared', () => {
    expect(reads(v1, 'images/badge.png')).toBe(false);
    expect(reads(v1, 'uploads')).toBe(false);
  });

  it('denies the zero-segment path under an explicit version 1', () => {
    expect(reads(v1Explicit, 'images/badge.png')).toBe(false);
  });

  it('allows a one-segment path', () => {
    expect(reads(v1, 'images/profilePics/profile.png')).toBe(true);
    expect(reads(v1, 'uploads/a.png')).toBe(true);
  });

  it('allows a deeper path', () => {
    expect(reads(v1, 'uploads/a/b/c.png')).toBe(true);
  });

  it('a nested match under a version 1 glob needs one segment in the glob', () => {
    expect(reads(nested, 'tree/leaf.txt')).toBe(false);
    expect(reads(nested, 'tree/a/leaf.txt')).toBe(true);
  });
});

describe('Storage rules version 2 recursive wildcard is unchanged', () => {
  const v2 = `rules_version = '2';\n${body}`;
  const v2Nested = `rules_version = '2';\n${nested}`;

  it('allows the zero-segment path', () => {
    expect(reads(v2, 'images/badge.png')).toBe(true);
    expect(reads(v2, 'uploads')).toBe(true);
  });

  it('allows one or more segments', () => {
    expect(reads(v2, 'uploads/a.png')).toBe(true);
    expect(reads(v2, 'uploads/a/b/c.png')).toBe(true);
  });

  it('a nested match under a version 2 glob may take zero segments in the glob', () => {
    expect(reads(v2Nested, 'tree/leaf.txt')).toBe(true);
    expect(reads(v2Nested, 'tree/a/leaf.txt')).toBe(true);
  });
});
