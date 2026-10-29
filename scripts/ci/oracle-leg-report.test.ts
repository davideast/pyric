import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Gh } from './github-issues.ts';
import {
  ISSUE_TITLE_PREFIX,
  LEGS,
  applyIssueAction,
  describeState,
  headline,
  inputFromEnv,
  issueAction,
  issueTitle,
  legTable,
  readStatuses,
  report,
  recordLeg,
  summarize,
  type LegState,
  type LegStatus,
  type RecordInput,
  type ReportContext,
} from './oracle-leg-report.ts';

const ROOT = resolve(import.meta.dir, '../..');
const RUN_URL = 'https://github.com/davideast/pyric/actions/runs/1';
const CONTEXT: ReportContext = { runUrl: RUN_URL, downloadFailed: false };

function recordInput(overrides: Partial<RecordInput>): RecordInput {
  return { rig: 'rules-firestore', disabled: '', missing: '', available: 'true', driftOutcome: 'success', driftFound: '', ...overrides };
}

function status(rig: string, state: LegState, detail = ''): LegStatus {
  return { rig, state, detail };
}

/** A status for every leg, all checked with no drift, with `overrides` applied. */
function allLegs(overrides: Record<string, LegStatus> = {}): LegStatus[] {
  return LEGS.map((leg) => overrides[leg.rig] ?? status(leg.rig, 'checked-clean'));
}

/** Every credentialed leg not run, as on a dispatch with nothing configured. */
function nothingChecked(): LegStatus[] {
  return allLegs({
    'oracle-run': status('oracle-run', 'disabled', '#1270 and #1271 (credentials without a key file)'),
    'messaging-send': status('messaging-send', 'disabled', '#1387 (credentials without a key file)'),
    'rules-firestore': status('rules-firestore', 'guard-missing', 'GCP_WIF_PROVIDER'),
    'rules-storage': status('rules-storage', 'guard-missing', 'GCP_WIF_PROVIDER'),
  });
}

interface GhCall {
  args: string[];
  /** The text of the --body-file at the time of the call. */
  bodyFile?: string;
}

/** A fake `gh`: lists `open` as the open issues, and records every call. */
function fakeGh(open: { number: number; title: string }[]): { gh: Gh; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const gh: Gh = (args) => {
    const bodyFlag = args.indexOf('--body-file');
    const bodyFile = bodyFlag === -1 ? undefined : readFileSync(args[bodyFlag + 1] ?? '', 'utf8');
    calls.push({ args, bodyFile });
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(open);
    if (args[1] === 'create') return 'https://github.com/davideast/pyric/issues/900\n';
    if (args[1] === 'comment') return 'https://github.com/davideast/pyric/issues/900#issuecomment-1\n';
    return '';
  };
  return { gh, calls };
}

function scratchFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'oracle-leg-report-test-')), 'issue-body.md');
}

describe('recording a leg', () => {
  test('a disabled leg is disabled even when its guard is set', () => {
    const recorded = recordLeg(recordInput({ rig: 'oracle-run', disabled: '#1270 and #1271', missing: '', available: 'false' }));
    expect(recorded).toEqual({ rig: 'oracle-run', state: 'disabled', detail: '#1270 and #1271' });
    expect(describeState(recorded)).toBe('not run: disabled until #1270 and #1271');
  });

  test('a missing guard is not run and names the variable', () => {
    const recorded = recordLeg(recordInput({ missing: 'GCP_WIF_PROVIDER', available: 'false', driftOutcome: 'skipped' }));
    expect(recorded.state).toBe('guard-missing');
    expect(describeState(recorded)).toBe('not run: GCP_WIF_PROVIDER not set');
  });

  test('a provider without a service account names the service account variable', () => {
    const recorded = recordLeg(recordInput({ missing: 'PARITY_SA_EMAIL', available: '', driftOutcome: 'skipped' }));
    expect(describeState(recorded)).toBe('not run: PARITY_SA_EMAIL not set');
  });

  test('a clean drift check is checked, no drift', () => {
    const recorded = recordLeg(recordInput({ driftOutcome: 'success' }));
    expect(recorded.state).toBe('checked-clean');
    expect(describeState(recorded)).toBe('checked, no drift');
  });

  test('a failed drift check that reported drift is checked, drift found', () => {
    const recorded = recordLeg(recordInput({ driftOutcome: 'failure', driftFound: 'true' }));
    expect(recorded.state).toBe('checked-drift');
    expect(describeState(recorded)).toBe('checked, drift found');
  });

  test('a failed drift check that did not report drift crashed, so the capture failed', () => {
    const recorded = recordLeg(recordInput({ driftOutcome: 'failure', driftFound: '' }));
    expect(recorded.state).toBe('capture-failed');
    expect(describeState(recorded)).toBe('capture failed (the drift check crashed)');
  });

  test('a drift check skipped after the capture step failed is capture failed', () => {
    const recorded = recordLeg(recordInput({ driftOutcome: 'skipped' }));
    expect(recorded.state).toBe('capture-failed');
    expect(describeState(recorded)).toBe('capture failed (the drift check skipped)');
  });

  test('a cancelled run is capture failed, never checked', () => {
    expect(recordLeg(recordInput({ driftOutcome: 'cancelled' })).state).toBe('capture-failed');
  });

  test('a leg whose credential check never finished is capture failed', () => {
    const recorded = recordLeg(recordInput({ available: '', driftOutcome: '' }));
    expect(recorded.state).toBe('capture-failed');
    expect(recorded.detail).toBe('the credential check did not finish');
  });

  test('a leg whose credential check passed but drift outcome is empty did not run its drift check', () => {
    expect(describeState(recordLeg(recordInput({ driftOutcome: '' })))).toBe('capture failed (the drift check did not run)');
  });

  test('the environment names the leg, and an unknown leg is refused', () => {
    expect(inputFromEnv({ RIG: 'rules-storage', MISSING: 'GCP_WIF_PROVIDER' }).missing).toBe('GCP_WIF_PROVIDER');
    expect(() => inputFromEnv({ RIG: 'rules-spanner' })).toThrow('not an oracle re-capture leg');
  });
});

/** Writes a leg's status file where download-artifact puts it: in a folder
 *  named for the artifact, `oracle-leg-<rig>-<attempt>`. */
function writeStatus(dir: string, entry: LegStatus, attempt = 1, text = JSON.stringify(entry)): void {
  const folder = join(dir, `oracle-leg-${entry.rig}-${attempt}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${entry.rig}.json`), text);
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'oracle-leg-report-test-'));
}

describe('reading the status files', () => {
  test('a leg with no file is not run: job ended before recording', () => {
    const dir = scratchDir();
    writeStatus(dir, status('unattended', 'checked-clean'));
    const statuses = readStatuses(dir);
    expect(statuses).toHaveLength(LEGS.length);
    expect(statuses[0]?.state).toBe('checked-clean');
    const missing = statuses.find((entry) => entry.rig === 'rules-firestore');
    expect(missing?.state).toBe('no-record');
    expect(describeState(missing as LegStatus)).toBe('not run: job ended before recording (no status file)');
  });

  test('a directory that was never downloaded reads every leg as no record', () => {
    const statuses = readStatuses(join(scratchDir(), 'never-downloaded'));
    expect(statuses.map((entry) => entry.state)).toEqual(LEGS.map(() => 'no-record'));
  });

  test('an unreadable file counts as no record', () => {
    const dir = scratchDir();
    writeStatus(dir, status('rules-storage', 'checked-clean'), 1, '{ not json');
    writeStatus(dir, status('rules-firestore', 'checked-clean'), 1, JSON.stringify({ state: 'verified' }));
    const statuses = readStatuses(dir);
    expect(statuses.find((entry) => entry.rig === 'rules-storage')?.state).toBe('no-record');
    expect(statuses.find((entry) => entry.rig === 'rules-firestore')?.state).toBe('no-record');
  });

  test('every state survives the round trip through a file', () => {
    const dir = scratchDir();
    const written = [
      status('unattended', 'checked-drift'),
      status('oracle-run', 'disabled', '#1270'),
      status('messaging-send', 'guard-missing', 'PYRIC_MESSAGING_SA_BASE64'),
      status('rules-firestore', 'capture-failed', 'the drift check skipped'),
      status('rules-storage', 'checked-clean'),
    ];
    for (const entry of written) writeStatus(dir, entry);
    expect(readStatuses(dir)).toEqual(written);
  });

  test('a re-run reads the latest attempt of each leg, and keeps the others', () => {
    const dir = scratchDir();
    for (const leg of LEGS) writeStatus(dir, status(leg.rig, 'checked-clean'), 1);
    writeStatus(dir, status('rules-storage', 'capture-failed', 'first try'), 1);
    writeStatus(dir, status('rules-storage', 'checked-drift', 'second try'), 2);
    writeStatus(dir, status('rules-storage', 'capture-failed', 'tenth try'), 10);
    const statuses = readStatuses(dir);
    expect(statuses.find((entry) => entry.rig === 'rules-storage')?.detail).toBe('tenth try');
    expect(statuses.find((entry) => entry.rig === 'rules-firestore')?.state).toBe('checked-clean');
  });

  test('an attempt that uploaded no file falls back to the earlier one, and the table says so', () => {
    const dir = scratchDir();
    writeStatus(dir, status('rules-storage', 'checked-drift'), 1);
    mkdirSync(join(dir, 'oracle-leg-rules-storage-2'));
    const statuses = readStatuses(dir);
    const storage = statuses.find((entry) => entry.rig === 'rules-storage');
    expect(storage?.state).toBe('checked-drift');
    expect(storage?.fallbackAttempt).toBe(1);
    expect(legTable(statuses)).toContain('| rules-storage | credentialed | checked, drift found (attempt 1) |');
  });

  test('a leg read from its latest attempt carries no attempt note', () => {
    const dir = scratchDir();
    writeStatus(dir, status('rules-storage', 'checked-clean'), 1);
    writeStatus(dir, status('rules-storage', 'checked-drift'), 2);
    const statuses = readStatuses(dir);
    expect(statuses.find((entry) => entry.rig === 'rules-storage')?.fallbackAttempt).toBeUndefined();
    expect(legTable(statuses)).not.toContain('(attempt');
  });

  test('one leg is not read as another', () => {
    const dir = scratchDir();
    writeStatus(dir, status('rules-firestore', 'checked-drift'), 1);
    const statuses = readStatuses(dir);
    expect(statuses.find((entry) => entry.rig === 'rules-storage')?.state).toBe('no-record');
    expect(statuses.find((entry) => entry.rig === 'rules-firestore')?.state).toBe('checked-drift');
  });
});

describe('the headline and the table', () => {
  test('no credentialed leg checked production', () => {
    expect(headline(summarize(nothingChecked()))).toBe('Production checked by 0 of 4 credentialed legs. Not run: 4.');
  });

  test('all four missing files read as not run: 4', () => {
    const missing = allLegs({
      'oracle-run': status('oracle-run', 'no-record'),
      'messaging-send': status('messaging-send', 'no-record'),
      'rules-firestore': status('rules-firestore', 'no-record'),
      'rules-storage': status('rules-storage', 'no-record'),
    });
    expect(headline(summarize(missing))).toBe('Production checked by 0 of 4 credentialed legs. Not run: 4.');
  });

  test('every leg clean says no drift', () => {
    const clean = allLegs();
    expect(headline(summarize(clean))).toBe('Production checked by 4 of 4 credentialed legs. No drift.');
  });

  test('drift and a failed capture are counted apart from not run', () => {
    const mixed = allLegs({
      'oracle-run': status('oracle-run', 'disabled', '#1270'),
      'rules-firestore': status('rules-firestore', 'checked-drift'),
      'rules-storage': status('rules-storage', 'capture-failed', 'the drift check skipped'),
    });
    expect(headline(summarize(mixed))).toBe(
      'Production checked by 2 of 4 credentialed legs. Not run: 1. Capture failed: 1. Drift found: 1.',
    );
  });

  test('drift in the unattended rigs is named in the headline', () => {
    const unattended = allLegs({ unattended: status('unattended', 'checked-drift') });
    expect(headline(summarize(unattended))).toBe(
      'Production checked by 4 of 4 credentialed legs. The unattended rigs need a person.',
    );
  });

  test('the table lists every leg with its tier and result', () => {
    const table = legTable(nothingChecked());
    expect(table).toContain('| unattended | unattended | checked, no drift |');
    expect(table).toContain('| oracle-run | credentialed | not run: disabled until #1270 and #1271 (credentials without a key file) |');
    expect(table).toContain('| rules-storage | credentialed | not run: GCP_WIF_PROVIDER not set |');
    expect(table.split('\n')).toHaveLength(LEGS.length + 2);
  });

  test('the issue title counts the legs that need a person and the legs that are disabled', () => {
    expect(issueTitle(summarize(nothingChecked()))).toBe(
      `${ISSUE_TITLE_PREFIX}0 of 4 credentialed legs, 2 need a person, 2 disabled`,
    );
    const one = allLegs({ 'rules-storage': status('rules-storage', 'checked-drift') });
    expect(issueTitle(summarize(one))).toBe(`${ISSUE_TITLE_PREFIX}4 of 4 credentialed legs, 1 needs a person`);
  });

  test('the title never reads "0 need a person" while a leg is disabled', () => {
    const held = allLegs({ 'oracle-run': status('oracle-run', 'disabled', '#1270') });
    expect(issueTitle(summarize(held))).toBe(`${ISSUE_TITLE_PREFIX}3 of 4 credentialed legs, 1 disabled`);
  });

  test('a leg with no status file counts as needing a person in the title', () => {
    const lost = allLegs({ 'rules-storage': status('rules-storage', 'no-record') });
    expect(issueTitle(summarize(lost))).toBe(`${ISSUE_TITLE_PREFIX}3 of 4 credentialed legs, 1 needs a person`);
  });

  test('a failed download is named in the headline, not read as legs that ended early', () => {
    const summary = summarize(nothingChecked());
    expect(headline(summary, true)).toContain('The leg status files could not be downloaded');
    expect(headline(summary)).not.toContain('could not be downloaded');
  });
});

describe('the report command', () => {
  function runReport(downloadOutcome: string): string {
    const summaryFile = join(scratchDir(), 'summary.md');
    writeFileSync(summaryFile, '');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      report({
        STATUS_DIR: scratchDir(),
        FILE_ISSUE: 'false',
        DOWNLOAD_OUTCOME: downloadOutcome,
        GITHUB_STEP_SUMMARY: summaryFile,
      });
    } finally {
      log.mockRestore();
    }
    return readFileSync(summaryFile, 'utf8');
  }

  test('a failed download is named in the run summary', () => {
    expect(runReport('failure')).toContain('The leg status files could not be downloaded');
  });

  test('a download that succeeded is not named', () => {
    expect(runReport('success')).not.toContain('could not be downloaded');
  });

  test('it writes the headline and the table to the run summary', () => {
    const summary = runReport('success');
    expect(summary).toContain('Production checked by 0 of 4 credentialed legs. Not run: 4.');
    expect(summary).toContain('| rules-storage | credentialed |');
  });
});

describe('the issue', () => {
  test('a run that does not file issues touches nothing', () => {
    const { gh, calls } = fakeGh([]);
    const outcome = applyIssueAction(gh, nothingChecked(), false, CONTEXT, scratchFile());
    expect(outcome.action).toBe('none');
    expect(calls).toEqual([]);
  });

  test('with no open issue, a failing run opens one labeled lane:reliability', () => {
    const { gh, calls } = fakeGh([]);
    const outcome = applyIssueAction(gh, nothingChecked(), true, CONTEXT, scratchFile());
    expect(outcome.action).toBe('open-or-update');
    const create = calls.find((call) => call.args[1] === 'create');
    expect(create?.args).toContain('lane:reliability');
    expect(create?.args[create.args.indexOf('--title') + 1]).toBe(
      `${ISSUE_TITLE_PREFIX}0 of 4 credentialed legs, 2 need a person, 2 disabled`,
    );
    expect(create?.bodyFile).toContain('Production checked by 0 of 4 credentialed legs. Not run: 4.');
    expect(create?.bodyFile).toContain(RUN_URL);
    expect(create?.bodyFile).toContain('| rules-firestore | credentialed | not run: GCP_WIF_PROVIDER not set |');
  });

  test('with an open issue, a failing run retitles it and comments the table', () => {
    const open = [{ number: 77, title: `${ISSUE_TITLE_PREFIX}0 of 4 credentialed legs, 4 need a person` }];
    const { gh, calls } = fakeGh(open);
    applyIssueAction(gh, nothingChecked(), true, CONTEXT, scratchFile());
    expect(calls.map((call) => call.args[1])).toEqual(['list', 'comment', 'edit']);
    expect(calls.some((call) => call.args[1] === 'create')).toBe(false);
    const edit = calls.find((call) => call.args[1] === 'edit');
    expect(edit?.args.slice(0, 3)).toEqual(['issue', 'edit', '77']);
    const comment = calls.find((call) => call.args[1] === 'comment');
    expect(comment?.args.slice(0, 3)).toEqual(['issue', 'comment', '77']);
    expect(comment?.bodyFile).toContain('| oracle-run | credentialed |');
  });

  test('a failed retitle still leaves the comment, and fails with the issue named', () => {
    const open = [{ number: 77, title: `${ISSUE_TITLE_PREFIX}0 of 4 credentialed legs, 4 need a person` }];
    const { gh, calls } = fakeGh(open);
    const failingEdit: Gh = (args) => {
      if (args[1] === 'edit') throw new Error('gh issue edit failed: GraphQL error');
      return gh(args);
    };
    expect(() => applyIssueAction(failingEdit, nothingChecked(), true, CONTEXT, scratchFile())).toThrow(
      'Commented on #77, but retitling it failed',
    );
    expect(calls.some((call) => call.args[1] === 'comment')).toBe(true);
  });

  test('a run that missed a status file still opens the issue', () => {
    const { gh, calls } = fakeGh([]);
    const statuses = allLegs({ 'rules-storage': status('rules-storage', 'no-record') });
    applyIssueAction(gh, statuses, true, CONTEXT, scratchFile());
    const create = calls.find((call) => call.args[1] === 'create');
    expect(create?.bodyFile).toContain('| rules-storage | credentialed | not run: job ended before recording (no status file) |');
  });

  test('when every leg checks production with no drift, the open issue gets a comment and closes', () => {
    const open = [{ number: 77, title: `${ISSUE_TITLE_PREFIX}2 of 4 credentialed legs, 2 need a person` }];
    const { gh, calls } = fakeGh(open);
    const outcome = applyIssueAction(gh, allLegs(), true, CONTEXT, scratchFile());
    expect(outcome).toEqual({ action: 'close', detail: 'closed #77' });
    const verbs = calls.map((call) => `${call.args[0]} ${call.args[1]}`);
    expect(verbs).toEqual(['issue list', 'issue comment', 'issue close']);
    expect(calls[1]?.bodyFile).toContain('Every leg checked production with no drift');
    expect(calls[2]?.args).toEqual(['issue', 'close', '77']);
  });

  test('when every leg is clean and no issue is open, nothing is filed or closed', () => {
    const { gh, calls } = fakeGh([]);
    const outcome = applyIssueAction(gh, allLegs(), true, CONTEXT, scratchFile());
    expect(outcome).toEqual({ action: 'close', detail: 'no open issue to close' });
    expect(calls.map((call) => call.args[1])).toEqual(['list']);
  });

  test('one disabled leg keeps the issue open even when the others are clean', () => {
    const statuses = allLegs({ 'oracle-run': status('oracle-run', 'disabled', '#1270') });
    expect(issueAction(summarize(statuses), true)).toBe('open-or-update');
  });

  test('drift in the unattended rigs keeps the issue open', () => {
    const statuses = allLegs({ unattended: status('unattended', 'checked-drift') });
    expect(issueAction(summarize(statuses), true)).toBe('open-or-update');
  });
});

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  'continue-on-error'?: boolean | string;
}

interface WorkflowJob {
  permissions?: Record<string, string>;
  needs?: string[];
  if?: string;
  steps?: WorkflowStep[];
  strategy?: { matrix: { include: { rig: string }[] } };
}

function workflow(): { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, WorkflowJob> } {
  const text = readFileSync(resolve(ROOT, '.github/workflows/oracle-recapture.yml'), 'utf8');
  return Bun.YAML.parse(text) as ReturnType<typeof workflow>;
}

function stepsOf(jobName: string): WorkflowStep[] {
  return workflow().jobs[jobName]?.steps ?? [];
}

function stepRunning(steps: WorkflowStep[], command: string): WorkflowStep | undefined {
  return steps.find((step) => step.run?.includes(command));
}

function uploadOfLegState(steps: WorkflowStep[]): WorkflowStep | undefined {
  return steps.find((step) => step.uses?.startsWith('actions/upload-artifact') && step.with?.name?.startsWith('oracle-leg-'));
}

const LEG_JOBS = ['unattended', 'credentialed'] as const;
/** A condition that names a status function runs a step after an earlier step failed. */
const STATUS_FUNCTION = /\b(always|cancelled|failure|success)\s*\(/;
const RECORD_COMMAND = 'oracle-leg-report.ts record';
const REPORT_COMMAND = 'oracle-leg-report.ts report';

describe('the workflow', () => {
  test('its legs are the legs this report knows', () => {
    const jobs = workflow().jobs;
    const matrixRigs = (jobs.credentialed?.strategy?.matrix.include ?? []).map((entry) => entry.rig);
    const credentialedRigs = LEGS.filter((leg) => leg.credentialed).map((leg) => leg.rig);
    expect(matrixRigs).toEqual(credentialedRigs);
    expect(jobs.unattended).toBeDefined();
    expect(LEGS.find((leg) => !leg.credentialed)?.rig).toBe('unattended');
  });

  test('only the report job can write issues, and it runs after both leg jobs even when they fail', () => {
    const { jobs, permissions } = workflow();
    expect(permissions).toEqual({ contents: 'read' });
    const writers = Object.entries(jobs).filter(([, job]) => job.permissions?.issues === 'write').map(([name]) => name);
    expect(writers).toEqual(['report']);
    expect(jobs.report?.needs).toEqual(['unattended', 'credentialed']);
    expect(jobs.report?.if).toBe('always()');
  });

  test('it never runs on pull requests', () => {
    const triggers = Object.keys(workflow().on);
    expect(triggers.sort()).toEqual(['schedule', 'workflow_dispatch']);
  });
});

describe.each([...LEG_JOBS])('the %s job records its state', (jobName) => {
  const steps = stepsOf(jobName);
  const record = stepRunning(steps, RECORD_COMMAND);
  const upload = uploadOfLegState(steps);
  const drift = steps.find((step) => step.id === 'drift');

  test('a step with id drift decides checked or not', () => {
    expect(drift?.run).toContain('oracle-drift-report.ts');
    expect(drift?.if).not.toBe('always()');
  });

  test('the drift step runs only after every step before it succeeded', () => {
    const driftIndex = steps.findIndex((step) => step === drift);
    expect(driftIndex).toBeGreaterThan(0);
    const upToDrift = steps.slice(0, driftIndex + 1);
    const withStatusFunction = upToDrift.filter((step) => STATUS_FUNCTION.test(step.if ?? ''));
    expect(withStatusFunction.map((step) => step.name ?? step.uses)).toEqual([]);
    const tolerated = upToDrift.filter((step) => step['continue-on-error'] !== undefined && step['continue-on-error'] !== false);
    expect(tolerated.map((step) => step.name ?? step.uses)).toEqual([]);
  });

  test('the record step always runs and reads the drift step outcome and output', () => {
    expect(record?.if).toBe('always()');
    expect(record?.env?.DRIFT_OUTCOME).toBe('${{ steps.drift.outcome }}');
    expect(record?.env?.DRIFT_FOUND).toBe('${{ steps.drift.outputs.found }}');
    expect(record?.env?.STATUS_DIR).toBe('${{ runner.temp }}/oracle-leg');
  });

  test('the upload always runs, follows the record step, and is named for the leg and attempt', () => {
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.name).toMatch(/^oracle-leg-.+-\$\{\{ github\.run_attempt \}\}$/);
    expect(upload?.with?.path).toBe('${{ runner.temp }}/oracle-leg');
    const order = [drift, record, upload].map((step) => steps.findIndex((candidate) => candidate === step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('the credentialed job records what its credential check decided', () => {
  const steps = stepsOf('credentialed');
  const record = stepRunning(steps, RECORD_COMMAND);

  test('the record step reads the rig, the disabled field and the credential check outputs', () => {
    expect(steps.some((step) => step.id === 'secret-check')).toBe(true);
    expect(record?.env?.RIG).toBe('${{ matrix.rig }}');
    expect(record?.env?.DISABLED).toBe('${{ matrix.disabled }}');
    expect(record?.env?.MISSING).toBe('${{ steps.secret-check.outputs.missing }}');
    expect(record?.env?.AVAILABLE).toBe('${{ steps.secret-check.outputs.available }}');
  });

  test('the artifact name carries the rig and the attempt', () => {
    expect(uploadOfLegState(steps)?.with?.name).toBe('oracle-leg-${{ matrix.rig }}-${{ github.run_attempt }}');
  });
});

describe('the unattended job records a fixed rig', () => {
  const steps = stepsOf('unattended');
  const record = stepRunning(steps, RECORD_COMMAND);

  test('the record step names the rig and says the capture ran', () => {
    expect(record?.env?.RIG).toBe('unattended');
    expect(record?.env?.AVAILABLE).toBe('true');
  });

  test('the artifact name carries the rig and the attempt', () => {
    expect(uploadOfLegState(steps)?.with?.name).toBe('oracle-leg-unattended-${{ github.run_attempt }}');
  });
});

describe('the report job', () => {
  const steps = stepsOf('report');
  const download = steps.find((step) => step.uses?.startsWith('actions/download-artifact'));
  const report = stepRunning(steps, REPORT_COMMAND);
  const reportTest = stepRunning(steps, 'bun test scripts/ci/oracle-leg-report.test.ts');

  test('it downloads every leg artifact into its own folder, so attempts do not collide', () => {
    expect(download?.id).toBe('download');
    expect(download?.with?.pattern).toBe('oracle-leg-*');
    expect(download?.with?.path).toBe('${{ runner.temp }}/oracle-leg');
    expect(download?.with).not.toHaveProperty('merge-multiple');
  });

  test('the report step always runs, reads the download outcome, and files only when asked', () => {
    expect(report?.if).toBe('always()');
    expect(report?.env?.DOWNLOAD_OUTCOME).toBe('${{ steps.download.outcome }}');
    expect(report?.env?.STATUS_DIR).toBe('${{ runner.temp }}/oracle-leg');
    expect(report?.env?.FILE_ISSUE).toContain("github.event_name == 'schedule'");
    expect(report?.env?.FILE_ISSUE).toContain('inputs.file-issue == true');
  });

  test('the report test runs before the report, and the PR check lists do not include it', () => {
    expect(reportTest).toBeDefined();
    expect(steps.indexOf(reportTest as WorkflowStep)).toBeLessThan(steps.indexOf(report as WorkflowStep));
    expect(readFileSync(resolve(ROOT, 'scripts/ci/check-set.ts'), 'utf8')).not.toContain('oracle-leg-report');
  });
});
