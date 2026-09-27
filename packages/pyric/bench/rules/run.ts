#!/usr/bin/env bun
/**
 * Rules engine benchmark. Times each stage of the rules pipeline separately
 * (parse, resolve, compile, evaluate, end to end) for Firestore, Realtime
 * Database and Storage fixtures, and compares a run to the committed
 * baseline.
 *
 *   bun run bench:rules                    table of medians and percentiles
 *   bun run bench:rules -- --json          the same report as JSON on stdout
 *   bun run bench:rules -- --check         fail when a median regresses past the margin
 *   bun run bench:rules -- --update        rewrite baseline.json from this run
 *   bun run bench:rules -- --profile       run under Bun's CPU profiler
 *
 * Other flags: --fixture <id> (repeatable), --quick, --warmup <n>,
 * --iterations <n>, --cold-samples <n>, --no-cold, --rounds <n>,
 * --margin <fraction>, --floor-us <n>,
 * --out <file>.
 *
 * The harness loads the built package (packages/pyric/dist), the same code
 * the test suite runs. Build first: `bun run build` in packages/pyric.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  compareToBaseline,
  type GateResult,
  rowKey,
  summarize,
  type BenchReport,
  type StageRow,
} from './gate.ts';

const HERE = import.meta.dir;
const PKG = join(HERE, '../..');
const DIST = join(PKG, 'dist');
const FIXTURES = join(HERE, 'fixtures');
const BASELINE = join(HERE, 'baseline.json');

// ─── Flags ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
function value(flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}
function values(flag: string): string[] {
  const out: string[] = [];
  argv.forEach((arg, i) => { if (arg === flag && argv[i + 1]) out.push(argv[i + 1]!); });
  return out;
}

const quick = has('--quick');
const settings = {
  warmup: Number(value('--warmup') ?? (quick ? 10 : 50)),
  iterations: Number(value('--iterations') ?? (quick ? 50 : 300)),
  coldSamples: has('--no-cold') ? 0 : Number(value('--cold-samples') ?? (quick ? 3 : 10)),
  /** Full passes over the fixtures; each stage keeps its fastest pass. */
  rounds: Number(value('--rounds') ?? (has('--check') || has('--update') ? 3 : 1)),
};
/** Default regression margin: 25 percent. See docs/rules-performance.md. */
const margin = Number(value('--margin') ?? 0.25);
/** A regression must also exceed this many microseconds, so tiny stages do not fail on jitter. */
const floorMicros = Number(value('--floor-us') ?? 5);
const only = new Set(values('--fixture'));

// One cold parse, in the fresh process the harness spawns per sample: load
// the parser module (which builds the Ohm grammar) and parse the source
// once, then print the nanoseconds. Nothing from the engine is loaded before
// this point.
//   bun bench/rules/run.ts --cold-parse <firestore|storage|rtdb> <rules file>
if (has('--cold-parse')) {
  const service = value('--cold-parse');
  const file = argv[argv.indexOf('--cold-parse') + 2];
  if (!service || !file) throw new Error('usage: --cold-parse <service> <rules file>');
  const source = readFileSync(file, 'utf8');
  const start = Bun.nanoseconds();
  if (service === 'rtdb') {
    const { parseExpression } = await import(join(DIST, 'rules/rtdb/grammar/RtdbExprParser.js'));
    const walk = (node: Record<string, unknown>) => {
      for (const [key, v] of Object.entries(node)) {
        if ((key === '.read' || key === '.write' || key === '.validate') && typeof v === 'string') {
          if (!parseExpression(v).valid) throw new Error(`does not parse: ${v}`);
        } else if (v && typeof v === 'object') walk(v as Record<string, unknown>);
      }
    };
    walk((JSON.parse(source) as { rules: Record<string, unknown> }).rules);
  } else {
    const { parseToASTOrError } = await import(join(DIST, 'rules/grammar/FirestoreParser.js'));
    if (!parseToASTOrError(source).ok) throw new Error('does not parse');
  }
  process.stdout.write(`${Bun.nanoseconds() - start}\n`);
  process.exit(0);
}

if (has('--profile')) {
  const dir = join(HERE, 'profiles', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const passThrough = argv.filter((arg) => arg !== '--profile');
  const args = ['--cpu-prof', `--cpu-prof-dir=${dir}`, '--cpu-prof-md', join(HERE, 'run.ts'), '--no-cold', ...passThrough];
  console.log(`bun ${args.join(' ')}`);
  const run = spawnSync(process.execPath, args, { stdio: 'inherit' });
  console.log(`\nCPU profiles in ${dir} (.cpuprofile opens in Chrome DevTools; .md is the text summary).`);
  process.exit(run.status ?? 1);
}

// ─── Build check ────────────────────────────────────────────────────────

if (!existsSync(join(DIST, 'rules/grammar/FirestoreParser.js'))) {
  console.error('packages/pyric/dist is missing. Build first: bun run build (in packages/pyric).');
  process.exit(2);
}
{
  const built = statSync(join(DIST, 'rules/grammar/FirestoreParser.js')).mtimeMs;
  const newer: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') && statSync(path).mtimeMs > built) newer.push(path);
    }
  };
  walk(join(PKG, 'src'));
  if (newer.length > 0) {
    console.error(`warning: ${newer.length} source file(s) are newer than dist, so this run measures the previous build. Rebuild with bun run build.`);
  }
}

// ─── Engine modules (from dist) ─────────────────────────────────────────

const load = (path: string) => import(join(DIST, path));
const parser = await load('rules/grammar/FirestoreParser.js');
const resolverBrowser = await load('rules/modules/resolver-browser.js');
const resolverCore = await load('rules/modules/resolver-core.js');
const handlerModule = await load('rules/simulator/handler.js');
const matchResolution = await load('rules/simulator/match-resolution.js');
const requestPath = await load('rules/simulator/request-path.js');
const wrappers = await load('rules/simulator/wrappers/timestamp.js');
const rtdbCompiled = await load('rules/rtdb/compiled-rules.js');
const rtdbParser = await load('rules/rtdb/grammar/RtdbExprParser.js');
const rtdbSpec = await load('rules/rtdb/simulation/spec.js');
const storageRules = await load('storage/sandbox/rules.js');
const storageEvaluator = await load('storage/sandbox/rules-evaluator.js');
const storageResolution = await load('storage/rules-resolution.js');

const sandboxApi = await import('pyric/sandbox');
const firestoreControls = await import('pyric/sandbox/firestore');
const databaseControls = await import('pyric/sandbox/database');
const firestoreSdk = await import('pyric/firestore');
const databaseSdk = await import('pyric/database');
const storageSdk = await import('pyric/storage');

// ─── Timing ─────────────────────────────────────────────────────────────

type Data = Record<string, unknown>;
const rows: StageRow[] = [];
const failures: string[] = [];

function record(subject: string, stage: string, timed: number[] | Timed, note?: string): number {
  const summary = summarize(Array.isArray(timed) ? timed : timed.samples);
  rows.push({ subject, stage, kind: 'timed', ...summary, ...(note ? { note } : {}) });
  return summary.median;
}

function derived(subject: string, stage: string, median: number, note: string): void {
  const v = Math.max(0, Math.round(median * 100) / 100);
  rows.push({ subject, stage, kind: 'derived', median: v, note });
}

function count(subject: string, stage: string, n: number, note?: string): void {
  rows.push({ subject, stage, kind: 'count', count: n, ...(note ? { note } : {}) });
}

/**
 * Per-stage time budget. A stage slower than budget / iterations takes fewer
 * samples (never under MIN_SAMPLES), so a 90 ms parse does not hold the run
 * for half a minute. The report records each stage's sample count.
 */
const WARMUP_BUDGET_NS = 0.5e9;
const SAMPLE_BUDGET_NS = (quick ? 1 : 3) * 1e9;
const MIN_SAMPLES = quick ? 10 : 30;

function plan(firstNs: number): { warmup: number; iterations: number } {
  const per = Math.max(firstNs, 1);
  return {
    warmup: Math.max(2, Math.min(settings.warmup, Math.floor(WARMUP_BUDGET_NS / per))),
    iterations: Math.max(MIN_SAMPLES, Math.min(settings.iterations, Math.floor(SAMPLE_BUDGET_NS / per))),
  };
}

interface Timed {
  /** Wall time of each timed call, in nanoseconds. */
  samples: number[];
  /** What each timed call returned, when it returns a sub-measure. */
  extra: number[];
}

/** Warm up, then time `fn`. `fn` may return a sub-measure in nanoseconds. */
function timeSync(fn: (i: number) => number | void): Timed {
  let start = Bun.nanoseconds();
  fn(0);
  const { warmup, iterations } = plan(Bun.nanoseconds() - start);
  for (let i = 1; i < warmup; i++) fn(i);
  Bun.gc(true);
  const out: Timed = { samples: [], extra: [] };
  for (let i = 0; i < iterations; i++) {
    start = Bun.nanoseconds();
    const extra = fn(warmup + i);
    out.samples.push(Bun.nanoseconds() - start);
    if (typeof extra === 'number') out.extra.push(extra);
  }
  return out;
}

/** The async counterpart; `prepare` runs untimed before each call. */
async function timeAsync(
  fn: (i: number) => Promise<void>,
  prepare: (i: number) => void | Promise<void> = () => {},
): Promise<number[]> {
  await prepare(0);
  let start = Bun.nanoseconds();
  await fn(0);
  const { warmup, iterations } = plan(Bun.nanoseconds() - start);
  for (let i = 1; i < warmup; i++) {
    await prepare(i);
    await fn(i);
  }
  Bun.gc(true);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const n = warmup + i;
    await prepare(n);
    start = Bun.nanoseconds();
    await fn(n);
    samples.push(Bun.nanoseconds() - start);
  }
  return samples;
}

const median = (timed: number[] | Timed) => summarize(Array.isArray(timed) ? timed : timed.samples).median;

/** Cold parse samples: each in a fresh bun process. */
function coldParse(subject: string, service: string, source: string): void {
  if (settings.coldSamples === 0) return;
  const file = join(tmpdir(), `pyric-rules-bench-${process.pid}-${subject.replace(/\W+/g, '-')}.rules`);
  writeFileSync(file, source, 'utf8');
  const samples: number[] = [];
  for (let i = 0; i < settings.coldSamples; i++) {
    const out = spawnSync(process.execPath, [join(HERE, 'run.ts'), '--cold-parse', service, file], { encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`cold parse failed for ${subject}: ${out.stderr}`);
    samples.push(Number(out.stdout.trim()));
  }
  record(subject, 'parse.cold', samples, 'fresh process: parser module load, grammar build, first parse');
}

// ─── Fixture values ─────────────────────────────────────────────────────

/** Revive `{ $timestamp }` tags with the given constructor. */
function revive(value: unknown, timestamp: (iso: string) => unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => revive(v, timestamp));
  if (value && typeof value === 'object') {
    const tag = (value as Data).$timestamp;
    if (typeof tag === 'string') return timestamp(tag);
    return Object.fromEntries(Object.entries(value as Data).map(([k, v]) => [k, revive(v, timestamp)]));
  }
  return value;
}
const forRules = (value: unknown) => revive(value, (iso) => wrappers.Timestamp.fromIsoString(iso));
const forSdk = (value: unknown) => revive(value, (iso) => firestoreSdk.Timestamp.fromDate(new Date(iso)));

function readFixture(id: string): Data {
  return JSON.parse(readFileSync(join(FIXTURES, id, 'fixture.json'), 'utf8')) as Data;
}

function fixtureDocs(id: string, docs: Data | undefined): Data {
  const out: Data = {};
  for (const [path, doc] of Object.entries(docs ?? {})) {
    const file = (doc as Data | null)?.$file;
    out[path] = typeof file === 'string' ? JSON.parse(readFileSync(join(FIXTURES, id, file), 'utf8')) : doc;
  }
  return out;
}

// ─── Firestore ──────────────────────────────────────────────────────────

interface FirestoreRequest {
  label: string;
  expect: 'ALLOW' | 'DENY';
  testCase: Data;
  e2e?: { uid: string; via: 'setDoc' | 'batch'; reset: Data; ops: { type: string; path: string; data: Data }[] };
}

let sandboxCount = 0;

/** Parse, compile and evaluate stages for one Firestore ruleset. */
function firestoreRuleStages(subject: string, source: string): { ast: unknown; sourceMap: unknown } {
  record(subject, 'parse.warm', timeSync(() => { parser.parseToAST(source); }));
  record(subject, 'compile', timeSync(() => { resolverCore.readAuthoredSourceMap(source); }),
    'the authored source map; the simulator walks the parsed AST directly');
  return { ast: parser.parseToAST(source), sourceMap: resolverCore.readAuthoredSourceMap(source) };
}

function firestoreEvaluate(
  subject: string,
  compiled: { ast: any; sourceMap: unknown },
  source: string,
  request: { label: string; expect: string; testCase: Data },
  docs: Data,
): void {
  const handler = new handlerModule.SimulateFirestoreRulesHandler();
  const tc = forRules(request.testCase) as Data;
  const store = new Map(Object.entries(forRules(docs) as Data));
  let lookupNs = 0;
  let lookups = 0;
  const getDoc = (path: string) => {
    const start = Bun.nanoseconds();
    const doc = (store.get(path) as Data | undefined) ?? null;
    lookupNs += Bun.nanoseconds() - start;
    lookups++;
    return doc;
  };
  const run = () => handler.simulateParsed(compiled.ast, source, [tc], { getDoc, sourceMap: compiled.sourceMap });

  const first = run();
  const result = first.success ? first.data.results[0] : undefined;
  if (!result || result.decision !== request.expect) {
    failures.push(`${subject}: evaluate returned ${result?.decision ?? first.error?.message}, fixture expects ${request.expect}`);
    return;
  }
  const nodes = (result.trace as { expressionTrace?: unknown[] }[])
    .reduce((sum, entry) => sum + (entry.expressionTrace?.length ?? 0), 0);

  lookups = 0;
  run();
  const perRequestLookups = lookups;
  const total = timeSync(() => { lookupNs = 0; run(); return lookupNs; });
  const timedLookups = total.extra;
  const timedRest = total.samples.map((ns, i) => ns - total.extra[i]!);

  const ast = compiled.ast;
  const segments = String(requestPath.documentRelativePath(tc.path as string)).split('/').filter(Boolean);
  const rootFunctions = [...(ast.functions ?? []), ...(ast.service.functions ?? []), ...ast.service.match.functions];
  const match = timeSync(() => {
    const recorder = { entries: [] as unknown[], push(entry: unknown) { this.entries.push(entry); } };
    for (const child of ast.service.match.children) matchResolution.collectMatches(child, segments, rootFunctions, recorder);
  });

  record(subject, 'evaluate', total, 'simulateParsed for one request');
  const matchMedian = record(subject, 'evaluate.match', match, 'collectMatches over the service match, timed on its own');
  record(subject, 'evaluate.lookups', timedLookups, `${perRequestLookups} getDoc call(s) per request, time inside the callback`);
  derived(subject, 'evaluate.expressions', median(timedRest) - matchMedian,
    'evaluate minus lookups minus match: expressions, trace recording and context building');
  count(subject, 'simulator nodes', nodes, 'expression trace entries the simulator records for this request');
}

async function firestoreEndToEnd(
  subject: string,
  source: string,
  docs: Data,
  e2e: NonNullable<FirestoreRequest['e2e']>,
): Promise<void> {
  const sandbox = sandboxApi.initializeSandbox();
  firestoreControls.setRules(sandbox, source);
  firestoreControls.seedDocuments(sandbox, forSdk(docs) as never);
  const reset = forSdk(e2e.reset) as Data;
  const writeAs = (uid: string) => {
    const db = firestoreSdk.getFirestore(sandbox.withAuth({ uid }));
    return async () => {
      if (e2e.via === 'setDoc') {
        const op = e2e.ops[0]!;
        await firestoreSdk.setDoc(firestoreSdk.doc(db, op.path), op.data);
        return;
      }
      const batch = firestoreSdk.writeBatch(db);
      for (const op of e2e.ops) {
        if (op.type === 'set') batch.set(firestoreSdk.doc(db, op.path), op.data);
        else batch.update(firestoreSdk.doc(db, op.path), op.data);
      }
      await batch.commit();
    };
  };
  const restore = () => { for (const [path, data] of Object.entries(reset)) sandbox.admin.setDocument(path, data as Data); };
  try {
    const samples = await timeAsync(writeAs(e2e.uid), restore);
    record(subject, 'e2e', samples, `pyric/firestore ${e2e.via === 'setDoc' ? 'setDoc' : 'writeBatch commit'} to the verdict and commit`);
  } catch (error) {
    failures.push(`${subject}: e2e write failed: ${(error as Error).message}`);
  }
  restore();
  await expectDenied(subject, 'the same write by another user', writeAs(STRANGER));
}

const STRANGER = 'bench-stranger';

/** A control: the rules must deny `fn`, or the e2e number may not include an evaluation. */
async function expectDenied(subject: string, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  failures.push(`${subject}: control "${what}" was allowed, so the e2e path may not be evaluating the rules`);
}

async function benchFirestoreFixture(id: string): Promise<void> {
  const fixture = readFixture(id);
  const rulesSpec = fixture.rules as { file: string; modules?: boolean };
  const authored = readFileSync(join(FIXTURES, id, rulesSpec.file), 'utf8');
  let source = authored;
  if (rulesSpec.modules) {
    const resolved = resolverBrowser.resolveModulesBrowser(authored);
    if (!resolved.success) throw new Error(`${id}: modules do not resolve: ${resolved.error.message}`);
    source = resolved.data.resolved;
    record(id, 'resolve', timeSync(() => { resolverBrowser.resolveModulesBrowser(authored); }),
      '2+modules import resolution and flattening');
  }
  coldParse(id, 'firestore', source);
  const compiled = firestoreRuleStages(id, source);
  const docs = fixtureDocs(id, fixture.docs as Data);
  for (const request of fixture.requests as FirestoreRequest[]) {
    const subject = `${id} / ${request.label}`;
    const lookupDocs = { ...docs, ...(request.e2e?.reset ?? {}) };
    firestoreEvaluate(subject, compiled, source, request, lookupDocs);
    if (request.e2e) await firestoreEndToEnd(subject, source, docs, request.e2e);
  }
}

// ─── Realtime Database ──────────────────────────────────────────────────

function rtdbExpressions(json: { rules: Data }): string[] {
  const out: string[] = [];
  const walk = (node: Data) => {
    for (const [key, v] of Object.entries(node)) {
      if ((key === '.read' || key === '.write' || key === '.validate') && typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object') walk(v as Data);
    }
  };
  walk(json.rules);
  return out;
}

function rtdbRuleStages(subject: string, text: string): unknown {
  const json = JSON.parse(text) as { rules: Data };
  const expressions = rtdbExpressions(json);
  record(subject, 'parse.warm', timeSync(() => {
    const parsed = JSON.parse(text) as { rules: Data };
    for (const expr of rtdbExpressions(parsed)) rtdbParser.parseExpression(expr);
  }), `JSON.parse and ${expressions.length} expression parse(s)`);
  record(subject, 'compile', timeSync(() => { rtdbCompiled.compileRtdbRules(json); }),
    'compileRtdbRules: parses, validates and lints every expression');
  return rtdbCompiled.compileRtdbRules(json);
}

function rtdbEvaluate(subject: string, text: string, compiled: unknown, input: Data, expect: string): void {
  const verdict = (result: any) => result.success ? (result.data.allowed ? 'ALLOW' : 'DENY') : `ERROR ${result.error.message}`;
  const got = verdict(rtdbCompiled.simulateRtdbRules(compiled, input));
  if (got !== expect) {
    failures.push(`${subject}: evaluate returned ${got}, fixture expects ${expect}`);
    return;
  }
  record(subject, 'evaluate', timeSync(() => { rtdbCompiled.simulateRtdbRules(compiled, input); }),
    'simulateRtdbRules for one request, expression trees already parsed');
  record(subject, 'evaluate.input-validation', timeSync(() => { rtdbSpec.SimulationInputSchema.safeParse(input); }),
    'SimulationInputSchema.safeParse on the same input, which evaluate runs first');
  const json = JSON.parse(text);
  const firstSamples: number[] = [];
  for (let i = 0; i < MIN_SAMPLES; i++) {
    const fresh = rtdbCompiled.compileRtdbRules(json);
    const start = Bun.nanoseconds();
    rtdbCompiled.simulateRtdbRules(fresh, input);
    firstSamples.push(Bun.nanoseconds() - start);
  }
  record(subject, 'evaluate.first', firstSamples, 'first request on a new compile: evaluation parses each rule it reaches once');
}

async function rtdbEndToEnd(subject: string, text: string, e2e: Data): Promise<void> {
  const sandbox = sandboxApi.initializeSandbox();
  databaseControls.setRules(sandbox, JSON.parse(text));
  databaseControls.setData(sandbox, { '/': e2e.tree as Data } as never);
  const db = databaseSdk.getDatabase(sandbox.withAuth({ uid: e2e.uid as string }));
  const at = databaseSdk.ref(db, e2e.path as string);
  const base = e2e.value as { puck: { t: number } };
  let next: unknown;
  try {
    const samples = await timeAsync(
      async () => { await databaseSdk.set(at, next); },
      (i) => {
        // Each frame carries a newer tick, as the game's frames do.
        next = { ...base, puck: { ...base.puck, t: base.puck.t + i } };
      },
    );
    record(subject, 'e2e', samples, 'pyric/database set of one frame to the verdict and commit');
  } catch (error) {
    failures.push(`${subject}: e2e write failed: ${(error as Error).message}`);
  }
  const stranger = databaseSdk.ref(databaseSdk.getDatabase(sandbox.withAuth({ uid: STRANGER })), e2e.path as string);
  const later = { ...base, puck: { ...base.puck, t: base.puck.t + 1e6 } };
  await expectDenied(subject, 'the same write by another user', () => databaseSdk.set(stranger, later));
}

async function benchRtdbFixture(id: string): Promise<void> {
  const fixture = readFixture(id);
  const text = readFileSync(join(FIXTURES, id, (fixture.rules as Data).file as string), 'utf8');
  coldParse(id, 'rtdb', text);
  const compiled = rtdbRuleStages(id, text);
  for (const request of fixture.requests as { label: string; expect: string; input: Data; e2e?: Data }[]) {
    const subject = `${id} / ${request.label}`;
    rtdbEvaluate(subject, text, compiled, request.input, request.expect);
    if (request.e2e) await rtdbEndToEnd(subject, text, request.e2e);
  }
}

// ─── Storage ────────────────────────────────────────────────────────────

function storageRuleStages(subject: string, source: string): unknown {
  const parse = record(subject, 'parse.warm', timeSync(() => { parser.parseToASTOrError(source); }));
  const both = median(timeSync(() => { storageResolution.compileStorageRules(source); }));
  derived(subject, 'compile', both - parse,
    'compileStorageRules minus parse: AST conversion, function scopes, resolution record');
  return storageRules.parseStorageRules(source);
}

function storageEvaluate(
  subject: string,
  rules: unknown,
  input: Data,
  expect: string,
  lookup: { gets: Data; exists: string[] },
  now: Date,
): void {
  let lookupNs = 0;
  let lookups = 0;
  const timed = <T>(fn: () => T): T => {
    const start = Bun.nanoseconds();
    const out = fn();
    lookupNs += Bun.nanoseconds() - start;
    lookups++;
    return out;
  };
  const firestoreLookup = {
    get: (path: string) => timed(() => (lookup.gets[path] as Data | undefined) ?? null),
    exists: (path: string) => timed(() => path in lookup.gets || lookup.exists.includes(path)),
  };
  const run = () => storageEvaluator.evaluateStorageRules(rules, input, now, firestoreLookup);
  const got = run().allowed ? 'ALLOW' : 'DENY';
  if (got !== expect) {
    failures.push(`${subject}: evaluate returned ${got}, fixture expects ${expect}`);
    return;
  }
  lookups = 0;
  run();
  const perRequestLookups = lookups;
  const total = timeSync(() => { lookupNs = 0; run(); return lookupNs; });
  record(subject, 'evaluate', total, 'evaluateStorageRules for one request');
  if (perRequestLookups > 0) {
    record(subject, 'evaluate.lookups', total.extra,
      `${perRequestLookups} firestore lookup(s) per request, time inside the callback`);
  }
}

async function storageEndToEnd(subject: string, source: string, firestoreDocs: Data, e2e: Data): Promise<void> {
  const sandbox = sandboxApi.initializeSandbox();
  firestoreControls.seedDocuments(sandbox, forSdk(firestoreDocs) as never);
  const dbName = `rules-bench-storage-${process.pid}-${sandboxCount++}`;
  const uploadAs = (uid: string) => {
    const storage = storageSdk.getStorageSandbox(sandbox.withAuth({ uid }), { rules: source, dbName } as never);
    const at = storageSdk.ref(storage, e2e.path as string);
    return async () => {
      await storageSdk.uploadString(at, e2e.text as string, 'raw', {
        contentType: e2e.contentType as string,
        customMetadata: e2e.customMetadata as Record<string, string>,
      });
    };
  };
  try {
    const samples = await timeAsync(uploadAs(e2e.uid as string));
    record(subject, 'e2e', samples, 'pyric/storage uploadString to the verdict and the stored object');
  } catch (error) {
    failures.push(`${subject}: e2e upload failed: ${(error as Error).message}`);
  }
  await expectDenied(subject, 'the same upload by another user', uploadAs(STRANGER));
}

async function benchStorageFixture(id: string): Promise<void> {
  const fixture = readFixture(id);
  const source = readFileSync(join(FIXTURES, id, (fixture.rules as Data).file as string), 'utf8');
  coldParse(id, 'storage', source);
  const rules = storageRuleStages(id, source);
  const docs = (fixture.firestoreDocs ?? {}) as Data;
  for (const request of fixture.requests as { label: string; expect: string; input: Data; e2e?: Data }[]) {
    const subject = `${id} / ${request.label}`;
    const gets = forRules(docs) as Data;
    storageEvaluate(subject, rules, request.input, request.expect, { gets, exists: [] }, new Date());
    if (request.e2e) await storageEndToEnd(subject, source, docs, request.e2e);
  }
}

// ─── Corpus ─────────────────────────────────────────────────────────────

function benchCorpus(): void {
  const fixture = readFixture('corpus');
  for (const s of fixture.scenarios as Data[]) {
    const subject = `corpus / ${s.id as string}`;
    const rules = s.rules as string;
    if (s.service === 'firestore') {
      const compiled = firestoreRuleStages(subject, rules);
      firestoreEvaluate(subject, compiled, rules, { label: s.label as string, expect: s.expect as string, testCase: s.testCase as Data }, {});
    } else if (s.service === 'storage') {
      const compiled = storageRuleStages(subject, rules);
      const now = typeof s.now === 'string' ? new Date(s.now) : new Date();
      storageEvaluate(subject, compiled, s.input as Data, s.expect as string, s.lookup as { gets: Data; exists: string[] }, now);
    } else {
      const compiled = rtdbRuleStages(subject, rules);
      rtdbEvaluate(subject, rules, compiled, s.input as Data, s.expect as string);
    }
  }
}

// ─── Run ────────────────────────────────────────────────────────────────

const FIXTURE_RUNNERS: Record<string, () => Promise<void> | void> = {
  chess: () => benchFirestoreFixture('chess'),
  'arcade-firestore': () => benchFirestoreFixture('arcade-firestore'),
  'arcade-rtdb': () => benchRtdbFixture('arcade-rtdb'),
  'arcade-storage': () => benchStorageFixture('arcade-storage'),
  corpus: benchCorpus,
};

const log = (line: string) => { if (!has('--json')) console.error(line); };

/** Each stage's fastest row across rounds, in first-round order. */
const best = new Map<string, StageRow>();
const order: string[] = [];
function keepFastest(roundRows: StageRow[]): void {
  for (const row of roundRows) {
    const key = rowKey(row);
    const held = best.get(key);
    if (!held) order.push(key);
    if (!held || (row.kind !== 'count' && (row.median ?? Infinity) < (held.median ?? Infinity))) best.set(key, row);
  }
}

/** Sampling flags a round's child process inherits. */
const SAMPLING_FLAGS = ['--warmup', '--iterations', '--cold-samples'];
function childArgs(ids: string[], out: string): string[] {
  const args = [join(HERE, 'run.ts'), '--child-out', out];
  for (const id of ids) args.push('--fixture', id);
  for (const flag of SAMPLING_FLAGS) {
    const v = value(flag);
    if (v !== undefined) args.push(flag, v);
  }
  if (quick) args.push('--quick');
  if (has('--no-cold')) args.push('--no-cold');
  return args;
}

/**
 * Run the fixtures `count` times. One round runs in this process; more than
 * one runs each round in its own process, since a process's JIT and heap
 * state can shift a stage by a fifth. Each stage keeps its fastest round:
 * other load on the machine only ever slows a round down, so the lowest
 * median of several rounds is the most repeatable figure for a before and
 * after comparison.
 */
async function runRounds(ids: string[], count: number, label = 'round'): Promise<void> {
  if (count === 1) {
    rows.length = 0;
    for (const id of ids) {
      log(`${label}: ${id}`);
      await FIXTURE_RUNNERS[id]!();
    }
    keepFastest([...rows]);
    return;
  }
  for (let round = 1; round <= count; round++) {
    log(`${label} ${round}/${count}: ${ids.join(', ')}`);
    const out = join(tmpdir(), `pyric-rules-bench-${process.pid}-${label}-${round}.json`);
    const child = spawnSync(process.execPath, childArgs(ids, out), { stdio: ['ignore', 'ignore', 'inherit'] });
    if (child.status !== 0 || !existsSync(out)) throw new Error(`${label} ${round} did not finish (exit ${child.status})`);
    const result = JSON.parse(readFileSync(out, 'utf8')) as { rows: StageRow[]; failures: string[] };
    keepFastest(result.rows);
    failures.push(...result.failures);
  }
}

const selected = Object.keys(FIXTURE_RUNNERS).filter((id) => {
  if (only.size > 0 && !only.has(id)) return false;
  if (existsSync(join(FIXTURES, id, 'fixture.json'))) return true;
  log(`skip ${id}: no fixture (see capture.ts)`);
  return false;
});
await runRounds(selected, settings.rounds);

function collect(): void {
  rows.length = 0;
  rows.push(...order.map((key) => best.get(key)!));
  const uniqueFailures = [...new Set(failures)];
  failures.length = 0;
  failures.push(...uniqueFailures);
}
collect();

// A round run as a child process hands its rows back and stops here.
const childOut = value('--child-out');
if (childOut) {
  writeFileSync(childOut, JSON.stringify({ rows, failures }), 'utf8');
  process.exit(0);
}

const report: BenchReport = {
  version: 1,
  recordedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    bun: Bun.version,
  },
  settings,
  rows,
};

// ─── Check ──────────────────────────────────────────────────────────────

let baseline: BenchReport | undefined;
let gate: GateResult | undefined;
let confirmed: string[] = [];
if (has('--check')) {
  if (!existsSync(BASELINE)) {
    console.error('No baseline.json; run with --update on a full run first.');
    process.exit(1);
  }
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as BenchReport;
  gate = compareToBaseline(baseline, report, margin, floorMicros);
  if (gate.regressions.length > 0) {
    // A stage past the margin gets more rounds before it fails: a real
    // regression stays slow, a busy moment on the machine does not.
    confirmed = [...new Set(gate.regressions.map((line) => line.split(' :: ')[0]!.split(' / ')[0]!))];
    await runRounds(confirmed, settings.rounds, 'confirm');
    collect();
    gate = compareToBaseline(baseline, report, margin, floorMicros);
  }
}

// ─── Output ─────────────────────────────────────────────────────────────

const STAGE_COLUMNS = [
  'parse.cold', 'parse.warm', 'resolve', 'compile',
  'evaluate', 'evaluate.match', 'evaluate.expressions', 'evaluate.lookups',
  'evaluate.input-validation', 'evaluate.first', 'simulator nodes', 'e2e',
];

function cell(row: StageRow | undefined): string {
  if (!row) return '';
  if (row.kind === 'count') return String(row.count);
  const v = row.median ?? Number.NaN;
  return v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${v.toFixed(1)} us`;
}

function medianTable(): string {
  const subjects = [...new Set(rows.map((r) => r.subject))];
  const byKey = new Map(rows.map((r) => [rowKey(r), r]));
  const columns = STAGE_COLUMNS.filter((stage) => rows.some((r) => r.stage === stage));
  const lines = [
    `| Fixture | ${columns.join(' | ')} |`,
    `| --- | ${columns.map(() => '---:').join(' | ')} |`,
  ];
  for (const subject of subjects) {
    lines.push(`| ${subject} | ${columns.map((stage) => cell(byKey.get(rowKey({ subject, stage })))).join(' | ')} |`);
  }
  return lines.join('\n');
}

function detailTable(): string {
  const lines = ['| Fixture | Stage | Median (us) | p95 (us) | p99 (us) | Samples | Note |', '| --- | --- | ---: | ---: | ---: | ---: | --- |'];
  for (const r of rows) {
    if (r.kind === 'count') {
      lines.push(`| ${r.subject} | ${r.stage} | ${r.count} | | | | ${r.note ?? ''} |`);
    } else if (r.kind === 'derived') {
      lines.push(`| ${r.subject} | ${r.stage} | ${r.median} | | | | derived: ${r.note ?? ''} |`);
    } else {
      lines.push(`| ${r.subject} | ${r.stage} | ${r.median} | ${r.p95} | ${r.p99} | ${r.samples} | ${r.note ?? ''} |`);
    }
  }
  return lines.join('\n');
}

const out = value('--out');
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');

if (has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nRules benchmark: ${report.machine.cpu}, bun ${report.machine.bun}, warmup ${settings.warmup}, iterations ${settings.iterations}, cold samples ${settings.coldSamples}, rounds ${settings.rounds} (each stage keeps its fastest round)\n`);
  console.log('Medians\n');
  console.log(medianTable());
  console.log('\nAll stages\n');
  console.log(detailTable());
}

if (failures.length > 0) {
  console.error(`\n${failures.length} fixture check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
}

if (has('--update')) {
  if (failures.length > 0 || only.size > 0 || quick) {
    console.error('Not writing the baseline: it needs a full run with every fixture check passing.');
    process.exitCode = 1;
  } else {
    writeFileSync(BASELINE, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.error(`\nWrote ${BASELINE}`);
  }
}

if (baseline && gate) {
  const result = gate;
  console.error(`\nCompared with baseline recorded ${baseline.recordedAt} on ${baseline.machine.cpu}, bun ${baseline.machine.bun} (margin ${(margin * 100).toFixed(0)} percent and ${floorMicros} us).`);
  if (confirmed.length > 0) console.error(`Ran ${settings.rounds} more round(s) of ${confirmed.join(', ')} to confirm stages that first measured past the margin.`);
  if (baseline.machine.cpu !== report.machine.cpu || baseline.machine.bun !== report.machine.bun) {
    console.error('warning: this machine or bun version differs from the baseline, so the comparison is not like for like.');
  }
  for (const line of result.improvements) console.error(`  faster: ${line}`);
  if (only.size === 0) for (const line of result.missing) console.error(`  missing from this run: ${line}`);
  for (const line of result.added) console.error(`  not in baseline: ${line}`);
  if (result.regressions.length > 0) {
    console.error(`\n${result.regressions.length} stage(s) regressed past ${(margin * 100).toFixed(0)} percent:`);
    for (const line of result.regressions) console.error(`  - ${line}`);
    process.exitCode = 1;
  } else {
    console.error('No stage median regressed past the margin.');
  }
}
