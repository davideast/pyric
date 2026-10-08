/**
 * The RTDB differential runner: generates sequences, runs each on the
 * in-page sandbox, the SharedWorker host and the Node host, compares the
 * normalized traces, and shrinks every mismatch to a minimal sequence.
 *
 *   bun differential.ts [--start=1] [--count=200] [--steps=<n>] [--chunks=4]
 *                       [--planes=sandbox,worker,node] [--save=<dir>]
 *                       [--replay=<fixture dir or file>] [--strict]
 *                       [--shrink=false]
 *
 * `--steps` fixes every sequence's length. `--save` writes each shrunk
 * mismatch as a fixture. `--replay` runs saved fixtures instead of generated
 * seeds. `--strict` also reports the divergences `known-divergences.ts` lists.
 * The Node plane runs the CLI's built `dist`, so build the CLI first. The exit
 * code is 1 when any sequence mismatches.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { firstMismatch, normalize, type Mismatch, type NormalTrace } from './compare.js';
import { generateSequence } from './generator.js';
import type { Trace } from './interpreter.js';
import type { PlaneName } from './planes.js';
import type { PlaneOutcome } from './run-plane.js';
import type { Sequence } from './sequence.js';
import { knownDivergence } from './known-divergences.js';

/** Skip the mismatches `known-divergences.ts` lists; `--strict` reports them too. */
let tolerateKnown = true;
export function reportKnownDivergences(report: boolean): void { tolerateKnown = !report; }

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '../../..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');

export interface PlaneRunner {
  run(plane: PlaneName, sequences: Sequence[]): Promise<PlaneOutcome[]>;
  dispose(): void;
}

/** Build `run-plane.ts` for Node, with the CLI's sources resolved to its built `dist`. */
async function buildNodeRunner(directory: string): Promise<string> {
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const distRoot = `${join(CLI_ROOT, 'dist')}/`;
  const build = await Bun.build({
    entrypoints: [join(HERE, 'run-plane.ts')],
    outdir: directory,
    target: 'node',
    packages: 'external',
    naming: 'run-plane.mjs',
    plugins: [{
      name: 'cli-dist',
      setup(builder) {
        // The harness imports the CLI's sources as `../../../src/...`; the
        // Node plane imports the same modules from the built package instead.
        builder.onLoad({ filter: /rtdb-differential\/[^/]+\.ts$/ }, async (args) => {
          const source = await Bun.file(args.path).text();
          return { contents: source.replaceAll('../../../src/', pathToFileURL(distRoot).href), loader: 'ts' };
        });
      },
    }],
  });
  if (!build.success) throw new Error(`Node runner build failed: ${build.logs.map(String).join('\n')}`);
  return join(directory, 'run-plane.mjs');
}

export async function createPlaneRunner(options: { chunks?: number } = {}): Promise<PlaneRunner> {
  const directory = mkdtempSync(join(tmpdir(), 'pyric-rtdb-differential-'));
  const nodeRunner = await buildNodeRunner(directory);
  const chunks = Math.max(1, options.chunks ?? 1);
  let batch = 0;

  async function runChunk(plane: PlaneName, sequences: Sequence[]): Promise<PlaneOutcome[]> {
    const id = `${plane}-${++batch}`;
    const input = join(directory, `${id}.in.json`);
    const output = join(directory, `${id}.out.json`);
    writeFileSync(input, JSON.stringify(sequences));
    const command = plane === 'node'
      ? [process.env.PYRIC_TEST_NODE ?? 'node', nodeRunner, plane, input, output]
      : [process.execPath, join(HERE, 'run-plane.ts'), plane, input, output];
    const child = Bun.spawn(command, { cwd: CLI_ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${plane} plane exited ${code}: ${stderr.slice(-4000)}`);
    return JSON.parse(readFileSync(output, 'utf8')) as PlaneOutcome[];
  }

  return {
    async run(plane, sequences) {
      if (sequences.length === 0) return [];
      const size = Math.ceil(sequences.length / chunks);
      const parts: Sequence[][] = [];
      for (let i = 0; i < sequences.length; i += size) parts.push(sequences.slice(i, i + size));
      return (await Promise.all(parts.map((part) => runChunk(plane, part)))).flat();
    },
    dispose() { rmSync(directory, { recursive: true, force: true }); },
  };
}

export interface Verdict {
  sequence: Sequence;
  mismatch: Classified | null;
  /** The known divergences the comparison skipped, by name. */
  tolerated: string[];
}

export type Classified = Mismatch & { kind: string };

function judge(
  planes: PlaneName[],
  sequence: Sequence,
  outcomes: Record<string, PlaneOutcome>,
  tolerated: Set<string>,
): Classified | null {
  const fatal = planes.filter((plane) => 'fatal' in outcomes[plane]!);
  if (fatal.length > 0) {
    return { where: 'fatal', kind: 'fatal', values: Object.fromEntries(planes.map((plane) => [plane, (outcomes[plane] as { fatal?: string }).fatal ?? 'completed'])) };
  }
  const traces: Record<string, NormalTrace> = {};
  for (const plane of planes) traces[plane] = normalize(outcomes[plane] as Trace);
  const stepAt = (where: string) => {
    const index = /^steps\[(\d+)\]$/.exec(where);
    return index ? sequence.steps[Number(index[1])] : undefined;
  };
  const mismatch = firstMismatch(traces, (candidate) => {
    if (!tolerateKnown) return false;
    const known = knownDivergence(candidate, stepAt(candidate.where));
    if (known !== undefined) tolerated.add(known.name);
    return known !== undefined;
  });
  if (mismatch === null) return null;
  // The step operation or listener event the planes disagree on.
  const step = /^steps\[(\d+)\]$/.exec(mismatch.where);
  const listener = /^events\.L\d+ (\S+)/.exec(mismatch.where);
  let kind = 'data';
  if (step) kind = `step ${sequence.steps[Number(step[1])]!.op}`;
  if (listener) kind = `events ${listener[1]}`;
  return { ...mismatch, kind };
}

export async function runAll(runner: PlaneRunner, planes: PlaneName[], sequences: Sequence[]): Promise<Verdict[]> {
  const results = await Promise.all(planes.map((plane) => runner.run(plane, sequences)));
  return sequences.map((sequence, index) => {
    const outcomes = Object.fromEntries(planes.map((plane, p) => [plane, results[p]![index]!]));
    const tolerated = new Set<string>();
    const mismatch = judge(planes, sequence, outcomes, tolerated);
    return { sequence, mismatch, tolerated: [...tolerated] };
  });
}

/** What disagrees and which planes side together: the shape a shrunk sequence must keep. */
export function signature(mismatch: Classified): string {
  const groups = new Map<string, string[]>();
  for (const [plane, value] of Object.entries(mismatch.values)) {
    const key = JSON.stringify(value) ?? 'undefined';
    groups.set(key, [...(groups.get(key) ?? []), plane]);
  }
  return `${mismatch.kind}:${[...groups.values()].map((group) => group.sort().join('+')).sort().join('|')}`;
}

/** Drop steps while the planes still disagree in the same way. */
export async function shrink(runner: PlaneRunner, planes: PlaneName[], verdict: Verdict): Promise<Verdict> {
  let best = verdict;
  const target = signature(verdict.mismatch!);
  let improved = true;
  while (improved) {
    improved = false;
    const steps = best.sequence.steps;
    const candidates: Sequence[] = [];
    for (let size = Math.max(1, Math.floor(steps.length / 2)); size >= 1; size = Math.floor(size / 2)) {
      for (let start = 0; start + size <= steps.length; start += size) {
        candidates.push({ ...best.sequence, steps: [...steps.slice(0, start), ...steps.slice(start + size)] });
      }
      if (size === 1) break;
    }
    if (best.sequence.instances === 3) {
      const usesThird = steps.some((step) => 'db' in step && step.db === 2);
      if (!usesThird) candidates.push({ ...best.sequence, instances: 2, initialRules: best.sequence.initialRules.slice(0, 2) });
    }
    const verdicts = await runAll(runner, planes, candidates);
    const smaller = verdicts.find((candidate) => candidate.mismatch !== null && signature(candidate.mismatch) === target);
    if (smaller) {
      best = smaller;
      improved = true;
    }
  }
  return best;
}

function fixtureFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).filter((name) => name.endsWith('.json')).sort().map((name) => join(path, name));
}

export function readFixtures(path: string): Sequence[] {
  return fixtureFiles(path).map((file) => (JSON.parse(readFileSync(file, 'utf8')) as { sequence: Sequence }).sequence);
}

async function main(): Promise<void> {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key!, value];
  }));
  const planes = (args['planes'] ?? 'sandbox,worker,node').split(',') as PlaneName[];
  reportKnownDivergences(args['strict'] === 'true');
  const start = Number(args['start'] ?? 1);
  const count = Number(args['count'] ?? 200);
  const sequences = args['replay'] !== undefined
    ? readFixtures(resolve(args['replay']))
    : Array.from({ length: count }, (_, index) => generateSequence(start + index, {
      ...(args['steps'] === undefined ? {} : { minSteps: Number(args['steps']), maxSteps: Number(args['steps']) }),
    }));
  const runner = await createPlaneRunner({ chunks: Number(args['chunks'] ?? 4) });
  try {
    const began = Date.now();
    const verdicts = await runAll(runner, planes, sequences);
    const mismatched = verdicts.filter((verdict) => verdict.mismatch !== null);
    console.log(`${sequences.length} sequences, ${mismatched.length} mismatched, ${Math.round((Date.now() - began) / 1000)} s`);
    const save = args['save'];
    const seen = new Set<string>();
    for (const verdict of mismatched) {
      const key = signature(verdict.mismatch!);
      const shrunk = args['shrink'] === 'false' || seen.has(key) ? verdict : await shrink(runner, planes, verdict);
      seen.add(key);
      const size = shrunk === verdict ? `${verdict.sequence.steps.length} steps, not shrunk` : `shrunk to ${shrunk.sequence.steps.length} steps`;
      console.log(`\nseed ${verdict.sequence.seed}: ${verdict.mismatch!.where} (${size})`);
      console.log(`  ${shrunk.mismatch!.where}: ${JSON.stringify(shrunk.mismatch!.values).slice(0, 1500)}`);
      console.log(`  steps: ${JSON.stringify(shrunk.sequence.steps).slice(0, 3000)}`);
      if (save !== undefined) {
        mkdirSync(save, { recursive: true });
        writeFileSync(join(save, `seed-${verdict.sequence.seed}.json`), `${JSON.stringify({ sequence: shrunk.sequence, mismatch: shrunk.mismatch }, null, 2)}\n`);
      }
    }
    process.exitCode = mismatched.length === 0 ? 0 : 1;
  } finally {
    runner.dispose();
  }
}

if (import.meta.main) await main();
