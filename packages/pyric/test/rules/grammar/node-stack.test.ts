/**
 * Under Node, the parser reads every nesting production compiles.
 *
 * Node's default stack holds far fewer recursive-descent frames than bun's:
 * before the segmented match (`source-segments.ts`), Node 22.15 exhausted it
 * at 80 parenthesized groups and 66 nested list literals, so `firestoreRules()`
 * threw "The rules source chains more terms than the rules parser reads." on
 * source production compiles. The bun test runner never sees that, so this
 * file runs every probe in one real `node` child against the built `dist`, as
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

/**
 * The one node child compiles every probe in `beforeAll`. At idle (load 0.3 per
 * thread on 32 threads) the hook took 0.55 to 0.63 s; under 64 busy loops on
 * 32 threads it took up to 2.7 s, and under 128 up to 5.0 s, at bun's 5 s
 * default (2026-10-21, WSL2). Before the probes shared one child, each test
 * spawned its own, and one hit that default at 5,012 ms on a CI runner (#1169).
 */
const NODE_PROBES_TIMEOUT_MS = 30_000;

/** The spawn stops the child just before the hook times out, so the error names its signal. */
const NODE_SPAWN_TIMEOUT_MS = NODE_PROBES_TIMEOUT_MS - 2_000;

type FirestoreGroup = 'grouped' | 'at129' | 'andMember' | 'brackets';

/** Every source the tests probe, keyed by the test that reads its result. */
interface Probes {
  /** Compiled and simulated with `firestoreRules()`. */
  firestore: Record<FirestoreGroup, string[]>;
  /** Parsed with `parseStorageRules()`. */
  storage: string[];
  /** `[expression, bad expression, rules file]` for `parseExpression()` and `parseRulesFile()`. */
  parser: [string, string, string];
}

type ParserOutcome = { valid: boolean } | { error: string };

interface Results {
  firestore: Record<FirestoreGroup, Outcome[]>;
  /** Null when the source compiles, else the error message. */
  storage: (string | null)[];
  /** `.valid` of each parser probe, or the message it threw. */
  parser: ParserOutcome[];
}

/**
 * Every probe runs in one node child, so the file pays for one node start
 * and one `dist` import instead of one per test. Each probe still gets its own
 * `firestoreRules()`, `parseStorageRules()` or parser call, as it did when each
 * test spawned its own child.
 */
function runProbes(probes: Probes): Results {
  const script = `
    const { firestoreRules } = await import(${JSON.stringify(pathToFileURL(rulesDist).href)});
    const { parseStorageRules } = await import(${JSON.stringify(pathToFileURL(storageDist).href)});
    const { parseExpression, parseRulesFile } = await import(${JSON.stringify(pathToFileURL(parserDist).href)});
    const probes = JSON.parse(process.argv[1]);
    const compile = (source) => {
      try {
        const summary = firestoreRules(source).simulate([
          { description: 'uid a', expectation: 'ALLOW', method: 'get', path: 'p/d1', auth: { uid: 'a' } },
          { description: 'uid b', expectation: 'DENY', method: 'get', path: 'p/d1', auth: { uid: 'b' } },
        ]);
        return { compiles: true, decisions: summary.cases.map((c) => c.decision) };
      } catch (e) {
        return { compiles: false, message: e.issues?.[0]?.message ?? String(e.message) };
      }
    };
    const parseStorage = (source) => {
      try { parseStorageRules(source); return null; } catch (e) { return String(e.message); }
    };
    const firestore = Object.fromEntries(Object.entries(probes.firestore).map(([group, sources]) => [group, sources.map(compile)]));
    const storage = probes.storage.map(parseStorage);
    const parse = (fn, source) => {
      try { return { valid: fn(source).valid }; } catch (e) { return { error: String(e?.message ?? e) }; }
    };
    const [expr, badExpr, rules] = probes.parser;
    const parser = [parse(parseExpression, expr), parse(parseExpression, badExpr), parse(parseRulesFile, rules)];
    process.stdout.write(JSON.stringify({ firestore, storage, parser }));
  `;
  const res = spawnSync('node', ['--input-type=module', '--eval', script, JSON.stringify(probes)], {
    encoding: 'utf8',
    timeout: NODE_SPAWN_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`node exited ${res.status} (signal ${res.signal}${res.error ? `, ${res.error.message}` : ''}): ${res.stderr}`);
  }
  try {
    return JSON.parse(res.stdout) as Results;
  } catch (e) {
    throw new Error(`node wrote ${Buffer.byteLength(res.stdout)} bytes that are not JSON (${(e as Error).message}): ${res.stdout.slice(0, 200)}`);
  }
}

interface Boundary { service: string; shape: string; largestPass: number | null; smallestFail: number | null }
let boundaries: Boundary[];
function bound(service: string, shape: Shape): Boundary {
  const found = boundaries.find((b) => b.service === service && b.shape === shape);
  if (found === undefined) throw new Error(`no captured boundary for ${service} ${shape} in ${capturesPath}`);
  return found;
}

interface NestingCase { shape: Shape; n: number; pass: boolean; decisions?: string[] }

/** paren-nesting, list-nesting and paren-literal at the largest captured pass and the smallest fail. */
function groupedCases(): NestingCase[] {
  const cases: NestingCase[] = [];
  for (const shape of ['paren-nesting', 'list-nesting'] as const) {
    const b = bound('firestore', shape);
    cases.push({ shape, n: b.largestPass!, pass: true, decisions: ['ALLOW', 'DENY'] });
    cases.push({ shape, n: b.smallestFail!, pass: false });
  }
  // `true` in parentheses grants both uids, as production's probe did.
  const literal = bound('firestore', 'paren-literal');
  cases.push({ shape: 'paren-literal', n: literal.largestPass!, pass: true, decisions: ['ALLOW', 'ALLOW'] });
  cases.push({ shape: 'paren-literal', n: literal.smallestFail!, pass: false });
  return cases;
}

const AT_129_SHAPES = ['map-nesting', 'index-chain', 'call-nesting'] as const;

function andMemberSources(): string[] {
  const andBound = bound('firestore', 'and-nesting');
  const memberBound = bound('firestore', 'member-chain');
  return [
    firestore(probeBlock('and-nesting', andBound.largestPass!)),
    firestore(probeBlock('and-nesting', andBound.smallestFail!)),
    firestore(probeBlock('member-chain', memberBound.largestPass!)),
  ];
}

/** Groups nested 96 deep inside keyword-named index brackets, then syntax errors inside deep brackets. */
function bracketSources(): string[] {
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
  return [valid, mixed, bad50, bad97, bad120, badCall, badPathParen, badPathList];
}

function storageSources(): string[] {
  const b = bound('storage', 'paren-nesting');
  return [storage(probeBlock('paren-nesting', b.largestPass!)), storage(probeBlock('paren-nesting', b.smallestFail!))];
}

function parserSources(): [string, string, string] {
  const expr = `${'('.repeat(97)}${LEAF}${')'.repeat(97)}`;
  const badExpr = `${'('.repeat(97)}request.auth.uid == == 'a'${')'.repeat(97)}`;
  return [expr, badExpr, firestore(probeBlock('paren-nesting', 97))];
}

let results: Results;

beforeAll(() => {
  if (!existsSync(rulesDist)) throw new Error(`dist/rules/index.js missing, run \`bun run build\` first (${rulesDist})`);
  boundaries = (JSON.parse(readFileSync(capturesPath, 'utf8')) as { boundaries: Boundary[] }).boundaries;
  results = runProbes({
    firestore: {
      grouped: groupedCases().map((c) => firestore(probeBlock(c.shape, c.n))),
      at129: AT_129_SHAPES.map((shape) => firestore(probeBlock(shape, bound('firestore', shape).smallestFail!))),
      andMember: andMemberSources(),
      brackets: bracketSources(),
    },
    storage: storageSources(),
    parser: parserSources(),
  });
}, NODE_PROBES_TIMEOUT_MS);

describe('firestoreRules() under node reads every nesting production compiles', () => {
  test('paren-nesting, paren-literal and list-nesting: the largest captured pass compiles with production verdicts, the smallest fail is rejected as too complex', () => {
    const expected = groupedCases().map((c): Outcome => {
      if (c.pass) return { compiles: true, decisions: c.decisions };
      return { compiles: false, message: NESTING_MESSAGE };
    });
    expect(results.firestore.grouped).toEqual(expected);
  });

  test('map-nesting, index-chain and call-nesting at production\'s captured failure (129) are rejected as too complex', () => {
    expect(results.firestore.at129).toEqual(AT_129_SHAPES.map(() => ({ compiles: false, message: NESTING_MESSAGE })));
  });

  test('and-nesting (49 / 50) and member-chain (100) match production under node', () => {
    expect(results.firestore.andMember).toEqual([
      { compiles: true, decisions: ['ALLOW', 'DENY'] },
      { compiles: false, message: NESTING_MESSAGE },
      { compiles: true, decisions: ['ALLOW', 'DENY'] },
    ]);
  });

  test('groups nested 96 deep inside keyword-named index brackets compile and deny the attacker read, while syntax errors inside deep brackets fail closed', () => {
    const outcomes = results.firestore.brackets;
    expect(outcomes).toHaveLength(8);
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
    const [pass, fail] = results.storage;
    expect(pass).toBeNull();
    expect(fail).toContain(NESTING_MESSAGE);
  });
});

describe('parseExpression() and parseRulesFile() under node', () => {
  test('read 97 nested groups and reject a syntax error inside them', () => {
    expect(results.parser).toEqual([{ valid: true }, { valid: false }, { valid: true }]);
  });
});
