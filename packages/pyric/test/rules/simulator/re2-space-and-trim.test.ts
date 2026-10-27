import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

/**
 * Replays of two Firestore Rules Test API captures from 2026-10-27, committed
 * as `packages/conformance/observations/firestore-rules/rules-firestore-re2-pattern-semantics.json`
 * and `rules-firestore-split-and-trim-edges.json` (rows firestore-rules#199
 * and #202). Each guard is the rules expression from the corpus scenario, and
 * each expected verdict is read from the observation by its case name.
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

const OBSERVATIONS = join(import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations', 'firestore-rules');

/** Production's verdict for one case of a committed observation. */
function captured(scenario: string) {
  const observation = JSON.parse(
    readFileSync(join(OBSERVATIONS, `rules-firestore-${scenario}.json`), 'utf8'),
  ) as { behavior: Record<string, 'ALLOW' | 'DENY'> };
  return (description: string): 'ALLOW' | 'DENY' => {
    const verdict = observation.behavior[description];
    if (verdict === undefined) throw new Error(`rules-firestore-${scenario} has no case "${description}"`);
    return verdict;
  };
}

const re2Capture = captured('re2-pattern-semantics');
const trimCapture = captured('split-and-trim-edges');

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
  { description: 'NBSP is not \\s', guard: "!'\\u00a0'.matches('\\\\s')", production: re2Capture('NBSP is not \\s') },
  { description: 'em space is not \\s', guard: "!'\\u2003'.matches('\\\\s')", production: re2Capture('em space is not \\s') },
  { description: 'vertical tab is not \\s', guard: "!'\\u000b'.matches('\\\\s')", production: re2Capture('vertical tab is not \\s') },
  {
    description: 'NBSP counts as a non-space char',
    guard: "'a b\\u00a0c'.matches('[^\\\\s]+ [^\\\\s]+')",
    production: re2Capture('NBSP counts as a non-space char'),
  },
  { description: 'space is \\s (control)', guard: "'a b'.matches('a\\\\sb')", production: re2Capture('space is \\s (control)') },
  {
    description: 'real nbsp from data is not \\s',
    guard: "!request.resource.data.nbsp.matches('\\\\s')",
    production: re2Capture('real nbsp from data is not \\s'),
    data: { nbsp: ' ' },
  },
];

const trim: readonly Capture[] = [
  { description: 'trim keeps NBSP', guard: "'\\u00a0'.trim().size() == 1", production: trimCapture('trim keeps NBSP') },
  { description: 'trim keeps ideographic space', guard: "'\\u3000a'.trim() == '\\u3000a'", production: trimCapture('trim keeps ideographic space') },
  { description: 'trim strips C0 controls', guard: "'\\u0001a\\u001f'.trim() == 'a'", production: trimCapture('trim strips C0 controls') },
  { description: 'trim keeps BOM', guard: "'\\ufeffa'.trim() == '\\ufeffa'", production: trimCapture('trim keeps BOM') },
  { description: 'trim strips space tab newline (control)', guard: "' \\ta\\n '.trim() == 'a'", production: trimCapture('trim strips space tab newline (control)') },
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
