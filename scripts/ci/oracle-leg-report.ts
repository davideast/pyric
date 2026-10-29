#!/usr/bin/env bun
// Says which legs of the weekly oracle re-capture checked production, and
// tells a person when one did not. `.github/workflows/oracle-recapture.yml`
// runs it in two places:
//
//   bun scripts/ci/oracle-leg-report.ts record   at the end of every leg
//   bun scripts/ci/oracle-leg-report.ts report   in the report job, after all legs
//
// `record` writes one small JSON status file per leg, which the leg uploads as
// the artifact `oracle-leg-<rig>-<attempt>`. `report` reads the latest attempt
// of each and writes a
// headline and a table of every leg to the run summary. A leg whose file never
// arrived is reported as not run, so a leg that died early cannot look like a
// leg that checked production. On a scheduled run, or a dispatch that asks for
// it, `report` also opens or updates one `lane:reliability` issue, and closes
// it once every leg has checked production with no drift.
//
// Both commands read their inputs from the environment (see `inputFromEnv`
// and `reportOptionsFromEnv`).

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeOpenIssue, openOrUpdateIssue, spawnGh, type Gh } from './github-issues.ts';

export interface Leg {
  rig: string;
  /** A credentialed leg reaches a real Firebase project. */
  credentialed: boolean;
}

/** Every leg of the workflow, in the order the report lists them. The workflow
 *  test checks this list against the workflow's jobs and matrix. */
export const LEGS: readonly Leg[] = [
  { rig: 'unattended', credentialed: false },
  { rig: 'oracle-run', credentialed: true },
  { rig: 'messaging-send', credentialed: true },
  { rig: 'rules-firestore', credentialed: true },
  { rig: 'rules-storage', credentialed: true },
];

export type LegState =
  | 'checked-clean'
  | 'checked-drift'
  | 'capture-failed'
  | 'disabled'
  | 'guard-missing'
  | 'no-record';

export interface LegStatus {
  rig: string;
  state: LegState;
  /** What the state names: the blocking issue of a disabled leg, the variable
   *  a leg lacks, or why a capture failed. Empty when there is nothing to name. */
  detail: string;
}

const ISSUE_LABEL = 'lane:reliability';
export const ISSUE_TITLE_PREFIX = 'Oracle re-capture: production checked by ';
const STATE_NAMES: readonly LegState[] = [
  'checked-clean', 'checked-drift', 'capture-failed', 'disabled', 'guard-missing', 'no-record',
];

// ---------------------------------------------------------------------------
// Recording one leg

export interface RecordInput {
  rig: string;
  /** The matrix `disabled` field: the blocking issue, or empty. */
  disabled: string;
  /** The credential variable the availability check found missing, or empty. */
  missing: string;
  /** The availability check's `available` output: 'true', 'false' or empty. */
  available: string;
  /** The drift step's outcome: success, failure, skipped or cancelled. */
  driftOutcome: string;
  /** The drift step's `found` output: 'true' when it reported drift. A step
   *  that fails without it crashed. */
  driftFound: string;
}

/** The state of one leg, from what the workflow's steps decided. */
export function recordLeg(input: RecordInput): LegStatus {
  const { rig } = input;
  const isDisabled = input.disabled !== '';
  const lacksCredential = input.missing !== '';
  const capturedAgainstProduction = input.available === 'true';
  const driftStepFailed = input.driftOutcome === 'failure';
  const driftReported = input.driftFound === 'true';
  const noDriftFound = input.driftOutcome === 'success';

  if (isDisabled) return { rig, state: 'disabled', detail: input.disabled };
  if (lacksCredential) return { rig, state: 'guard-missing', detail: input.missing };
  if (!capturedAgainstProduction) {
    return { rig, state: 'capture-failed', detail: 'the credential check did not finish' };
  }
  if (driftStepFailed && driftReported) return { rig, state: 'checked-drift', detail: '' };
  if (driftStepFailed) return { rig, state: 'capture-failed', detail: 'the drift check crashed' };
  if (noDriftFound) return { rig, state: 'checked-clean', detail: '' };
  return { rig, state: 'capture-failed', detail: `the drift check ${input.driftOutcome || 'did not run'}` };
}

export function inputFromEnv(env: NodeJS.ProcessEnv): RecordInput {
  const rig = env.RIG ?? '';
  if (!LEGS.some((leg) => leg.rig === rig)) throw new Error(`RIG "${rig}" is not an oracle re-capture leg`);
  return {
    rig,
    disabled: env.DISABLED ?? '',
    missing: env.MISSING ?? '',
    available: env.AVAILABLE ?? '',
    driftOutcome: env.DRIFT_OUTCOME ?? '',
    driftFound: env.DRIFT_FOUND ?? '',
  };
}

export function describeState(status: LegStatus): string {
  switch (status.state) {
    case 'checked-clean': return 'checked, no drift';
    case 'checked-drift': return 'checked, drift found';
    case 'capture-failed': return `capture failed${status.detail ? ` (${status.detail})` : ''}`;
    case 'disabled': return `not run: disabled until ${status.detail}`;
    case 'guard-missing': return `not run: ${status.detail} not set`;
    case 'no-record': return 'not run: job ended before recording (no status file)';
  }
}

export function summaryLine(status: LegStatus): string {
  return `Oracle leg ${status.rig}: ${describeState(status)}`;
}

// ---------------------------------------------------------------------------
// Reading every leg

function isLegState(value: unknown): value is LegState {
  return STATE_NAMES.some((name) => name === value);
}

function parseStatus(rig: string, text: string): LegStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { state, detail } = parsed as { state?: unknown; detail?: unknown };
  if (!isLegState(state)) return undefined;
  return { rig, state, detail: typeof detail === 'string' ? detail : '' };
}

function noRecord(rig: string): LegStatus {
  return { rig, state: 'no-record', detail: '' };
}

/** The attempt number in an artifact folder named `oracle-leg-<rig>-<attempt>`,
 *  or undefined when the folder belongs to another leg. */
function attemptOf(folder: string, rig: string): number | undefined {
  const prefix = `oracle-leg-${rig}-`;
  if (!folder.startsWith(prefix)) return undefined;
  const attempt = folder.slice(prefix.length);
  return /^\d+$/.test(attempt) ? Number(attempt) : undefined;
}

/** The status file of the latest attempt that uploaded one for `rig`. */
function latestStatusFile(dir: string, rig: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const attempts = readdirSync(dir)
    .map((folder) => ({ folder, attempt: attemptOf(folder, rig) }))
    .filter((entry): entry is { folder: string; attempt: number } => entry.attempt !== undefined)
    .sort((a, b) => b.attempt - a.attempt);
  const files = attempts.map((entry) => join(dir, entry.folder, `${rig}.json`));
  return files.find((file) => existsSync(file));
}

/** One status per leg, from the latest attempt that recorded one. A leg with
 *  no file, or an unreadable one, is `no-record`. */
export function readStatuses(dir: string): LegStatus[] {
  return LEGS.map((leg) => {
    const file = latestStatusFile(dir, leg.rig);
    if (file === undefined) return noRecord(leg.rig);
    return parseStatus(leg.rig, readFileSync(file, 'utf8')) ?? noRecord(leg.rig);
  });
}

// ---------------------------------------------------------------------------
// The report

export interface Summary {
  credentialedLegs: number;
  /** Credentialed legs that compared a fresh capture with the pinned observations. */
  checked: number;
  /** Credentialed legs that did not run at all. */
  notRun: number;
  /** Legs held back by a blocking issue. They are part of `notRun`. */
  disabled: number;
  /** Credentialed legs whose capture failed. */
  captureFailed: number;
  /** Credentialed legs that found drift. */
  drifted: number;
  /** Legs of any tier that need a person: drift, a failed capture, or a missing credential or record. */
  needPerson: number;
  /** An unattended rig found drift or failed. */
  unattendedNeedsPerson: boolean;
  /** Every leg checked with no drift. */
  allClean: boolean;
}

function isCredentialed(status: LegStatus): boolean {
  return LEGS.some((leg) => leg.rig === status.rig && leg.credentialed);
}

function needsPerson(state: LegState): boolean {
  return state !== 'checked-clean' && state !== 'disabled';
}

function countStates(statuses: LegStatus[], states: LegState[]): number {
  return statuses.filter((status) => states.includes(status.state)).length;
}

export function summarize(statuses: LegStatus[]): Summary {
  const credentialed = statuses.filter(isCredentialed);
  return {
    credentialedLegs: credentialed.length,
    checked: countStates(credentialed, ['checked-clean', 'checked-drift']),
    notRun: countStates(credentialed, ['disabled', 'guard-missing', 'no-record']),
    disabled: countStates(statuses, ['disabled']),
    captureFailed: countStates(credentialed, ['capture-failed']),
    drifted: countStates(credentialed, ['checked-drift']),
    needPerson: statuses.filter((status) => needsPerson(status.state)).length,
    unattendedNeedsPerson: statuses.some((status) => !isCredentialed(status) && needsPerson(status.state)),
    allClean: statuses.every((status) => status.state === 'checked-clean'),
  };
}

export interface ReportContext {
  runUrl: string | undefined;
  /** The step that downloads the leg status files failed. */
  downloadFailed: boolean;
}

const DOWNLOAD_FAILED_NOTICE =
  'The leg status files could not be downloaded, so the legs below read as not run for that reason.';

export function headline(summary: Summary, downloadFailed = false): string {
  const parts = [`Production checked by ${summary.checked} of ${summary.credentialedLegs} credentialed legs.`];
  if (summary.notRun > 0) parts.push(`Not run: ${summary.notRun}.`);
  if (summary.captureFailed > 0) parts.push(`Capture failed: ${summary.captureFailed}.`);
  if (summary.drifted > 0) parts.push(`Drift found: ${summary.drifted}.`);
  if (summary.unattendedNeedsPerson) parts.push('The unattended rigs need a person.');
  if (downloadFailed) parts.push(DOWNLOAD_FAILED_NOTICE);
  const nothingWrong = summary.notRun + summary.captureFailed + summary.drifted === 0
    && !summary.unattendedNeedsPerson && !downloadFailed;
  if (nothingWrong) parts.push('No drift.');
  return parts.join(' ');
}

/** The title counts the legs that need a person and the legs that are disabled,
 *  so an open issue never reads as if nothing were wrong while a leg is held back. */
export function issueTitle(summary: Summary): string {
  const verb = summary.needPerson === 1 ? 'needs' : 'need';
  const counts: string[] = [];
  if (summary.needPerson > 0) counts.push(`${summary.needPerson} ${verb} a person`);
  if (summary.disabled > 0) counts.push(`${summary.disabled} disabled`);
  const checked = `${summary.checked} of ${summary.credentialedLegs} credentialed legs`;
  return `${ISSUE_TITLE_PREFIX}${[checked, ...counts].join(', ')}`;
}

export function legTable(statuses: LegStatus[]): string {
  const rows = statuses.map((status) => {
    const tier = isCredentialed(status) ? 'credentialed' : 'unattended';
    return `| ${status.rig} | ${tier} | ${describeState(status)} |`;
  });
  return ['| Leg | Tier | Result |', '|---|---|---|', ...rows].join('\n');
}

export function reportMarkdown(statuses: LegStatus[], context: ReportContext): string {
  const lines = [`## Oracle re-capture: ${headline(summarize(statuses), context.downloadFailed)}`, ''];
  if (context.runUrl) lines.push(`Run: ${context.runUrl}`, '');
  lines.push(legTable(statuses), '');
  return lines.join('\n');
}

export function closingMarkdown(statuses: LegStatus[], context: ReportContext): string {
  const lines = ['Every leg checked production with no drift on this run, so this issue is closed.', ''];
  if (context.runUrl) lines.push(`Run: ${context.runUrl}`, '');
  lines.push(legTable(statuses), '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The issue

export type IssueAction = 'none' | 'open-or-update' | 'close';

/** What the report does about the issue. Nothing unless the run files issues. */
export function issueAction(summary: Summary, fileIssue: boolean): IssueAction {
  if (!fileIssue) return 'none';
  return summary.allClean ? 'close' : 'open-or-update';
}

export interface IssueOutcome {
  action: IssueAction;
  /** What `gh` printed for an open or update, or the number closed. */
  detail: string;
}

export function applyIssueAction(
  gh: Gh,
  statuses: LegStatus[],
  fileIssue: boolean,
  context: ReportContext,
  bodyFile: string,
): IssueOutcome {
  const summary = summarize(statuses);
  const action = issueAction(summary, fileIssue);
  if (action === 'none') return { action, detail: '' };
  if (action === 'close') {
    writeFileSync(bodyFile, closingMarkdown(statuses, context));
    const closed = closeOpenIssue(gh, ISSUE_TITLE_PREFIX, bodyFile);
    return { action, detail: closed === undefined ? 'no open issue to close' : `closed #${closed}` };
  }
  writeFileSync(bodyFile, reportMarkdown(statuses, context));
  const detail = openOrUpdateIssue(gh, {
    prefix: ISSUE_TITLE_PREFIX,
    title: issueTitle(summary),
    label: ISSUE_LABEL,
    bodyFile,
  });
  return { action, detail };
}

// ---------------------------------------------------------------------------
// Entry points

function appendToStepSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, `${markdown}\n`);
}

function runUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.GITHUB_RUN_ID) return undefined;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function statusDirFromEnv(env: NodeJS.ProcessEnv): string {
  if (!env.STATUS_DIR) throw new Error('STATUS_DIR is not set');
  return resolve(env.STATUS_DIR);
}

function record(env: NodeJS.ProcessEnv): void {
  const status = recordLeg(inputFromEnv(env));
  const dir = statusDirFromEnv(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${status.rig}.json`), `${JSON.stringify(status, null, 2)}\n`);
  console.log(summaryLine(status));
  appendToStepSummary(summaryLine(status));
}

function report(env: NodeJS.ProcessEnv): void {
  const dir = statusDirFromEnv(env);
  const statuses = readStatuses(dir);
  const context: ReportContext = {
    runUrl: runUrlFromEnv(env),
    downloadFailed: env.DOWNLOAD_OUTCOME === 'failure',
  };
  const markdown = reportMarkdown(statuses, context);
  console.log(markdown);
  appendToStepSummary(markdown);

  const fileIssue = env.FILE_ISSUE === 'true';
  const outcome = applyIssueAction(spawnGh(process.cwd()), statuses, fileIssue, context, join(dir, 'issue-body.md'));
  if (outcome.action === 'none') {
    console.log('This run does not file issues.');
    return;
  }
  const line = `Issue: ${outcome.action} (${outcome.detail})`;
  console.log(line);
  appendToStepSummary(line);
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === 'record') {
    record(process.env);
  } else if (command === 'report') {
    report(process.env);
  } else {
    console.error('usage: bun scripts/ci/oracle-leg-report.ts record|report');
    process.exit(2);
  }
}
