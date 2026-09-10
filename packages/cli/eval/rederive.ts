/**
 * Results-directory rederivation. Walks a results directory
 * (`<runId>/<row>/<variant>/<task>/<seed>/`), rebuilds each run's state from
 * its event log, and re-scores it against the current corpus rather than
 * trusting the recorded `runs.ndjson` line verbatim.
 *
 * This is what makes a corrected assertion or a fixed classifier apply to
 * runs already paid for, and what makes a harness crash recoverable when the
 * event log proves the CLI itself ran. It folds what used to be
 * `rescore.ts` into the reporting tool.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { classifyRunOutcome } from './outcome.js';
import { scoreRun } from './score.js';
import { buildEvalState } from './state.js';
import type { EvalResultLine, EvalRow, EvalRun, EvalState, EvalTask } from './types.js';

export const RUNS_FILE_NAME = 'runs.ndjson';

/** Read every result line out of one NDJSON file, or the empty list when it is missing. */
export function readNdjsonLines(path: string): EvalResultLine[] {
  if (!existsSync(path)) return [];
  const runs: EvalResultLine[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    runs.push(JSON.parse(trimmed) as EvalResultLine);
  }
  return runs;
}

/** Directory entries that are themselves directories, sorted for a stable walk. */
function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Joins the fields that identify one run, for matching a recorded line to its directory. */
function runKey(row: string, variant: string, task: string, seed: number): string {
  return `${row} ${variant} ${task} ${seed}`;
}

/** Outcomes worth re-deriving: a completed run, or a crash that still has its log. */
const RESCORABLE_OUTCOMES: ReadonlySet<string> = new Set(['pass', 'fail', 'crash']);

/**
 * Options for `rederiveResultsDirectory` and `loadRunLines`. Both default to
 * the real corpus and matrix; tests inject their own so a directory can be
 * re-derived without depending on the checked-in records.
 */
export interface LoadRunLinesOptions {
  tasks?: Map<string, EvalTask>;
  rows?: Map<string, EvalRow>;
}

/**
 * Whether a run the runner recorded as a crash may be re-scored from its log.
 *
 * The runner writes an empty `events.ndjson` while it prepares a run, so the
 * file existing proves nothing. Only a log with at least one recorded call
 * proves the CLI itself ran and used the surface, which is what makes
 * `completed` an honest base to re-score from: the crash was then the harness
 * failing afterward, during collection or scoring. An empty log means the
 * harness died before or during the spawn, and scoring the task's assertion
 * against a sandbox the CLI never touched would report a harness failure as a
 * design failure.
 */
function crashRecoveredByLog(state: EvalState): boolean {
  return state.calls.length > 0;
}

/**
 * One run directory's line, re-derived from its event log rather than trusted
 * from `runs.ndjson`, or null when the log does not support re-deriving it and
 * the recorded line stands. The recorded outcome supplies the duration and
 * decides whether a crash is recoverable; everything about whether the task
 * passed comes fresh from the log and the current corpus.
 */
async function rederiveRun(
  runDir: string,
  runId: string,
  row: EvalRow,
  variant: string,
  task: EvalTask,
  seed: number,
  recorded: EvalResultLine | undefined,
): Promise<EvalResultLine | null> {
  const eventsPath = join(runDir, 'events.ndjson');
  const state = await buildEvalState(runDir, eventsPath);

  const recordedCrash = recorded === undefined || recorded.outcome === 'crash';
  if (recordedCrash && !crashRecoveredByLog(state)) return null;

  const priorDurationMs = recorded?.durationMs ?? 0;
  const refined = classifyRunOutcome(row.cli, 'completed', runDir, state.calls.length);
  const run: EvalRun = {
    runId,
    row,
    variant,
    task,
    seed,
    dir: runDir,
    workspaceDir: join(runDir, 'workspace'),
    stateDir: runDir,
    eventsPath,
    serverCommand: [],
    repoRoot: runDir,
  };
  return scoreRun({ run, spawn: refined, durationMs: priorDurationMs, state });
}

/** A row for a directory name the matrix no longer names, so classification still runs. */
function fallbackRow(rowId: string): EvalRow {
  return { id: rowId, cli: rowId as EvalRow['cli'], model: 'unknown', condition: 'agent-default', seeds: [] };
}

/**
 * Walk one results directory (`<runId>/<row>/<variant>/<task>/<seed>/`) and
 * produce one result line per run, re-deriving every run whose event log is
 * intact and whose recorded outcome (or absence of one) means the process
 * completed or crashed after the CLI had already run.
 */
export async function rederiveResultsDirectory(
  resultsDir: string,
  tasks: Map<string, EvalTask>,
  rows: Map<string, EvalRow>,
): Promise<EvalResultLine[]> {
  const runId = basename(resultsDir);
  const recorded = new Map<string, EvalResultLine>();
  for (const line of readNdjsonLines(join(resultsDir, RUNS_FILE_NAME))) {
    recorded.set(runKey(line.row, line.variant, line.task, line.seed), line);
  }

  const out: EvalResultLine[] = [];
  for (const rowId of listDirs(resultsDir)) {
    const row = rows.get(rowId) ?? fallbackRow(rowId);
    for (const variant of listDirs(join(resultsDir, rowId))) {
      for (const taskId of listDirs(join(resultsDir, rowId, variant))) {
        const task = tasks.get(taskId);
        if (task === undefined) continue;
        for (const seedName of listDirs(join(resultsDir, rowId, variant, taskId))) {
          const seed = Number(seedName);
          const runDir = join(resultsDir, rowId, variant, taskId, seedName);
          const existing = recorded.get(runKey(rowId, variant, taskId, seed));
          const eventsPath = join(runDir, 'events.ndjson');

          const rescorable = existing === undefined || RESCORABLE_OUTCOMES.has(existing.outcome);
          if (!rescorable || !existsSync(eventsPath)) {
            if (existing !== undefined) out.push(existing);
            continue;
          }

          const rederived = await rederiveRun(runDir, runId, row, variant, task, seed, existing);
          if (rederived !== null) {
            out.push(rederived);
            continue;
          }
          if (existing !== undefined) out.push(existing);
        }
      }
    }
  }
  return out;
}
