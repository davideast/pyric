import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../src/index.js';
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
});
