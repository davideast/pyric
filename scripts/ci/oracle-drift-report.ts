#!/usr/bin/env bun
/**
 * Oracle drift report.
 *
 * Used by .github/workflows/oracle-recapture.yml after a capture rig has
 * re-run against production and overwritten its observation files in place.
 * The observations tree is committed, so a change to it IS the drift report:
 * an unchanged fact means production still behaves as pinned; a changed fact
 * means cloud behavior moved and the affected registry rows need human review
 * (see packages/conformance/docs/how-to-run-the-conformance-system.md).
 *
 * Strips `observedAt` and re-canonicalizes both sides before comparing, so it
 * fires ONLY on a real change to a captured fact. It never commits or pushes.
 * On drift it writes the timestamp-free diff to BOTH stdout (so CLI inspection
 * via `gh run view --log-failed` has the full diff) and `GITHUB_STEP_SUMMARY`,
 * then exits 1.
 *
 * Usage: bun scripts/ci/oracle-drift-report.ts <rig-label>
 * Exit:  0 = no drift; 1 = drift detected; 2 = usage error.
 * Output: `found=true` in GITHUB_OUTPUT when it detects drift.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalizeObservation } from './oracle-observation-diff.ts';

const OBS_TREE = 'packages/conformance/observations';
const DOC = 'packages/conformance/docs/how-to-run-the-conformance-system.md';

export interface DriftReportOptions {
  label: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function headContent(cwd: string, path: string): string | null {
  try {
    return runGit(cwd, ['show', `HEAD:${path}`]);
  } catch {
    return null;
  }
}

function workingContent(cwd: string, path: string): string | null {
  try {
    return readFileSync(join(cwd, path), 'utf8');
  } catch {
    return null;
  }
}

function changedObservationPaths(cwd: string): string[] {
  const out = runGit(cwd, ['status', '--porcelain', '--', OBS_TREE]);
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const segments = line.slice(3).split(' -> ');
    const lastSegment = segments[segments.length - 1] ?? '';
    const path = lastSegment.trim().replace(/^"|"$/g, '');
    if (path.endsWith('.json')) paths.push(path);
  }
  return paths.sort();
}

function normalizedDiff(cwd: string, path: string, tmp: string): string {
  const head = canonicalizeObservation(headContent(cwd, path));
  const work = canonicalizeObservation(workingContent(cwd, path));
  if (head === work) return '';

  const headFile = join(tmp, 'HEAD', path);
  const workFile = join(tmp, 'CURRENT', path);
  mkdirSync(dirname(headFile), { recursive: true });
  mkdirSync(dirname(workFile), { recursive: true });
  writeFileSync(headFile, head ?? '');
  writeFileSync(workFile, work ?? '');

  let raw = '';
  try {
    raw = runGit(cwd, ['--no-pager', 'diff', '--no-index', '--unified=3', '--', headFile, workFile]);
  } catch (err) {
    raw = (err as { stdout?: string }).stdout ?? '';
  }
  return raw
    .split('\n')
    .filter((l) => !l.startsWith('index ') && !l.startsWith('diff --git '))
    .map((l) => {
      if (l.startsWith('--- ')) return `--- a/${path}`;
      if (l.startsWith('+++ ')) return `+++ b/${path}`;
      return l;
    })
    .join('\n')
    .trim();
}

function resolveArtifactSlug(label: string, env: NodeJS.ProcessEnv): string {
  const rawRig = env.RIG ?? '';
  const rigEnv = rawRig.trim();
  if (rigEnv) return rigEnv;
  if (label.startsWith('unattended')) return 'unattended';
  return label.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

export function runOracleDriftReport(options: DriftReportOptions): number {
  const label = options.label.trim();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? ((msg: string) => console.log(msg));
  const error = options.error ?? ((msg: string) => console.error(msg));

  if (!label) {
    error('usage: bun scripts/ci/oracle-drift-report.ts <rig-label>');
    return 2;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'oracle-drift-'));
  const drifted: { path: string; diff: string }[] = [];
  try {
    for (const path of changedObservationPaths(cwd)) {
      const diff = normalizedDiff(cwd, path, tmp);
      if (diff) drifted.push({ path, diff });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (drifted.length === 0) {
    log(`[oracle-drift] ${label}: no drift - production still matches the pinned observations.`);
    return 0;
  }

  const artifactSlug = resolveArtifactSlug(label, env);
  const artifactName = `observation-drift-${artifactSlug}`;
  const rawRunId = env.GITHUB_RUN_ID ?? '';
  const runId = rawRunId.trim();

  const lines: string[] = [];
  lines.push(`## Oracle drift detected - ${label}`);
  lines.push('');
  lines.push(
    `The re-capture changed **${drifted.length}** committed observation(s) under \`${OBS_TREE}\` ` +
      '(beyond the per-run `observedAt` timestamp). Production behavior moved since these facts were ' +
      'last pinned. Nothing was committed.',
  );
  lines.push('');
  lines.push(
    `Review the diff below and follow the drift-response procedure in \`${DOC}\` before ` +
      're-capturing deliberately on a branch.',
  );
  if (runId) {
    lines.push(
      `Rewritten observation files were uploaded as artifact \`${artifactName}\` ` +
        `(\`gh run download ${runId} -n ${artifactName}\`).`,
    );
  }
  lines.push('');
  for (const { path, diff } of drifted) {
    lines.push(`### \`${path}\``);
    lines.push('');
    lines.push('```diff');
    lines.push(diff);
    lines.push('```');
    lines.push('');
  }
  const report = lines.join('\n');

  log(report);
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${report}\n`);
  }

  const outputPath = env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, 'found=true\n');
  }

  error(
    `::error::Oracle observation drift detected for ${label} (${drifted.length} file(s)) - see log and job summary above.`,
  );
  return 1;
}

if (import.meta.main) {
  process.exit(runOracleDriftReport({ label: process.argv[2] ?? '' }));
}
