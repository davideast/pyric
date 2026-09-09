/**
 * Re-score recorded runs against the current corpus.
 *
 * A results directory keeps every run's copied event log and snapshot, so a
 * corrected assertion or a new metric can be applied to runs already paid for.
 * This reads each run directory, rebuilds its state, re-runs the task's assert,
 * and prints one summary per row and variant. It never spawns anything.
 *
 * Usage: bun eval/rescore.ts <results-dir>... [--json <out.ndjson>]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTasks } from './load.js';
import { buildEvalState } from './state.js';
import type { EvalTask } from './types.js';

interface RescoredRun {
  results: string;
  row: string;
  variant: string;
  task: string;
  seed: number;
  spawn: string;
  pass: boolean;
  reason: string | null;
  firstOperation: string | null;
  firstAccepted: boolean;
  anyAccepted: boolean;
  calls: number;
  rejections: number;
  errorCalls: number;
  durationMs: number;
}

function acceptedBy(task: EvalTask, operation: string | null): boolean {
  if (task.acceptedFirstOperations.length === 0) return true;
  return operation !== null && task.acceptedFirstOperations.includes(operation);
}

/** The spawn outcome and duration the runner recorded for one run. */
function recordedLine(
  resultsDir: string,
  row: string,
  variant: string,
  task: string,
  seed: number,
): { spawn: string; durationMs: number } {
  const path = join(resultsDir, 'runs.ndjson');
  if (!existsSync(path)) return { spawn: 'unknown', durationMs: 0 };
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim().length === 0) continue;
    const line = JSON.parse(raw) as {
      row: string;
      variant: string;
      task: string;
      seed: number;
      outcome: string;
      durationMs: number;
    };
    if (line.row === row && line.variant === variant && line.task === task && line.seed === seed) {
      const spawn = line.outcome === 'pass' || line.outcome === 'fail' ? 'completed' : line.outcome;
      return { spawn, durationMs: line.durationMs };
    }
  }
  return { spawn: 'unknown', durationMs: 0 };
}

async function rescoreDir(resultsDir: string, tasks: Map<string, EvalTask>): Promise<RescoredRun[]> {
  const out: RescoredRun[] = [];
  for (const row of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!row.isDirectory()) continue;
    const rowDir = join(resultsDir, row.name);
    for (const variant of readdirSync(rowDir, { withFileTypes: true })) {
      if (!variant.isDirectory()) continue;
      const variantDir = join(rowDir, variant.name);
      for (const taskEntry of readdirSync(variantDir, { withFileTypes: true })) {
        if (!taskEntry.isDirectory()) continue;
        const task = tasks.get(taskEntry.name);
        if (!task) continue;
        const taskDir = join(variantDir, taskEntry.name);
        for (const seedEntry of readdirSync(taskDir, { withFileTypes: true })) {
          if (!seedEntry.isDirectory()) continue;
          const runDir = join(taskDir, seedEntry.name);
          const eventsPath = join(runDir, 'events.ndjson');
          if (!existsSync(eventsPath)) continue;
          const seed = Number(seedEntry.name);
          const recorded = recordedLine(resultsDir, row.name, variant.name, taskEntry.name, seed);
          const state = await buildEvalState(runDir, eventsPath);
          const verdict = recorded.spawn === 'completed' ? task.assert(state) : 'not completed';
          const operations = state.calls.map((call) => call.operation);
          const firstOperation = operations.find((operation) => operation !== null) ?? null;
          out.push({
            results: resultsDir,
            row: row.name,
            variant: variant.name,
            task: taskEntry.name,
            seed,
            spawn: recorded.spawn,
            pass: verdict === true,
            reason: verdict === true ? null : verdict,
            firstOperation,
            firstAccepted: acceptedBy(task, firstOperation),
            anyAccepted: operations.some((operation) => acceptedBy(task, operation)),
            calls: state.calls.length,
            rejections: state.calls.filter((call) => call.schemaRejected).length,
            errorCalls: state.calls.filter((call) => !call.ok).length,
            durationMs: recorded.durationMs,
          });
        }
      }
    }
  }
  return out;
}

function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a';
  return `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function summarize(runs: RescoredRun[]): void {
  const groups = new Map<string, RescoredRun[]>();
  for (const run of runs) {
    const key = `${run.variant} / ${run.row}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  for (const [key, group] of [...groups.entries()].sort()) {
    const n = group.length;
    const passed = group.filter((run) => run.pass);
    const calls = group.reduce((sum, run) => sum + run.calls, 0);
    const rejections = group.reduce((sum, run) => sum + run.rejections, 0);
    const errors = group.reduce((sum, run) => sum + run.errorCalls, 0);
    const meanCalls = passed.length > 0 ? passed.reduce((sum, run) => sum + run.calls, 0) / passed.length : 0;
    const meanMs = n > 0 ? group.reduce((sum, run) => sum + run.durationMs, 0) / n : 0;
    console.log(`${key}  (${n} runs)`);
    console.log(`  completion              ${percent(passed.length, n)}`);
    console.log(`  first call accepted     ${percent(group.filter((run) => run.firstAccepted).length, n)}`);
    console.log(`  accepted op reached     ${percent(group.filter((run) => run.anyAccepted).length, n)}`);
    console.log(`  runs with a rejection   ${percent(group.filter((run) => run.rejections > 0).length, n)}`);
    console.log(`  rejected calls          ${rejections} of ${calls}`);
    console.log(`  error calls             ${errors} of ${calls}`);
    console.log(`  calls per completion    ${meanCalls.toFixed(2)}`);
    console.log(`  mean duration           ${(meanMs / 1000).toFixed(1)}s`);
  }
}

async function main(argv: string[]): Promise<number> {
  const dirs: string[] = [];
  let jsonOut: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--json') {
      jsonOut = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    dirs.push(token);
  }
  const tasks = await loadTasks();
  const runs: RescoredRun[] = [];
  for (const dir of dirs) runs.push(...(await rescoreDir(dir, tasks)));
  summarize(runs);
  if (jsonOut !== null) {
    writeFileSync(jsonOut, runs.map((run) => JSON.stringify(run)).join('\n') + '\n', 'utf8');
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
