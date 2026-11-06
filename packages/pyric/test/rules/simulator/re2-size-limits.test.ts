/**
 * Firestore and Storage refuse a regex that expands past pyric's matcher
 * state limit instead of building a matcher that exhausts memory (#1264).
 * A literal is refused at compile with production's refusal text and a
 * sentence naming pyric's limit. A pattern from request data is an
 * evaluation error, which `|| true` absorbs and which denies on its own.
 * `a{1001}` is refused by RE2's repeat cap (ST-H3-10).
 *
 * The character-position limit RTDB takes from its deploy captures (#1261)
 * does not apply here: production compiles Firestore patterns that expand
 * to 11,000 and 100,000 characters (#1897). Firestore also refuses a source
 * of 262,144 bytes or more with production's message (#1899). Both come
 * from the 2026-11-03 hunt captures in
 * `test/rules/grammar/fixtures/size-limits/captures.json`, replayed through
 * `setRules` in the in-process sandbox.
 *
 * Each refusal is bounded in time and heap, so a regression fails here
 * instead of killing the runner.
 */
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../../src/rules/api/firestore.js';
import { RulesCompileError } from '../../../src/rules/api/errors.js';
import { lint } from '../../../src/rules/api/lint.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { simulateDeployedRules } from '../../../src/firestore/sandbox/rules-simulator.js';
import type { TestCase } from '../../../src/rules/test/spec.js';
import { compileStorageRules } from '../../../src/storage/rules-resolution.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { scenario as firestoreRe2Scenario } from '../../../../conformance/rules-corpus/firestore/re2-pattern-semantics.ts';
import { scenario as storageRe2Scenario } from '../../../../conformance/rules-corpus/storage/h1-regex-re2-classes.ts';
import { initializeSandbox } from 'pyric/sandbox';
import { inspect, setRules } from 'pyric/sandbox/firestore';
import { doc, getDoc, getFirestore } from 'pyric/firestore';

const NESTED = '((a{1000}){1000}){1000}';
const OVER_REPEAT_CAP = 'a{1001}';
const CONTROLS = ['a{1000}', '(a{100}){100}', '(?<x>a)'];

const LIMIT_SENTENCE =
  "pyric refuses patterns that expand past 200,000 matcher states, a limit of pyric; " +
  "production's limit has not been measured.";

function invalid(pattern: string): string {
  return `Invalid regular expression pattern. Pattern: ${pattern}.`;
}

const TIME_BOUND_MS = 2000;
const HEAP_BOUND_BYTES = 100 * 1024 * 1024;

/** Run `work` and fail when it takes over two seconds or grows the heap past 100 MB. */
function bounded<T>(work: () => T): T {
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = work();
  expect(performance.now() - started).toBeLessThan(TIME_BOUND_MS);
  expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(HEAP_BOUND_BYTES);
  return result;
}

function firestoreSource(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /p/{id} { allow read, create: if ${condition}; }
  }
}`;
}

function storageSource(condition: string): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read: if ${condition}; }
  }
}`;
}

function firestoreCompileMessages(source: string): string[] {
  try {
    firestoreRules(source);
  } catch (e) {
    if (e instanceof RulesCompileError) return e.issues.map((i) => i.message);
    throw e;
  }
  return [];
}

function storageCompileMessage(source: string): string | null {
  try {
    compileStorageRules(source);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('Firestore: regex literals past the size limit (#1264)', () => {
  const source = firestoreSource(`'a'.matches('${NESTED}')`);
  const message = `${invalid(NESTED)} ${LIMIT_SENTENCE}`;

  test('firestoreRules() refuses the nested repeat with the limit message', () => {
    expect(bounded(() => firestoreCompileMessages(source))).toContain(message);
  });

  test('lint() reports it as INVALID_REGEX_PATTERN', () => {
    const issues = bounded(() => lint(source));
    expect(issues.some((i) => i.code === 'INVALID_REGEX_PATTERN' && i.message === message)).toBe(true);
  });

  test('simulate() refuses the ruleset', () => {
    const result = bounded(() => new SimulateFirestoreRulesHandler().simulate(source, [
      { description: 'read', expectation: 'DENY', method: 'get', path: 'p/d1' } as TestCase,
    ]));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain(message);
  });

  test('a{1001} is refused at compile (ST-H3-10)', () => {
    const messages = bounded(() => firestoreCompileMessages(firestoreSource(`'a'.matches('${OVER_REPEAT_CAP}')`)));
    expect(messages).toContain(invalid(OVER_REPEAT_CAP));
  });

  for (const pattern of CONTROLS) {
    test(`${pattern} still compiles`, () => {
      expect(bounded(() => firestoreCompileMessages(firestoreSource(`'a'.matches('${pattern}')`)))).toEqual([]);
    });
  }

  test('every pattern in the RE2 semantics scenario still compiles', () => {
    expect(firestoreCompileMessages(firestoreRe2Scenario.rules)).toEqual([]);
  });
});

describe('Firestore: a pattern from request data past the size limit (#1264)', () => {
  function create(condition: string, expectation: 'ALLOW' | 'DENY'): { source: string; cases: TestCase[] } {
    return {
      source: firestoreSource(condition),
      cases: [{
        description: condition,
        expectation,
        method: 'create',
        path: 'p/d1',
        data: { p: NESTED },
      } as TestCase],
    };
  }

  const absorbed = create("'a'.matches(request.resource.data.p) || true", 'ALLOW');
  const alone = create("'a'.matches(request.resource.data.p)", 'DENY');

  for (const { source, cases } of [absorbed, alone]) {
    const expected = cases[0]!.expectation;
    test(`simulate(): ${cases[0]!.description} is ${expected}`, () => {
      const summary = bounded(() => firestoreRules(source).simulate(cases));
      expect(summary.cases.map((c) => c.decision)).toEqual([expected]);
    });

    test(`the in-page sandbox: ${cases[0]!.description} is ${expected}`, () => {
      const result = bounded(() =>
        simulateDeployedRules(new RulesState(source), new SimulateFirestoreRulesHandler(), cases, {}));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.results.map((r) => r.decision)).toEqual([expected]);
    });
  }

  test('split() and replace() refuse it too', () => {
    const split = create("'a'.split(request.resource.data.p).size() == 1 || true", 'ALLOW');
    const replace = create("'a'.replace(request.resource.data.p, 'b') == 'a'", 'DENY');
    for (const { source, cases } of [split, replace]) {
      const summary = bounded(() => firestoreRules(source).simulate(cases));
      expect(summary.cases.map((c) => c.decision)).toEqual([cases[0]!.expectation]);
    }
  });
});

describe('Storage: regex literals past the size limit (#1264)', () => {
  test('compileStorageRules() refuses the nested repeat with the limit message', () => {
    const message = bounded(() => storageCompileMessage(storageSource(`'a'.matches('${NESTED}')`)));
    expect(message).toBe(`Storage rules do not compile: ${invalid(NESTED)} ${LIMIT_SENTENCE}`);
  });

  test('a{1001} is refused at compile (ST-H3-10)', () => {
    const message = bounded(() => storageCompileMessage(storageSource(`'a'.matches('${OVER_REPEAT_CAP}')`)));
    expect(message).toBe(`Storage rules do not compile: ${invalid(OVER_REPEAT_CAP)}`);
  });

  for (const pattern of CONTROLS) {
    test(`${pattern} still compiles`, () => {
      expect(bounded(() => storageCompileMessage(storageSource(`'a'.matches('${pattern}')`)))).toBeNull();
    });
  }

  test('every pattern in the RE2 classes scenario still compiles', () => {
    expect(storageCompileMessage(storageRe2Scenario.rules)).toBeNull();
  });
});

describe('Storage: a pattern from request data past the size limit (#1264)', () => {
  function allowed(condition: string): boolean {
    const { rules } = compileStorageRules(storageSource(condition));
    return evaluateStorageRules(rules, {
      request: { auth: null, method: 'get', path: '/b/bucket/o/file.txt' },
      resource: { size: 1, metadata: { p: NESTED } },
    }).allowed;
  }

  test('an error that || true absorbs', () => {
    expect(bounded(() => allowed("'a'.matches(resource.metadata.p) || true"))).toBe(true);
  });

  test('an error that denies on its own', () => {
    expect(bounded(() => allowed("'a'.matches(resource.metadata.p)"))).toBe(false);
  });
});

interface Probe {
  name: string;
  source?: string;
  sourceTemplate?: string;
  comment?: { placeholder: string; character: string; repeat: number };
  sourceBytes?: number;
  sourceSha256?: string;
  compiles: boolean;
  error?: { code: number; message: string; status: string };
  cases?: Array<{ description: string; method: string; path: string; decision: string }>;
}

const fixture = JSON.parse(
  readFileSync(new URL('../grammar/fixtures/size-limits/captures.json', import.meta.url), 'utf8'),
) as { probes: Probe[] };

function probe(name: string): Probe {
  const found = fixture.probes.find((p) => p.name === name);
  if (found === undefined) throw new Error(`no probe ${name}`);
  return found;
}

/** The source the probe sent, rebuilt from its template when it stores one. */
function sourceOf(p: Probe): string {
  if (p.source !== undefined) return p.source;
  const { placeholder, character, repeat } = p.comment!;
  return p.sourceTemplate!.replace(placeholder, character.repeat(repeat));
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Load `source` through `setRules`, then read `path` as the capture's get case did. */
async function load(source: string, path: string): Promise<{ rejection: string | undefined; read: string }> {
  const sandbox = initializeSandbox({});
  setRules(sandbox, source);
  const refusal = inspect(sandbox).rules.lint.findings.find((f) => f.rule === 'PARSE_ERROR' || f.rule === 'COMPILE_LIMIT');
  let read = 'ok';
  try {
    await getDoc(doc(getFirestore(sandbox.withAuth({ uid: 'u' })), path));
  } catch (err) {
    read = (err as { code?: string }).code ?? String(err);
  }
  return { rejection: refusal?.message, read };
}

const LONG_PATTERN_PROBES = ['k5-regex-11000', 'k6-regex-10001', 'k7-regex-control', 'k8-split-11000', 'k9-regex-100k'];

describe('Firestore compiles the long counted patterns production compiles (#1897)', () => {
  for (const name of LONG_PATTERN_PROBES) {
    const p = probe(name);
    const captured = p.cases![0]!;

    test(`${name}: loads through setRules and getDoc is ${captured.decision}`, async () => {
      expect(captured.decision).toBe('ALLOW');
      const { rejection, read } = await load(sourceOf(p), captured.path);
      expect(rejection).toBeUndefined();
      expect(read).toBe('ok');
    });

    test(`${name}: firestoreRules() compiles it and simulate() allows the captured case`, () => {
      const summary = bounded(() => firestoreRules(sourceOf(p)).simulate([
        { description: captured.description, expectation: 'ALLOW', method: 'get', path: captured.path } as TestCase,
      ]));
      expect(summary.cases.map((c) => c.decision)).toEqual(['ALLOW']);
    });
  }

  test('(a{1000}){11} matches 11,000 a and not 10,999', () => {
    const source = firestoreSource("request.resource.data.s.matches('(a{1000}){11}')");
    const cases = [11000, 10999].map((n) => ({
      description: `${n} a`,
      expectation: n === 11000 ? 'ALLOW' : 'DENY',
      method: 'create',
      path: 'p/d1',
      data: { s: 'a'.repeat(n) },
    } as TestCase));
    const summary = bounded(() => firestoreRules(source).simulate(cases));
    expect(summary.cases.map((c) => c.decision)).toEqual(['ALLOW', 'DENY']);
  });
});

describe('Firestore refuses a source of 262,144 bytes or more (#1899)', () => {
  const refused = probe('c5j-source-300k-comment');
  const control = probe('c5k-source-200k-comment');
  const reason = refused.error!.message;

  test('the probes rebuild the sources the capture sent', () => {
    for (const p of [refused, control]) {
      expect(utf8Bytes(sourceOf(p))).toBe(p.sourceBytes!);
      expect(createHash('sha256').update(sourceOf(p), 'utf8').digest('hex')).toBe(p.sourceSha256!);
    }
    expect(refused.error).toEqual({
      code: 400,
      message: 'Total size of sources must be smaller than 262144.',
      status: 'INVALID_ARGUMENT',
    });
  });

  test("c5j: setRules reports production's message and getDoc is denied", async () => {
    const { rejection, read } = await load(sourceOf(refused), 'c/1');
    expect(rejection).toBe(`Firestore rules did not compile: ${reason}`);
    expect(read).toBe('permission-denied');
  });

  test("c5j: firestoreRules() refuses it with production's message", () => {
    expect(bounded(() => firestoreCompileMessages(sourceOf(refused)))).toEqual([reason]);
  });

  test('c5k: the 200 KB control loads and getDoc is allowed', async () => {
    expect(control.cases!.map((c) => c.decision)).toEqual(['ALLOW']);
    const { rejection, read } = await load(sourceOf(control), 'c/1');
    expect(rejection).toBeUndefined();
    expect(read).toBe('ok');
  });

  /** The c5 source with a comment body of `character` that brings it to `bytes` UTF-8 bytes. */
  function sourceOfBytes(bytes: number, character = 'x'): string {
    const template = refused.sourceTemplate!;
    const fixed = utf8Bytes(template.replace(refused.comment!.placeholder, ''));
    const source = template.replace(refused.comment!.placeholder, character.repeat((bytes - fixed) / utf8Bytes(character)));
    expect(utf8Bytes(source)).toBe(bytes);
    return source;
  }

  // The boundary is inferred from production's message ("smaller than
  // 262144"); the captures sent 300,145 and 200,145 bytes, not 262,144.
  test('262,143 bytes compiles and 262,144 is refused, the boundary production\'s message implies', () => {
    expect(firestoreCompileMessages(sourceOfBytes(262_143))).toEqual([]);
    expect(firestoreCompileMessages(sourceOfBytes(262_144))).toEqual([reason]);
  });

  // pyric counts UTF-8 bytes, as the issue states the limit; no capture
  // sent a source with characters past ASCII.
  test('a source of 262,145 UTF-8 bytes in far fewer characters is refused', () => {
    const source = sourceOfBytes(262_145, 'é');
    expect(source.length).toBeLessThan(200_000);
    expect(firestoreCompileMessages(source)).toEqual([reason]);
  });

  /** The SOURCE_SIZE messages `lint()` reports for `source`. */
  function lintSizeMessages(source: string): string[] {
    return lint(source).filter((i) => i.code === 'SOURCE_SIZE').map((i) => i.message);
  }

  const agreement: Array<[string, () => string, boolean]> = [
    ['262,143 ASCII bytes', () => sourceOfBytes(262_143), false],
    ['262,144 ASCII bytes', () => sourceOfBytes(262_144), true],
    ['262,143 bytes of two-byte characters', () => sourceOfBytes(262_143, 'é'), false],
    ['262,145 bytes of two-byte characters', () => sourceOfBytes(262_145, 'é'), true],
  ];
  for (const [label, build, refusedAtLoad] of agreement) {
    test(`lint() and the loader agree on ${label}`, () => {
      const source = build();
      const expected = refusedAtLoad ? [reason] : [];
      expect(firestoreCompileMessages(source)).toEqual(expected);
      expect(lintSizeMessages(source)).toEqual(expected);
    });
  }
});
