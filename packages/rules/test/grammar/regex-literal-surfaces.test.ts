import { describe, expect, test } from 'bun:test';
import { firestoreRules, lint, storageRules } from '../../src/index.js';
import { compileStorageRules } from '../../src/storage/rules-resolution.js';
import { parseStorageRules } from '../../src/storage/rules.js';

describe('#1334 regex literal compile checks across split(), matches(), replace(), and parseStorageRules', () => {
  const invalidLiteralPatterns: readonly string[] = [
    '[',
    '(',
    '(?=a)a',
    '(a)\\1',
    'a{1001}',
    '\\Z',
  ];

  test.each(invalidLiteralPatterns)(
    'refuses invalid split(%j) literal across firestoreRules, lint, compileStorageRules, parseStorageRules, and storageRules',
    (pattern) => {
      const fsSource = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        `      allow get: if 'a'.split(${JSON.stringify(pattern)}).size() > 0 || true;`,
        '    }',
        '  }',
        '}',
      ].join('\n');

      expect(() => firestoreRules(fsSource)).toThrow(
        `Invalid regular expression pattern. Pattern: ${pattern}.`,
      );
      const lintIssues = lint(fsSource);
      const regexIssue = lintIssues.find((i) => i.code === 'INVALID_REGEX_PATTERN');
      expect(regexIssue).toBeDefined();
      expect(regexIssue?.origin).toBe('parse');
      expect(regexIssue?.message).toBe(`Invalid regular expression pattern. Pattern: ${pattern}.`);

      const stSource = [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /items/{id} {',
        `      allow read: if 'a'.split(${JSON.stringify(pattern)}).size() > 0 || true;`,
        '    }',
        '  }',
        '}',
      ].join('\n');

      expect(() => compileStorageRules(stSource)).toThrow(
        `Storage rules do not compile: Invalid regular expression pattern. Pattern: ${pattern}.`,
      );
      expect(() => parseStorageRules(stSource)).toThrow(
        `Storage rules do not compile: Invalid regular expression pattern. Pattern: ${pattern}.`,
      );
      expect(() => storageRules(stSource)).toThrow(
        `Invalid regular expression pattern. Pattern: ${pattern}.`,
      );
    },
  );

  test('parseStorageRules refuses invalid matches() literals by default and honors allowInvalidRegex option', () => {
    const brokenMatches = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      "      allow read: if 'a'.matches('(') || true;",
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(() => parseStorageRules(brokenMatches)).toThrow(
      'Storage rules do not compile: Invalid regular expression pattern. Pattern: (.',
    );
    expect(() => parseStorageRules(brokenMatches, { allowInvalidRegex: true })).not.toThrow();
  });

  test('keeps invalid literal patterns in replace() compiling on both Firestore and Storage (absorbable at runtime)', () => {
    const fsSource = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      "      allow get: if 'a'.replace('[', 'b') == 'a';",
      "      allow list: if 'a'.replace('[', 'b') == 'a' || true;",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const fsCompiled = firestoreRules(fsSource);
    const fsSim = fsCompiled.simulate([
      { description: 'unabsorbed invalid replace', expectation: 'DENY', method: 'get', path: 'items/1' },
      { description: 'absorbed invalid replace', expectation: 'ALLOW', method: 'list', path: 'items/1' },
    ]);
    expect(fsSim.cases.map((c) => c.decision)).toEqual(['DENY', 'ALLOW']);

    const fsLint = lint(fsSource);
    expect(fsLint.some((i) => i.code === 'INVALID_REGEX_PATTERN')).toBe(false);

    const stSource = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      "      allow get: if 'a'.replace('[', 'b') == 'a';",
      "      allow list: if 'a'.replace('[', 'b') == 'a' || true;",
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(() => compileStorageRules(stSource)).not.toThrow();
    expect(() => parseStorageRules(stSource)).not.toThrow();
    const stSim = storageRules(stSource, { bucket: 'b1' }).simulate([
      { description: 'st unabsorbed replace', expectation: 'DENY', method: 'get', path: '/items/1', resource: { size: 1 } },
      { description: 'st absorbed replace', expectation: 'ALLOW', method: 'list', path: '/items/1' },
    ]);
    expect(stSim.cases.map((c) => c.decision)).toEqual(['DENY', 'ALLOW']);
  });
});
