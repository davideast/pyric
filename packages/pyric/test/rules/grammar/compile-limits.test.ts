import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import {
  CALL_DEPTH_LIMIT,
  LET_LIMIT,
  NESTING_LEVEL_LIMIT,
  compileLimitViolations,
  nestingViolations,
} from '../../../src/rules/grammar/compile-limits.js';
import { compileLimitProbes } from '../compile-limits-probes.js';

function violations(source: string) {
  const ast = parseToAST(source);
  if (!ast) throw new Error('probe source did not parse');
  return compileLimitViolations(ast);
}

function firestore(block: string): string {
  return `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n  }\n}\n`;
}

function condition(expr: string): number {
  const ast = parseToAST(firestore(`    match /p/{d} { allow read: if ${expr}; }`));
  return nestingViolations(ast!.service.match.children[0]!.allows[0]!.condition);
}

describe('compile limits: every Rules Test API probe', () => {
  test('a bare literal compiles in 98 parentheses and is rejected in 99, one level past a comparison', () => {
    const literal = compileLimitProbes().filter((p) => p.shape === 'paren-literal');
    expect(literal.map((p) => [p.n, p.compiles])).toEqual([[98, true], [99, false]]);
  });

  test('the thresholds are the captured boundaries', () => {
    expect([CALL_DEPTH_LIMIT, LET_LIMIT, NESTING_LEVEL_LIMIT]).toEqual([21, 11, 99]);
  });

  // Production's ERROR issues for each probe, verbatim and in order: the
  // messages, the call stacks they name, and how many nesting issues it
  // reports.
  for (const probe of compileLimitProbes()) {
    test(`${probe.label}: ${probe.compiles ? 'compiles' : 'rejected'} with production's errors`, () => {
      expect(violations(probe.source).map((v) => v.message)).toEqual(probe.modeledErrors);
      expect(probe.errors.length === 0).toBe(probe.compiles);
    });
  }

  test('a slash directly followed by a digit is rejected as a path; one followed by a space divides', () => {
    const slash = compileLimitProbes().filter((p) => p.shape === 'slash-divisor');
    expect(slash.map((p) => [p.service, p.n, p.compiles])).toEqual([
      ['firestore', 0, false], ['firestore', 1, true], ['storage', 0, false], ['storage', 1, true],
    ]);
    expect(slash.find((p) => !p.compiles)!.errors).toEqual([
      "Missing 'match' keyword before path.",
      "Unexpected '/2'.",
      "mismatched input ')' expecting {'{', '/', PATH_SEGMENT}",
    ]);
  });

  test('a call-depth rejection is on the line of the 22nd function, where production reports it', () => {
    const probe = compileLimitProbes().find((p) => p.service === 'firestore' && p.shape === 'call-depth' && p.range)!;
    expect(violations(probe.source).map((v) => v.line)).toEqual([271, 296, 322]);
  });

  test('a second recursive wildcard is rejected on the line of the declaration that holds it', () => {
    for (const shape of ['glob-in-path', 'glob-nested'] as const) {
      const probe = compileLimitProbes().find((p) => p.service === 'firestore' && p.shape === shape && !p.compiles)!;
      expect(violations(probe.source).map((v) => v.line)).toEqual(probe.errorPositions.map((p) => p![0]));
    }
  });

  test('a recursive wildcard counts across every enclosing declaration path', () => {
    const lines = (block: string) => violations(firestore(block)).filter((v) => v.code === 'GLOB_MATCH_COUNT').map((v) => v.line);
    expect(lines('    match /{a=**}/x/{b} {\n      match /y/{c} {\n        match /{d=**} { allow read: if true; }\n      }\n    }')).toEqual([6]);
    expect(lines('    match /{a=**}/x/{b=**}/y/{c=**} { allow read: if true; }')).toEqual([4]);
    expect(lines('    match /x/{a} {\n      match /{b=**} { allow read: if true; }\n    }\n    match /{c=**} { allow read: if true; }')).toEqual([]);
  });

  test('a let-count rejection is at the return expression, where production reports it', () => {
    for (const service of ['firestore', 'storage'] as const) {
      const probe = compileLimitProbes().find((p) => p.service === service && p.shape === 'let-count' && !p.compiles)!;
      expect(probe.errorPositions).toEqual([[18, 16]]);
      expect(violations(probe.source).map((v) => [v.line, v.column])).toEqual(probe.errorPositions);
    }
  });
});

describe('compile limits: a slash that starts a path', () => {
  // Production's verdicts on these conditions, from Rules Test API probes:
  // every slash directly followed by a character other than whitespace is
  // rejected, and whitespace after the slash, a newline included, divides.
  const rejected = ['(1/0) == 1', '4/2 == 2', 'request.resource.data.a/request.resource.data.z == 1', '(4/(2)) == 2', '(4/-2) == -2', 't(1/0)'];
  const compiles = ['(1 / 0) == 1', '(4/ 2) == 2', '(4/\n2) == 2', '(4/\t2) == 2', '(1%0) == 1'];
  const ruleset = (cond: string) => firestore(`    function t(a) { return true; }\n    match /c/{id} { allow create: if ${cond}; }`);

  for (const cond of rejected) {
    test(`${JSON.stringify(cond)} is rejected`, () => {
      expect(violations(ruleset(cond)).map((v) => [v.code, v.message])).toEqual([['SLASH_STARTS_PATH', "Missing 'match' keyword before path."]]);
    });
  }
  for (const cond of compiles) {
    test(`${JSON.stringify(cond)} compiles`, () => {
      expect(violations(ruleset(cond))).toEqual([]);
    });
  }
});

describe('compile limits: shapes the capture does not measure', () => {
  test('a recursive function has no bounded depth and is rejected as a stack over the limit', () => {
    const v = violations(firestore(`    function loop() { return loop(); }\n    match /p/{d} { allow read: if loop(); }`));
    expect(v.map((x) => x.code)).toEqual(['CALL_DEPTH']);
    expect(v[0]!.message).toBe(`Maximum allowed call depth of 20 is reached for [${Array(21).fill('loop').join('->')}] call stack.`);
  });

  test('mutual recursion no rule calls is rejected too', () => {
    const v = violations(firestore(`    function a() { return b(); }\n    function b() { return a(); }\n    match /p/{d} { allow read: if true; }`));
    expect(v.map((x) => x.code)).toEqual(['CALL_DEPTH']);
  });

  test('a call resolves by declaration scope, not by name across the ruleset', () => {
    const chain = (prefix: string, last: string) => Array.from({ length: 12 }, (_, i) =>
      `      function ${prefix}${i + 1}() { return ${i === 11 ? last : `${prefix}${i + 2}()`}; }`).join('\n');
    // Block /a: g1..g12, and g12 calls the h1 that /a declares, 13 functions.
    // Block /b declares its own chain h1..h12. Joined by name, g1..g12 and
    // h1..h12 would be 24 functions on one stack.
    const source = firestore([
      `    match /a/{d} {\n${chain('g', 'h1()')}\n      function h1() { return true; }\n      allow read: if g1();\n    }`,
      `    match /b/{d} {\n${chain('h', 'true')}\n      allow read: if h1();\n    }`,
    ].join('\n'));
    expect(violations(source)).toEqual([]);
  });

  test('!, a ternary and a method call add no level; a comparison, a list and a function call do', () => {
    const deep = `${'('.repeat(97)}request.auth.uid == 'a'${')'.repeat(97)}`;
    expect(condition(`!${deep}`)).toBe(0);
    expect(condition(`true ? ${deep} : false`)).toBe(0);
    expect(condition(`'x'.matches(${deep})`)).toBe(0);
    // The list puts its element one level deeper, so the comparison reaches level 100.
    expect(condition(`[${deep}].size() > 0`)).toBe(1);
    expect(condition(`string(${deep}) == 'true'`)).toBe(1);
  });
});
