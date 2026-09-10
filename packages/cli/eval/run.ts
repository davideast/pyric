/**
 * The runner. For every row, variant, task and seed it prepares a workspace and
 * a state directory, seeds the sandbox, asks the row's provider for an
 * invocation, spawns it under a hard timeout, then scores the run from the event
 * log and the final state.
 *
 * Nothing about the agent's stdout is evidence. It is captured verbatim for a
 * human, and scoring reads only the server's log and the sandbox.
 *
 * ## Three directories, because the state is what is being measured
 *
 * A CLI with built-in file tools can answer a task by reading the sandbox state
 * off disk instead of calling a single MCP tool, and the run then measures the
 * agent's file reading rather than the tool surface. So no run puts the state
 * where the agent is:
 *
 *   run directory        `<results>/<row>/<variant>/<task>/<seed>/`
 *     Results and the provider config files the CLI takes by path. The CLI is
 *     never started here and is never handed this path.
 *   workspace            `<run>/workspace/`
 *     Where the CLI is started, and the only directory a provider may name in a
 *     directory flag. Holds nothing but the files a provider has no other way to
 *     deliver, which today is Antigravity's `.agents/mcp_config.json`.
 *   state directory      `<tmpdir>/pyric-eval/<runId>/<row>/<variant>/<task>/<seed>/`
 *     The seeded rules files, `.pyric/state/in-process.json`, the storage sidecar
 *     and `events.ndjson`. Outside the results tree entirely, so no relative
 *     walk from the workspace reaches it. Copied into the run directory after
 *     the process exits, so results stay self-contained, then deleted.
 *
 * ## What this closes, and what it does not
 *
 * The state directory still has to reach the server somehow, and the server is
 * spawned by the CLI from an MCP config the agent can read. So the path is not
 * in that config at all. Every run-specific variable, `PYRIC_PROJECT_DIR`,
 * `PYRIC_EVAL_LOG` and the `PYRIC_EVAL_*` run block, is set on the CLI process
 * itself, and the server the CLI spawns inherits it. A config file carries only
 * `PYRIC_TOOL_SURFACE`, which the argument list already shows. An agent that
 * reads its own configuration finds no path to follow.
 *
 * `assertNoLeakedPaths` enforces that for every file a provider puts in the
 * workspace, and throws rather than skipping, because a silent skip would let a
 * leaking provider produce numbers that look like measurements.
 *
 * Reading the process environment is still open to an agent that thinks to look.
 * The only fully closed condition is `mcp-only` on Claude Code, where the
 * built-in tools are withdrawn and the surface under test is the only way to
 * touch anything. Every other row is measured knowing that.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadRows, loadTasks, selectRecords } from './load.js';
import { applySeed } from './seed.js';
import { buildEvalState, emptyEvalState } from './state.js';
import { scoreRun, type SpawnOutcome } from './score.js';
import { classifyRunOutcome } from './outcome.js';
import { DEFAULT_BUDGET_PER_WINDOW, isThrottled, Pacer, type PacingOptions } from './pacing.js';
import { defaultServerCommand, spawnEnv } from './providers/server-env.js';
import { IN_PROCESS_STATE_RELATIVE } from '../src/bridge/server/in-process.js';
import { STORAGE_SIDECAR_RELATIVE } from './storage-sidecar.js';
import { buildInvocation as buildClaude } from './providers/claude.js';
import { buildInvocation as buildCodex } from './providers/codex.js';
import { buildInvocation as buildAntigravity } from './providers/antigravity.js';
import { buildInvocation as buildFake, type FakeCall } from './providers/fake.js';
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

/** The events file name inside a state directory, exported as `PYRIC_EVAL_LOG`. */
export const EVENTS_FILE = 'events.ndjson';
export const RESULTS_FILE = 'runs.ndjson';

/** The directory inside a run directory the CLI is started in. */
export const WORKSPACE_DIR = 'workspace';

/** Where state directories live: under the OS temp root, never under results. */
export const STATE_ROOT = join(tmpdir(), 'pyric-eval');

/**
 * Where results live by default: under the OS temp root, never under the repo.
 * A run directory holds the CLI's raw output and, for a provider that takes a
 * config by path, the config file itself. A trusted-workspace agent that reads
 * everything under its own repository must never find a corpus answer there,
 * so results move out of the tree entirely. `--results-dir` overrides this.
 */
export const RESULTS_ROOT = join(tmpdir(), 'pyric-eval', 'results');

/** Resolve the results directory from parsed flags, defaulting to `RESULTS_ROOT`. */
export function resolveResultsDir(flags: Record<string, string | boolean>): string {
  const override = flags['results-dir'];
  if (typeof override === 'string') return override;
  return RESULTS_ROOT;
}

/**
 * What is copied out of the state directory into the run directory once the
 * process has exited, so a finished result carries its own evidence.
 */
export const COLLECTED_FILES = [
  EVENTS_FILE,
  IN_PROCESS_STATE_RELATIVE,
  STORAGE_SIDECAR_RELATIVE,
] as const;

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
  /** Root of the state directories. Defaults to `STATE_ROOT` under the temp dir. */
  stateRoot?: string;
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
          const leaf = join(options.runId, row.id, variant, task.id, String(seed));
          const dir = join(options.resultsDir, leaf);
          const stateDir = join(options.stateRoot ?? STATE_ROOT, leaf);
          const serverCommand =
            options.serverCommand?.(variant) ?? defaultServerCommand(options.repoRoot, variant);
          const run: EvalRun = {
            runId: options.runId,
            row,
            variant,
            task,
            seed,
            dir,
            workspaceDir: join(dir, WORKSPACE_DIR),
            stateDir,
            eventsPath: join(stateDir, EVENTS_FILE),
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
    // The workspace, never the run directory: what the process can see from its
    // own cwd is part of what the run measures.
    cwd: run.workspaceDir,
    env: spawnEnv(process.env, env),
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

/** Write one provider file, creating the directories above it. */
function writeProviderFiles(base: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(base, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
}

/**
 * Refuse to write a workspace file that names the state directory or the events
 * file. The agent can read everything in its workspace, so a path written there
 * is a path it can follow, and the run would then measure file reading rather
 * than the tool surface. This throws instead of dropping the file, because a run
 * that quietly changed what it measures is worse than a run that stops.
 */
/**
 * A harness invariant was broken. Unlike a task that failed to seed or a CLI
 * that crashed, this means the sweep itself would measure the wrong thing, so
 * it stops the sweep rather than becoming one crash line.
 */
export class HarnessInvariantError extends Error {}

export function assertNoLeakedPaths(run: EvalRun, workspaceFiles: Record<string, string>): void {
  // The events path sits inside the state directory, so it is tested first and
  // the message names the most specific thing that was leaked.
  const secrets: Array<[string, string]> = [
    ['the events path', run.eventsPath],
    ['the state directory', run.stateDir],
  ];
  for (const [relativePath, contents] of Object.entries(workspaceFiles)) {
    for (const [label, secret] of secrets) {
      if (secret.length > 0 && contents.includes(secret)) {
        throw new HarnessInvariantError(
          `provider for ${run.row.cli} put ${label} in the workspace file ${relativePath}`,
        );
      }
    }
  }
}

/**
 * Prepare the run directory, the empty workspace, the seeded state directory and
 * the provider's files. The seed lands in the state directory, so the workspace
 * the CLI is started in holds only what the provider had to put there.
 */
async function prepareRun(
  run: EvalRun,
  build: BuildInvocation,
): Promise<{ command: string[]; env: Record<string, string> }> {
  mkdirSync(run.dir, { recursive: true });
  mkdirSync(run.workspaceDir, { recursive: true });
  mkdirSync(run.stateDir, { recursive: true });
  await applySeed(run.stateDir, run.task.seed);
  const invocation = build(run);
  assertNoLeakedPaths(run, invocation.workspaceFiles);
  writeProviderFiles(run.dir, invocation.files);
  writeProviderFiles(run.workspaceDir, invocation.workspaceFiles);
  writeFileSync(run.eventsPath, '', 'utf8');
  return { command: invocation.command, env: invocation.env };
}

/**
 * Copy the evidence out of the state directory into the run directory and drop
 * the state directory. Scoring then reads the copies, so a results tree is
 * complete on its own and no temporary directory outlives the run that made it.
 */
function collectState(run: EvalRun): void {
  for (const relativePath of COLLECTED_FILES) {
    const source = join(run.stateDir, relativePath);
    if (!existsSync(source)) continue;
    const target = join(run.dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  rmSync(run.stateDir, { recursive: true, force: true });
}

/** Execute the plan and append one result line per run. Returns those lines. */
export async function runAll(options: RunnerOptions): Promise<EvalResultLine[]> {
  const runs = planRuns(options);
  const resultsPath = join(options.resultsDir, options.runId, RESULTS_FILE);
  mkdirSync(dirname(resultsPath), { recursive: true });

  const pacer = new Pacer(options.pacing);
  const lines: EvalResultLine[] = [];
  for (const run of runs) {
    // One task's failure to seed, spawn, or score must never end the sweep:
    // it is recorded as a crash line and the next run proceeds.
    try {
      const line = await runOne(options, run, pacer, resultsPath);
      if (line) lines.push(line);
    } catch (error) {
      if (error instanceof HarnessInvariantError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const line = scoreRun({
        run,
        spawn: 'crash',
        durationMs: 0,
        state: emptyEvalState(),
        crashReason: message,
      });
      appendFileSync(resultsPath, `${JSON.stringify(line)}\n`, 'utf8');
      lines.push(line);
    }
  }
  return lines;
}

/**
 * The ledger a run is metered against. A run that replays a canned transcript
 * calls no model, so it spends no metered account and must not consume a real
 * CLI's window: it meters under its own name instead.
 */
export const REPLAY_LEDGER_KEY = 'replay';

function ledgerKeyFor(options: RunnerOptions, run: EvalRun): string {
  if (options.transcripts !== undefined) return REPLAY_LEDGER_KEY;
  return run.row.cli;
}

/** Prepare, spawn, collect, and score one run. Returns null for a dry run. */
async function runOne(
  options: RunnerOptions,
  run: EvalRun,
  pacer: Pacer,
  resultsPath: string,
): Promise<EvalResultLine | null> {
  const build = providerFor(options, run.row);
  const prepared = await prepareRun(run, build);

  if (options.dryRun) {
    const layout = { dir: run.dir, workspace: run.workspaceDir, state: run.stateDir };
    process.stdout.write(`${JSON.stringify({ ...layout, ...prepared })}\n`);
    return null;
  }

  const ledgerKey = ledgerKeyFor(options, run);
  let report: SpawnReport = { outcome: 'throttled', durationMs: 0 };
  const budget = await pacer.reserveBudget(ledgerKey);
  if (budget === 'ready') {
    report = await pacer.run(ledgerKey, () =>
      spawnInvocation(run, prepared.command, prepared.env, options.timeoutMs),
    );
  }

  collectState(run);
  const state = await buildEvalState(run.dir, join(run.dir, EVENTS_FILE));
  // The stdout and stderr the process just wrote may carry a quota refusal, a
  // cut-off stream, or built-in tool use, none of which the event log or the
  // sandbox can show. This only ever narrows a completed or crashed outcome.
  const refinedOutcome = classifyRunOutcome(
    run.row.cli,
    report.outcome,
    run.dir,
    state.calls.length,
  );
  const line = scoreRun({ run, spawn: refinedOutcome, durationMs: report.durationMs, state });
  appendFileSync(resultsPath, `${JSON.stringify(line)}\n`, 'utf8');
  return line;
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

/**
 * Read the canned transcripts a replay run drives the real binary with, from a
 * JSON object keyed by task id. The transcripts are a harness input rather than
 * a corpus property, so they live in a file the caller names instead of on the
 * task record, which states only what the agent is asked and what must be true
 * afterwards.
 */
export function readTranscripts(path: string): Record<string, FakeCall[]> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, FakeCall[]>;
  for (const [taskId, calls] of Object.entries(parsed)) {
    if (!Array.isArray(calls)) throw new Error(`transcript for ${taskId} is not a list of calls`);
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
  const budget =
    typeof flags.budget === 'string' ? Number(flags.budget) : DEFAULT_BUDGET_PER_WINDOW;
  const noWait = flags['no-wait'] === true;
  const resultsDir = resolveResultsDir(flags);

  const options: RunnerOptions = {
    repoRoot,
    resultsDir,
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    rows: selectRecords(allRows, splitList(flags.rows)),
    tasks: selectRecords(allTasks, splitList(flags.tasks)),
    variants: variantSelection.length > 0 ? variantSelection : [...DEFAULT_VARIANTS],
    seeds: seedSelection,
    dryRun: flags['dry-run'] === true,
    timeoutMs: timeout,
    pacing: { minGapMs: minGap, budgetPerWindow: budget, noWait },
  };

  // Naming a transcript file selects the fake provider: the replay client
  // drives the real server over stdio with canned calls, so the whole pipeline
  // runs without a model and without spending a metered account.
  if (typeof flags.transcripts === 'string') {
    options.transcripts = readTranscripts(flags.transcripts);
    options.providerFor = () => buildFake;
  }

  process.stderr.write(`results directory: ${resultsDir}\n`);
  const lines = await runAll(options);
  process.stderr.write(`${lines.length} runs recorded under ${options.runId}\n`);
  process.stderr.write(`results directory: ${join(resultsDir, options.runId)}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
