/**
 * Seeded Firestore differential runner: synthesizes deterministic multi-step
 * operation sequences, runs each against the in-process `pyric/firestore`
 * sandbox (`sandbox`) and the real hosted `@pyric/cli` HTTP/WebSocket serve
 * plane (`hosted`), compares normalized traces (including Admin `RemoteSandbox`
 * cross-reads and persistence bundle round-trip equivalence), and shrinks any
 * mismatch to a minimal reproducing sequence with a one-liner replay command.
 *
 *   bun packages/cli/test/serve/firestore-differential/differential.ts \
 *     [--start=1] [--count=200] [--steps=35] [--chunks=2] \
 *     [--planes=sandbox,hosted] [--save=<dir>] [--replay=<dir-or-file>] \
 *     [--strict] [--shrink=false] [--target-repo=<dir>]
 *
 * Environment overrides:
 *   PYRIC_FS_DIFF_SEED=<n>      Start seed (defaults to --start or 1)
 *   PYRIC_FS_DIFF_SEEDS=<count> Number of seeds (defaults to --count or 200; 1 when PYRIC_FS_DIFF_SEED is set alone)
 *   PYRIC_FS_DIFF_STEPS=<n>     Fixed step count per sequence
 *   PYRIC_FS_DIFF_CHUNKS=<n>    Parallel worker chunk count
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveNodeExecutable } from '../require-node-on-path.js';
import {
  firstMismatch,
  normalizeTrace,
  type Mismatch,
  type NormalTrace,
  type Trace,
} from './compare.js';
import { generateSequence, type GenerateOptions } from './generator.js';
import { knownDivergence } from './known-divergences.js';
import type { PlaneName } from './planes.js';
import type { PlaneOutcome } from './run-plane.js';
import type { Sequence } from './sequence.js';

let tolerateKnown = true;
export function reportKnownDivergences(report: boolean): void {
  tolerateKnown = !report;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '../../..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');

export interface PlaneRunner {
  run(plane: PlaneName, sequences: Sequence[]): Promise<PlaneOutcome[]>;
  dispose(): void;
}

export async function buildForNode(
  directory: string,
  script: string,
  targetRepoRoot: string = REPO_ROOT,
): Promise<string> {
  const linked = join(directory, 'node_modules');
  if (!existsSync(linked)) {
    symlinkSync(join(targetRepoRoot, 'node_modules'), linked, 'dir');
  }
  const naming = script.replace(/\.ts$/, '.mjs');
  const distRoot = `${join(targetRepoRoot, 'packages/cli/dist')}/`;
  const build = await Bun.build({
    entrypoints: [join(HERE, script)],
    outdir: directory,
    target: 'node',
    packages: 'external',
    naming,
    plugins: [
      {
        name: 'cli-dist',
        setup(builder) {
          builder.onLoad({ filter: /firestore-differential\/[^/]+\.ts$/ }, async (args) => {
            const source = await Bun.file(args.path).text();
            return {
              contents: source.replaceAll('../../../src/', pathToFileURL(distRoot).href),
              loader: 'ts',
            };
          });
        },
      },
    ],
  });
  if (!build.success) {
    throw new Error(`Node runner build failed: ${build.logs.map(String).join('\n')}`);
  }
  return join(directory, naming);
}

export async function createPlaneRunner(
  options: { chunks?: number; targetRepoRoot?: string } = {},
): Promise<PlaneRunner> {
  let targetRepoRoot = REPO_ROOT;
  if (options.targetRepoRoot !== undefined) {
    targetRepoRoot = resolve(options.targetRepoRoot);
  }
  const usesExternalRepo = targetRepoRoot !== REPO_ROOT;
  const targetCliRoot = join(targetRepoRoot, 'packages/cli');
  const directory = mkdtempSync(join(tmpdir(), 'pyric-firestore-differential-'));
  const nodeRunner = await buildForNode(directory, 'run-plane.ts', targetRepoRoot);
  const chunks = Math.max(1, options.chunks ?? 1);
  let batch = 0;

  async function runChunk(plane: PlaneName, sequences: Sequence[]): Promise<PlaneOutcome[]> {
    const id = `${plane}-${++batch}`;
    const input = join(directory, `${id}.in.json`);
    const output = join(directory, `${id}.out.json`);
    writeFileSync(input, JSON.stringify(sequences));

    let command: string[];
    if (plane === 'hosted' || usesExternalRepo) {
      command = [resolveNodeExecutable(), nodeRunner, plane, input, output];
    } else {
      command = [process.execPath, join(HERE, 'run-plane.ts'), plane, input, output];
    }

    const child = Bun.spawn(command, {
      cwd: targetCliRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(`${plane} plane exited ${code}: ${stderr.slice(-4000)}`);
    }
    return JSON.parse(readFileSync(output, 'utf8')) as PlaneOutcome[];
  }

  return {
    async run(plane, sequences) {
      if (sequences.length === 0) {
        return [];
      }
      const effectiveChunks = sequences.length <= 60 ? 1 : chunks;
      const size = Math.ceil(sequences.length / effectiveChunks);
      const parts: Sequence[][] = [];
      for (let i = 0; i < sequences.length; i += size) {
        parts.push(sequences.slice(i, i + size));
      }
      const chunkResults = await Promise.all(parts.map((part) => runChunk(plane, part)));
      return chunkResults.flat();
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export type ClassifiedMismatch = Mismatch & { kind: string; stepIndex?: number };

export interface Verdict {
  sequence: Sequence;
  mismatch: ClassifiedMismatch | null;
  tolerated: string[];
}

function judge(
  planes: readonly PlaneName[],
  sequence: Sequence,
  outcomes: Record<string, PlaneOutcome>,
  tolerated: Set<string>,
): ClassifiedMismatch | null {
  const fatalPlanes = planes.filter((plane) => {
    const outcome = outcomes[plane];
    return outcome === undefined || 'fatal' in outcome;
  });
  if (fatalPlanes.length > 0) {
    const values: Record<string, unknown> = {};
    for (const plane of planes) {
      const outcome = outcomes[plane];
      if (outcome !== undefined && 'fatal' in outcome) {
        values[plane] = outcome.fatal;
      } else {
        values[plane] = 'completed';
      }
    }
    return { where: 'fatal', kind: 'fatal', values };
  }

  const traces: Record<string, NormalTrace> = {};
  for (const plane of planes) {
    const outcome = outcomes[plane];
    if (outcome !== undefined && !('fatal' in outcome)) {
      traces[plane] = normalizeTrace(outcome as Trace);
    }
  }

  const mismatch = firstMismatch(traces, (candidate) => {
    if (!tolerateKnown) {
      return false;
    }
    const known = knownDivergence(candidate, sequence);
    if (known !== undefined) {
      tolerated.add(known.name);
      return true;
    }
    return false;
  });
  if (mismatch === null) {
    return null;
  }

  const stepMatch = /^steps\[(\d+)\]$/.exec(mismatch.where);
  if (stepMatch !== null) {
    const stepIndex = Number(stepMatch[1]);
    const stepOp = sequence.steps[stepIndex]?.op ?? 'unknown';
    return { ...mismatch, kind: `step ${stepOp}`, stepIndex };
  }

  const listenerMatch = /^events\.L\d+ (\S+)/.exec(mismatch.where);
  if (listenerMatch !== null) {
    return { ...mismatch, kind: `events ${listenerMatch[1] ?? 'listener'}` };
  }

  return { ...mismatch, kind: mismatch.where };
}

export async function runAll(
  runner: PlaneRunner,
  planes: readonly PlaneName[],
  sequences: Sequence[],
): Promise<Verdict[]> {
  const results = await Promise.all(planes.map((plane) => runner.run(plane, sequences)));
  return sequences.map((sequence, seqIdx) => {
    const outcomes: Record<string, PlaneOutcome> = {};
    planes.forEach((plane, planeIdx) => {
      const planeOutcomes = results[planeIdx];
      const item = planeOutcomes?.[seqIdx];
      if (item !== undefined) {
        outcomes[plane] = item;
      }
    });
    const tolerated = new Set<string>();
    const mismatch = judge(planes, sequence, outcomes, tolerated);
    return { sequence, mismatch, tolerated: [...tolerated] };
  });
}

export function signature(mismatch: ClassifiedMismatch): string {
  const groups = new Map<string, string[]>();
  for (const [plane, value] of Object.entries(mismatch.values)) {
    const key = JSON.stringify(value) ?? 'undefined';
    const existing = groups.get(key) ?? [];
    groups.set(key, [...existing, plane]);
  }
  const encodedGroups = [...groups.values()]
    .map((group) => [...group].sort().join('+'))
    .sort()
    .join('|');
  return `${mismatch.kind}:${encodedGroups}`;
}

export async function shrink(
  runner: PlaneRunner,
  planes: readonly PlaneName[],
  verdict: Verdict,
): Promise<Verdict> {
  if (verdict.mismatch === null) {
    return verdict;
  }
  let best = verdict;
  const target = signature(verdict.mismatch);
  let improved = true;

  while (improved) {
    improved = false;
    const steps = best.sequence.steps;
    const candidates: Sequence[] = [];
    for (
      let size = Math.max(1, Math.floor(steps.length / 2));
      size >= 1;
      size = Math.floor(size / 2)
    ) {
      for (let start = 0; start + size <= steps.length; start += size) {
        candidates.push({
          ...best.sequence,
          steps: [...steps.slice(0, start), ...steps.slice(start + size)],
        });
      }
      if (size === 1) {
        break;
      }
    }
    const verdicts = await runAll(runner, planes, candidates);
    const smaller = verdicts.find(
      (candidate) => candidate.mismatch !== null && signature(candidate.mismatch) === target,
    );
    if (smaller !== undefined) {
      best = smaller;
      improved = true;
    }
  }
  return best;
}

function fixtureFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  if (statSync(path).isFile()) {
    return [path];
  }
  return readdirSync(path)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(path, name));
}

export function readFixtures(path: string): Sequence[] {
  return fixtureFiles(path).map(
    (file) => (JSON.parse(readFileSync(file, 'utf8')) as { sequence: Sequence }).sequence,
  );
}

export function replayCommandFor(seed: number, fixedSteps?: number): string {
  if (fixedSteps !== undefined) {
    return `PYRIC_FS_DIFF_SEED=${seed} PYRIC_FS_DIFF_STEPS=${fixedSteps} bun test --cwd packages/cli ./test/serve/firestore-differential/firestore-differential.gate.ts`;
  }
  return `PYRIC_FS_DIFF_SEED=${seed} bun test --cwd packages/cli ./test/serve/firestore-differential/firestore-differential.gate.ts`;
}

export function formatFailureReport(
  original: Verdict,
  shrunk: Verdict,
  fixedSteps?: number,
): string {
  const mismatch = original.mismatch;
  const shrunkMismatch = shrunk.mismatch;
  if (mismatch === null || shrunkMismatch === null) {
    return '';
  }
  const seed = original.sequence.seed;
  let sizeNote = `${original.sequence.steps.length} steps, not shrunk`;
  if (shrunk !== original) {
    sizeNote = `shrunk from ${original.sequence.steps.length} to ${shrunk.sequence.steps.length} steps`;
  }
  let cliSuffix = '';
  if (fixedSteps !== undefined) {
    cliSuffix = ` --steps=${fixedSteps}`;
  }
  const lines: string[] = [
    `seed ${seed}: ${mismatch.where} (${sizeNote})`,
    `  replay: ${replayCommandFor(seed, fixedSteps)}`,
    `  cli: bun packages/cli/test/serve/firestore-differential/differential.ts --start=${seed} --count=1${cliSuffix}`,
    `  ${shrunkMismatch.where}: ${JSON.stringify(shrunkMismatch.values).slice(0, 1500)}`,
    `  initialRules: ${shrunk.sequence.initialRules}`,
    `  steps: ${JSON.stringify(shrunk.sequence.steps).slice(0, 3000)}`,
  ];
  return lines.join('\n');
}

function parseCliArgs(argv: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const arg of argv) {
    const clean = arg.replace(/^--/, '');
    const eqIndex = clean.indexOf('=');
    if (eqIndex === -1) {
      if (clean.length > 0) {
        parsed[clean] = 'true';
      }
    } else {
      const key = clean.slice(0, eqIndex);
      const value = clean.slice(eqIndex + 1);
      if (key.length > 0) {
        parsed[key] = value;
      }
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const planesRaw = args['planes'] ?? 'sandbox,hosted';
  const planes = planesRaw.split(',').filter((name) => name.length > 0) as PlaneName[];
  reportKnownDivergences(args['strict'] === 'true');

  const envSeed = process.env.PYRIC_FS_DIFF_SEED;
  const envCount = process.env.PYRIC_FS_DIFF_SEEDS;
  const envSteps = process.env.PYRIC_FS_DIFF_STEPS;
  const envChunks = process.env.PYRIC_FS_DIFF_CHUNKS;

  const start = Number(args['start'] ?? envSeed ?? 1);
  let defaultCount = 200;
  if (envSeed !== undefined && args['count'] === undefined && envCount === undefined) {
    defaultCount = 1;
  }
  const count = Number(args['count'] ?? envCount ?? defaultCount);
  const stepsRaw = args['steps'] ?? envSteps;
  let fixedSteps: number | undefined;
  if (stepsRaw !== undefined) {
    fixedSteps = Number(stepsRaw);
  }
  const chunks = Number(args['chunks'] ?? envChunks ?? 2);

  const genOpts: GenerateOptions = {};
  if (fixedSteps !== undefined) {
    genOpts.minSteps = fixedSteps;
    genOpts.maxSteps = fixedSteps;
  }

  let sequences: Sequence[];
  const replayArg = args['replay'];
  if (replayArg !== undefined) {
    sequences = readFixtures(resolve(replayArg));
  } else {
    sequences = Array.from({ length: count }, (_, idx) => generateSequence(start + idx, genOpts));
  }

  const runnerOpts: { chunks: number; targetRepoRoot?: string } = { chunks };
  const targetRepoArg = args['target-repo'];
  if (targetRepoArg !== undefined) {
    runnerOpts.targetRepoRoot = targetRepoArg;
  }

  const runner = await createPlaneRunner(runnerOpts);
  try {
    const began = Date.now();
    const verdicts = await runAll(runner, planes, sequences);
    const mismatched = verdicts.filter((verdict) => verdict.mismatch !== null);
    const elapsedSeconds = Math.round((Date.now() - began) / 1000);
    console.log(`${sequences.length} sequences, ${mismatched.length} mismatched, ${elapsedSeconds} s`);

    const saveDir = args['save'];
    const seenSignatures = new Set<string>();
    for (const verdict of mismatched) {
      if (verdict.mismatch === null) {
        continue;
      }
      const sig = signature(verdict.mismatch);
      let shrunk = verdict;
      if (args['shrink'] !== 'false' && !seenSignatures.has(sig)) {
        shrunk = await shrink(runner, planes, verdict);
      }
      seenSignatures.add(sig);
      console.log(`\n${formatFailureReport(verdict, shrunk, fixedSteps)}`);
      if (saveDir !== undefined) {
        mkdirSync(saveDir, { recursive: true });
        writeFileSync(
          join(saveDir, `seed-${verdict.sequence.seed}.json`),
          `${JSON.stringify({ sequence: shrunk.sequence, mismatch: shrunk.mismatch }, null, 2)}\n`,
        );
      }
    }
    process.exitCode = mismatched.length === 0 ? 0 : 1;
  } finally {
    runner.dispose();
  }
}

if (import.meta.main) {
  await main();
}
