/**
 * The hourly check (`HourlyCheck` in `session.ts`). For the roles' current
 * commit it passes only when every gate passes (`gates.ts`):
 *
 * - typecheck, tests, studio-checks: Studio's own, in the check's checkout,
 *   inside its sandbox (`app-gates.ts`), passing failures the start commit
 *   already had (`known-failures.ts`);
 * - app-start: the one command starts Studio there and it answers;
 * - walks: the brief's walk scripts pass in Chromium against it;
 * - ui-rules, copy: the factory's ast-grep rules and the copy rules, on what
 *   changed since the run's start commit (`ui-gates.ts`);
 * - layout: no layout finding on a walked page at 1440px or 390px that the
 *   start commit's capture didn't have (`layout-gate.ts`).
 *
 * It writes `checks/hour-<n>/` (`check-output.ts`) and points `checks/latest`
 * at it. A pass records the commit as the last good one and, when it is
 * new, serves it on the tailnet (`served.ts`). The supervisor writes the
 * result into `latest-check.json`, the extra fields included.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appPaths, hourDir, type AppPaths } from './app-paths.ts';
import { prepareCheckout, readAppRecord, type AppRecord } from './app-setup.ts';
import { staticGates, startAndWalk, type WalkRun } from './app-gates.ts';
import { astGrepBinary } from './ast-grep.ts';
import { excuseKnown, type KnownFailures } from './known-failures.ts';
import { baselinePages, baselineScreenshots, ensureBaseline } from './baseline.ts';
import { copyWalks, walkNames, WIDTHS, writeCaptureRecord } from './captures.ts';
import { pointLatest, writeGateLogs, writeResult, type CheckRecord } from './check-output.ts';
import { DEFAULT_OVERRIDES_FILE, mergeOverrides, readOverrides, type CopyOverrides } from './copy-rules.ts';
import { addedFiles, changedLines } from './diff-lines.ts';
import { hostRunner } from './exec.ts';
import { galleryHtml } from './gallery.ts';
import { composeGates, skipped, type GateResult } from './gates.ts';
import { headCommit } from './git.ts';
import { newLayoutProblems } from './layout-gate.ts';
import { openSandbox as realSandbox, type SandboxOpener } from './sandbox.ts';
import { serveLastGood, servedPort } from './served.ts';
import type { CheckContext, CheckResult, HourlyCheck } from './session.ts';
import { copyReport, readApproved, runUiGates } from './ui-gates.ts';
import type { PageCapture } from './walk-runner.ts';

const STUDIO_PATHSPEC = 'studio';

export interface CheckDeps {
  openSandbox: SandboxOpener;
  say: (line: string) => void;
}

/** What the supervisor writes into `latest-check.json`, beside `passed` and `summary`. */
export interface HourlyResult extends CheckResult {
  commit: string;
  resultDir: string;
  /** The last good version: on the tailnet, and on this machine. */
  servedUrl?: string;
  localUrl: string;
}

class CheckAborted extends Error {}

function stopIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CheckAborted('the run ended during the check');
}

function copyOverrides(paths: AppPaths): CopyOverrides {
  const base = readOverrides(DEFAULT_OVERRIDES_FILE);
  return existsSync(paths.copyOverrides) ? mergeOverrides(base, readOverrides(paths.copyOverrides)) : base;
}

async function uiGates(paths: AppPaths, record: AppRecord, commit: string, dir: string): Promise<GateResult[]> {
  const repo = paths.check.repo;
  const changed = changedLines(repo, record.startCommit, commit, STUDIO_PATHSPEC);
  const ui = await runUiGates({
    runner: hostRunner(paths.check.home),
    astGrep: astGrepBinary(paths.check.studio),
    repo,
    changed,
    added: addedFiles(repo, record.startCommit, commit, STUDIO_PATHSPEC),
    approved: readApproved(paths.approvedComponents),
    overrides: copyOverrides(paths),
  });
  writeFileSync(join(dir, 'copy-report.md'), copyReport(ui.copy));
  const ruleLines = ui.violations.map((v) => `${v.file}:${v.line} ${v.rule}: ${v.message}\n  ${v.text}`);
  const copyFailures = ui.copy.filter((entry) => entry.problems.length > 0);
  const copyLines = copyFailures.map((entry) => `${entry.file}:${entry.line} ${entry.kind} "${entry.text}": ${entry.problems.join('; ')}`);
  return [
    { gate: 'ui-rules', passed: ui.violations.length === 0, summary: `${ui.violations.length} violations in ${changed.size} changed files`, output: ruleLines.join('\n') },
    { gate: 'copy', passed: copyFailures.length === 0, summary: `${copyFailures.length} of ${ui.copy.length} new strings fail; see copy-report.md`, output: copyLines.join('\n') },
  ];
}

function layoutGate(walked: WalkRun, before: readonly PageCapture[]): GateResult {
  if (walked.result === undefined) return skipped('layout', 'no pages were walked');
  const problems = newLayoutProblems(walked.result.pages, before);
  const lines = problems.map((problem) => `${problem.path} at ${problem.width}px, ${problem.rule}: ${problem.detail}`);
  const summary = `${problems.length} new layout problems on ${walked.result.pages.length} captures`;
  return { gate: 'layout', passed: problems.length === 0, summary, output: lines.join('\n') };
}

async function appGates(paths: AppPaths, record: AppRecord, dir: string, known: KnownFailures, deps: CheckDeps): Promise<{ gates: GateResult[]; walked: WalkRun }> {
  const walksDir = copyWalks(record.briefDir, join(paths.check.root, 'hour-walks'));
  const walks = walkNames(record.briefDir);
  const astGrep = astGrepBinary(paths.check.studio);
  return deps.openSandbox(paths.check.root, paths, async (runner, namespace) => {
    const statics = (await staticGates(runner, paths.check, astGrep)).map((result) => excuseKnown(result, known));
    const walked = await startAndWalk({ runner, namespace, checkout: paths.check, logDir: dir, walksDir, walks, outDir: join(dir, 'screenshots') });
    return { gates: [...statics, walked.appStart, walked.walks], walked };
  });
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

export async function runHourlyCheck(context: CheckContext, deps: CheckDeps): Promise<HourlyResult> {
  const paths = appPaths(context.runDir);
  const record = readAppRecord(paths);
  const commit = headCommit(context.appDir);
  const dir = hourDir(paths, context.hour);
  mkdirSync(dir, { recursive: true });
  deps.say(`hour ${context.hour}: checking ${commit.slice(0, 12)}`);
  const baseline = await ensureBaseline({ paths, record, walks: walkNames(record.briefDir), openSandbox: deps.openSandbox, say: deps.say });
  stopIfAborted(context.signal);
  await prepareCheckout(paths, paths.check, commit, { openSandbox: deps.openSandbox, withRoot: true, say: deps.say });
  stopIfAborted(context.signal);
  const capturedAt = new Date().toISOString();
  const { gates: inside, walked } = await appGates(paths, record, dir, baseline.knownFailures, deps);
  stopIfAborted(context.signal);
  const before = baselinePages(paths);
  const gates = [...inside, ...await uiGates(paths, record, commit, dir), layoutGate(walked, before)];
  const composed = composeGates(gates);
  writeGateLogs(dir, gates);
  writeCaptureRecord(join(dir, 'screenshots'), { commit, capturedAt, widths: WIDTHS });
  writeCaptureRecord(dir, { commit, capturedAt, widths: WIDTHS });
  writeGallery(dir, context.hour, walked, before);
  const served = await serveLastGood({ paths, passed: composed.passed, commit, hour: context.hour, openSandbox: deps.openSandbox, say: deps.say });
  const localUrl = `http://127.0.0.1:${servedPort()}/`;
  const urls = served.url === undefined ? 'nothing is served yet' : `last good version at ${served.url} (${localUrl} here)`;
  const summary = `${composed.summary}. ${urls}. Details in ${dir}`;
  const result: CheckRecord = {
    hour: context.hour,
    at: new Date().toISOString(),
    commit,
    startCommit: record.startCommit,
    passed: composed.passed,
    summary,
    gates: gates.map((gate) => ({ gate: gate.gate, passed: gate.passed, summary: gate.summary })),
    ...(served.url === undefined ? {} : { servedUrl: served.url }),
    localUrl,
    serve: served.note,
  };
  writeResult(dir, result);
  pointLatest(paths.latest, dir);
  return { passed: composed.passed, summary, commit, resultDir: dir, localUrl, ...(served.url === undefined ? {} : { servedUrl: served.url }) };
}

const defaultDeps: CheckDeps = { openSandbox: realSandbox, say: (line) => console.log(`▸ ${line}`) };

export const hourlyCheck: HourlyCheck = (context) => runHourlyCheck(context, defaultDeps);
