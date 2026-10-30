/**
 * The `round` command: every brief of a round, once per model, at one cap.
 * It checks everything it can before it spends anything (the briefs, the
 * builder and its settings, the token, the checkout, that no run of the round
 * exists yet, that the runs at their cap fit under the round's), packs the workspace once, then runs
 * at most two builders at once, each holding a heavy-run slot, each in a
 * sandbox of its own (`builder-run.ts`). One meter covers the round: the
 * model forwarder refuses a run's requests once it has spent its cap, and
 * every run's once the round has spent its total.
 *
 * When a run's sandbox can't start, no later run's can either: the round
 * starts no more runs, lets the ones under way finish, and throws
 * `NamespaceUnavailable`, so the command exits 2.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeHeavyRunSlot } from '../../scripts/lib/heavy-run-slots.ts';
import { packWorkspace, tarballsIn } from '../apps/install.ts';
import { readBriefsDir, type Brief } from './brief.ts';
import { claudeBuilder, claudeBuilderProblems, scriptBuilder, type Builder } from './builder-command.ts';
import { runBuilder, runExists, type BuilderRunInput } from './builder-run.ts';
import { harnessToken, NO_TOKEN_PROBLEM } from './harness-token.ts';
import { PreflightFailed, preflightProblems } from './canary/canary.ts';
import { roundMeter, type RoundMeter } from './model-meter.ts';
import { NamespaceUnavailable } from './namespace.ts';
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

/** The most a round can spend: every run at its cap. */
export const possibleSpendUsd = (runs: number, maxBudgetUsd: number) => runs * maxBudgetUsd;

const dollars = (usd: number) => `$${usd.toFixed(2)}`;

/** Whether the round's runs, each at its cap, fit under the round's cap. */
export function spendProblems(runs: number, options: Pick<RoundOptions, 'maxBudgetUsd' | 'maxRoundUsd'>): string[] {
  const possible = possibleSpendUsd(runs, options.maxBudgetUsd);
  const fits = possible <= options.maxRoundUsd + 1e-9;
  if (fits) return [];
  return [`${runs} runs at ${dollars(options.maxBudgetUsd)} each could spend ${dollars(possible)}, over --max-round-usd ${dollars(options.maxRoundUsd)}`];
}

interface Checked {
  briefs: Brief[];
  builder: Builder;
  runs: PlannedRun[];
  /** The forwarder's token. Never printed, recorded or passed into a sandbox. */
  token: string | undefined;
  /** What to tell the owner about the token's source. */
  notices: string[];
}

/** The forwarder's token, and what keeps it from being read; a model builder needs one. */
function checkToken(options: RoundOptions): { token: string | undefined; problems: string[]; notices: string[] } {
  const read = harnessToken(options.tokenFile);
  const usesModel = options.builder === 'claude';
  const isMissing = usesModel && read.token === undefined && read.problems.length === 0;
  return isMissing ? { ...read, problems: [NO_TOKEN_PROBLEM] } : read;
}

/** Everything `round` checks before it packs or spends anything. Throws `PreflightFailed` with every problem. */
export function checkRound(options: RoundOptions): Checked {
  const dir = options.briefs ?? briefsDir(options.round);
  const problems: string[] = [];
  const read = readBriefsDir(dir);
  problems.push(...read.errors);
  const resolved = resolveBuilder(options.builder);
  problems.push(...resolved.problems);
  const token = checkToken(options);
  problems.push(...token.problems);
  problems.push(...preflightProblems(REPO_ROOT, { build: options.build, ...(options.packages === undefined ? {} : { packages: options.packages }) }));
  const runs = planRuns(read.briefs, options.models);
  problems.push(...spendProblems(runs.length, options));
  problems.push(...runs.filter((planned) => runExists(options.round, planned.run)).map((planned) => `run ${planned.run} of round ${options.round} exists already; a round never overwrites a run`));
  if (problems.length > 0 || resolved.builder === undefined) throw new PreflightFailed(`round ${options.round} can't start:\n- ${problems.join('\n- ')}`);
  return { briefs: read.briefs, builder: resolved.builder, runs, token: token.token, notices: token.notices };
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

export type RunResult =
  | { run: string; record: RunRecord }
  | { run: string; error: string }
  | { run: string; skipped: string };

function costLine(record: RunRecord): string {
  const { usage, meteredCostUsd } = record.harness;
  const claude = usage === null ? 'no usage from claude' : dollars(usage.costUsd);
  return `${claude}, ${dollars(meteredCostUsd)} metered`;
}

function summaryLine(result: RunResult): string {
  if ('skipped' in result) return `- ${result.run}: not started (${result.skipped})`;
  if ('error' in result) return `✗ ${result.run}: ${result.error.split('\n')[0]}`;
  const { harness } = result.record;
  const mark = harness.report.state === 'valid' ? '✓' : '✗';
  return `${mark} ${result.run}: report ${harness.report.state}, ${harness.problemsReported} problems, ${harness.network.googleEvents.length} Google-host events, ${costLine(result.record)}`;
}

const isCleanRun = (result: RunResult) => 'record' in result && result.record.harness.report.state === 'valid';

function startLine(options: RoundOptions, checked: Checked): string {
  const { runs, briefs, builder } = checked;
  const possible = dollars(possibleSpendUsd(runs.length, options.maxBudgetUsd));
  return [
    `round ${options.round}: ${runs.length} runs (${briefs.length} briefs × ${options.models.length} models)`,
    `${dollars(options.maxBudgetUsd)} cap per run, possible spend ${possible} under a round cap of ${dollars(options.maxRoundUsd)}`,
    `at most ${options.concurrency} at once, builder ${builder.label}`,
  ].join(', ');
}

interface RoundContext {
  options: RoundOptions;
  checked: Checked;
  meter: RoundMeter;
  /** What every run of the round shares. */
  base: Omit<BuilderRunInput, 'identity' | 'brief' | 'meter'>;
}

async function runOne(context: RoundContext, planned: PlannedRun): Promise<RunResult> {
  const { options, checked } = context;
  const slot = await takeHeavyRunSlot({ command: `bun test/builders/harness.ts round ${options.round} (${planned.run})`, env: { ...process.env } });
  try {
    const identity = { run: planned.run, round: options.round, brief: planned.brief.id, model: planned.model, builder: checked.builder.label, maxBudgetUsd: options.maxBudgetUsd, wallClockMinutes: planned.brief.limits.wallClockMinutes };
    const record = await runBuilder({ ...context.base, identity, brief: planned.brief, meter: context.meter.run(options.maxBudgetUsd) });
    return { run: planned.run, record };
  } finally {
    slot.release();
  }
}

/**
 * Runs the round. Resolves true when every run ended with a valid report.
 * Throws `NamespaceUnavailable` when a run's sandbox could not start.
 */
export async function runRound(options: RoundOptions): Promise<boolean> {
  const checked = checkRound(options);
  for (const notice of checked.notices) say(notice);
  say(startLine(options, checked));
  const tarballs = options.packages === undefined ? await packWorkspace(REPO_ROOT, options.build) : tarballsIn(REPO_ROOT, options.packages);
  const packagesDir = dirname([...tarballs.values()][0] ?? join(REPO_ROOT, 'dist', 'packages'));
  const context: RoundContext = {
    options,
    checked,
    meter: roundMeter(options.maxRoundUsd),
    base: { builder: checked.builder, token: checked.token, tarballs, packagesDir, provenance: provenance(REPO_ROOT, tarballs), say },
  };
  let unavailable: NamespaceUnavailable | undefined;
  const results = await inPool(checked.runs, options.concurrency, async (planned): Promise<RunResult> => {
    if (unavailable !== undefined) return { run: planned.run, skipped: 'no sandbox could start' };
    try {
      return await runOne(context, planned);
    } catch (error) {
      if (error instanceof NamespaceUnavailable) unavailable = error;
      return { run: planned.run, error: error instanceof Error ? error.stack ?? error.message : String(error) };
    }
  });
  console.log('');
  for (const result of results) console.log(summaryLine(result));
  say(`round ${options.round} spent ${dollars(context.meter.spentUsd())} metered of its ${dollars(options.maxRoundUsd)} cap`);
  if (unavailable !== undefined) throw unavailable;
  return results.every(isCleanRun);
}
