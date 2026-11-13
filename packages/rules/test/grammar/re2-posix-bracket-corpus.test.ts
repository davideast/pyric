import { describe, expect, test } from 'bun:test';
import { firestoreRules, storageRules } from '../../src/index.js';
import { evaluateStorageRules } from '../../src/storage/rules-evaluator.js';
import { parseStorageRules } from '../../src/storage/rules.js';
import {
  normalizeRe2ForJsRegExp,
  scanRe2Pattern,
  spellRe2SpaceClasses,
} from '../../src/grammar/re2-pattern.js';

function evalBothMatches(
  patternLiteral: string,
  subject: string,
): { firestore: boolean; storage: boolean } {
  const fsSummary = firestoreRules(
    [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      `      allow get: if resource.data.val.matches(${JSON.stringify(patternLiteral)});`,
      '    }',
      '  }',
      '}',
    ].join('\n'),
  ).simulate([
    {
      description: `matches(${patternLiteral}) on ${JSON.stringify(subject)}`,
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/i1',
      auth: null,
      resource: { val: subject },
    },
  ]);

  const stParsed = parseStorageRules(
    [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      `      allow get: if resource.metadata.val.matches(${JSON.stringify(patternLiteral)});`,
      '    }',
      '  }',
      '}',
    ].join('\n'),
  );
  const stRes = evaluateStorageRules(stParsed, {
    request: { auth: null, method: 'get', path: '/b/b1/o/items/i1' },
    resource: { size: 1, metadata: { val: subject } },
  });

  return {
    firestore: fsSummary.cases[0]?.decision === 'ALLOW',
    storage: stRes.allowed,
  };
}

describe('RE2 POSIX character class differential corpus (Firestore vs Storage)', () => {
  const corpus: ReadonlyArray<readonly [string, string, boolean]> = [
    // Lookaround and backreference tokens following [:name:] remain ordinary class members
    ['[[:alpha:](?=)]', 'a', true],
    ['[[:alpha:](?=)]', '=', true],
    ['[[:alpha:](?=)]', '?', true],
    ['[[:alpha:](?=)]', '(', true],
    ['[[:alpha:](?=)]', '9', false],
    ['[[:alpha:](?!)]', '!', true],
    ['[[:alpha:](?<=)]', '<', true],
    ['[[:alpha:]\\001]', '\x01', true],
    // Scoped/inline flag syntax following [:name:] preserves literal flag characters and does not hoist flags
    ['[[:digit:](?i:9)]', 'i', true],
    ['[[:digit:](?i:9)]', '5', true],
    ['[[:digit:](?i:9)]', ':', true],
    ['[[:digit:](?i:9)]', 'a', false],
    ['[[:upper:](?i:9)]', 'A', true],
    ['[[:upper:](?i:9)]', 'i', true],
    ['[[:upper:](?i:9)]', 'a', false],
    // \s and \S after [:name:] stay inside the enclosing bracket class with ASCII-only RE2 semantics
    ['[[:alpha:]\\s]', ' ', true],
    ['[[:alpha:]\\s]', '\t', true],
    ['[[:alpha:]\\s]', 'z', true],
    ['[[:alpha:]\\s]', '\u00a0', false],
    ['[[:digit:]\\S]', 'x', true],
    ['[[:digit:]\\S]', ' ', false],
    // Negated POSIX classes, leading ], and escaped \] combined with POSIX classes
    ['[[:^digit:](?=)]', 'a', true],
    ['[[:^digit:](?=)]', '5', false],
    ['[][[:digit:](?i:9)]', ']', true],
    ['[][[:digit:](?i:9)]', 'i', true],
    ['[\\][:alpha:](?=)]', ']', true],
    ['[\\][:alpha:](?=)]', '=', true],
    // Inline case-insensitive flag outside class combined with POSIX class inside [...]
    ['(?i)[[:upper:]0]', 'a', true],
    ['(?i)[[:upper:]0]', '0', true],
    ['(?i)[[:upper:]0]', '1', false],
  ];

  test.each(corpus)('pattern %s on %j evaluates to %s across Firestore and Storage', (pattern, subject, expected) => {
    expect(evalBothMatches(pattern, subject)).toEqual({
      firestore: expected,
      storage: expected,
    });
  });

  test('supports POSIX classes followed by group/flag characters in replace() and split()', () => {
    const fsSim = firestoreRules(
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        "      allow get: if 'a=9i'.replace('[[:digit:](?i:9)]', 'X') == 'a=XX'",
        "        && 'x?y'.split('[[:digit:](?=)]') == ['x', 'y'];",
        '    }',
        '  }',
        '}',
      ].join('\n'),
    ).simulate([
      {
        description: 'replace and split with POSIX class',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/i1',
        auth: null,
      },
    ]);
    expect(fsSim.cases[0]?.decision).toBe('ALLOW');

    const stParsed = parseStorageRules(
      [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /items/{id} {',
        "      allow get: if 'a=9i'.replace('[[:digit:](?i:9)]', 'X') == 'a=XX'",
        "        && 'x?y'.split('[[:digit:](?=)]') == ['x', 'y'];",
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const stRes = evaluateStorageRules(stParsed, {
      request: { auth: null, method: 'get', path: '/b/b1/o/items/i1' },
      resource: { size: 1 },
    });
    expect(stRes.allowed).toBe(true);
  });

  test('keeps inClass active across [:name:] in normalizeRe2ForJsRegExp, spellRe2SpaceClasses, and scanRe2Pattern', () => {
    expect(scanRe2Pattern('[[:alpha:](?=)]')).toEqual({ unsupported: null, inlineFlags: '' });
    expect(scanRe2Pattern('[[:alpha:]\\1]')).toEqual({ unsupported: null, inlineFlags: '' });
    expect(scanRe2Pattern('[[:digit:](?i:9)]')).toEqual({ unsupported: null, inlineFlags: '' });

    expect(normalizeRe2ForJsRegExp('[[:digit:](?i:9)]')).toBe('[[:digit:](?i:9)]');
    expect(normalizeRe2ForJsRegExp('[[:alpha:]\\A\\z\\Q]')).toBe('[[:alpha:]\\A\\z\\Q]');

    // Inside [...], \s expands to RE2_SPACE_MEMBERS without enclosing [...] brackets even after [:alpha:]
    const spelled = spellRe2SpaceClasses('[[:alpha:]\\s]', true);
    expect(spelled).toBe('[[:alpha:]\\t\\n\\f\\r ]');
  });

  describe('SD:REGEX-ENGINES standing corpus: RE2 character-class-endpoint range validation', () => {
    const invalidRangePatterns: ReadonlyArray<string> = [
      '[\\d-a]',
      '[a-\\d]',
      '[\\w-z]',
      '[\\w-!]',
      '[0-\\s]',
      '[\\s-a]',
      '[\\D-9]',
      '[9-\\D]',
      '[\\W-a]',
      '[\\S-z]',
      '[\\d-\\w]',
      '[[:digit:]-a]',
      '[a-[:digit:]]',
      '[[:^digit:]-a]',
      '[a-[:^alpha:]]',
      '[[:digit:]-[:alpha:]]',
      '[\\p{N}-a]',
      '[a-\\p{N}]',
      '[\\pL-z]',
      '[a-\\PN]',
      '[--\\d]',
      '[^\\d-a]',
    ];

    test.each(invalidRangePatterns)(
      'rejects invalid character-class-endpoint range %s at compile time in firestoreRules() and storageRules()',
      (pattern) => {
        expect(() =>
          firestoreRules(
            [
              "rules_version = '2';",
              'service cloud.firestore {',
              '  match /databases/{database}/documents {',
              '    match /items/{id} {',
              `      allow get: if resource.data.val.matches(${JSON.stringify(pattern)});`,
              '    }',
              '  }',
              '}',
            ].join('\n'),
          ),
        ).toThrow();

        expect(() =>
          storageRules(
            [
              "rules_version = '2';",
              'service firebase.storage {',
              '  match /b/{bucket}/o {',
              '    match /items/{id} {',
              `      allow read: if resource.metadata.val.matches(${JSON.stringify(pattern)});`,
              '    }',
              '  }',
              '}',
            ].join('\n'),
          ),
        ).toThrow();
      },
    );

    test.each(invalidRangePatterns)(
      'rejects dynamic %s at runtime across matches(), split(), and replace() in Firestore and Storage (and absorbs under || true)',
      (pattern) => {
        const fsDynamic = firestoreRules(
          [
            "rules_version = '2';",
            'service cloud.firestore {',
            '  match /databases/{database}/documents {',
            '    match /items/{id} {',
            '      allow get: if !resource.data.val.matches(resource.data.pat);',
            '      allow list: if resource.data.val.split(resource.data.pat).size() >= 0;',
            "      allow create: if request.resource.data.val.replace(request.resource.data.pat, 'X') != '';",
            '      allow delete: if resource.data.val.matches(resource.data.pat) || true;',
            '    }',
            '  }',
            '}',
          ].join('\n'),
        );

        const fsRes = fsDynamic.simulate([
          {
            description: 'dynamic matches',
            expectation: 'DENY',
            method: 'get',
            path: 'items/i1',
            resource: { val: '5', pat: pattern },
          },
          {
            description: 'dynamic split',
            expectation: 'DENY',
            method: 'list',
            path: 'items/i1',
            resource: { val: '5', pat: pattern },
          },
          {
            description: 'dynamic replace',
            expectation: 'DENY',
            method: 'create',
            path: 'items/i1',
            data: { val: '5', pat: pattern },
          },
          {
            description: 'error absorption under || true',
            expectation: 'ALLOW',
            method: 'delete',
            path: 'items/i1',
            resource: { val: '5', pat: pattern },
          },
        ]);
        expect(fsRes.cases.map((c) => c.decision)).toEqual(['DENY', 'DENY', 'DENY', 'ALLOW']);

        const stDynamic = storageRules(
          [
            "rules_version = '2';",
            'service firebase.storage {',
            '  match /b/{bucket}/o {',
            '    match /items/{id} {',
            '      allow get: if !resource.metadata.val.matches(resource.metadata.pat);',
            '      allow list: if resource.metadata.val.split(resource.metadata.pat).size() >= 0;',
            "      allow update: if resource.metadata.val.replace(resource.metadata.pat, 'X') != '';",
            '      allow delete: if resource.metadata.val.matches(resource.metadata.pat) || true;',
            '    }',
            '  }',
            '}',
          ].join('\n'),
          { bucket: 'b1' },
        );

        const stRes = stDynamic.simulate([
          {
            description: 'storage dynamic matches',
            expectation: 'DENY',
            method: 'get',
            path: '/items/i1',
            resource: { size: 1, metadata: { val: '5', pat: pattern } },
          },
          {
            description: 'storage dynamic split',
            expectation: 'DENY',
            method: 'list',
            path: '/items/i1',
            resource: { size: 1, metadata: { val: '5', pat: pattern } },
          },
          {
            description: 'storage dynamic replace',
            expectation: 'DENY',
            method: 'update',
            path: '/items/i1',
            resource: { size: 1, metadata: { val: '5', pat: pattern } },
            requestResource: { size: 1, metadata: { val: '5', pat: pattern } },
          },
          {
            description: 'storage error absorption under || true',
            expectation: 'ALLOW',
            method: 'delete',
            path: '/items/i1',
            resource: { size: 1, metadata: { val: '5', pat: pattern } },
          },
        ]);
        expect(stRes.cases.map((c) => c.decision)).toEqual(['DENY', 'DENY', 'DENY', 'ALLOW']);
      },
    );

    const validHyphenCorpus: ReadonlyArray<readonly [string, string, boolean]> = [
      // Escaped hyphen next to character class is a literal '-'
      ['[\\d\\-a]', '5', true],
      ['[\\d\\-a]', '-', true],
      ['[\\d\\-a]', 'a', true],
      ['[\\d\\-a]', 'b', false],
      ['[a\\-\\d]', '-', true],
      ['[a\\-\\d]', '9', true],
      // Leading and trailing unescaped hyphens next to character classes are literal '-'
      ['[-\\d]', '-', true],
      ['[-\\d]', '7', true],
      ['[-\\d]', 'a', false],
      ['[\\d-]', '-', true],
      ['[\\d-]', '7', true],
      ['[\\d-]', 'a', false],
      ['[[:digit:]-]', '-', true],
      ['[[:digit:]-]', '4', true],
      ['[-[:digit:]]', '-', true],
      ['[\\p{L}-]', '-', true],
      ['[\\p{L}-]', 'z', true],
      // Valid single-character ranges including '-' as start endpoint and astral ranges
      ['[a-z]', 'm', true],
      ['[--9]', '0', true],
      ['[--9]', '-', true],
      ['[😀-😂]', '😁', true],
      // Quoted \Q...\E treats [\d-a] as literal characters, not a character class
      ['\\Q[\\d-a]\\E', '[\\d-a]', true],
      ['\\Q[\\d-a]\\E', '5', false],
    ];

    test.each(validHyphenCorpus)(
      'preserves valid RE2 hyphen/range pattern %s on %j -> %s across Firestore and Storage',
      (pattern, subject, expected) => {
        expect(evalBothMatches(pattern, subject)).toEqual({
          firestore: expected,
          storage: expected,
        });
      },
    );
  });
});
