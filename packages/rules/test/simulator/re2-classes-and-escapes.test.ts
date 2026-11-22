import { describe, expect, test } from 'bun:test';
import { firestoreRules, lint, storageRules } from '../../src/index.js';
import { compileStorageRules } from '../../src/storage/rules-resolution.js';
import { parseStorageRules } from '../../src/storage/rules.js';

function evalMatchesBoth(
  pattern: string,
  subject: string,
): { firestore: string; storage: string } {
  const fs = firestoreRules(
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
  ).simulate([
    {
      description: 'fs matches',
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/1',
      resource: { val: subject },
    },
  ]);

  const st = storageRules(
    [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      `      allow get: if resource.metadata.val.matches(${JSON.stringify(pattern)});`,
      '    }',
      '  }',
      '}',
    ].join('\n'),
    { bucket: 'b1' },
  ).simulate([
    {
      description: 'st matches',
      expectation: 'ALLOW',
      method: 'get',
      path: '/items/1',
      resource: { size: 1, metadata: { val: subject } },
    },
  ]);

  return {
    firestore: fs.cases[0]!.decision,
    storage: st.cases[0]!.decision,
  };
}

describe('#1332 RE2 POSIX classes, \\Q..\\E, (?i) orbits, inline flag scoping, and refused escapes', () => {
  describe('all 14 POSIX character classes and their negations (ASCII-only per RE2)', () => {
    const eAcute = '\u00e9';
    const kelvin = '\u212a';
    const grin = String.fromCodePoint(0x1f600);

    const posixCases: ReadonlyArray<{
      name: string;
      member: string;
      asciiNonMember: string;
      unicodeNonMember: string;
    }> = [
      { name: 'alnum', member: '7', asciiNonMember: '-', unicodeNonMember: eAcute },
      { name: 'alpha', member: 'Z', asciiNonMember: '9', unicodeNonMember: eAcute },
      { name: 'ascii', member: '\x00', asciiNonMember: '', unicodeNonMember: eAcute },
      { name: 'blank', member: '\t', asciiNonMember: '\n', unicodeNonMember: '\u00a0' },
      { name: 'cntrl', member: '\x1f', asciiNonMember: ' ', unicodeNonMember: '\u0085' },
      { name: 'digit', member: '5', asciiNonMember: 'a', unicodeNonMember: '\u0661' },
      { name: 'graph', member: '!', asciiNonMember: ' ', unicodeNonMember: eAcute },
      { name: 'lower', member: 'm', asciiNonMember: 'M', unicodeNonMember: eAcute },
      { name: 'print', member: ' ', asciiNonMember: '\t', unicodeNonMember: eAcute },
      { name: 'punct', member: '@', asciiNonMember: 'a', unicodeNonMember: '\u2014' },
      { name: 'space', member: '\x0b', asciiNonMember: 'a', unicodeNonMember: '\u00a0' },
      { name: 'upper', member: 'Q', asciiNonMember: 'q', unicodeNonMember: '\u00c9' },
      { name: 'word', member: '_', asciiNonMember: '-', unicodeNonMember: eAcute },
      { name: 'xdigit', member: 'f', asciiNonMember: 'g', unicodeNonMember: kelvin },
    ];

    for (const c of posixCases) {
      test(`[[:${c.name}:]] and [[:^${c.name}:]] across ASCII and non-ASCII subjects`, () => {
        const pos = `[[:${c.name}:]]`;
        const neg = `[[:^${c.name}:]]`;
        expect(evalMatchesBoth(pos, c.member)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
        expect(evalMatchesBoth(neg, c.member)).toEqual({ firestore: 'DENY', storage: 'DENY' });
        if (c.asciiNonMember !== '') {
          expect(evalMatchesBoth(pos, c.asciiNonMember)).toEqual({ firestore: 'DENY', storage: 'DENY' });
          expect(evalMatchesBoth(neg, c.asciiNonMember)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
        }
        expect(evalMatchesBoth(pos, c.unicodeNonMember)).toEqual({ firestore: 'DENY', storage: 'DENY' });
        expect(evalMatchesBoth(neg, c.unicodeNonMember)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
        expect(evalMatchesBoth(neg, grin)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      });
    }
  });

  describe('\\Q..\\E literal quoting', () => {
    test('\\Q.*\\E matches only literal .* and handles unclosed \\Q and trailing quantifiers', () => {
      expect(evalMatchesBoth('\\Q.*\\E', '.*')).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('\\Q.*\\E', 'ab')).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalMatchesBoth('\\Qa.b', 'a.b')).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('\\Qa.b', 'axb')).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalMatchesBoth('\\Qab\\E+', 'abb')).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('\\Qab\\E+', 'abab')).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalMatchesBoth('\\Q[[:foo:]]\\Z\\E', '[[:foo:]]\\Z')).toEqual({
        firestore: 'ALLOW',
        storage: 'ALLOW',
      });
    });
  });

  describe('(?i) Unicode simple case-folding orbits', () => {
    const kelvin = '\u212a';
    const longS = '\u017f';
    const angstrom = '\u212b';
    const aRingUpper = '\u00c5';
    const aRingLower = '\u00e5';
    const micro = '\u00b5';
    const muUpper = '\u039c';
    const sigmaFinal = '\u03c2';
    const sigmaUpper = '\u03a3';
    const ohm = '\u2126';
    const omegaLower = '\u03c9';
    const cyrillicRoundedVe = '\u1c80';
    const cyrillicVeUpper = '\u0412';
    const sharpS = '\u00df';
    const capitalSharpS = '\u1e9e';

    test('folds Kelvin (U+212A) across literals, character classes, and negated classes', () => {
      expect(evalMatchesBoth('(?i)k', kelvin)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('(?i)K', kelvin)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth(`(?i)${kelvin}`, 'k')).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('(?i)[k]', kelvin)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('(?i)[a-z]', kelvin)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('(?i)[[:lower:]]', kelvin)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('(?i)[[:alpha:]]', kelvin)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('(?i)[^k]', kelvin)).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalMatchesBoth('(?i)[^[:lower:]]', kelvin)).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalMatchesBoth('(?i)[[:^lower:]]', kelvin)).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalMatchesBoth('(?i)[[:^lower:]]', 'A')).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalMatchesBoth('(?i)[[:^lower:]]', '1')).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    });

    test('folds multi-member Latin, Greek, and Cyrillic simple case-folding orbits', () => {
      expect(evalMatchesBoth('(?i)s', longS)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('(?i)[a-z]', longS)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth(`(?i)${aRingLower}`, angstrom)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth(`(?i)[${aRingUpper}]`, angstrom)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth(`(?i)${muUpper}`, micro)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth(`(?i)${sigmaUpper}`, sigmaFinal)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth(`(?i)${omegaLower}`, ohm)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth(`(?i)${cyrillicVeUpper}`, cyrillicRoundedVe)).toEqual({
        firestore: 'ALLOW',
        storage: 'ALLOW',
      });
      expect(evalMatchesBoth(`(?i)${sharpS}`, capitalSharpS)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    });
  });

  describe('mid-pattern inline flag scoping', () => {
    test('scopes (?i) and (?-i) to the remainder of the enclosing group across matches, split, and replace', () => {
      expect(evalMatchesBoth('a(?i)b', 'aB')).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('a(?i)b', 'Ab')).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalMatchesBoth('(a(?i)b)c', 'aBc')).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('(a(?i)b)c', 'aBC')).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalMatchesBoth('(?i)a(?-i)b', 'Ab')).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalMatchesBoth('(?i)a(?-i)b', 'AB')).toEqual({ firestore: 'DENY', storage: 'DENY' });

      const fsSplitReplace = firestoreRules(
        [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /items/{id} {',
          "      allow get: if 'xaByAbz'.split('a(?i)b') == ['x', 'yAbz']",
          "        && 'aBc_aBC'.replace('(a(?i)b)c', 'X') == 'X_aBC';",
          '    }',
          '  }',
          '}',
        ].join('\n'),
      ).simulate([{ description: 'scoped split/replace', expectation: 'ALLOW', method: 'get', path: 'items/1' }]);
      expect(fsSplitReplace.cases[0]!.decision).toBe('ALLOW');
    });
  });

  describe('RE2-refused escapes and invalid bracket constructs vs accepted controls', () => {
    const refusedPatterns: readonly string[] = [
      '\\Z',
      '\\G',
      '\\R',
      '\\X',
      '\\h',
      '\\e',
      '\\cA',
      '\\k<x>',
      '(?<x>a)\\k<x>',
      '[[:foo:]]',
      '\\p{Foo}',
      '\\pX',
      '\\C',
      '[\\1]',
      '[\\1-\\7]',
      '[\\b]',
      '[\\A]',
      '[\\z]',
      '[\\Q]',
      '\\E',
    ];

    test.each(refusedPatterns)(
      'refuses %s at compile time across firestoreRules, lint, compileStorageRules, parseStorageRules, and storageRules',
      (pattern) => {
        const fsSource = [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /items/{id} {',
          `      allow get: if resource.data.val.matches(${JSON.stringify(pattern)});`,
          '    }',
          '  }',
          '}',
        ].join('\n');

        expect(() => firestoreRules(fsSource)).toThrow(/Invalid regular expression pattern/);
        const lintIssues = lint(fsSource);
        expect(lintIssues.some((i) => i.code === 'INVALID_REGEX_PATTERN')).toBe(true);

        const stSource = [
          "rules_version = '2';",
          'service firebase.storage {',
          '  match /b/{bucket}/o {',
          '    match /items/{id} {',
          `      allow read: if resource.metadata.val.matches(${JSON.stringify(pattern)});`,
          '    }',
          '  }',
          '}',
        ].join('\n');

        expect(() => compileStorageRules(stSource)).toThrow(/Invalid regular expression pattern/);
        expect(() => parseStorageRules(stSource)).toThrow(/Invalid regular expression pattern/);
        expect(() => storageRules(stSource)).toThrow(/Invalid regular expression pattern/);
      },
    );

    test.each(['\\Z', '[[:foo:]]', '\\p{Foo}', '\\pX', '[\\1]', '[\\1-\\7]'])(
      'treats dynamic %s as an absorbable evaluation error across matches, split, and replace',
      (pattern) => {
        const fs = firestoreRules(
          [
            "rules_version = '2';",
            'service cloud.firestore {',
            '  match /databases/{database}/documents {',
            '    match /items/{id} {',
            '      allow get: if !resource.data.val.matches(resource.data.pat);',
            '      allow list: if resource.data.val.split(resource.data.pat).size() >= 0;',
            "      allow create: if request.resource.data.val.replace(request.resource.data.pat, '_') != '';",
            '      allow delete: if resource.data.val.split(resource.data.pat).size() == 1 || true;',
            '    }',
            '  }',
            '}',
          ].join('\n'),
        ).simulate([
          { description: 'm', expectation: 'DENY', method: 'get', path: 'items/1', resource: { val: 'a', pat: pattern } },
          { description: 's', expectation: 'DENY', method: 'list', path: 'items/1', resource: { val: 'a', pat: pattern } },
          { description: 'r', expectation: 'DENY', method: 'create', path: 'items/1', data: { val: 'a', pat: pattern } },
          { description: 'o', expectation: 'ALLOW', method: 'delete', path: 'items/1', resource: { val: 'a', pat: pattern } },
        ]);
        expect(fs.cases.map((c) => c.decision)).toEqual(['DENY', 'DENY', 'DENY', 'ALLOW']);

        const st = storageRules(
          [
            "rules_version = '2';",
            'service firebase.storage {',
            '  match /b/{bucket}/o {',
            '    match /items/{id} {',
            '      allow get: if resource.metadata.val.split(resource.metadata.pat).size() == 1;',
            '      allow delete: if resource.metadata.val.split(resource.metadata.pat).size() == 1 || true;',
            '    }',
            '  }',
            '}',
          ].join('\n'),
          { bucket: 'b1' },
        ).simulate([
          { description: 'st s', expectation: 'DENY', method: 'get', path: '/items/1', resource: { size: 1, metadata: { val: 'a', pat: pattern } } },
          { description: 'st o', expectation: 'ALLOW', method: 'delete', path: '/items/1', resource: { size: 1, metadata: { val: 'a', pat: pattern } } },
        ]);
        expect(st.cases.map((c) => c.decision)).toEqual(['DENY', 'ALLOW']);
      },
    );

    test.each(['(a{100}){100}', '(?<x>a)', '(?P<x>a)', '\\pL', '\\p{Greek}', '[\\0]', '[[:alpha:]\\001]', '[\\s\\@]'])(
      'keeps valid RE2 control pattern %s compiling in both Firestore and Storage',
      (pattern) => {
        const fsSource = [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /items/{id} {',
          `      allow get: if resource.data.val.matches(${JSON.stringify(pattern)});`,
          '    }',
          '  }',
          '}',
        ].join('\n');
        expect(() => firestoreRules(fsSource)).not.toThrow();

        const stSource = [
          "rules_version = '2';",
          'service firebase.storage {',
          '  match /b/{bucket}/o {',
          '    match /items/{id} {',
          `      allow read: if resource.metadata.val.matches(${JSON.stringify(pattern)});`,
          '    }',
          '  }',
          '}',
        ].join('\n');
        expect(() => compileStorageRules(stSource)).not.toThrow();
      },
    );
  });
});
