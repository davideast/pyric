/**
 * Regression suite for #2211: Firestore and Storage rules `split()` and
 * `replace()` read RE2's Unicode property classes (`\pN`, `\p{Greek}`, etc.),
 * ASCII POSIX character classes (`[[:punct:]]`, `[[:^alpha:]]`, etc.), and
 * `\Q..\E` literal quoting identically to production RE2 without regressing
 * `matches()`.
 *
 * Replays the #2211 cases from the committed production Rules Test API
 * captures under `packages/conformance/observations/firestore-rules/`:
 * - `rules-firestore-re2-more-classes-and-escapes.json` (`c9-re2-more`: `pn0`, `pg0`, `px1`, `px2`, `qs0`)
 * - `rules-firestore-re2-replace-and-split-dialect.json` (`c1-re2-replace-split`: `pl0`, `pl1`, `pl2`, `px0`, `qe0`, `qe1`)
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firestoreRules, lint, storageRules } from '../../src/index.js';
import { compileStorageRules } from '../../src/storage/rules-resolution.js';
import { parseStorageRules } from '../../src/storage/rules.js';

type Verdict = 'ALLOW' | 'DENY';

const OBSERVATIONS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'firestore-rules',
);

const ALPHA_GREEK = String.fromCodePoint(0x03b1);
const BETA_GREEK = String.fromCodePoint(0x03b2);
const GAMMA_GREEK = String.fromCodePoint(0x03b3);
const BE_CYRILLIC = String.fromCodePoint(0x0411);
const ARABIC_INDIC_THREE = String.fromCodePoint(0x0663);
const E_ACUTE_LOWER = String.fromCodePoint(0x00e9);
const E_ACUTE_UPPER = String.fromCodePoint(0x00c9);
const NBSP = String.fromCodePoint(0x00a0);
const EM_SPACE = String.fromCodePoint(0x2003);
const EM_DASH = String.fromCodePoint(0x2014);
const NEXT_LINE = String.fromCodePoint(0x0085);
const KELVIN = String.fromCodePoint(0x212a);
const HAN_ZHONG = String.fromCodePoint(0x4e2d);
const HAN_WEN = String.fromCodePoint(0x6587);
const YI_SYLLABLE_IT = String.fromCodePoint(0xa000);

function readObservedBehavior(scenarioId: string): Record<string, Verdict> {
  const filePath = join(OBSERVATIONS_DIR, `rules-firestore-${scenarioId}.json`);
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
    behavior: Record<string, Verdict>;
  };
  return parsed.behavior;
}

function requireObservedVerdict(
  behavior: Readonly<Record<string, Verdict>>,
  key: string,
): Verdict {
  const verdict = behavior[key];
  if (verdict === undefined) {
    throw new Error(`Missing observed case: ${key}`);
  }
  return verdict;
}

function evalGuardBoth(
  guard: string,
  payload: Readonly<Record<string, string>> = {},
): { firestore: string; storage: string } {
  const fsRulesSource = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/{id} {',
    `      allow create: if ${guard};`,
    '    }',
    '  }',
    '}',
  ].join('\n');
  const fsSummary = firestoreRules(fsRulesSource).simulate([
    {
      description: guard,
      expectation: 'ALLOW',
      method: 'create',
      path: 'items/1',
      data: payload,
    },
  ]);
  const fsCase = fsSummary.cases[0];
  if (fsCase === undefined) {
    throw new Error('Missing Firestore simulation case result');
  }

  const storageGuard = guard.replaceAll('request.resource.data.', 'request.resource.metadata.');
  const stRulesSource = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    '    match /items/{id} {',
    `      allow create: if ${storageGuard};`,
    '    }',
    '  }',
    '}',
  ].join('\n');
  const stSummary = storageRules(stRulesSource, { bucket: 'b1' }).simulate([
    {
      description: storageGuard,
      expectation: 'ALLOW',
      method: 'create',
      path: '/items/1',
      requestResource: { size: 1, metadata: payload },
    },
  ]);
  const stCase = stSummary.cases[0];
  if (stCase === undefined) {
    throw new Error('Missing Storage simulation case result');
  }

  return {
    firestore: fsCase.decision,
    storage: stCase.decision,
  };
}

describe('#2211: captured production verdicts for \\p classes, POSIX classes, and \\Q..\\E in split() and replace()', () => {
  const c9Observed = readObservedBehavior('re2-more-classes-and-escapes');
  const c1Observed = readObservedBehavior('re2-replace-and-split-dialect');

  const capturedCases: ReadonlyArray<{
    readonly behavior: Readonly<Record<string, Verdict>>;
    readonly key: string;
    readonly guard: string;
  }> = [
    {
      behavior: c9Observed,
      key: "pn0: 'a1'.replace('\\\\pN', 'x') == 'ax'",
      guard: "'a1'.replace('\\\\pN', 'x') == 'ax'",
    },
    {
      behavior: c9Observed,
      key: `pg0: '${ALPHA_GREEK}'.replace('\\\\p{Greek}', 'x') == 'x'`,
      guard: `'${ALPHA_GREEK}'.replace('\\\\p{Greek}', 'x') == 'x'`,
    },
    {
      behavior: c9Observed,
      key: "px1: 'a'.replace('[[:^alpha:]]', 'x') == 'a'",
      guard: "'a'.replace('[[:^alpha:]]', 'x') == 'a'",
    },
    {
      behavior: c9Observed,
      key: "px2: 'a.b'.split('[[:punct:]]') == ['a', 'b']",
      guard: "'a.b'.split('[[:punct:]]') == ['a', 'b']",
    },
    {
      behavior: c9Observed,
      key: "qs0: 'a.b'.split('\\\\Q.\\\\E') == ['a', 'b']",
      guard: "'a.b'.split('\\\\Q.\\\\E') == ['a', 'b']",
    },
    {
      behavior: c1Observed,
      key: "pl0: 'a'.replace('\\\\p{L}', 'x') == 'x'",
      guard: "'a'.replace('\\\\p{L}', 'x') == 'x'",
    },
    {
      behavior: c1Observed,
      key: "pl1: 'a'.replace('\\\\pL', 'x') == 'x'",
      guard: "'a'.replace('\\\\pL', 'x') == 'x'",
    },
    {
      behavior: c1Observed,
      key: "pl2: '1a2'.split('\\\\pL') == ['1', '2']",
      guard: "'1a2'.split('\\\\pL') == ['1', '2']",
    },
    {
      behavior: c1Observed,
      key: "px0: 'a'.replace('[[:alpha:]]', 'x') == 'x'",
      guard: "'a'.replace('[[:alpha:]]', 'x') == 'x'",
    },
    {
      behavior: c1Observed,
      key: "qe0: 'a.b'.replace('\\\\Qa.b\\\\E', 'x') == 'x'",
      guard: "'a.b'.replace('\\\\Qa.b\\\\E', 'x') == 'x'",
    },
    {
      behavior: c1Observed,
      key: "qe1: 'axb'.replace('\\\\Qa.b\\\\E', 'x') == 'axb'",
      guard: "'axb'.replace('\\\\Qa.b\\\\E', 'x') == 'axb'",
    },
  ];

  for (const item of capturedCases) {
    test(`matches production on Firestore and Storage: ${item.key}`, () => {
      const expected = requireObservedVerdict(item.behavior, item.key);
      expect(expected).toBe('ALLOW');
      expect(evalGuardBoth(item.guard)).toEqual({
        firestore: expected,
        storage: expected,
      });
    });
  }
});

describe('#2211: RE2 Unicode property classes (\\p / \\P) in split() and replace()', () => {
  test('reads one-letter shorthand categories (\\pN, \\PN, \\pL, \\PL, \\pP, \\pS, \\pZ) as classes rather than literal letters', () => {
    const shorthandGuards: readonly string[] = [
      "'pN'.replace('\\\\pN', 'x') == 'pN'",
      "'pN7pN'.split('\\\\pN') == ['pN', 'pN']",
      `'a1${ARABIC_INDIC_THREE}b'.replace('\\\\pN', '#') == 'a##b'`,
      `'a1${ARABIC_INDIC_THREE}b'.split('\\\\pN+') == ['a', 'b']`,
      "'a1b2'.replace('\\\\PN', '_') == '_1_2'",
      "'a1b2c'.split('\\\\PL') == ['a', 'b', 'c']",
      "'pL'.replace('\\\\pL', 'x') == 'xx'",
      "'12'.replace('\\\\pL', 'x') == '12'",
      "'a,b!c'.split('\\\\pP') == ['a', 'b', 'c']",
      "'a+b=c'.replace('\\\\pS', '-') == 'a-b-c'",
      `'a${NBSP}b${EM_SPACE}c'.split('\\\\pZ') == ['a', 'b', 'c']`,
    ];
    for (const guard of shorthandGuards) {
      expect(evalGuardBoth(guard)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    }
  });

  test('reads braced general categories, scripts, negations (\\P{...}, \\p{^...}, \\P{^...}), bracket unions, and (?i)', () => {
    const unicodeClassGuards: readonly string[] = [
      "'p{Greek}'.replace('\\\\p{Greek}', 'x') == 'p{Greek}'",
      `'p{Greek}${ALPHA_GREEK}p{Greek}'.split('\\\\p{Greek}') == ['p{Greek}', 'p{Greek}']`,
      `'a${ALPHA_GREEK}${BETA_GREEK}b${GAMMA_GREEK}c'.split('\\\\p{Greek}+') == ['a', 'b', 'c']`,
      `'a${ALPHA_GREEK}b'.replace('\\\\P{Greek}', '_') == '_${ALPHA_GREEK}_'`,
      `'a${ALPHA_GREEK}b'.replace('\\\\p{^Greek}', '_') == '_${ALPHA_GREEK}_'`,
      `'a${ALPHA_GREEK}b'.replace('\\\\P{^Greek}', '_') == 'a_b'`,
      `'a${ALPHA_GREEK}b${BE_CYRILLIC}c'.split('[\\\\p{Greek}\\\\p{Cyrillic}]') == ['a', 'b', 'c']`,
      `'hi${HAN_ZHONG}${HAN_WEN}ok'.replace('\\\\p{Han}+', '-') == 'hi-ok'`,
      `'x${YI_SYLLABLE_IT}y'.split('\\\\p{Yi}') == ['x', 'y']`,
      "'camelCase'.replace('(\\\\p{Ll})(\\\\p{Lu})', '$1_$2') == 'camel_Case'",
      `'${ALPHA_GREEK}-42'.replace('(?P<script>\\\\p{Greek}+)-(\\\\pN+)', '$2:\${script}') == '42:${ALPHA_GREEK}'`,
      "'a\\nb'.replace('\\\\p{Any}', 'x') == 'xxx'",
      "'aB'.replace('(?i)\\\\p{Ll}', 'x') == 'xx'",
      "'aB1'.split('(?i)\\\\P{Ll}') == ['aB']",
      `'a1'.matches('\\\\pL\\\\pN') && '${ALPHA_GREEK}'.matches('\\\\p{Greek}')`,
    ];
    for (const guard of unicodeClassGuards) {
      expect(evalGuardBoth(guard)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    }
  });
});

describe('#2211: RE2 ASCII POSIX classes in split() and replace()', () => {
  const posixCases: ReadonlyArray<{
    readonly name: string;
    readonly member: string;
    readonly nonAscii: string;
  }> = [
    { name: 'alnum', member: '7', nonAscii: E_ACUTE_LOWER },
    { name: 'alpha', member: 'Z', nonAscii: E_ACUTE_LOWER },
    { name: 'ascii', member: '!', nonAscii: ALPHA_GREEK },
    { name: 'blank', member: '\t', nonAscii: NBSP },
    { name: 'cntrl', member: '\x1f', nonAscii: NEXT_LINE },
    { name: 'digit', member: '5', nonAscii: ARABIC_INDIC_THREE },
    { name: 'graph', member: '#', nonAscii: E_ACUTE_LOWER },
    { name: 'lower', member: 'm', nonAscii: E_ACUTE_LOWER },
    { name: 'print', member: ' ', nonAscii: E_ACUTE_LOWER },
    { name: 'punct', member: '.', nonAscii: EM_DASH },
    { name: 'space', member: '\x0b', nonAscii: NBSP },
    { name: 'upper', member: 'Q', nonAscii: E_ACUTE_UPPER },
    { name: 'word', member: '_', nonAscii: E_ACUTE_LOWER },
    { name: 'xdigit', member: 'f', nonAscii: KELVIN },
  ];

  for (const item of posixCases) {
    test(`[[:${item.name}:]] and [[:^${item.name}:]] keep ASCII-only RE2 membership in split() and replace()`, () => {
      const subject = `${ALPHA_GREEK}${item.member}${BETA_GREEK}${item.nonAscii}`;
      const expectedPieces = [ALPHA_GREEK, `${BETA_GREEK}${item.nonAscii}`];
      const expectedReplaced = `${ALPHA_GREEK}_${BETA_GREEK}${item.nonAscii}`;
      const guard = [
        `request.resource.data.s.split('[[:${item.name}:]]') == ${JSON.stringify(expectedPieces)}`,
        `request.resource.data.s.replace('[[:${item.name}:]]', '_') == ${JSON.stringify(expectedReplaced)}`,
        `request.resource.data.nonAscii.replace('[[:^${item.name}:]]', '_') == '_'`,
        `request.resource.data.member.replace('[[:^${item.name}:]]', '_') == request.resource.data.member`,
      ].join(' && ');
      expect(
        evalGuardBoth(guard, {
          s: subject,
          nonAscii: item.nonAscii,
          member: item.member,
        }),
      ).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    });
  }

  test('does not misread [[:punct:]] as [:punct followed by literal ] and supports unions and (?i)', () => {
    const posixEdgeGuards: readonly string[] = [
      "'ap]b'.replace('[[:punct:]]', 'x') == 'apxb'",
      "'apb'.replace('[[:punct:]]', 'x') == 'apb'",
      "'a:b]c!d'.split('[[:punct:]]') == ['a', 'b', 'c', 'd']",
      "'a, b! c'.split('[[:punct:][:space:]]+') == ['a', 'b', 'c']",
      "'a.b'.replace('[^[:punct:]]', 'x') == 'x.x'",
      `'1a2${KELVIN}3'.split('(?i)[[:lower:]]') == ['1', '2', '3']`,
      `'a${KELVIN}b'.replace('(?i)[[:lower:]]', '_') == '___'`,
    ];
    for (const guard of posixEdgeGuards) {
      expect(evalGuardBoth(guard)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    }
  });
});

describe('#2211: RE2 \\Q..\\E literal quoting in split() and replace()', () => {
  test('quotes regex metacharacters, binds trailing quantifiers to the last quoted char, and handles unclosed \\Q', () => {
    const quotedGuards: readonly string[] = [
      "'a.b+c*?[d](e)|f^g$h'.split('\\\\Q.b+c*?[d](e)|f^g$\\\\E') == ['a', 'h']",
      "'a.*b_axxb'.replace('\\\\Q.*\\\\E', '!') == 'a!b_axxb'",
      "'Q.E'.replace('\\\\Q.\\\\E', 'x') == 'QxE'",
      "'QaE'.replace('\\\\Q.\\\\E', 'x') == 'QaE'",
      "'abbb_abab'.replace('\\\\Qab\\\\E+', 'X') == 'X_XX'",
      "'a..b.c'.split('\\\\Q.\\\\E{2}') == ['a', 'b.c']",
      "'a.b+c'.split('\\\\Q.b+') == ['a', 'c']",
      "'a.b'.replace('\\\\Qa.b', 'x') == 'x'",
      "'a.B_A.b'.replace('(?i)\\\\Qa.b\\\\E', 'X') == 'X_X'",
      "'x[[:foo:]]\\\\Zy'.split('\\\\Q[[:foo:]]\\\\Z\\\\E') == ['x', 'y']",
      "'v1.2'.replace('v(\\\\pN+)\\\\Q.\\\\E([[:digit:]]+)', '$2-$1') == '2-1'",
    ];
    for (const guard of quotedGuards) {
      expect(evalGuardBoth(guard)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    }
  });

  test.each(['[\\Q]', '\\E'])(
    'refuses %s in split() literals at compile time and treats it as an absorbable error dynamically and in replace()',
    (invalidPattern) => {
      const fsLiteralSplit = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        `      allow get: if 'a'.split(${JSON.stringify(invalidPattern)}).size() > 0;`,
        '    }',
        '  }',
        '}',
      ].join('\n');
      expect(() => firestoreRules(fsLiteralSplit)).toThrow(/Invalid regular expression pattern/);
      expect(lint(fsLiteralSplit).some((issue) => issue.code === 'INVALID_REGEX_PATTERN')).toBe(true);

      const stLiteralSplit = [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /items/{id} {',
        `      allow read: if 'a'.split(${JSON.stringify(invalidPattern)}).size() > 0;`,
        '    }',
        '  }',
        '}',
      ].join('\n');
      expect(() => compileStorageRules(stLiteralSplit)).toThrow(/Invalid regular expression pattern/);
      expect(() => parseStorageRules(stLiteralSplit)).toThrow(/Invalid regular expression pattern/);

      expect(evalGuardBoth('request.resource.data.s.split(request.resource.data.p).size() >= 0', {
        s: 'a',
        p: invalidPattern,
      })).toEqual({ firestore: 'DENY', storage: 'DENY' });
      expect(evalGuardBoth('request.resource.data.s.split(request.resource.data.p).size() >= 0 || true', {
        s: 'a',
        p: invalidPattern,
      })).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(evalGuardBoth(`'a'.replace(${JSON.stringify(invalidPattern)}, 'x') != ''`)).toEqual({
        firestore: 'DENY',
        storage: 'DENY',
      });
      expect(evalGuardBoth(`'a'.replace(${JSON.stringify(invalidPattern)}, 'x') != '' || true`)).toEqual({
        firestore: 'ALLOW',
        storage: 'ALLOW',
      });
    },
  );
});
