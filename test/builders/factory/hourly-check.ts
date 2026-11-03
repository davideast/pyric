/**
 * The hourly check (`HourlyCheck` in `session.ts`). For the roles' current
 * commit it passes only when every gate passes (`gates.ts`, `hour-gates.ts`).
 *
 * It fetches the commit from the roles' clone into the harness's bare repo
 * (`git.ts`) and checks it in a fresh tree (`check-run.ts`): the UI scans,
 * the install, Studio's start and the walks from the walk sandbox, then
 * Studio's typecheck, tests and ast-grep checks. The baseline is taken the
 * same way at the start commit (`baseline.ts`).
 *
 * It writes `<run>.host/checks/hour-<n>.<stamp>/` (`check-output.ts`) and
 * points `hour-<n>` and `latest` at it, also when the check throws. A pass
 * records the commit as the last good one; a commit that passed the serve
 * gates is served, labelled with the gates it fails (`serve-newest.ts`),
 * and the summary names the served commit, its label and its status page. The whole check stops at the supervisor's signal or after
 * its budget, 50 minutes unless `PYRIC_FACTORY_CHECK_MINUTES` says. The
 * supervisor writes the result into `latest-check.json`, the extra fields
 * included.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appPaths, type AppPaths } from './app-paths.ts';
import { readAppRecord, type AppRecord } from './app-setup.ts';
import type { WalkRun } from './app-gates.ts';
import { baselinePages, ensureBaseline } from './baseline.ts';
import { walkNames, WIDTHS, writeCaptureRecord } from './captures.ts';
import { runTreeCheck } from './check-run.ts';
import { freshCheckDir, publishCheck, writeGateLogs, writeResult, type CheckRecord } from './check-output.ts';
import { addedFiles, changedLines } from './diff-lines.ts';
import { galleryHtml } from './gallery.ts';
import { composeGates, type GateResult } from './gates.ts';
import { fetchHead } from './git.ts';
import { copyOverrides, hourGates } from './hour-gates.ts';
import { optional } from './optional.ts';
import type { SandboxOpener } from './sandbox.ts';
import { servedLine, serveNewest, type ServedNow } from './serve-newest.ts';
import type { CheckContext, CheckResult, HourlyCheck } from './session.ts';
import { copyReport, readApproved } from './ui-gates.ts';
import type { PageCapture } from './walk-runner.ts';

const STUDIO_PATHSPEC = 'studio';
const DEFAULT_BUDGET_MINUTES = 50;

export interface CheckDeps {
  openSandbox?: SandboxOpener;
  say: (line: string) => void;
  /** Starts the served copy; tests pass one that records the call. */
  serve?: typeof serveNewest;
}

/** What the supervisor writes into `latest-check.json`, beside `passed` and `summary`. */
export interface HourlyResult extends CheckResult {
  commit?: string;
  resultDir: string;
  /** The served copy on the private network, when it is served and ready. */
  servedUrl?: string;
  localUrl?: string;
  statusUrl?: string;
  /** The commit the served copy shows, and the gates it fails. */
  servedCommit?: string;
  servedFailing?: string[];
}

export function checkBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.PYRIC_FACTORY_CHECK_MINUTES ?? DEFAULT_BUDGET_MINUTES);
  const isValid = Number.isFinite(minutes) && minutes > 0;
  if (!isValid) throw new Error(`PYRIC_FACTORY_CHECK_MINUTES must be a positive number of minutes, not ${env.PYRIC_FACTORY_CHECK_MINUTES}`);
  return minutes * 60_000;
}

function writeGallery(dir: string, hour: number, walked: WalkRun, before: readonly PageCapture[]): void {
  const html = galleryHtml({
    title: `Hour ${hour}: start commit and this hour`,
    after: walked.result?.pages ?? [],
    before,
    beforeDir: join('..', 'baseline', 'screenshots'),
    afterDir: 'screenshots',
  });
  writeFileSync(join(dir, 'gallery.html'), html);
}

interface Checked {
  commit: string;
  gates: GateResult[];
}

/** Takes the baseline when it is due, checks the commit's tree, and writes the gates' files into `dir`. */
async function checkCommit(paths: AppPaths, record: AppRecord, context: CheckContext, dir: string, deps: CheckDeps, signal: AbortSignal): Promise<Checked> {
  const commit = fetchHead(paths.gitDir, context.appDir);
  deps.say(`hour ${context.hour}: checking ${commit.slice(0, 12)}`);
  const walks = walkNames(record.briefDir);
  const sandbox = optional('openSandbox', deps.openSandbox);
  const baseline = await ensureBaseline({ paths, record, walks, signal, say: deps.say, ...sandbox });
  const changed = changedLines(paths.gitDir, record.startCommit, commit, STUDIO_PATHSPEC);
  const ui = { changed, added: addedFiles(paths.gitDir, record.startCommit, commit, STUDIO_PATHSPEC), approved: readApproved(paths.approvedComponents), overrides: copyOverrides(paths) };
  const capturedAt = new Date().toISOString();
  const jobs = [{ label: 'walks', walks, routes: [], outDir: join(dir, 'screenshots') }];
  const checked = await runTreeCheck({ paths, record, commit, label: `hour-${context.hour}`, logDir: dir, jobs, ui, signal, say: deps.say, ...sandbox });
  if (checked.ui !== undefined) writeFileSync(join(dir, 'copy-report.md'), copyReport(checked.ui.copy));
  const before = baselinePages(paths);
  const gates = hourGates(checked, baseline.knownFailures, changed.size, before);
  writeGateLogs(dir, gates);
  writeCaptureRecord(join(dir, 'screenshots'), { commit, capturedAt, widths: WIDTHS });
  writeGallery(dir, context.hour, checked.walked, before);
  return { commit, gates };
}

export type ServedFields = Pick<CheckRecord, 'servedUrl' | 'localUrl' | 'statusUrl' | 'servedCommit' | 'servedFailing'>;

/** The served copy's fields for `result.json` and `latest-check.json`. */
export function servedFields(served: ServedNow | undefined): ServedFields {
  if (served === undefined) return {};
  return { localUrl: served.localUrl, statusUrl: served.statusUrl, servedCommit: served.commit, ...optional('servedUrl', served.url), ...optional('servedFailing', served.failing) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runHourlyCheck(context: CheckContext, deps: CheckDeps): Promise<HourlyResult> {
  const paths = appPaths(context.runDir);
  const dir = freshCheckDir(paths, `hour-${context.hour}`);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(checkBudgetMs())]);
  const at = () => new Date().toISOString();
  let fields: ServedFields = {};
  let result: CheckRecord = { hour: context.hour, at: at(), passed: false, summary: 'the check did not finish', gates: [] };
  try {
    const record = readAppRecord(paths);
    result = { ...result, startCommit: record.startCommit };
    const checked = await checkCommit(paths, record, context, dir, deps, signal);
    const composed = composeGates(checked.gates);
    const serve = deps.serve ?? serveNewest;
    const outcome = await serve({ paths, record, failed: composed.failed, commit: checked.commit, hour: context.hour, signal, say: deps.say, ...optional('openSandbox', deps.openSandbox) });
    const served = outcome.served;
    fields = servedFields(served);
    result = {
      ...result,
      at: at(),
      commit: checked.commit,
      passed: composed.passed,
      summary: `${composed.summary}. ${servedLine(served)}. Details in ${dir}`,
      gates: checked.gates.map((gate) => ({ gate: gate.gate, passed: gate.passed, summary: gate.summary })),
      serve: outcome.note,
      ...fields,
    };
  } catch (error) {
    const why = signal.aborted ? `the check stopped: ${errorText(signal.reason)}` : errorText(error);
    result = { ...result, at: at(), passed: false, summary: `the check failed: ${why.split('\n')[0] ?? ''}. Details in ${dir}`, error: why };
  } finally {
    writeResult(dir, result);
    publishCheck(paths, context.hour, dir);
  }
  return { passed: result.passed, summary: result.summary, resultDir: dir, ...optional('commit', result.commit), ...fields };
}

const defaultDeps: CheckDeps = { say: (line) => console.log(`▸ ${line}`) };

export const hourlyCheck: HourlyCheck = (context) => runHourlyCheck(context, defaultDeps);
