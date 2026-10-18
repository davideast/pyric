/**
 * The segmented match (`source-segments.ts`) reads source exactly as the
 * whole match does. Under bun the whole match holds every source here, so it
 * is the oracle: each source is parsed whole and again in segments small
 * enough to cut ordinary brackets, and the two ASTs must agree node for node,
 * with the same positions, completion positions and parenthesized groups.
 * Source the whole match rejects must stay rejected (fail closed).
 *
 * `spliceSegments` is spied on so a segmented parse that quietly fell back to
 * the whole match (because its pieces did not splice) fails the test instead
 * of passing as equal.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mock } from 'bun:test';
import { parseExpression, parseRulesFile, parseToASTOrError } from '../../../src/rules/grammar/FirestoreParser.js';
import * as segments from '../../../src/rules/grammar/source-segments.js';
import { segmentSource } from '../../../src/rules/grammar/source-segments.js';
import { completionPosition, expressionPosition } from '../../../src/rules/grammar/expression-positions.js';
import { parenthesizedGroups } from '../../../src/rules/grammar/paren-groups.js';
import { compileLimitViolations } from '../../../src/rules/grammar/compile-limits.js';
import type { Expression } from '../../../src/rules/grammar/FirestoreAST.js';

/** Larger than any source here nests: the whole match. */
const WHOLE = 10_000;

let splice: Mock<typeof segments.spliceSegments>;
beforeEach(() => {
  splice = spyOn(segments, 'spliceSegments');
});
afterEach(() => {
  splice.mockRestore();
});
/** Splices that failed, each a segmented parse that fell back to the whole match. */
const failedSplices = () => splice.mock.results.filter((r) => r.type === 'return' && r.value === undefined).length;

/** Differences between two parsed values, positions and parenthesized groups included. */
function differences(a: unknown, b: unknown, path = '$', out: string[] = []): string[] {
  if (out.length > 5) return out;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    if (!Object.is(a, b)) out.push(`${path}: ${String(a)} != ${String(b)}`);
    return out;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (JSON.stringify(Array.from(a as Uint8Array)) !== JSON.stringify(Array.from(b as Uint8Array))) out.push(`${path}: bytes differ`);
    return out;
  }
  if (JSON.stringify(expressionPosition(a)) !== JSON.stringify(expressionPosition(b))) out.push(`${path}: position`);
  if (JSON.stringify(completionPosition(a)) !== JSON.stringify(completionPosition(b))) out.push(`${path}: completion`);
  if (parenthesizedGroups(a as Expression) !== parenthesizedGroups(b as Expression)) out.push(`${path}: groups`);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) differences((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, out);
  return out;
}

function rules(body: string): string {
  return `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${body}\n  }\n}\n`;
}

/** Parse whole and in segments at each depth; the segmented ASTs equal the whole one. */
function expectSameParse(source: string, depths: readonly number[] = [2, 3, 4, 5, 8]): void {
  const whole = parseToASTOrError(source, { segmentDepth: WHOLE });
  for (const depth of depths) {
    const before = failedSplices();
    const cut = parseToASTOrError(source, { segmentDepth: depth });
    expect({ depth, ok: cut.ok }).toEqual({ depth, ok: whole.ok });
    if (whole.ok && cut.ok) {
      expect({ depth, diff: differences(whole.ast, cut.ast) }).toEqual({ depth, diff: [] });
      expect(compileLimitViolations(cut.ast)).toEqual(compileLimitViolations(whole.ast));
      expect({ depth, failedSplices: failedSplices() - before }).toEqual({ depth, failedSplices: 0 });
    }
  }
}

// ── Random source ───────────────────────────────────────────────────────

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed: number) {
  const rand = prng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const ws = () => pick(['', '', ' ', ' ', '\n        ', ' /* c */ ', ' // c\n ']);
  const leaf = () => pick([
    'request.auth.uid', 'x', '1', '2.5', "'s'", '"d"', 'true', 'false', 'null', "b'ab'",
    'resource.data.items', '/databases/$(database)/documents/u/$(x)', '/databases/(default)/documents/a',
  ]);
  const expr = (depth: number): string => {
    if (depth <= 0 || rand() < 0.12) return leaf();
    const e = () => expr(depth - 1);
    switch (Math.floor(rand() * 17)) {
      case 0: return `(${ws()}${e()}${ws()})`;
      case 1: return `[${e()},${ws()}${e()}]`;
      case 2: return `{'k':${ws()}${e()}, k2: ${e()}}`;
      case 3: return `f(${e()},${ws()}${e()})`;
      case 4: return `${e()}.m(${ws()}${e()})`;
      case 5: return `${e()}[${ws()}${e()}${ws()}]`;
      case 6: return `${e()}[${e()}:${e()}]`;
      case 7: return `${e()}.p`;
      case 8: return `${e()} ${pick(['&&', '||', '==', '!=', '<', '>=', '+', '-', '*', '%'])}${ws()}${e()}`;
      case 9: return `!${e()}`;
      case 10: return `-${e()}`;
      case 11: return `${e()} ? ${e()} : ${e()}`;
      case 12: return `${e()} in ${e()}`;
      case 13: return `${e()} is string`;
      case 14: return `/databases/$(database)/documents/u/$(${e()})`;
      case 15: return `(${e()} && ${e()})`;
      default: return `g(${e()})`;
    }
  };
  return { expr, rand, pick };
}

function randomRules(seed: number): string {
  const { expr, pick } = generator(seed);
  const d = () => 2 + Math.floor(prng(seed * 7 + 1)() * 6);
  return rules([
    `    function f(a, b) {\n      let v = ${expr(d())};\n      return ${expr(d())};\n    }`,
    `    match /p/{d} {\n      allow ${pick(['read', 'write', 'get, list'])}: if ${expr(d())};`,
    `      allow update: if ${expr(d())};\n    }`,
  ].join('\n'));
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('segmented match: the same AST as the whole match', () => {
  test('every rules file in the corpus', () => {
    const root = join(import.meta.dir, '../corpus');
    let count = 0;
    for (const dir of ['valid', 'edge-cases', 'invalid']) {
      for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.rules'))) {
        expectSameParse(readFileSync(join(root, dir, file), 'utf8'));
        count++;
      }
    }
    expect(count).toBeGreaterThan(40);
  });

  test('400 random rules files mixing every bracket kind, comments and line breaks', () => {
    let segmented = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const source = randomRules(seed);
      if (segmentSource(source.trim(), 3) !== undefined) segmented++;
      expectSameParse(source, [2, 3, 5]);
    }
    // The oracle compares segmented parses, not whole ones twice.
    expect(segmented).toBeGreaterThan(350);
  });

  test('groups, lists, maps, calls and index brackets nested 60 deep', () => {
    const leaf = "request.auth.uid == 'a'";
    for (const [open, close] of [['(', ')'], ['[', ']'], ["{'a': ", '}'], ['f(', ')'], ['x.m(', ')'], ['x[', ']'], ['/a/$(', ')/b']]) {
      expectSameParse(rules(`    match /p/{d} {\n      allow read: if ${open!.repeat(60)}${leaf}${close!.repeat(60)};\n    }`), [4, 24]);
    }
  });

  test('a conjunction inside parentheses around a replaced bracket completes at the outermost parenthesis', () => {
    expectSameParse(rules(`    match /p/{d} {\n      allow read: if ((((a && (b)))));\n    }`), [3, 4, 5, 6, 7]);
  });

  test('a path literal keeps its raw text when an interpolation in it is replaced', () => {
    const source = rules(`    match /p/{d} {\n      allow read: if exists(/databases/$(database)/documents/u/$(((((x))))));\n    }`);
    const cut = parseToASTOrError(source, { segmentDepth: 3 });
    expect(cut.ok).toBe(true);
    expect(JSON.stringify(cut.ok && cut.ast)).toContain('"raw":"/databases/$(database)/documents/u/$(((((x)))))"');
    expectSameParse(source, [3, 4, 5]);
  });

  test('a slice whose brackets are replaced stays a slice', () => {
    expectSameParse(rules(`    match /p/{d} {\n      allow read: if x[((1)):((2))] == x[(((3)))];\n    }`), [3, 4]);
  });
});

describe('segmented match: fails closed', () => {
  // Each source is invalid. A placeholder identifier fits where its bracket
  // does not (a map key, a call's name, a member name, a let name), so the
  // outer text alone would match.
  const invalid = [
    ['a group as a map key', "{ (aaaaaaaaaa): 1 }"],
    ['a group called like a function', '(aaaaaaaaaa)(bbbbbbbbbb)'],
    ['a group as a member name', 'x.(aaaaaaaaaa)'],
    ['a trailing comma in call arguments', 'f(aaaaaaaaaa, bbbbbbbbbb,)'],
    ['a syntax error deep inside', "((((((((a == == 'b'))))))))"],
  ] as const;
  for (const [label, condition] of invalid) {
    test(`${label}: rejected with the whole match's error`, () => {
      const source = rules(`    match /p/{d} {\n      allow read: if ${condition};\n    }`);
      const whole = parseToASTOrError(source, { segmentDepth: WHOLE });
      expect(whole.ok).toBe(false);
      for (const depth of [3, 4, 5]) {
        const cut = parseToASTOrError(source, { segmentDepth: depth });
        expect(cut.ok).toBe(false);
        if (!whole.ok && !cut.ok) expect({ line: cut.error.line, column: cut.error.column }).toEqual({ line: whole.error.line, column: whole.error.column });
      }
    });
  }

  test('an unclosed group wrapping a replaced closed group is rejected', () => {
    const source = rules('    match /p/{d} {\n      allow read: if ((((aaaaaaaaaa)));\n    }');
    for (const depth of [WHOLE, 3, 4, 5]) expect(parseToASTOrError(source, { segmentDepth: depth }).ok).toBe(false);
  });

  test('source holding the placeholder mark is matched whole', () => {
    const source = rules(`    match /p/{d} {\n      allow read: if ((((('\u01C2\u01C20\u01C2')))));\n    }`);
    expect(segmentSource(source.trim(), 3)).toBeUndefined();
    expectSameParse(source, [3]);
  });

  test('random single-character mutations: rejected by the segmented match exactly when the whole match rejects them', () => {
    let rejected = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { rand } = generator(seed * 31);
      const source = randomRules(seed);
      const at = Math.floor(rand() * source.length);
      const mutated = source.slice(0, at) + '()[]{},:.'[Math.floor(rand() * 9)]! + source.slice(at + 1);
      const whole = parseToASTOrError(mutated, { segmentDepth: WHOLE });
      if (!whole.ok) rejected++;
      for (const depth of [2, 3]) {
        const cut = parseToASTOrError(mutated, { segmentDepth: depth });
        expect({ seed, depth, ok: cut.ok }).toEqual({ seed, depth, ok: whole.ok });
      }
    }
    expect(rejected).toBeGreaterThan(100);
  });
});

describe('segmented match: the strict parse entries', () => {
  test('parseExpression and parseRulesFile read 40 nested groups and reject a deep syntax error', () => {
    const deep = `${'('.repeat(40)}a == 'b'${')'.repeat(40)}`;
    expect(parseExpression(deep).valid).toBe(true);
    expect(parseExpression(`${'('.repeat(40)}a == == 'b'${')'.repeat(40)}`).valid).toBe(false);
    expect(parseRulesFile(rules(`    match /p/{d} {\n      allow read: if ${deep};\n    }`)).valid).toBe(true);
    expect(failedSplices()).toBe(0);
  });
});
