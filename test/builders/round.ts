/**
 * The `round` command: every brief of a round, once per model, at one cap.
 * It checks everything it can before it spends anything (the briefs, the
 * builder, the checkout, that no run of the round exists yet), packs the
 * workspace once, then runs at most two builders at once, each holding a
 * heavy-run slot, each in a sandbox of its own (`builder-run.ts`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeHeavyRunSlot } from '../../scripts/lib/heavy-run-slots.ts';
import { packWorkspace, tarballsIn } from '../apps/install.ts';
import { readBriefs, type Brief } from './brief.ts';
import { claudeBuilder, claudeBuilderProblems, scriptBuilder, type Builder } from './builder-command.ts';
import { runBuilder, runExists } from './builder-run.ts';
import { PreflightFailed, preflightProblems } from './canary/canary.ts';
import { provenance } from './provenance.ts';
import { runId, type RoundOptions } from './round-options.ts';
import { briefsDir, builderSettingsFile } from './round-paths.ts';
import type { RunRecord } from './run-record.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP_BUILDER_SKILL = join(REPO_ROOT, '.agents', 'skills', 'app-builder', 'SKILL.md');

export interface PlannedRun {
  run: string;
  brief: Brief;
  model: string;
}

function say(line: string): void {
  console.log(`▸ ${line}`);
}

/** Each brief once per model, brief by brief, so a stopped round has compared the briefs it reached. */
export function planRuns(briefs: readonly Brief[], models: readonly string[]): PlannedRun[] {
  return briefs.flatMap((brief) => models.map((model) => ({ run: runId(brief.id, model), brief, model })));
}

function whichClaude(): string | undefined {
  const result = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  const path = result.stdout.trim();
  return result.status === 0 && path !== '' ? path : undefined;
}

/** The builder `--builder` names, or what keeps it from starting. */
export function resolveBuilder(name: string): { builder?: Builder; problems: string[] } {
  if (name !== 'claude') {
    const exists = existsSync(name);
    return exists ? { builder: scriptBuilder(name), problems: [] } : { problems: [`the builder script ${name} does not exist`] };
  }
  const options = { claude: whichClaude(), settings: builderSettingsFile(), systemPrompt: APP_BUILDER_SKILL };
  const problems = claudeBuilderProblems(options);
  if (problems.length > 0 || options.claude === undefined) return { problems };
  return { builder: claudeBuilder({ ...options, claude: options.claude }), problems: [] };
}

interface Checked {
  briefs: Brief[];
  builder: Builder;
  runs: PlannedRun[];
}

/** Everything `round` checks before it packs or spends anything. Throws `PreflightFailed` with every problem. */
export function checkRound(options: RoundOptions): Checked {
  const dir = options.briefs ?? briefsDir(options.round);
  const problems: string[] = [];
  const read = existsSync(dir) ? readBriefs(dir) : { briefs: [], errors: [`no briefs directory ${dir}`] };
  problems.push(...read.errors);
  const resolved = resolveBuilder(options.builder);
  problems.push(...resolved.problems);
  problems.push(...preflightProblems(REPO_ROOT, { build: options.build, ...(options.packages === undefined ? {} : { packages: options.packages }) }));
  const runs = planRuns(read.briefs, options.models);
  problems.push(...runs.filter((planned) => runExists(options.round, planned.run)).map((planned) => `run ${planned.run} of round ${options.round} exists already; a round never overwrites a run`));
  if (problems.length > 0 || resolved.builder === undefined) throw new PreflightFailed(`round ${options.round} can't start:\n- ${problems.join('\n- ')}`);
  return { briefs: read.briefs, builder: resolved.builder, runs };
}

/** Runs `work` over `items`, at most `limit` at once. */
export async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type RunResult = { run: string; record: RunRecord } | { run: string; error: string };

function summaryLine(result: RunResult): string {
  if ('error' in result) return `✗ ${result.run}: ${result.error.split('\n')[0]}`;
  const { harness } = result.record;
  const cost = harness.usage === null ? 'no usage' : `$${harness.usage.costUsd.toFixed(2)}`;
  return `${harness.report.state === 'valid' ? '✓' : '✗'} ${result.run}: report ${harness.report.state}, ${harness.problemsReported} problems, ${harness.network.googleEvents.length} Google-host events, ${cost}`;
}

const isCleanRun = (result: RunResult) => !('error' in result) && result.record.harness.report.state === 'valid';

/** Runs the round. Resolves true when every run ended with a valid report. */
export async function runRound(options: RoundOptions): Promise<boolean> {
  const checked = checkRound(options);
  say(`round ${options.round}: ${checked.runs.length} runs (${checked.briefs.length} briefs × ${options.models.length} models), $${options.maxBudgetUsd} cap per run, at most ${options.concurrency} at once, builder ${checked.builder.label}`);
  const tarballs = options.packages === undefined ? await packWorkspace(REPO_ROOT, options.build) : tarballsIn(REPO_ROOT, options.packages);
  const packagesDir = dirname([...tarballs.values()][0] ?? join(REPO_ROOT, 'dist', 'packages'));
  const built = provenance(REPO_ROOT, tarballs);
  const results = await inPool(checked.runs, options.concurrency, async (planned): Promise<RunResult> => {
    const slot = await takeHeavyRunSlot({ command: `bun test/builders/harness.ts round ${options.round} (${planned.run})`, env: { ...process.env } });
    try {
      const identity = { run: planned.run, round: options.round, brief: planned.brief.id, model: planned.model, builder: checked.builder.label, maxBudgetUsd: options.maxBudgetUsd, wallClockMinutes: planned.brief.limits.wallClockMinutes };
      const record = await runBuilder({ identity, brief: planned.brief, builder: checked.builder, tarballs, packagesDir, provenance: built, say });
      return { run: planned.run, record };
    } catch (error) {
      return { run: planned.run, error: error instanceof Error ? error.stack ?? error.message : String(error) };
    } finally {
      slot.release();
    }
  });
  console.log('');
  for (const result of results) console.log(summaryLine(result));
  return results.every(isCleanRun);
}
