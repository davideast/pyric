#!/usr/bin/env bun
/**
 * Capture production Security Rules structural limits: function call depth,
 * `let` bindings per function, and expression nesting depth, for Firestore
 * and Storage rulesets.
 *
 * Every probe submits one generated ruleset to the Rules Test API
 * (`projects.test`), which compiles and evaluates it without deploying it. A
 * ruleset production rejects returns issues and no test results; one it
 * accepts returns a verdict per test case, with any evaluation error in the
 * case's debug messages. The capture records, per probe, whether the ruleset
 * compiled, the verbatim issues with severity and position, and each case's
 * decision.
 *
 * Output: packages/pyric/test/rules/linter/fixtures/compile-limits/captures.json
 *
 * Credentials: the same contract as `capture-rules-expression-cost.ts`:
 * PARITY_SA_BASE64, PARITY_SA_PATH, or a firebase-tools login with
 * PARITY_PROJECT_ID. The caller needs `firebaserules.rulesets.test`.
 *
 * Usage:
 *   PARITY_PROJECT_ID=<project> bun run packages/conformance/src/capture-rules-compile-limits.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectScope } from '../../pyric/src/project-scope.ts';
import type { StorageTestCase, TestCase } from '../../pyric/src/rules/test/spec.ts';
import { REPO_ROOT } from './rules-expression-cost-suites.ts';

const OUT_DIR = join(REPO_ROOT, 'packages', 'pyric', 'test', 'rules', 'linter', 'fixtures', 'compile-limits');
const OUT = join(OUT_DIR, 'captures.json');
const RULES_API = 'https://firebaserules.googleapis.com/v1';

export type Service = 'firestore' | 'storage';
export type Shape = 'call-depth' | 'call-depth-uncalled' | 'let-count' | 'paren-nesting' | 'paren-literal' | 'and-nesting' | 'list-nesting' | 'map-nesting' | 'index-chain' | 'call-nesting' | 'slash-divisor' | 'member-chain' | 'glob-in-path' | 'glob-nested';

const LEAF = "request.auth.uid == 'a'";

/** Wrap a match-block body in the service's document or object scope. */
export function wrap(service: Service, block: string): string {
  return service === 'firestore'
    ? `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n  }\n}\n`
    : `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n${block}\n  }\n}\n`;
}

/** `f1()` calls `f2()` ... calls `fN()`, which reads `request.auth`: N functions on one call stack. */
export function callChain(prefix: string, n: number): string {
  const fns: string[] = [];
  for (let i = 1; i <= n; i++) fns.push(`      function ${prefix}${i}() { return ${i === n ? LEAF : `${prefix}${i + 1}()`}; }`);
  return fns.join('\n');
}

/** Generate the match-block body for one probe shape at size `n`. */
export function probeBlock(shape: Shape, n: number, path = 'p'): string {
  switch (shape) {
    case 'call-depth':
      return `    match /${path}/{d} {\n${callChain('f', n)}\n      allow read: if f1();\n    }`;
    case 'call-depth-uncalled':
      return `    match /${path}/{d} {\n${callChain('f', n)}\n      allow read: if ${LEAF};\n    }`;
    case 'let-count': {
      const lets = Array.from({ length: n }, (_, i) => `        let v${i} = ${i};`).join('\n');
      const reads = Array.from({ length: n }, (_, i) => `v${i} == ${i}`).join(' && ');
      return `    match /${path}/{d} {\n      function g() {\n${lets}\n        return ${LEAF} && ${reads};\n      }\n      allow read: if g();\n    }`;
    }
    case 'paren-nesting':
      // n parenthesis pairs around one comparison.
      return `    match /${path}/{d} {\n      allow read: if ${'('.repeat(n)}${LEAF}${')'.repeat(n)};\n    }`;
    case 'paren-literal':
      // n parenthesis pairs around the bare literal `true`: one level shallower
      // than a comparison. A compiling probe grants both uids.
      return `    match /${path}/{d} {\n      allow read: if ${'('.repeat(n)}true${')'.repeat(n)};\n    }`;
    case 'list-nesting':
      // Two list literals nested n deep, compared: [[...[uid]...]] == [[...['a']...]].
      return `    match /${path}/{d} {\n      allow read: if ${'['.repeat(n)}request.auth.uid${']'.repeat(n)} == ${'['.repeat(n)}'a'${']'.repeat(n)};\n    }`;
    case 'map-nesting':
      // Two map literals nested n deep, compared: {'a': {'a': ... uid ...}} == {'a': ... 'a' ...}.
      return `    match /${path}/{d} {\n      allow read: if ${"{'a': ".repeat(n)}request.auth.uid${'}'.repeat(n)} == ${"{'a': ".repeat(n)}'a'${'}'.repeat(n)};\n    }`;
    case 'index-chain':
      // A list literal nested n deep, read back with n chained index brackets.
      return `    match /${path}/{d} {\n      allow read: if ${'['.repeat(n)}request.auth.uid${']'.repeat(n)}${'[0]'.repeat(n)} == 'a';\n    }`;
    case 'slash-divisor':
      // An int division with n spaces after the slash: (4/2) at n = 0, (4/ 2) at n = 1.
      return `    match /${path}/{d} {\n      allow read: if ${LEAF} && (4/${' '.repeat(n)}2) == 2;\n    }`;
    case 'member-chain':
      // A member chain of n terms, request.auth.token.m.m..., behind a leaf that
      // grants uid a; for uid b the chain evaluates and errors on the missing key.
      return `    match /${path}/{d} {\n      allow read: if ${LEAF} || request.auth.token${'.m'.repeat(n - 3)} == 1;\n    }`;
    case 'call-nesting':
      // n nested calls of one identity function: id(id(... uid ...)) == 'a'.
      return `    match /${path}/{d} {\n      function id(x) { return x; }\n      allow read: if ${'id('.repeat(n)}request.auth.uid${')'.repeat(n)} == 'a';\n    }`;
    case 'glob-in-path':
      // n recursive wildcards in one match path: /{g1=**}/p/{d} at n = 1,
      // /{g1=**}/p/{g2=**} at n = 2.
      return `    match /{g1=**}/${path}/${n === 1 ? '{d}' : '{g2=**}'} {\n      allow read: if ${LEAF};\n    }`;
    case 'glob-nested':
      // n recursive wildcards across a match and the match nested in it:
      // /p/{gid} then /{rest=**} at n = 1, /{g=**}/p/{gid} then /{rest=**} at n = 2.
      return `    match /${n === 1 ? '' : '{g=**}/'}${path}/{gid} {\n      match /{rest=**} {\n        allow read: if ${LEAF};\n      }\n    }`;
    case 'and-nesting': {
      // n terms: t1 && (t2 && (... && (leaf))).
      let inner = LEAF;
      for (let i = n - 1; i >= 1; i--) inner = `request.auth.uid != 'z${i}' && (${inner})`;
      return `    match /${path}/{d} {\n      allow read: if ${inner};\n    }`;
    }
  }
}

export interface ProbeCase { description: string; uid: string; path: string }

export interface Issue { severity: string; description: string; line?: number; column?: number }

export interface ProbeRecord {
  service: Service;
  shape: Shape;
  n: number;
  /** Set on a combined probe: one match block per depth in this range, one case per block. */
  range?: [number, number];
  compiles: boolean;
  /** Verbatim compiler issues, with severity and source position. */
  issues: Issue[];
  cases: { description: string; decision: 'ALLOW' | 'DENY'; notes: string[] }[];
  /**
   * Set when the Rules Test API answered the ruleset with a server error on
   * every attempt, rather than compiling it or reporting issues: the status
   * and the error message verbatim. The ruleset did not compile.
   */
  apiError?: string;
}

interface RunResult { compiles: boolean; issues: Issue[]; results: { decision: 'ALLOW' | 'DENY'; notes: string[] }[]; apiError?: string }
export type Execute = (service: Service, source: string, cases: ProbeCase[]) => Promise<RunResult>;

export async function tools(): Promise<{ run: Execute; projectId: string }> {
  const { parityScope } = await import('../../pyric/test/rules/parity/harness.ts');
  const { buildApiTestCase, buildStorageApiTestCase } = await import('../../pyric/src/rules/test/spec.ts');
  const scope = parityScope() as ProjectScope;
  const run: Execute = async (service, source, cases) => {
    const testCases = service === 'firestore'
      ? cases.map((c) => buildApiTestCase({ description: c.description, expectation: 'ALLOW', method: 'get', path: `${c.path}/d1`, auth: { uid: c.uid } } as TestCase))
      : cases.map((c) => buildStorageApiTestCase({ description: c.description, expectation: 'ALLOW', method: 'get', path: `${c.path}/o1`, auth: { uid: c.uid } } as StorageTestCase));
    const body = JSON.stringify({
      source: { files: [{ name: service === 'firestore' ? 'firestore.rules' : 'storage.rules', content: source }] },
      testSuite: { testCases },
    });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${RULES_API}/projects/${scope.projectId}:test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await scope.resolveToken()}`, 'Content-Type': 'application/json' },
        body,
      });
      // The API answers 500 and 503 transiently; retry those with backoff.
      if ((res.status === 500 || res.status === 503) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      // A server error on the last attempt is the API's answer to this
      // ruleset, recorded with the probe; any other failure stops the capture.
      if (res.status === 500) {
        const error = (await res.json() as { error?: { status?: string; message?: string } }).error;
        return { compiles: false, issues: [], results: [], apiError: `${res.status} ${error?.status ?? ''}: ${error?.message ?? ''}` };
      }
      if (!res.ok) throw new Error(`Rules Test API ${res.status}: ${await res.text()}`);
      const data = await res.json() as {
        issues?: { severity?: string; description: string; sourcePosition?: { line?: number; column?: number } }[];
        testResults?: { state?: string; debugMessages?: string[] }[];
      };
      const issues: Issue[] = (data.issues ?? []).map((i) => ({
        severity: i.severity ?? 'SEVERITY_UNSPECIFIED',
        description: i.description,
        ...(i.sourcePosition?.line !== undefined ? { line: i.sourcePosition.line } : {}),
        ...(i.sourcePosition?.column !== undefined ? { column: i.sourcePosition.column } : {}),
      }));
      const tr = data.testResults ?? [];
      return {
        compiles: tr.length === cases.length,
        issues,
        // Every case expects ALLOW, so SUCCESS means production granted it.
        results: tr.map((r) => ({ decision: r.state === 'SUCCESS' ? 'ALLOW' as const : 'DENY' as const, notes: r.debugMessages ?? [] })),
      };
    }
  };
  return { run, projectId: scope.projectId };
}

const records: ProbeRecord[] = [];
let calls = 0;

function show(rec: ProbeRecord): string {
  if (rec.apiError !== undefined) return `API ERROR ${rec.apiError}`;
  return rec.compiles
    ? `compiles ${rec.cases.map((c) => `${c.description}=${c.decision}${c.notes.length ? ` (${c.notes.join(' | ')})` : ''}`).join(', ')}${rec.issues.length ? ` issues: ${rec.issues.map((i) => `${i.severity} ${i.description}`).join('; ')}` : ''}`
    : `REJECTED ${rec.issues.map((i) => `${i.severity}@${i.line ?? '?'}:${i.column ?? '?'} ${i.description}`).join('; ')}`;
}

async function submit(run: Execute, service: Service, shape: Shape, n: number, source: string, cases: ProbeCase[], range?: [number, number]): Promise<ProbeRecord> {
  calls++;
  const res = await run(service, source, cases);
  const rec: ProbeRecord = {
    service, shape, n,
    ...(range ? { range } : {}),
    compiles: res.compiles,
    issues: res.issues,
    cases: res.results.map((r, i) => ({ description: cases[i]!.description, ...r })),
    ...(res.apiError === undefined ? {} : { apiError: res.apiError }),
  };
  records.push(rec);
  console.log(`  ${service.padEnd(9)} ${shape.padEnd(20)} ${range ? `${range[0]}..${range[1]}` : `n=${n}`} ${show(rec)}`);
  return rec;
}

function probe(run: Execute, service: Service, shape: Shape, n: number): Promise<ProbeRecord> {
  return submit(run, service, shape, n, wrap(service, probeBlock(shape, n)), [
    { description: 'uid a', uid: 'a', path: 'p' },
    { description: 'uid b', uid: 'b', path: 'p' },
  ]);
}

/** One ruleset with a call chain of every depth from lo to hi, each in its own match block. */
function probeCallDepths(run: Execute, service: Service, lo: number, hi: number): Promise<ProbeRecord> {
  const blocks: string[] = [];
  const cases: ProbeCase[] = [];
  for (let n = lo; n <= hi; n++) {
    blocks.push(`    match /p${n}/{d} {\n${callChain(`c${n}_`, n)}\n      allow read: if c${n}_1();\n    }`);
    cases.push({ description: `depth ${n}`, uid: 'a', path: `p${n}` });
  }
  return submit(run, service, 'call-depth', hi, wrap(service, blocks.join('\n')), cases, [lo, hi]);
}

/** A probe passes when it compiles and grants uid a while denying uid b. */
function passes(r: ProbeRecord): boolean {
  return r.compiles && r.cases[0]?.decision === 'ALLOW' && r.cases[1]?.decision === 'DENY';
}

/** Largest n in [lo, hi] that passes, given lo passes and hi fails. */
async function bisect(run: Execute, service: Service, shape: Shape, lo: number, hi: number): Promise<number> {
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(await probe(run, service, shape, mid))) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Bounds for one service and shape: the largest n that passed and the smallest n that failed. */
export interface Boundary { service: Service; shape: Shape; largestPass: number | null; smallestFail: number | null }

/** Derive each shape's bounds from single-shape probes; combined probes are excluded. */
export function boundaries(probes: readonly ProbeRecord[]): Boundary[] {
  const out: Boundary[] = [];
  for (const service of ['firestore', 'storage'] as const) {
    for (const shape of ['call-depth', 'call-depth-uncalled', 'let-count', 'and-nesting', 'paren-nesting', 'paren-literal', 'list-nesting', 'map-nesting', 'index-chain', 'call-nesting', 'slash-divisor', 'member-chain', 'glob-in-path', 'glob-nested'] as const) {
      const mine = probes.filter((p) => p.service === service && p.shape === shape && !p.range);
      if (mine.length === 0) continue;
      const ok = mine.filter((p) => p.compiles).map((p) => p.n);
      const bad = mine.filter((p) => !p.compiles).map((p) => p.n);
      out.push({
        service, shape,
        largestPass: ok.length ? Math.max(...ok) : null,
        smallestFail: bad.length ? Math.min(...bad) : null,
      });
    }
  }
  return out;
}

function bound(service: Service, shape: Shape): Boundary | undefined {
  return boundaries(records).find((b) => b.service === service && b.shape === shape);
}

async function sweep(run: Execute): Promise<void> {
  for (const service of ['firestore', 'storage'] as const) {
    // Call depth: every N from 8 to 24 in one ruleset, one match block per N.
    // A compile-time limit rejects the whole ruleset and names each chain over
    // it; then bisect with one chain per ruleset.
    let depth: number | null = null;
    const combined = await probeCallDepths(run, service, 8, 24);
    if (combined.compiles) {
      depth = 7;
      for (const c of combined.cases) {
        if (c.decision !== 'ALLOW') break;
        depth++;
      }
    } else if (passes(await probe(run, service, 'call-depth', 8)) && !passes(await probe(run, service, 'call-depth', 24))) {
      depth = await bisect(run, service, 'call-depth', 8, 24);
    }
    // A chain that no rule calls, at the limit (control) and one over it,
    // shows whether the limit is checked at compile time.
    if (depth !== null) {
      await probe(run, service, 'call-depth-uncalled', depth);
      await probe(run, service, 'call-depth-uncalled', depth + 1);
    }

    // let bindings: 11 and 12, then larger when 12 compiles.
    for (const n of [11, 12, 20, 40]) if (!passes(await probe(run, service, 'let-count', n))) break;

    // Nesting: bisect 30..60 in Firestore; in Storage probe the Firestore
    // boundary and one above it. A shape that passes at 60 is probed further
    // out instead.
    for (const shape of ['and-nesting', 'paren-nesting'] as const) {
      const fs = bound('firestore', shape);
      if (service === 'storage' && fs?.largestPass != null && fs.smallestFail === fs.largestPass + 1) {
        await probe(run, service, shape, fs.largestPass);
        await probe(run, service, shape, fs.smallestFail);
        continue;
      }
      const lo = await probe(run, service, shape, 30);
      const hi = await probe(run, service, shape, 60);
      if (passes(lo) && !passes(hi)) await bisect(run, service, shape, 30, 60);
      else if (passes(hi)) for (const n of [200, 1000]) if (!passes(await probe(run, service, shape, n))) break;
    }
  }
}

async function main(args: string[]): Promise<void> {
  const { run, projectId } = await tools();
  // `--probe <service> <shape> <n,n,...>` appends single probes to the stored fixture.
  const i = args.indexOf('--probe');
  let capturedAt = new Date().toISOString();
  if (i >= 0) {
    const stored = JSON.parse(readFileSync(OUT, 'utf8')) as { capturedAt: string; calls: number; probes: ProbeRecord[] };
    records.push(...stored.probes);
    calls = stored.calls;
    capturedAt = stored.capturedAt;
    const service = args[i + 1] as Service;
    const shape = args[i + 2] as Shape;
    for (const n of args[i + 3]!.split(',').map(Number)) await probe(run, service, shape, n);
  } else {
    await sweep(run);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const fixture = {
    schema: 'pyric.rules-compile-limits.v1',
    capturedAt,
    projectId,
    method: 'Rules Test API projects.test, one generated ruleset per probe; each case is a get with uid a (granted when the ruleset works) and uid b (denied). probeBlock() in packages/conformance/src/capture-rules-compile-limits.ts generates each shape.',
    calls,
    boundaries: boundaries(records),
    probes: records,
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`[compile-limits] ${calls} Rules Test API calls; wrote ${OUT}`);
}

if (import.meta.main) {
  if (!process.env.PARITY_SA_BASE64 && process.env.PARITY_SA_PATH) {
    process.env.PARITY_SA_BASE64 = Buffer.from(readFileSync(process.env.PARITY_SA_PATH)).toString('base64');
  }
  await main(process.argv.slice(2));
}
