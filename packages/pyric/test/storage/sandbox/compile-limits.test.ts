/**
 * The Storage evaluator refuses a ruleset production rejects at compile
 * time, and evaluates one production compiles, for every Storage probe in
 * the Rules Test API compile-limit capture.
 */
import { describe, expect, test } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { compileStorageRules } from '../../../src/storage/rules-resolution.js';
import { compileLimitProbes } from '../../rules/compile-limits-probes.js';

const probes = compileLimitProbes().filter((p) => p.service === 'storage');

function rejection(source: string): string {
  try {
    parseStorageRules(source);
  } catch (e) {
    if (e instanceof SyntaxError) return e.message;
    throw e;
  }
  throw new Error('parseStorageRules accepted the ruleset');
}

describe('Storage evaluator: production compile limits', () => {
  test('the capture holds the rejected shapes and the 21-function control', () => {
    const shapes = new Set(probes.filter((p) => !p.compiles).map((p) => p.shape));
    expect([...shapes].sort()).toEqual(['and-nesting', 'call-depth', 'call-depth-uncalled', 'let-count', 'list-nesting', 'paren-nesting', 'slash-divisor']);
    expect(probes.some((p) => p.shape === 'call-depth' && p.n === 21 && p.compiles && !p.range)).toBe(true);
  });

  for (const probe of probes.filter((p) => !p.compiles)) {
    test(`${probe.label}: parseStorageRules and the install step reject it with production's errors`, () => {
      const message = rejection(probe.source);
      expect(message.startsWith('Storage rules do not compile: ')).toBe(true);
      // Each modeled production error appears as many times as production reports it.
      const errors = probe.modeledErrors;
      for (const error of new Set(errors)) {
        expect(message.split(error).length - 1).toBe(errors.filter((e) => e === error).length);
      }
      expect(() => compileStorageRules(probe.source)).toThrow(probe.errors[0]!);
    });
  }

  for (const probe of probes.filter((p) => p.compiles)) {
    test(`${probe.label}: compiles and evaluates as production does`, () => {
      const rules = parseStorageRules(probe.source);
      const decide = (uid: string) => evaluateStorageRules(rules, {
        request: { auth: { uid }, method: 'get', path: 'b/pyric-default/o/p/o1' },
        resource: null,
      }).allowed;
      expect([decide('a'), decide('b')]).toEqual([true, false]);
    });
  }
});
