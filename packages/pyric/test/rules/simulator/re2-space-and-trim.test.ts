import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

/**
 * Replays of two Firestore Rules Test API captures from 2026-10-27
 * (scenarios `re2-pattern-semantics` and `split-and-trim-edges`, project
 * digame-mas). Each guard is a rules expression, and each expected verdict is
 * production's answer for it.
 *
 * - `matches()` compiles RE2, where `\s` is `[\t\n\f\r ]`: no NBSP, em
 *   space or vertical tab, whether the character comes from a literal or
 *   from request data.
 * - `trim()` strips every code unit at or below U+0020 (C0 controls and
 *   space) from both ends, and keeps NBSP, U+3000 and the byte-order mark.
 */
const sim = new SimulateFirestoreRulesHandler();

type Capture = {
  readonly description: string;
  readonly guard: string;
  readonly production: 'ALLOW' | 'DENY';
  readonly data?: Record<string, unknown>;
};

function verdictOf(capture: Capture): string {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow get: if ${capture.guard};
    }
  }
}`;
  const testCase: TestCase = { description: capture.description, expectation: 'ALLOW', method: 'get', path: 'c/1' };
  if (capture.data) testCase.data = capture.data;
  const res = sim.simulate(rules, [testCase]);
  if (!res.success) return `ERROR:${res.error.code}`;
  return res.data.results[0]?.decision ?? 'NONE';
}

const re2Space: readonly Capture[] = [
  { description: 'NBSP is not \\s', guard: "!'\\u00a0'.matches('\\\\s')", production: 'ALLOW' },
  { description: 'em space is not \\s', guard: "!'\\u2003'.matches('\\\\s')", production: 'ALLOW' },
  { description: 'vertical tab is not \\s', guard: "!'\\u000b'.matches('\\\\s')", production: 'ALLOW' },
  {
    description: 'NBSP counts as a non-space char',
    guard: "'a b\\u00a0c'.matches('[^\\\\s]+ [^\\\\s]+')",
    production: 'ALLOW',
  },
  { description: 'space is \\s (control)', guard: "'a b'.matches('a\\\\sb')", production: 'ALLOW' },
  {
    description: 'real nbsp from data is not \\s',
    guard: "!request.resource.data.nbsp.matches('\\\\s')",
    production: 'ALLOW',
    data: { nbsp: ' ' },
  },
];

const trim: readonly Capture[] = [
  { description: 'trim keeps NBSP', guard: "'\\u00a0'.trim().size() == 1", production: 'ALLOW' },
  { description: 'trim keeps ideographic space', guard: "'\\u3000a'.trim() == '\\u3000a'", production: 'ALLOW' },
  { description: 'trim strips C0 controls', guard: "'\\u0001a\\u001f'.trim() == 'a'", production: 'ALLOW' },
  { description: 'trim keeps BOM', guard: "'\\ufeffa'.trim() == '\\ufeffa'", production: 'ALLOW' },
  { description: 'trim strips space tab newline (control)', guard: "' \\ta\\n '.trim() == 'a'", production: 'ALLOW' },
];

describe('FS2-SIM-5a: matches() reads \\s as RE2 ASCII whitespace', () => {
  for (const capture of re2Space) {
    test(capture.description, () => {
      expect(verdictOf(capture)).toBe(capture.production);
    });
  }
});

/**
 * `\S` and `\s` inside a class, read from RE2's syntax reference
 * (https://github.com/google/re2/wiki/Syntax: `\s` is `[\t\n\f\r ]`, `\S`
 * its complement) rather than from a capture. `[\S\@]` takes the code-unit
 * fallback, because `\@` is not a valid escape under the `u` flag.
 */
const re2NonSpace: readonly Capture[] = [
  { description: 'NBSP is \\S', guard: "'\\u00a0'.matches('\\\\S')", production: 'ALLOW' },
  { description: 'vertical tab is [\\S]', guard: "'\\u000b'.matches('[\\\\S]')", production: 'ALLOW' },
  { description: 'space is not [\\S]', guard: "!' '.matches('[\\\\S]')", production: 'ALLOW' },
  { description: 'an astral character is [\\S]', guard: "'\u{1F600}'.matches('[\\\\S]')", production: 'ALLOW' },
  { description: 'em space is [\\S\\@] in the fallback', guard: "'\\u2003'.matches('[\\\\S\\\\@]')", production: 'ALLOW' },
  { description: 'tab is not [\\S\\@] in the fallback', guard: "!'\\t'.matches('[\\\\S\\\\@]')", production: 'ALLOW' },
  { description: 'em space is not [\\s\\@] in the fallback', guard: "!'\\u2003'.matches('[\\\\s\\\\@]')", production: 'ALLOW' },
];

describe('FS2-SIM-5a: \\S and class members follow RE2', () => {
  for (const capture of re2NonSpace) {
    test(capture.description, () => {
      expect(verdictOf(capture)).toBe(capture.production);
    });
  }
});

describe('FS2-SIM-8: trim() strips what production strips', () => {
  for (const capture of trim) {
    test(capture.description, () => {
      expect(verdictOf(capture)).toBe(capture.production);
    });
  }
});
