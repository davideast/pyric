import { describe, expect, test } from 'bun:test';
import { firestoreRules, storageRules } from '../../src/index.js';
import { re2PatternProblem } from '../../src/simulator/re2-pattern-check.js';
import { re2FullMatch, re2PatternCompiles, replaceRe2 } from '../../src/simulator/rules-type.js';
import { splitRe2 } from '../../src/simulator/string-split.js';

function evalBoth(expr: string): {
  fs: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
  st: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
} {
  const fsSource = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if ${expr};
    }
  }
}`;
  const stSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if ${expr};
    }
  }
}`;
  const fs = firestoreRules(fsSource).explain({
    description: expr,
    expectation: 'ALLOW',
    method: 'get',
    path: 'items/d1',
  }).decision;
  const st = storageRules(stSource, { bucket: 'demo-bell.appspot.com' }).explain({
    description: expr,
    expectation: 'ALLOW',
    method: 'get',
    path: 'items/d1',
    resource: { size: 1 },
  }).decision;
  return { fs, st };
}

describe('RE2 bell escape (\\a) across matches, replace, and split', () => {
  test.each([
    ["matches() \\a matches ASCII bell", "'\\x07'.matches('\\\\a')", 'ALLOW'],
    ["matches() \\a rejects literal a", "'a'.matches('\\\\a')", 'DENY'],
    ["matches() [\\a] matches ASCII bell", "'\\x07'.matches('[\\\\a]')", 'ALLOW'],
    ["matches() [\\a] rejects literal a", "'a'.matches('[\\\\a]')", 'DENY'],
    ["matches() [^\\a] matches literal a", "'a'.matches('[^\\\\a]')", 'ALLOW'],
    ["matches() [^\\a] rejects ASCII bell", "'\\x07'.matches('[^\\\\a]')", 'DENY'],
    ["matches() (?i)\\a matches ASCII bell", "'\\x07'.matches('(?i)\\\\a')", 'ALLOW'],
    ["matches() (?i)\\a rejects literal a and A", "'a'.matches('(?i)\\\\a') || 'A'.matches('(?i)\\\\a')", 'DENY'],
    ["matches() (?i)[\\a] rejects literal a", "'a'.matches('(?i)[\\\\a]')", 'DENY'],
    ["replace() \\a replaces ASCII bell", "'\\x07'.replace('\\\\a', 'X') == 'X'", 'ALLOW'],
    ["replace() \\a leaves literal a untouched", "'a'.replace('\\\\a', 'X') == 'a'", 'ALLOW'],
    ["replace() [\\a] replaces ASCII bell", "'\\x07'.replace('[\\\\a]', 'X') == 'X'", 'ALLOW'],
    ["replace() [\\a] leaves literal a untouched", "'a'.replace('[\\\\a]', 'X') == 'a'", 'ALLOW'],
    ["split() \\a splits on ASCII bell", "'x\\x07y'.split('\\\\a') == ['x', 'y']", 'ALLOW'],
    ["split() \\a does not split on literal a", "'xay'.split('\\\\a') == ['xay']", 'ALLOW'],
    ["split() [\\a] splits on ASCII bell", "'x\\x07y'.split('[\\\\a]') == ['x', 'y']", 'ALLOW'],
    ["split() [\\a] does not split on literal a", "'xay'.split('[\\\\a]') == ['xay']", 'ALLOW'],
  ] as const)('Firestore and Storage: %s', (_label, expr, expected) => {
    expect(evalBoth(expr)).toEqual({ fs: expected, st: expected });
  });

  test.each([
    ["escaped backslash before a (\\\\a) matches literal \\a", "'\\\\a'.matches('\\\\\\\\a')", 'ALLOW'],
    ["escaped backslash before a (\\\\a) rejects bell", "'\\x07'.matches('\\\\\\\\a')", 'DENY'],
    ["escaped backslash before a (\\\\a) rejects bare a", "'a'.matches('\\\\\\\\a')", 'DENY'],
    ["escaped backslash + bell (\\\\\\a) matches \\ + bell", "'\\\\\\x07'.matches('\\\\\\\\\\\\a')", 'ALLOW'],
    ["escaped backslash + bell (\\\\\\a) rejects literal \\a", "'\\\\a'.matches('\\\\\\\\\\\\a')", 'DENY'],
    ["char class [\\\\a] matches backslash and a, rejects bell", "'\\\\'.matches('[\\\\\\\\a]') && 'a'.matches('[\\\\\\\\a]') && !'\\x07'.matches('[\\\\\\\\a]')", 'ALLOW'],
    ["char class [\\\\\\a] matches backslash and bell, rejects a", "'\\\\'.matches('[\\\\\\\\\\\\a]') && '\\x07'.matches('[\\\\\\\\\\\\a]') && !'a'.matches('[\\\\\\\\\\\\a]')", 'ALLOW'],
    ["quoted \\Q\\a\\E matches literal \\a and rejects bell", "'\\\\a'.matches('\\\\Q\\\\a\\\\E') && !'\\x07'.matches('\\\\Q\\\\a\\\\E')", 'ALLOW'],
    ["replace() with \\\\a replaces literal \\a, not bell", "'\\\\a\\x07'.replace('\\\\\\\\a', 'X') == 'X\\x07'", 'ALLOW'],
    ["split() with \\\\a splits literal \\a, not bell", "'p\\\\aq\\x07r'.split('\\\\\\\\a') == ['p', 'q\\x07r']", 'ALLOW'],
  ] as const)('escaped backslash and quoting: %s', (_label, expr, expected) => {
    expect(evalBoth(expr)).toEqual({ fs: expected, st: expected });
  });

  test('character class ranges and Unicode combinations with \\a', () => {
    expect(re2PatternCompiles('[\\a-\\x09]')).toBe(true);
    expect(re2PatternProblem('[\\a-\\x09]')).toBeNull();
    expect(re2FullMatch('[\\a-\\x09]', '\x07')).toBe(true);
    expect(re2FullMatch('[\\a-\\x09]', '\x08')).toBe(true);
    expect(re2FullMatch('[\\a-\\x09]', '\x09')).toBe(true);
    expect(re2FullMatch('[\\a-\\x09]', 'a')).toBe(false);

    expect(re2PatternCompiles('[\\x08-\\a]')).toBe(false);
    expect(re2PatternProblem('[\\x08-\\a]')).not.toBeNull();

    expect(re2PatternCompiles('\\a\\p{L}')).toBe(true);
    expect(re2FullMatch('\\a\\p{L}', '\x07z')).toBe(true);
    expect(re2FullMatch('\\a\\p{L}', 'az')).toBe(false);

    expect(replaceRe2('x\x07y\x08z', '[\\a-\\x08]', '-')).toBe('x-y-z');
    expect(splitRe2('x\x07y\x07z', '\\a+')).toEqual(['x', 'y', 'z']);
  });
});
