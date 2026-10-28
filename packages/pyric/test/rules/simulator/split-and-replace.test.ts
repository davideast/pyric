/**
 * `split()` and `replace()` on Firestore and Storage, through the one shared
 * `splitRe2` and `replaceRe2` (#1333).
 *
 * Every expected verdict is production's own, read from the Firestore Rules
 * Test API captures in `packages/conformance/observations/firestore-rules/`:
 * `rules-firestore-re2-pattern-semantics.json` (row firestore-rules#199) and
 * `rules-firestore-split-and-trim-edges.json` (row firestore-rules#202),
 * recaptured 2026-10-28. Storage's capture `xref-shared-language-semantics`
 * (row storage-rules#219) agrees with Firestore on split(), so Storage must
 * give the same verdict for each guard.
 *
 * - FS2-SIM-4: capture-group text is never a piece.
 * - FS2-SIM-7: trailing empty pieces are dropped, one piece always remains,
 *   and a leading empty piece is kept.
 * - FS2-SIM-5a2, split() and replace() half: `.` matches `\r`, not `\n`.
 * - FS2-SIM-6, `(?i)` half: split() and replace() honor a leading `(?i)`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

type Verdict = 'ALLOW' | 'DENY';

function observedBehavior(scenario: string): Record<string, Verdict> {
  const file = join(
    import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations', 'firestore-rules',
    `rules-firestore-${scenario}.json`,
  );
  return (JSON.parse(readFileSync(file, 'utf8')) as { behavior: Record<string, Verdict> }).behavior;
}

const production: Record<string, Verdict> = {
  ...observedBehavior('re2-pattern-semantics'),
  ...observedBehavior('split-and-trim-edges'),
};

/** [captured case description, its rules guard] */
type CapturedGuard = readonly [description: string, guard: string];

const FINDINGS: Readonly<Record<string, readonly CapturedGuard[]>> = {
  'FS2-SIM-4': [
    ['split on a capturing group returns two pieces', "'a1b'.split('(1)') == ['a', 'b']"],
    ['split on a capturing group has size two', "'a1b'.split('(1)').size() == 2"],
    ['split on a capturing dash hasOnly the pieces', "'a-b'.split('(-)').hasOnly(['a', 'b'])"],
    ['split on a non-capturing group (control)', "'a1b'.split('(?:1)') == ['a', 'b']"],
    ['capturing split drops the trailing empty piece', "'a1b2'.split('([0-9])') == ['a', 'b']"],
  ],
  'FS2-SIM-7': [
    ['trailing comma drops the empty piece', "'a,b,'.split(',') == ['a', 'b']"],
    ['trailing comma keeps the empty piece', "'a,b,'.split(',') == ['a', 'b', '']"],
    ['two trailing commas give size two', "'a,b,,'.split(',').size() == 2"],
    ['split on dot of a.b.c is empty', "'a.b.c'.split('.').size() == 0"],
    ['split on dot of a.b.c has size one', "'a.b.c'.split('.').size() == 1"],
    ['split on dot of a.b.c is one empty piece', "'a.b.c'.split('.') == ['']"],
    ['split of a lone comma is empty', "','.split(',').size() == 0"],
    ['split of a lone comma is one empty piece', "','.split(',') == ['']"],
    ['split of two commas is one empty piece', "',,'.split(',') == ['']"],
    ['empty string splits to one empty piece', "''.split(',') == ['']"],
    ['leading comma keeps the empty piece (control)', "',a'.split(',') == ['', 'a']"],
    ['leading kept and trailing dropped together', "',a,'.split(',') == ['', 'a']"],
  ],
  'FS2-SIM-5a2': [
    ['split dot matches carriage return', "'xa\\rbx'.split('a.b') == ['x', 'x']"],
    ['replace dot matches carriage return', "'a\\rb'.replace('a.b', '_') == '_'"],
    ['replace dot does not match newline (control)', "'a\\nb'.replace('a.b', '_') == 'a\\nb'"],
    ['replace (?s) dot matches newline', "'a\\nb'.replace('(?s)a.b', '_') == '_'"],
  ],
  'FS2-SIM-6': [
    ['split with (?i) splits both cases', "'aXbxc'.split('(?i)x') == ['a', 'b', 'c']"],
    ['replace with (?i) replaces uppercase', "'aXb'.replace('(?i)x', '_') == 'a_b'"],
  ],
};

function firestoreVerdict(guard: string): string {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow get: if ${guard};
    }
  }
}`;
  const result = new SimulateFirestoreRulesHandler().simulate(rules, [
    { description: guard, expectation: 'ALLOW', method: 'get', path: 'c/1' },
  ]);
  if (!result.success) return `ERROR:${result.error.code}`;
  return result.data.results[0]?.decision ?? 'NONE';
}

function storageSource(guard: string): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read: if ${guard}; }
  }
}`;
}

function storageVerdict(guard: string, metadata: Record<string, string> = {}): Verdict {
  const allowed = evaluateStorageRules(parseStorageRules(storageSource(guard)), {
    request: { auth: null, method: 'get', path: '/b/bucket/o/file.txt' },
    resource: { size: 1, metadata },
  }).allowed;
  return allowed ? 'ALLOW' : 'DENY';
}

for (const [finding, guards] of Object.entries(FINDINGS)) {
  describe(`${finding}: Firestore and Storage give production's verdict`, () => {
    for (const [description, guard] of guards) {
      test(description, () => {
        const expected = production[description];
        expect(expected).toBeDefined();
        expect(firestoreVerdict(guard)).toBe(expected!);
        expect(storageVerdict(guard)).toBe(expected!);
      });
    }
  });
}

/**
 * The shared compile reads RE2's backreference and lookaround refusals with
 * `scanRe2Pattern`, which skips escapes and classes. An escaped backslash
 * before a digit and `(?=` inside a class are literals, on both engines.
 */
describe('escapes and classes are not backreferences or lookarounds', () => {
  const guards = [
    "'\\\\1'.split('\\\\\\\\1') == ['']",
    "'(?='.split('[(?=]+') == ['']",
    "'a(?=b'.replace('[(?=]', '_') == 'a___b'",
  ];
  for (const guard of guards) {
    test(guard, () => {
      expect(firestoreVerdict(guard)).toBe('ALLOW');
      expect(storageVerdict(guard)).toBe('ALLOW');
    });
  }

  test('a real backreference and a real lookahead still deny', () => {
    for (const guard of ["'aa'.split('(a)\\\\1').size() > 0", "'ab'.replace('a(?=b)', '_') == '_b'"]) {
      expect(firestoreVerdict(guard)).toBe('DENY');
      expect(storageVerdict(guard)).toBe('DENY');
    }
  });
});

/**
 * Production's `(?i)k` matches the Kelvin sign U+212A in split() and
 * replace() (captured ALLOW). pyric compiles these patterns with
 * JavaScript's `i` flag and no `u` flag, which does not fold U+212A to `k`,
 * so pyric denies both today. The two cases are pinned in
 * `packages/conformance/firestore-rules-exceptions/` under ST-H1-3, whose
 * `matches()` half is #1332; that item flips these assertions.
 */
describe('Kelvin sign under (?i): production folds it, pyric does not yet (#1332)', () => {
  const kelvin: readonly CapturedGuard[] = [
    ['split (?i)k splits on the Kelvin sign', "'a\\u212ab'.split('(?i)k') == ['a', 'b']"],
    ['replace (?i)k replaces the Kelvin sign', "'\\u212a'.replace('(?i)k', '_') == '_'"],
  ];
  for (const [description, guard] of kelvin) {
    test(description, () => {
      expect(production[description]).toBe('ALLOW');
      expect(firestoreVerdict(guard)).toBe('DENY');
      expect(storageVerdict(guard)).toBe('DENY');
    });
  }
});

/**
 * Storage's split() and replace() compile through the shared
 * `compileRe2Regex`, so a pattern from request data gets pyric's size limit
 * and RE2's 1000-repeat cap (#1264, ST-H3-10), as `matches()` does. The
 * refusal is an evaluation error: it denies on its own and `|| true`
 * absorbs it.
 */
describe('Storage split() and replace(): a pattern from request data past the limits', () => {
  const patterns = {
    'the size limit': '((a{1000}){1000}){1000}',
    'the 1000-repeat cap': 'a{1001}',
  };
  const calls = {
    split: "'a'.split(resource.metadata.p).size() > 0",
    replace: "'a'.replace(resource.metadata.p, '_') != ''",
  };
  for (const [limit, pattern] of Object.entries(patterns)) {
    for (const [method, guard] of Object.entries(calls)) {
      test(`${method}() refuses a pattern past ${limit}`, () => {
        const started = performance.now();
        expect(storageVerdict(guard, { p: pattern })).toBe('DENY');
        expect(storageVerdict(`${guard} || true`, { p: pattern })).toBe('ALLOW');
        expect(performance.now() - started).toBeLessThan(2000);
      });
    }
  }

  test('a{1000} still splits and replaces (control)', () => {
    expect(storageVerdict(calls.split, { p: 'a{1000}' })).toBe('ALLOW');
    expect(storageVerdict(calls.replace, { p: 'a{1000}' })).toBe('ALLOW');
  });
});
