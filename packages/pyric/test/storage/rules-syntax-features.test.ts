/**
 * Storage rules syntax acceptance corpus.
 *
 * Firebase Security Rules is one language across Firestore and Storage.
 * Each case here is a syntactically valid ruleset production Firebase
 * accepts; `parseStorageRules` must accept every one. The corpus pins
 * the syntax features that historically parsed for Firestore but not
 * for Storage while the two services used independent parsers.
 *
 * Acceptance only: cases assert the source parses, not how it evaluates.
 * Evaluation semantics live in rules.test.ts and the oracle conformance
 * suites.
 */
import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../src/storage/rules.js';

function ruleset(condition: string, extra = ''): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    ${extra}
    match /files/{fileId} {
      allow read: if ${condition};
    }
  }
}`;
}

const CASES: Array<{ name: string; source: string }> = [
  {
    name: 'rules_version declaration',
    source: ruleset('true'),
  },
  {
    name: 'ternary conditional ?:',
    source: ruleset("request.auth != null ? request.auth.uid == fileId : false"),
  },
  {
    name: 'in operator',
    source: ruleset("fileId in ['a.txt', 'b.txt']"),
  },
  {
    name: 'is type-check operator',
    source: ruleset('resource.size is int'),
  },
  {
    name: 'list literal',
    source: ruleset("['image/png', 'image/jpeg'].size() > 0"),
  },
  {
    name: 'map literal',
    source: ruleset("{'owner': request.auth.uid}.size() == 1"),
  },
  {
    name: 'slice access a[x:y]',
    source: ruleset("fileId.split('-')[0:2].size() == 2"),
  },
  {
    name: 'string escape sequences',
    source: ruleset("fileId != 'a\\'b\\\\c\\n'"),
  },
  {
    name: 'float literals',
    source: ruleset('resource.size * 0.5 < 1048576.0'),
  },
  {
    name: 'export function inside a match body',
    source: ruleset('isOwner(fileId)', 'export function isOwner(uid) { return request.auth.uid == uid; }'),
  },
  {
    name: 'function at service scope',
    source: `rules_version = '2';
service firebase.storage {
  function signedIn() { return request.auth != null; }
  match /b/{bucket}/o {
    match /files/{fileId} {
      allow read: if signedIn();
    }
  }
}`,
  },
  {
    name: 'function at global scope',
    source: `rules_version = '2';
function signedIn() { return request.auth != null; }
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{fileId} {
      allow read: if signedIn();
    }
  }
}`,
  },
  {
    name: 'import declaration',
    source: `rules_version = '2';
import { isOwner } from 'shared';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{fileId} {
      allow read: if isOwner(fileId);
    }
  }
}`,
  },
  {
    name: 'multi-line /* */ comment',
    source: `rules_version = '2';
/* shared
   header comment */
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{fileId} {
      allow read: if /* inline */ true;
    }
  }
}`,
  },
  {
    name: 'unary minus on numeric literal',
    source: ruleset('resource.size > -1'),
  },
  {
    name: 'modulo operator',
    source: ruleset('resource.size % 2 == 0'),
  },
];

describe('storage rules syntax acceptance', () => {
  for (const c of CASES) {
    it(`parses ${c.name}`, () => {
      expect(() => parseStorageRules(c.source)).not.toThrow();
    });
  }
});

describe('storage rules syntax rejection (production-pinned orderings, #347 probe)', () => {
  /** Production rejects these orderings at parse ("Unexpected 'import'" /
   *  "Unexpected 'rules_version'"), so the mirror must too — an accepting
   *  local parser would pass rules that fail on deploy. */
  it("rejects an import declaration after a global function", () => {
    expect(() =>
      parseStorageRules(`rules_version = '2';
function f() { return true; }
import { helper } from 'shared/helpers';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{id} { allow read: if f(); }
  }
}`),
    ).toThrow(SyntaxError);
  });

  it('rejects a function declaration before rules_version', () => {
    expect(() =>
      parseStorageRules(`function f() { return true; }
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{id} { allow read: if f(); }
  }
}`),
    ).toThrow(SyntaxError);
  });
});
