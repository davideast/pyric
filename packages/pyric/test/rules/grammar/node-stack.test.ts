/**
 * Under Node, the parser reads every nesting production compiles.
 *
 * Node's default stack holds far fewer recursive-descent frames than bun's:
 * before the segmented match (`source-segments.ts`), Node 22.15 exhausted it
 * at 80 parenthesized groups and 66 nested list literals, so `firestoreRules()`
 * threw "The rules source chains more terms than the rules parser reads." on
 * source production compiles. The bun test runner never sees that, so this
 * file runs each probe in a real `node` child against the built `dist`, as
 * the CLI and published package run it.
 *
 * Evidence: production's limits in
 * `test/rules/linter/fixtures/compile-limits/captures.json` (Rules Test API,
 * 2026-09-27), each probe generated as `probeBlock()` in
 * `packages/conformance/src/capture-rules-compile-limits.ts` generates it:
 * `paren-nesting` n=97 compiles (uid a ALLOW, uid b DENY) and n=98 is
 * rejected with "Expression is too complex to evaluate safely.";
 * `paren-literal` 98 compiles and 99 is rejected; `list-nesting` 97 / 98;
 * `map-nesting`, `index-chain` and `call-nesting` are rejected at 129; Storage
 * `paren-nesting` 97 / 98.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pyricRoot = resolve(import.meta.dir, '../../..');
const rulesDist = join(pyricRoot, 'dist/rules/index.js');
const storageDist = join(pyricRoot, 'dist/storage/index.js');
const parserDist = join(pyricRoot, 'dist/rules/grammar/FirestoreParser.js');
const capturesPath = join(pyricRoot, 'test/rules/linter/fixtures/compile-limits/captures.json');

const NESTING_MESSAGE = 'Expression is too complex to evaluate safely.';
const LEAF = "request.auth.uid == 'a'";

type Shape = 'paren-nesting' | 'paren-literal' | 'list-nesting' | 'map-nesting' | 'index-chain' | 'call-nesting' | 'and-nesting' | 'member-chain';

/** The match block `probeBlock()` generates for `shape` at size `n`. */
function probeBlock(shape: Shape, n: number): string {
  switch (shape) {
    case 'paren-nesting':
      return `    match /p/{d} {\n      allow read: if ${'('.repeat(n)}${LEAF}${')'.repeat(n)};\n    }`;
    case 'paren-literal':
      return `    match /p/{d} {\n      allow read: if ${'('.repeat(n)}true${')'.repeat(n)};\n    }`;
    case 'list-nesting':
      return `    match /p/{d} {\n      allow read: if ${'['.repeat(n)}request.auth.uid${']'.repeat(n)} == ${'['.repeat(n)}'a'${']'.repeat(n)};\n    }`;
    case 'map-nesting':
      return `    match /p/{d} {\n      allow read: if ${"{'a': ".repeat(n)}request.auth.uid${'}'.repeat(n)} == ${"{'a': ".repeat(n)}'a'${'}'.repeat(n)};\n    }`;
    case 'index-chain':
      return `    match /p/{d} {\n      allow read: if ${'['.repeat(n)}request.auth.uid${']'.repeat(n)}${'[0]'.repeat(n)} == 'a';\n    }`;
    case 'call-nesting':
      return `    match /p/{d} {\n      function id(x) { return x; }\n      allow read: if ${'id('.repeat(n)}request.auth.uid${')'.repeat(n)} == 'a';\n    }`;
    case 'and-nesting': {
      let inner = LEAF;
      for (let i = n - 1; i >= 1; i--) inner = `request.auth.uid != 'z${i}' && (${inner})`;
      return `    match /p/{d} {\n      allow read: if ${inner};\n    }`;
    }
    case 'member-chain':
      return `    match /p/{d} {\n      allow read: if ${LEAF} || request.auth.token${'.m'.repeat(n - 3)} == 1;\n    }`;
  }
}

const firestore = (block: string) =>
  `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n  }\n}\n`;
const storage = (block: string) =>
  `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n${block}\n  }\n}\n`;

interface Outcome {
  compiles: boolean;
  /** The first compile issue's message, when the source does not compile. */
  message?: string;
  /** Decisions for uid a and uid b, when it compiles. */
  decisions?: string[];
}

/** Compile and simulate each source with `firestoreRules()` in one node child. */
function runFirestore(sources: string[]): Outcome[] {
  const script = `
    const { firestoreRules } = await import(${JSON.stringify(pathToFileURL(rulesDist).href)});
    const sources = JSON.parse(process.argv[1]);
    const out = sources.map((source) => {
      try {
        const summary = firestoreRules(source).simulate([
          { description: 'uid a', expectation: 'ALLOW', method: 'get', path: 'p/d1', auth: { uid: 'a' } },
          { description: 'uid b', expectation: 'DENY', method: 'get', path: 'p/d1', auth: { uid: 'b' } },
        ]);
        return { compiles: true, decisions: summary.cases.map((c) => c.decision) };
      } catch (e) {
        return { compiles: false, message: e.issues?.[0]?.message ?? String(e.message) };
      }
    });
    process.stdout.write(JSON.stringify(out));
  `;
  return runNode(script, sources);
}

/** Parse each source with `parseStorageRules()` in one node child: null when it compiles, else the error message. */
function runStorage(sources: string[]): (string | null)[] {
  const script = `
    const { parseStorageRules } = await import(${JSON.stringify(pathToFileURL(storageDist).href)});
    const sources = JSON.parse(process.argv[1]);
    const out = sources.map((source) => {
      try { parseStorageRules(source); return null; } catch (e) { return String(e.message); }
    });
    process.stdout.write(JSON.stringify(out));
  `;
  return runNode(script, sources);
}

function runNode<T>(script: string, sources: string[]): T {
  const res = spawnSync('node', ['--input-type=module', '--eval', script, JSON.stringify(sources)], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`node exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout) as T;
}

interface Boundary { service: string; shape: string; largestPass: number | null; smallestFail: number | null }
let boundaries: Boundary[];
function bound(service: string, shape: Shape): Boundary {
  const found = boundaries.find((b) => b.service === service && b.shape === shape);
  if (found === undefined) throw new Error(`no captured boundary for ${service} ${shape}`);
  return found;
}

beforeAll(() => {
  if (!existsSync(rulesDist)) throw new Error(`dist/rules/index.js missing, run \`bun run build\` first (${rulesDist})`);
  boundaries = (JSON.parse(readFileSync(capturesPath, 'utf8')) as { boundaries: Boundary[] }).boundaries;
});

describe('firestoreRules() under node reads every nesting production compiles', () => {
  test('paren-nesting, paren-literal and list-nesting: the largest captured pass compiles with production verdicts, the smallest fail is rejected as too complex', () => {
    const cases: { shape: Shape; n: number; pass: boolean; decisions?: string[] }[] = [];
    for (const shape of ['paren-nesting', 'list-nesting'] as const) {
      const b = bound('firestore', shape);
      cases.push({ shape, n: b.largestPass!, pass: true, decisions: ['ALLOW', 'DENY'] });
      cases.push({ shape, n: b.smallestFail!, pass: false });
    }
    // `true` in parentheses grants both uids, as production's probe did.
    const literal = bound('firestore', 'paren-literal');
    cases.push({ shape: 'paren-literal', n: literal.largestPass!, pass: true, decisions: ['ALLOW', 'ALLOW'] });
    cases.push({ shape: 'paren-literal', n: literal.smallestFail!, pass: false });
    const outcomes = runFirestore(cases.map((c) => firestore(probeBlock(c.shape, c.n))));
    const expected = cases.map((c): Outcome => {
      if (c.pass) return { compiles: true, decisions: c.decisions };
      return { compiles: false, message: NESTING_MESSAGE };
    });
    expect(outcomes).toEqual(expected);
  });

  test('map-nesting, index-chain and call-nesting at production\'s captured failure (129) are rejected as too complex', () => {
    const shapes = ['map-nesting', 'index-chain', 'call-nesting'] as const;
    const outcomes = runFirestore(shapes.map((shape) => firestore(probeBlock(shape, bound('firestore', shape).smallestFail!))));
    expect(outcomes).toEqual(shapes.map(() => ({ compiles: false, message: NESTING_MESSAGE })));
  });

  test('and-nesting (49 / 50) and member-chain (100) match production under node', () => {
    const andBound = bound('firestore', 'and-nesting');
    const memberBound = bound('firestore', 'member-chain');
    const outcomes = runFirestore([
      firestore(probeBlock('and-nesting', andBound.largestPass!)),
      firestore(probeBlock('and-nesting', andBound.smallestFail!)),
      firestore(probeBlock('member-chain', memberBound.largestPass!)),
    ]);
    expect(outcomes).toEqual([
      { compiles: true, decisions: ['ALLOW', 'DENY'] },
      { compiles: false, message: NESTING_MESSAGE },
      { compiles: true, decisions: ['ALLOW', 'DENY'] },
    ]);
  });

  test('groups nested 96 deep inside keyword-named index brackets compile and deny the attacker read, while syntax errors inside deep brackets fail closed', () => {
    // davideast/pyric#1058 follow-up repro: AST level 99, which production compiles.
    const inner = `${'('.repeat(95)}(request.auth.uid == "admin" ? 0 : 0)${')'.repeat(95)}`;
    const valid = firestore(`    match /p/{d} {\n      allow read: if resource.data.in[resource.data.is[${inner}]] == 1;\n    }`);
    const mixed = firestore(`    match /p/{d} {\n      function id(x) { return x; }\n      allow read: if ${'([id('.repeat(32)}${LEAF}${')][0])'.repeat(32)};\n    }`);
    const bad50 = firestore(`    match /p/{d} {\n      allow read: if ${'('.repeat(50)}request.auth.uid == == 'a'${')'.repeat(50)};\n    }`);
    const bad97 = firestore(`    match /p/{d} {\n      allow read: if ${'('.repeat(97)}request.auth.uid == == 'a'${')'.repeat(97)};\n    }`);
    const bad120 = firestore(`    match /p/{d} {\n      allow read: if ${'('.repeat(120)}request.auth.uid == == 'a'${')'.repeat(120)};\n    }`);
    const badCall = firestore(`    match /p/{d} {\n      allow read: if ${'f('.repeat(24)}1 +${')'.repeat(24)};\n    }`);
    const badPathParen = firestore(`    match /p/{d} {\n      allow read: if ${'('.repeat(19)}exists(/databases/(default)/documents/a/ (1 + 2))${')'.repeat(19)};\n    }`);
    const badPathList = firestore(`    match /p/{d} {\n      allow read: if ${'('.repeat(19)}exists(/databases/(default)/documents/a/ [1, 2, 3])${')'.repeat(19)};\n    }`);
    const outcomes = runFirestore([valid, mixed, bad50, bad97, bad120, badCall, badPathParen, badPathList]);
    expect(outcomes[0]).toEqual({ compiles: true, decisions: ['DENY', 'DENY'] });
    expect(outcomes[1]).toEqual({ compiles: true, decisions: ['ALLOW', 'DENY'] });
    for (const bad of outcomes.slice(2)) {
      expect(bad.compiles).toBe(false);
      expect(bad.message).not.toContain('chains more terms');
      expect(bad.message).not.toContain('ǂ');
    }
    expect(outcomes[5]?.message).toContain('Line 5, col 73:');
  });
});

describe('parseStorageRules() under node reads every nesting production compiles', () => {
  test('paren-nesting: the largest captured pass compiles and the smallest fail is rejected as too complex', () => {
    const b = bound('storage', 'paren-nesting');
    const [pass, fail] = runStorage([storage(probeBlock('paren-nesting', b.largestPass!)), storage(probeBlock('paren-nesting', b.smallestFail!))]);
    expect(pass).toBeNull();
    expect(fail).toContain(NESTING_MESSAGE);
  });
});

describe('parseExpression() and parseRulesFile() under node', () => {
  test('read 97 nested groups and reject a syntax error inside them', () => {
    const script = `
      const { parseExpression, parseRulesFile } = await import(${JSON.stringify(pathToFileURL(parserDist).href)});
      const [expr, badExpr, rules] = JSON.parse(process.argv[1]);
      process.stdout.write(JSON.stringify([parseExpression(expr).valid, parseExpression(badExpr).valid, parseRulesFile(rules).valid]));
    `;
    const expr = `${'('.repeat(97)}${LEAF}${')'.repeat(97)}`;
    const badExpr = `${'('.repeat(97)}request.auth.uid == == 'a'${')'.repeat(97)}`;
    expect(runNode<boolean[]>(script, [expr, badExpr, firestore(probeBlock('paren-nesting', 97))])).toEqual([true, false, true]);
  });
});
