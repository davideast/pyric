/**
 * The runner. For every row, variant, task and seed it prepares a working
 * directory, seeds the sandbox, asks the row's provider for an invocation,
 * spawns it under a hard timeout, then scores the run from the event log and
 * the final state.
 *
 * Nothing about the agent's stdout is evidence. It is captured verbatim for a
 * human, and scoring reads only the server's log and the sandbox.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadRows, loadTasks, selectRecords } from './load.js';
import { applySeed } from './seed.js';
import { buildEvalState } from './state.js';
import { scoreRun, type SpawnOutcome } from './score.js';
import { isThrottled, Pacer, type PacingOptions } from './pacing.js';
import { defaultServerCommand } from './providers/server-env.js';
import { buildInvocation as buildClaude } from './providers/claude.js';
import { buildInvocation as buildCodex } from './providers/codex.js';
import { buildInvocation as buildAntigravity } from './providers/antigravity.js';
import { buildInvocation as buildFake } from './providers/fake.js';
import type { BuildInvocation, EvalResultLine, EvalRow, EvalRun, EvalTask } from './types.js';

/** The four surface variants under test, in the order the contract lists them. */
export const DEFAULT_VARIANTS = [
  'discriminator',
  'verb-prefixed',
  'noun-prefixed',
  'verb-suffixed',
] as const;

/** Ceiling for one agent process. Above the longest provider print timeout. */
export const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;

/** The events file name inside a run directory, exported as `PYRIC_EVAL_LOG`. */
export const EVENTS_FILE = 'events.ndjson';
export const RESULTS_FILE = 'runs.ndjson';

const PROVIDERS: Record<string, BuildInvocation> = {
  claude: buildClaude,
  codex: buildCodex,
  antigravity: buildAntigravity,
  fake: buildFake,
};

export interface RunnerOptions {
  repoRoot: string;
  resultsDir: string;
  runId: string;
  rows: EvalRow[];
  tasks: EvalTask[];
  variants: string[];
  /** Restricts each row's own seed list. Empty means the row decides. */
  seeds: number[];
  dryRun: boolean;
  timeoutMs: number;
  pacing: PacingOptions;
  /** Overrides the MCP server command, so a test can drive a stand-in server. */
  serverCommand?: (variant: string) => string[];
  /** Provider override, so a test can force the fake provider for a real row. */
  providerFor?: (row: EvalRow) => BuildInvocation;
  /** Canned calls handed to the fake provider, keyed by task id. */
  transcripts?: Record<string, Array<{ tool: string; args: Record<string, unknown> }>>;
}

/** The seeds one row contributes, narrowed by an explicit selection. */
function seedsFor(row: EvalRow, selection: number[]): number[] {
  if (selection.length === 0) return row.seeds;
  return row.seeds.filter((seed) => selection.includes(seed));
}

/** Every run the options describe, in a stable order. */
export function planRuns(options: RunnerOptions): EvalRun[] {
  const runs: EvalRun[] = [];
  for (const row of options.rows) {
    for (const variant of options.variants) {
      for (const task of options.tasks) {
        for (const seed of seedsFor(row, options.seeds)) {
          const dir = join(
            options.resultsDir,
            options.runId,
            row.id,
            variant,
            task.id,
            String(seed),
          );
          const serverCommand =
            options.serverCommand?.(variant) ?? defaultServerCommand(options.repoRoot, variant);
          const run: EvalRun = {
            runId: options.runId,
            row,
            variant,
            task,
            seed,
            dir,
            eventsPath: join(dir, EVENTS_FILE),
            serverCommand,
            repoRoot: options.repoRoot,
          };
          const transcript = options.transcripts?.[task.id];
          if (transcript !== undefined) run.fakeTranscript = transcript;
          runs.push(run);
        }
      }
    }
  }
  return runs;
}

/** The provider module for one row, unless the caller forced another. */
function providerFor(options: RunnerOptions, row: EvalRow): BuildInvocation {
  const forced = options.providerFor?.(row);
  if (forced !== undefined) return forced;
  const provider = PROVIDERS[row.cli];
  if (provider === undefined) throw new Error(`no provider for cli ${row.cli}`);
  return provider;
}

interface SpawnReport {
  outcome: SpawnOutcome;
  durationMs: number;
}

/**
 * Spawn one invocation, capturing both streams to files. A process still
 * running at the timeout is killed and reported as a timeout; a nonzero exit
 * carrying a rate-limit signal is reported as throttled; any other nonzero exit
 * is a crash.
 */
async function spawnInvocation(
  run: EvalRun,
  command: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SpawnReport> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error(`run ${run.runId} has an empty command`);

  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  const child = spawn(executable, args, {
    cwd: run.dir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.on('error', () => resolveExit(null));
    child.on('close', (code) => resolveExit(code));
  });
  clearTimeout(timer);

  writeFileSync(join(run.dir, 'stdout.log'), stdout, 'utf8');
  writeFileSync(join(run.dir, 'stderr.log'), stderr, 'utf8');

  const durationMs = Date.now() - startedAt;
  if (timedOut) return { outcome: 'timeout', durationMs };
  if (isThrottled(exitCode, stderr)) return { outcome: 'throttled', durationMs };
  if (exitCode !== 0) return { outcome: 'crash', durationMs };
  return { outcome: 'completed', durationMs };
}

/** Prepare the working directory, the seed state and the provider's files. */
async function prepareRun(
  run: EvalRun,
  build: BuildInvocation,
): Promise<{ command: string[]; env: Record<string, string> }> {
  mkdirSync(run.dir, { recursive: true });
  await applySeed(run.dir, run.task.seed);
  const invocation = build(run);
  for (const [relativePath, contents] of Object.entries(invocation.files)) {
    const target = join(run.dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  writeFileSync(join(run.dir, EVENTS_FILE), '', 'utf8');
  return { command: invocation.command, env: invocation.env };
}

/** Execute the plan and append one result line per run. Returns those lines. */
export async function runAll(options: RunnerOptions): Promise<EvalResultLine[]> {
  const runs = planRuns(options);
  const resultsPath = join(options.resultsDir, options.runId, RESULTS_FILE);
  mkdirSync(dirname(resultsPath), { recursive: true });

  const pacer = new Pacer(options.pacing);
  const lines: EvalResultLine[] = [];
  for (const run of runs) {
    const build = providerFor(options, run.row);
    const prepared = await prepareRun(run, build);

    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify({ dir: run.dir, ...prepared })}\n`);
      continue;
    }

    let report: SpawnReport = { outcome: 'throttled', durationMs: 0 };
    if (pacer.hasBudget(run.row.cli)) {
      report = await pacer.run(run.row.cli, () =>
        spawnInvocation(run, prepared.command, prepared.env, options.timeoutMs),
      );
    }

    const state = await buildEvalState(run.dir, run.eventsPath);
    const line = scoreRun({ run, spawn: report.outcome, durationMs: report.durationMs, state });
    appendFileSync(resultsPath, `${JSON.stringify(line)}\n`, 'utf8');
    lines.push(line);
  }
  return lines;
}

/** Parse `--flag value` pairs and boolean flags out of the argument list. */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[name] = true;
      continue;
    }
    parsed[name] = next;
    index += 1;
  }
  return parsed;
}

/** Split a comma-separated flag value. An absent flag selects everything. */
function splitList(value: string | boolean | undefined): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv);
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const allRows = await loadRows();
  const allTasks = await loadTasks();

  const variantSelection = splitList(flags.variants);
  const seedSelection = splitList(flags.seeds).map((seed) => Number(seed));
  const timeout = typeof flags.timeout === 'string' ? Number(flags.timeout) : DEFAULT_TIMEOUT_MS;
  const minGap = typeof flags['min-gap'] === 'string' ? Number(flags['min-gap']) : 5_000;
  const budget = typeof flags.budget === 'string' ? Number(flags.budget) : 200;

  const options: RunnerOptions = {
    repoRoot,
    resultsDir: join(import.meta.dirname, 'results'),
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    rows: selectRecords(allRows, splitList(flags.rows)),
    tasks: selectRecords(allTasks, splitList(flags.tasks)),
    variants: variantSelection.length > 0 ? variantSelection : [...DEFAULT_VARIANTS],
    seeds: seedSelection,
    dryRun: flags['dry-run'] === true,
    timeoutMs: timeout,
    pacing: { minGapMs: minGap, budgetPerWindow: budget },
  };

  const lines = await runAll(options);
  process.stderr.write(`${lines.length} runs recorded under ${options.runId}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
