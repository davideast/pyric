#!/usr/bin/env bun
/**
 * Measure the production cost of every Security Rules standard library
 * function and write the cost records.
 *
 * Cost is counted in the units of production's per-request limit (1000
 * expressions), per call: the call node, its `let` bindings and its body. The
 * arguments a caller passes are the caller's expressions and are not part of
 * a function's cost.
 *
 * Method
 *  1. Probes. For every case in a module's `*.test.json`, each call to one of
 *     the module's exports in the case's call expression becomes a probe: the
 *     call alone, wrapped in a single-rule block the way the module tests wrap
 *     it, under the case's request and documents. A second probe calls a
 *     function that returns `false` with the same arguments. The function's
 *     cost for that case is `X(call) - X(reference) + 2`: the reference costs
 *     one call node, the arguments, and one literal.
 *  2. Padding. Each probe block starts with two always-false rules whose cost
 *     is set by path wildcards: `__pyricPad0(int(a))` from
 *     `rules-expression-cost-pad.ts` grows by 5 expressions per step (plus 2
 *     per 40-step segment), and `__pyricFine(int(v))` grows by 6 per step for
 *     v in 0..4. Together they reach every integer in the range the probes
 *     need. The request reaches the limit exactly when
 *     `pad(a, v) + X >= D`, so the smallest reaching padding gives X exactly.
 *     The wildcards carry the padding because the test cases of
 *     unauthenticated requests have no auth token to carry it.
 *  3. Calibration. D is measured per service from three blocks of known cost:
 *     `false` (1), `true && false` (4) and 20 conjoined `true` (58). The run
 *     stops when the three disagree, since the padding model would then be
 *     wrong.
 *  4. Search. The linter's estimator predicts each probe's cost; the first
 *     round probes the predicted boundary and spreads the rest of its points
 *     over the window, and later rounds split the remaining interval. Every
 *     probe of a service shares one ruleset, so each round is one request per
 *     chunk of up to 125 test cases.
 *  5. Requests. An unauthenticated case is sent with `auth: null`. Without the
 *     field, production makes `request.auth` undefined rather than null, so
 *     `request.auth != null` errors and `&&` evaluates both operands, which
 *     is not the path a signed-out client takes.
 *
 * Output
 *  - packages/pyric/test/rules/modules/fixtures/stdlib-cost-capture.json:
 *    calibration, every probe's measured X, and per-function min and max.
 *    A full run replaces it. A run with --module replaces its modules' rows
 *    in place and keeps the full run's totals, date and calibration; its own
 *    request and test case counts go in `runs`, under each module it measured
 *    (`mergeCapture`).
 *  - With --write: the `costs` records in every module test file and the cost
 *    line above every exported function (`applyCostLines`). Run
 *    `bun run inline-stdlib` in packages/pyric afterwards.
 *
 * Credentials: the Firestore rules oracle contract (`run-rules.ts`).
 * PARITY_SA_BASE64 or PARITY_SA_PATH selects a service account holding
 * `firebaserules.rulesets.test`; otherwise the firebase-tools login is used
 * with PARITY_PROJECT_ID (default digame-mas). A service that answers
 * PERMISSION_DENIED or an auth failure with the service account retries with
 * the firebase-tools login. The Rules Test API evaluates the submitted
 * ruleset without deploying it.
 *
 * Usage:
 *   bun run packages/conformance/src/measure-stdlib-cost.ts [--write] [--module auth,storage/uploads]
 *   --dry-run   build the rulesets and probes and print the plan; no network.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectScope } from '../../pyric/src/project-scope.ts';
import { parseToAST } from '../../pyric/src/rules/grammar/FirestoreParser.ts';
import type { FunctionDef } from '../../pyric/src/rules/grammar/FirestoreAST.ts';
import { countDocumentAccessCalls } from '../../pyric/src/rules/grammar/document-access-count.ts';
import { estimateExpressionCosts } from '../../pyric/src/rules/linter/expression-cost.ts';
import { resolveModulesBrowser } from '../../pyric/src/rules/modules/resolver-browser.ts';
import {
  applyCostLines,
  parseStdlibTestFile,
  type StdlibCostRecord,
} from '../../pyric/src/rules/modules/stdlib-cost.ts';
import type { StorageTestCase, TestCase } from '../../pyric/src/rules/test/spec.ts';
import { PAD_MAX, isLimitMessage, padFunctions } from './rules-expression-cost-pad.ts';
import { REPO_ROOT } from './rules-expression-cost-suites.ts';

export const STDLIB_DIR = join(REPO_ROOT, 'packages', 'pyric', 'src', 'rules', 'modules', 'stdlib');
export const CAPTURE_PATH = join(REPO_ROOT, 'packages', 'pyric', 'test', 'rules', 'modules', 'fixtures', 'stdlib-cost-capture.json');

type Service = 'firestore' | 'storage';
const DEFAULT_TIME = '2026-07-21T00:00:00Z';
const FINE_MAX = 4;
const POINTS_PER_ROUND = 6;
const MAX_ROUNDS = 8;
const MAX_REQUEST_BYTES = 400_000;
// The API answers INVALID_ARGUMENT for 250 test cases in one request and accepts 125.
const MAX_REQUEST_CASES = 125;
let chunkCap = MAX_REQUEST_CASES;
const ATTEMPTS = 6;

// ─── Modules and probes ──────────────────────────────────────────────────

interface ModuleText {
  name: string;
  service: Service;
  source: string;
  testPath: string;
  rulesPath: string;
  exports: { name: string; params: string[] }[];
  cases: Record<string, any>[];
}

export function loadModules(): ModuleText[] {
  const out: ModuleText[] = [];
  const read = (dir: string, prefix: string, service: Service) => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.rules')).sort()) {
      const name = `${prefix}${file.replace(/\.rules$/, '')}`;
      const rulesPath = join(dir, file);
      const testPath = join(dir, file.replace(/\.rules$/, '.test.json'));
      const source = readFileSync(rulesPath, 'utf8');
      const exports = [...source.matchAll(/^export function (\w+)\s*\(([^)]*)\)/gm)].map((m) => ({
        name: m[1]!,
        params: m[2]!.split(',').map((p) => p.trim()).filter(Boolean),
      }));
      const { cases } = parseStdlibTestFile<Record<string, any>>(readFileSync(testPath, 'utf8'), testPath);
      out.push({ name, service, source, testPath, rulesPath, exports, cases });
    }
  };
  read(STDLIB_DIR, '', 'firestore');
  read(join(STDLIB_DIR, 'storage'), 'storage/', 'storage');
  return out;
}

/** Top-level calls of `names` in an expression: `{ name, text, args }`. */
export function extractCalls(expr: string, names: ReadonlySet<string>): { name: string; text: string; args: string[] }[] {
  const out: { name: string; text: string; args: string[] }[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === "'" || ch === '"') {
      i = skipString(expr, i);
      continue;
    }
    const m = /^[A-Za-z_]\w*/.exec(expr.slice(i));
    if (!m) { i++; continue; }
    const word = m[0];
    const prev = i > 0 ? expr[i - 1] : '';
    let j = i + word.length;
    while (expr[j] === ' ') j++;
    if (names.has(word) && expr[j] === '(' && prev !== '.') {
      const close = matchParen(expr, j);
      const inner = expr.slice(j + 1, close);
      out.push({ name: word, text: expr.slice(i, close + 1), args: splitArgs(inner) });
      i = close + 1;
      continue;
    }
    i += word.length;
  }
  return out;
}

function skipString(s: string, start: number): number {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length && s[i] !== quote) i += s[i] === '\\' ? 2 : 1;
  return i + 1;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') { i = skipString(s, i) - 1; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced call in: ${s}`);
}

function splitArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "'" || ch === '"') { i = skipString(inner, i) - 1; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { args.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  const last = inner.slice(start).trim();
  if (last) args.push(last);
  return args;
}

interface Probe {
  module: string;
  fn: string;
  caseDescription: string;
  callText: string;
  args: string[];
  testCase: Record<string, any>;
}

function callExpression(c: Record<string, any>): string {
  return c.wrapCallExpr ?? `${c.wrapFunction}(${(c.wrapArgs ?? []).join(', ')})`;
}

export function buildProbes(mod: ModuleText): Probe[] {
  const names = new Set(mod.exports.map((e) => e.name));
  const probes: Probe[] = [];
  const seen = new Set<string>();
  for (const c of mod.cases) {
    for (const call of extractCalls(callExpression(c), names)) {
      const { description, expectation, wrapFunction, wrapCallExpr, wrapArgs, wrapOperation, ...state } = c;
      const key = JSON.stringify([call.text, state]);
      if (seen.has(key)) continue;
      seen.add(key);
      probes.push({ module: mod.name, fn: call.name, caseDescription: c.description, callText: call.text, args: call.args, testCase: c });
    }
  }
  return probes;
}

// ─── Rulesets ────────────────────────────────────────────────────────────

const FINE_FN = [
  '    function __pyricFine(n) {',
  `      return ${Array.from({ length: FINE_MAX + 1 }, (_, k) => `!(n <= ${k})`).reduceRight((inner, term) => `${term} && (${inner})`, 'false')};`,
  '    }',
].join('\n');

function refFunctions(arities: Iterable<number>): string {
  return [...arities].map((n) => {
    const params = Array.from({ length: n }, (_, i) => `a${i}`).join(', ');
    return `    function __pyricArgs${n}(${params}) {\n      return false;\n    }`;
  }).join('\n');
}

/** One measured expression: a single rule in its own padded block. */
interface Item {
  id: string;
  service: Service;
  blockPath: string;
  requestPath: string;
  method: string;
  condition: string;
  testCase: Record<string, any>;
  /** Known cost, for calibration items. */
  known?: number;
  estimate?: number;
}

const CALIBRATION: { condition: string; cost: number }[] = [
  { condition: 'false', cost: 1 },
  { condition: 'true && false', cost: 4 },
  { condition: Array.from({ length: 20 }, () => 'true').join(' && '), cost: 58 },
];

function padPrefix(id: string): string {
  return `/${id}/{pyricPadA}/pv/{pyricPadV}`;
}

function blockFor(service: Service, c: Record<string, any>): { match: string; path: string } {
  if (service === 'storage') return { match: '/test/{file}', path: c.path };
  return { match: c.wrapMatch ?? '/test/{docId}', path: c.path };
}

export function buildItems(service: Service, modules: ModuleText[]) {
  const items: Item[] = [];
  const probes: (Probe & { call: string; ref: string | null })[] = [];
  const arities = new Set<number>();
  CALIBRATION.forEach((cal, k) => {
    const id = `${service === 'storage' ? 's' : 'f'}cal${k}`;
    items.push({
      id, service, blockPath: `${padPrefix(id)}/test/{docId}`, requestPath: `${id}/{A}/pv/{V}/test/x`,
      method: 'get', condition: cal.condition, testCase: { method: 'get', auth: null }, known: cal.cost,
    });
  });
  let n = 0;
  const refs = new Map<string, string>();
  for (const mod of modules.filter((m) => m.service === service)) {
    for (const probe of buildProbes(mod)) {
      const { match, path } = blockFor(service, probe.testCase);
      const method = probe.testCase.method;
      const id = `p${n++}`;
      items.push({
        id, service, blockPath: `${padPrefix(id)}${match}`, requestPath: `${id}/{A}/pv/{V}/${path}`,
        method, condition: probe.callText, testCase: probe.testCase,
      });
      let refId: string | null = null;
      if (probe.args.length > 0) {
        arities.add(probe.args.length);
        const refCondition = `__pyricArgs${probe.args.length}(${probe.args.join(', ')})`;
        const { description, expectation, wrapFunction, wrapCallExpr, wrapArgs, wrapOperation, ...state } = probe.testCase;
        const key = JSON.stringify([refCondition, state]);
        refId = refs.get(key) ?? null;
        if (!refId) {
          refId = `r${n++}`;
          refs.set(key, refId);
          items.push({
            id: refId, service, blockPath: `${padPrefix(refId)}${match}`, requestPath: `${refId}/{A}/pv/{V}/${path}`,
            method, condition: refCondition, testCase: probe.testCase,
          });
        }
      }
      probes.push({ ...probe, call: id, ref: refId });
    }
  }
  return { items, probes, arities };
}

function rulesetSource(service: Service, modules: ModuleText[], items: Item[], arities: Set<number>, padded: boolean): string {
  const imports = modules
    .filter((m) => m.service === service)
    .map((m) => `import { ${m.exports.map((e) => e.name).join(', ')} } from '${m.name}';`);
  const blocks = items.map((item) => [
    `    match ${item.blockPath} {`,
    ...(padded
      ? [`      allow ${item.method}: if __pyricPad0(int(pyricPadA));`, `      allow ${item.method}: if __pyricFine(int(pyricPadV));`]
      : []),
    `      allow ${item.method}: if ${item.condition};`,
    '    }',
  ].join('\n'));
  const header = service === 'storage'
    ? ['service firebase.storage {', '  match /b/{bucket}/o {']
    : ['service cloud.firestore {', '  match /databases/{database}/documents {'];
  const source = [
    "rules_version = '2+modules';",
    ...imports,
    ...header,
    padFunctions(),
    FINE_FN,
    refFunctions([...arities].sort()),
    ...blocks,
    '  }',
    '}',
    '',
  ].join('\n');
  const resolved = resolveModulesBrowser(source);
  if (!resolved.success) throw new Error(`${service} ruleset did not resolve: ${resolved.error.code} ${resolved.error.message}`);
  return resolved.data.resolved.replace(/\n\/\/ @pyric-source-map:.*$/s, '\n');
}

function estimate(rules: string, items: Item[]): void {
  const ast = parseToAST(rules);
  if (!ast) throw new Error('estimator could not parse the probe ruleset');
  const est = estimateExpressionCosts(ast);
  for (const item of items) {
    const suffix = item.blockPath;
    const grant = est.rules.find((r) => r.blockPath === suffix)?.grantCost ?? 0;
    const deny = est.blocks.find((b) => b.blockPath === suffix && b.method === item.method)?.denyCost ?? 0;
    item.estimate = Math.max(grant, deny);
  }
}

// ─── Test cases ──────────────────────────────────────────────────────────

/** Fixture sentinels to Rules Test API values. The API reads an ISO-8601
 *  string in a document field as a timestamp. */
export function apiValue(value: unknown, time: string): unknown {
  if (value === 'REQUEST_TIME') return time;
  if (Array.isArray(value)) return value.map((v) => apiValue(v, time));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o.__type === 'timestamp' && typeof o.iso === 'string') return o.iso;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, apiValue(v, time)]));
  }
  return value;
}

function padPath(item: Item, a: number, v: number): string {
  return item.requestPath.replace('{A}', String(a)).replace('{V}', String(v));
}

function testCaseFor(item: Item, a: number, v: number): TestCase | StorageTestCase {
  const c = item.testCase;
  const time = c.requestTime ?? DEFAULT_TIME;
  const description = `${item.id} a=${a} v=${v}`;
  if (item.service === 'storage') {
    return {
      description, expectation: 'DENY', method: c.method, path: padPath(item, a, v),
      auth: c.auth ?? null, requestTime: time,
      ...(c.resource ? { resource: c.resource } : {}),
      ...(c.existingResource ? { existingResource: c.existingResource } : {}),
      ...(c.functionMocks ? { functionMocks: c.functionMocks } : {}),
    } as StorageTestCase;
  }
  return {
    description, expectation: 'DENY', method: c.method, path: padPath(item, a, v),
    auth: c.auth ?? null, requestTime: time,
    ...(c.data ? { data: apiValue(c.data, time) } : {}),
    ...(c.resource ? { resource: apiValue(c.resource, time) } : {}),
    ...(c.functionMocks ? { functionMocks: c.functionMocks } : {}),
  } as TestCase;
}

// ─── Padding arithmetic ──────────────────────────────────────────────────

/** Padding cost above its constant part: 5 per step, 2 per segment call, 6 per fine step. */
export const padSteps = (a: number, v: number) => 5 * a + 2 * Math.floor(a / 40) + 6 * v;

/** Every reachable padding total with one (a, v) that produces it, ascending. */
export function reachablePadding(): { total: number; a: number; v: number }[] {
  const byTotal = new Map<number, { a: number; v: number }>();
  for (let a = 0; a <= PAD_MAX; a++) {
    for (let v = 0; v <= FINE_MAX; v++) {
      const total = padSteps(a, v);
      if (!byTotal.has(total)) byTotal.set(total, { a, v });
    }
  }
  return [...byTotal.entries()].map(([total, p]) => ({ total, ...p })).sort((x, y) => x.total - y.total);
}

// ─── Network ─────────────────────────────────────────────────────────────

interface Runner {
  requests: number;
  testCases: number;
  run(service: Service, rules: string, cases: (TestCase | StorageTestCase)[]): Promise<{ notes: string[] }[]>;
}

const RULES_API = 'https://firebaserules.googleapis.com/v1';

/**
 * One `projects.test` call. The body is built with the oracle's case builders,
 * except that an unauthenticated case sends `auth: null`: a request without
 * the field makes `request.auth` undefined ("Property auth is undefined on
 * object."), which errors instead of comparing to null and so evaluates both
 * operands of `request.auth != null && ...`.
 */
async function testRules(
  scope: ProjectScope,
  service: Service,
  rules: string,
  cases: (TestCase | StorageTestCase)[],
): Promise<{ ok: true; results: { notes: string[] }[] } | { ok: false; status: number; message: string }> {
  const { buildApiTestCase, buildStorageApiTestCase } = await import('../../pyric/src/rules/test/spec.ts');
  const testCases = cases.map((tc) => {
    const api: any = service === 'storage' ? buildStorageApiTestCase(tc as StorageTestCase) : buildApiTestCase(tc as TestCase);
    if (tc.auth === null || tc.auth === undefined) api.request.auth = null;
    return api;
  });
  const token = await scope.resolveToken();
  const res = await fetch(`${RULES_API}/projects/${scope.projectId}:test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: { files: [{ name: service === 'storage' ? 'storage.rules' : 'firestore.rules', content: rules }] },
      testSuite: { testCases },
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, message: text.slice(0, 2000) };
  const body = JSON.parse(text) as { testResults?: { debugMessages?: string[] }[]; issues?: { description: string }[] };
  const results = body.testResults ?? [];
  if (results.length !== cases.length) {
    return { ok: false, status: res.status, message: `expected ${cases.length} results, got ${results.length}: ${(body.issues ?? []).map((i) => i.description).join('; ')}` };
  }
  return { ok: true, results: results.map((r) => ({ notes: r.debugMessages ?? [] })) };
}

async function cliScope(): Promise<ProjectScope> {
  const saved = process.env.PARITY_SA_BASE64;
  delete process.env.PARITY_SA_BASE64;
  try {
    const { parityScope } = await import('../../pyric/test/rules/parity/harness.ts');
    return parityScope() as ProjectScope;
  } finally {
    if (saved !== undefined) process.env.PARITY_SA_BASE64 = saved;
  }
}

async function makeRunner(): Promise<Runner & { projects: Record<Service, string> }> {
  const { parityScope } = await import('../../pyric/test/rules/parity/harness.ts');
  const scopes: Record<Service, ProjectScope> = { firestore: parityScope(), storage: parityScope() };
  const hasCli = existsSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'));
  const fellBack = new Set<Service>();
  const runner = {
    requests: 0,
    testCases: 0,
    projects: { firestore: scopes.firestore.projectId, storage: scopes.storage.projectId },
    async run(service: Service, rules: string, cases: (TestCase | StorageTestCase)[]) {
      const chunks: typeof cases[] = [];
      let current: typeof cases = [];
      let bytes = 0;
      for (const tc of cases) {
        const size = JSON.stringify(tc).length;
        if (current.length > 0 && (bytes + size > MAX_REQUEST_BYTES || current.length >= chunkCap)) {
          chunks.push(current);
          current = [];
          bytes = 0;
        }
        current.push(tc);
        bytes += size;
      }
      if (current.length > 0) chunks.push(current);
      const results: { notes: string[] }[] = [];
      while (chunks.length > 0) {
        const chunk = chunks.shift()!;
        let res: Awaited<ReturnType<typeof testRules>> | undefined;
        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
          runner.requests++;
          try {
            res = await testRules(scopes[service], service, rules, chunk);
          } catch (e) {
            res = { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
          }
          if (res.ok) break;
          if (chunk.length > 1 && (res.status === 400 || (res.status >= 500 && attempt >= 2))) break;
          const credentialFailure = res.status === 401 || res.status === 403 || /invalid_grant|JWT/i.test(res.message);
          if (credentialFailure && hasCli && !fellBack.has(service)) {
            fellBack.add(service);
            scopes[service] = await cliScope();
            runner.projects[service] = scopes[service].projectId;
            console.log(`[stdlib-cost] ${service}: service account refused (${res.message.slice(0, 80)}); using the firebase-tools login for ${scopes[service].projectId}`);
            continue;
          }
          const transient = res.status === 0 || res.status === 429 || res.status >= 500;
          if (!transient || attempt === ATTEMPTS) break;
          await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
        }
        if (res && !res.ok && chunk.length > 1 && (res.status === 400 || res.status >= 500)) {
          // The API rejects a request with too many test cases as INVALID_ARGUMENT
          // without naming the limit, and answers some test cases with a lasting
          // 503: split the chunk (lowering the cap on a 400) to isolate either.
          const half = Math.ceil(chunk.length / 2);
          if (res.status === 400) chunkCap = Math.min(chunkCap, half);
          chunks.unshift(chunk.slice(0, half), chunk.slice(half));
          continue;
        }
        if (!res || !res.ok) throw new Error(`Rules Test API failed: ${res?.status} ${res?.message}${chunk.length === 1 ? ` (test case ${chunk[0]!.description})` : ""}`);
        runner.testCases += chunk.length;
        results.push(...res.results);
      }
      return results;
    },
  };
  return runner;
}

// ─── Search ──────────────────────────────────────────────────────────────

interface SearchState {
  /** Index into the reachable list of the largest total observed below the limit. */
  below: number;
  /** Index of the smallest total observed at the limit. */
  at: number;
}

function indexAtOrAbove(reach: { total: number }[], total: number): number {
  let lo = 0;
  let hi = reach.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (reach[mid]!.total < total) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, reach.length - 1);
}

function candidates(state: SearchState, window: [number, number], focus: number[]): number[] {
  const lo = Math.max(state.below + 1, window[0]);
  const hi = Math.min(state.at - 1, window[1]);
  if (state.at - state.below <= 1) return [];
  if (hi < lo) {
    // The boundary lies outside the window: step past the window edge.
    if (state.below < window[0]) return [Math.max(0, window[0] - (window[1] - window[0]) - 1)];
    return [Math.min(state.at - 1, window[1] + (window[1] - window[0]) + 1)];
  }
  const picks = new Set<number>(focus.filter((f) => f >= lo && f <= hi));
  const span = hi - lo + 1;
  if (span <= POINTS_PER_ROUND) for (let i = lo; i <= hi; i++) picks.add(i);
  for (let k = 1; picks.size < POINTS_PER_ROUND && k <= POINTS_PER_ROUND; k++) {
    picks.add(lo + Math.floor((k * span) / (POINTS_PER_ROUND + 1)));
  }
  return [...picks].sort((x, y) => x - y);
}

/**
 * Smallest reachable padding total at which each item reaches the limit.
 * `predict(item)` gives the expected total; the window bounds the search.
 */
async function measure(
  runner: Runner,
  service: Service,
  rules: string,
  items: Item[],
  reach: ReturnType<typeof reachablePadding>,
  predict: (item: Item) => { focus: number; window: [number, number] },
): Promise<Map<string, SearchState>> {
  const states = new Map<string, SearchState>(items.map((i) => [i.id, { below: -1, at: reach.length }]));
  const plans = new Map(items.map((i) => {
    const p = predict(i);
    const f = indexAtOrAbove(reach, p.focus);
    return [i.id, { focus: [f - 1, f, f + 1], window: [indexAtOrAbove(reach, p.window[0]), indexAtOrAbove(reach, p.window[1])] as [number, number] }];
  }));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const batch: { item: Item; index: number }[] = [];
    for (const item of items) {
      const plan = plans.get(item.id)!;
      for (const index of candidates(states.get(item.id)!, plan.window, round === 0 ? plan.focus : [])) batch.push({ item, index });
    }
    if (batch.length === 0) break;
    const results = await runner.run(service, rules, batch.map(({ item, index }) => testCaseFor(item, reach[index]!.a, reach[index]!.v)));
    results.forEach((r, k) => {
      const { item, index } = batch[k]!;
      const s = states.get(item.id)!;
      if (isLimitMessage(r.notes)) s.at = Math.min(s.at, index);
      else s.below = Math.max(s.below, index);
    });
    const open = items.filter((i) => { const s = states.get(i.id)!; return s.at - s.below > 1; }).length;
    console.log(`[stdlib-cost] ${service} round ${round + 1}: ${batch.length} test cases, ${open} unresolved`);
  }
  return states;
}

/** Exact X from a resolved threshold: `pad + X >= D` first holds at `at`. */
function exactCost(reach: ReturnType<typeof reachablePadding>, s: SearchState, d: number): number | null {
  if (s.below < 0 || s.at >= reach.length || s.at - s.below !== 1) return null;
  if (reach[s.at]!.total - reach[s.below]!.total !== 1) return null;
  return d - reach[s.at]!.total;
}

// ─── Run ─────────────────────────────────────────────────────────────────

function staticReads(service: Service, modules: ModuleText[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const mod of modules.filter((m) => m.service === service)) {
    const probe = [
      "rules_version = '2+modules';",
      `import { ${mod.exports.map((e) => e.name).join(', ')} } from '${mod.name}';`,
      service === 'storage' ? 'service firebase.storage { match /b/{bucket}/o { } }' : 'service cloud.firestore { match /databases/{database}/documents { } }',
    ].join('\n');
    const resolved = resolveModulesBrowser(probe);
    if (!resolved.success) throw new Error(`${mod.name}: ${resolved.error.message}`);
    const ast = parseToAST(resolved.data.resolved)!;
    const fns = new Map<string, FunctionDef>();
    for (const fn of [...(ast.functions ?? []), ...(ast.service.functions ?? [])]) fns.set(fn.name, fn);
    for (const e of mod.exports) {
      const fn = fns.get(e.name)!;
      const reads = countDocumentAccessCalls(fn.body, fns) + fn.lets.reduce((n, l) => n + countDocumentAccessCalls(l.value, fns), 0);
      out.set(`${mod.name}.${e.name}`, reads);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const dryRun = args.includes('--dry-run');
  const mi = args.indexOf('--module');
  const selected = mi >= 0 ? new Set(args[mi + 1]!.split(',')) : null;
  if (!process.env.PARITY_SA_BASE64 && process.env.PARITY_SA_PATH) {
    process.env.PARITY_SA_BASE64 = Buffer.from(readFileSync(process.env.PARITY_SA_PATH)).toString('base64');
  }
  const modules = loadModules().filter((m) => !selected || selected.has(m.name));
  const reach = reachablePadding();
  const runner = dryRun ? null : await makeRunner();
  const functions: any[] = [];
  const calibration: Record<string, unknown> = {};
  const probeRows: any[] = [];

  for (const service of ['firestore', 'storage'] as const) {
    if (!modules.some((m) => m.service === service)) continue;
    const { items, probes, arities } = buildItems(service, modules);
    const rules = rulesetSource(service, modules, items, arities, true);
    estimate(rulesetSource(service, modules, items, arities, false), items);
    const calItems = items.filter((i) => i.known !== undefined);
    const measured = items.filter((i) => i.known === undefined);
    console.log(`[stdlib-cost] ${service}: ${probes.length} probes, ${measured.length} measured expressions, ruleset ${rules.length} bytes`);
    if (!runner) continue;

    // 1. Calibration: D is near 982 in Firestore; search a wide window.
    const calStates = await measure(runner, service, rules, calItems, reach, (item) => ({
      focus: 982 - item.known!, window: [900 - item.known!, 1060 - item.known!],
    }));
    const ds = calItems.map((item) => {
      const s = calStates.get(item.id)!;
      const x = exactCost(reach, s, 0);
      if (x === null) throw new Error(`${service} calibration ${item.condition.slice(0, 30)} did not resolve: ${JSON.stringify(s)}`);
      return -x + item.known!;
    });
    if (new Set(ds).size !== 1) throw new Error(`${service} calibration disagrees: D = ${ds.join(', ')}`);
    const d = ds[0]!;
    calibration[service] = { d, checks: calItems.map((i, k) => ({ condition: i.condition, cost: i.known, d: ds[k] })) };
    console.log(`[stdlib-cost] ${service}: calibrated D = ${d}`);

    // 2. Probes.
    const states = await measure(runner, service, rules, measured, reach, (item) => ({
      focus: d - item.estimate!, window: [d - item.estimate! - 8, d - 1],
    }));
    const xOf = (id: string) => exactCost(reach, states.get(id)!, d);
    const reads = staticReads(service, modules);
    for (const probe of probes) {
      const xCall = xOf(probe.call);
      const xRef = probe.ref ? xOf(probe.ref) : 2;
      const perCall = xCall === null || xRef === null ? null : xCall - xRef + 2;
      const estimateCall = items.find((i) => i.id === probe.call)!.estimate!;
      const estimateRef = probe.ref ? items.find((i) => i.id === probe.ref)!.estimate! : 2;
      probeRows.push({
        module: probe.module, function: probe.fn, case: probe.caseDescription, call: probe.callText,
        measured: { call: xCall, reference: xRef, perCall },
        estimated: { call: estimateCall, reference: estimateRef, perCall: estimateCall - estimateRef + 2 },
      });
    }
    for (const mod of modules.filter((m) => m.service === service)) {
      for (const e of mod.exports) {
        const rows = probeRows.filter((r) => r.module === mod.name && r.function === e.name);
        const values = rows.map((r) => r.measured.perCall);
        if (rows.length === 0 || values.some((v) => v === null)) {
          throw new Error(`${mod.name}.${e.name}: ${rows.length === 0 ? 'no test case calls it' : 'a probe did not resolve'}`);
        }
        const min = Math.min(...values);
        const max = Math.max(...values);
        functions.push({
          module: mod.name, function: e.name, cost: { min, max }, reads: reads.get(`${mod.name}.${e.name}`)!,
          cheapestCase: rows.find((r) => r.measured.perCall === min)!.case,
          mostExpensiveCase: rows.find((r) => r.measured.perCall === max)!.case,
        });
      }
    }
  }
  if (!runner) return;

  console.log('\nmodule               function                 min  max  reads');
  for (const f of functions) console.log(`${f.module.padEnd(20)} ${f.function.padEnd(24)} ${String(f.cost.min).padStart(3)}  ${String(f.cost.max).padStart(3)}  ${f.reads}`);
  console.log(`\n[stdlib-cost] ${runner.requests} Rules Test API requests, ${runner.testCases} test cases, at most ${chunkCap} test cases per request`);

  const previous = existsSync(CAPTURE_PATH) && selected ? JSON.parse(readFileSync(CAPTURE_PATH, 'utf8')) as CostCapture : null;
  const capture = mergeCapture(previous, {
    capturedAt: new Date().toISOString(),
    modules: selected ? modules.map((m) => m.name) : null,
    projects: runner.projects,
    calibration,
    requests: runner.requests,
    testCases: runner.testCases,
    functions,
    probes: probeRows,
  });
  mkdirSync(dirname(CAPTURE_PATH), { recursive: true });
  writeFileSync(CAPTURE_PATH, JSON.stringify(capture, null, 2) + '\n');
  console.log(`[stdlib-cost] wrote ${CAPTURE_PATH}`);

  if (!write) return;
  for (const mod of modules) {
    const records: StdlibCostRecord[] = mod.exports.map((e) => {
      const f = functions.find((x) => x.module === mod.name && x.function === e.name);
      return { function: e.name, cost: f.cost, reads: f.reads };
    });
    writeFileSync(mod.testPath, withCostRecords(readFileSync(mod.testPath, 'utf8'), records));
    writeFileSync(mod.rulesPath, applyCostLines(mod.source, records));
  }
  console.log('[stdlib-cost] wrote cost records and cost lines; run `bun run inline-stdlib` in packages/pyric');
}

// ─── Capture ─────────────────────────────────────────────────────────────

interface CaptureRow {
  module: string;
  function: string;
  [field: string]: any;
}

/** What one run of this tool measured. `modules` is null for a full run. */
export interface CostRun {
  capturedAt: string;
  modules: string[] | null;
  projects: Record<string, string>;
  calibration: Record<string, unknown>;
  requests: number;
  testCases: number;
  functions: CaptureRow[];
  probes: CaptureRow[];
}

/** The totals of a partial run, recorded under each module it measured. */
export interface PartialRunRecord {
  requests: number;
  testCases: number;
  date: string;
  modules: string[];
  calibration: Record<string, unknown>;
}

export interface CostCapture {
  schema: string;
  capturedAt: string;
  projects: Record<string, string>;
  method: string;
  calibration: Record<string, unknown>;
  /** Totals of the last full run; null until a full run is recorded. */
  requests: number | null;
  testCases: number | null;
  note?: string;
  runs?: Record<string, PartialRunRecord>;
  functions: CaptureRow[];
  probes: CaptureRow[];
}

const METHOD = 'padding: pad(a, v) + X >= D; per call = X(call) - X(reference with the same arguments) + 2';

/**
 * Rows of `previous` with the rows of `modules` replaced by `next`, in place:
 * a measured module's rows go where its first row was, and a module the
 * capture has not measured before goes at the end.
 */
function replaceRows(previous: CaptureRow[], next: CaptureRow[], modules: readonly string[]): CaptureRow[] {
  const out: CaptureRow[] = [];
  const placed = new Set<string>();
  for (const r of previous) {
    if (!modules.includes(r.module)) {
      out.push(r);
      continue;
    }
    if (placed.has(r.module)) continue;
    placed.add(r.module);
    out.push(...next.filter((n) => n.module === r.module));
  }
  out.push(...next.filter((n) => !placed.has(n.module)));
  return out;
}

/**
 * The capture after `run`. A full run replaces the capture. A partial run
 * keeps the full run's totals, date and calibration, replaces its modules'
 * rows in place, and records its own totals in `runs` under each module it
 * measured.
 */
export function mergeCapture(previous: CostCapture | null, run: CostRun): CostCapture {
  if (!run.modules) {
    return {
      schema: 'pyric.stdlib-cost.v1', capturedAt: run.capturedAt, projects: run.projects, method: METHOD,
      calibration: run.calibration, requests: run.requests, testCases: run.testCases,
      functions: run.functions, probes: run.probes,
    };
  }
  const record: PartialRunRecord = {
    requests: run.requests, testCases: run.testCases, date: run.capturedAt,
    modules: run.modules, calibration: run.calibration,
  };
  const runs = { ...(previous?.runs ?? {}) };
  for (const m of run.modules) {
    delete runs[m];
    runs[m] = record;
  }
  const base: CostCapture = previous ?? {
    schema: 'pyric.stdlib-cost.v1', capturedAt: run.capturedAt, projects: run.projects, method: METHOD,
    calibration: {}, requests: null, testCases: null, functions: [], probes: [],
  };
  return {
    ...base,
    projects: { ...run.projects, ...base.projects },
    runs,
    functions: replaceRows(base.functions, run.functions, run.modules),
    probes: replaceRows(base.probes, run.probes, run.modules),
  };
}

/** Replace the `costs` array of a test file, one record per line, keeping the case text as written. */
export function withCostRecords(text: string, records: readonly StdlibCostRecord[]): string {
  const start = text.indexOf('"costs": [');
  const end = text.indexOf('],\n  "cases"');
  if (start < 0 || end < 0) throw new Error('test file lacks the "costs" and "cases" layout');
  const body = records.map((r) => `    ${JSON.stringify(r).replace(/,"/g, ', "').replace(/:/g, ': ').replace(/\{"/g, '{ "').replace(/\}/g, ' }')}`).join(',\n');
  return `${text.slice(0, start)}"costs": [\n${body}\n  ${text.slice(end)}`;
}

if (import.meta.main) await main();
