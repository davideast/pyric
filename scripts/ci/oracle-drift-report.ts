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
 * Why not a bare `git diff --exit-code`: every observation envelope stamps a
 * fresh `observedAt` timestamp on every write, and short arrays can serialize
 * differently across writer versions. Those are noise, not drift. This report
 * strips `observedAt` and re-canonicalizes both sides before comparing, so it
 * fires ONLY on a real change to a captured fact — anything other than the
 * timestamp. That is the same judgement a human applies reading the diff
 * locally, made mechanical so the scheduled lane can gate on it.
 *
 * It NEVER commits, pushes, or otherwise persists the change. On drift it
 * writes the (timestamp-free) diff into the GitHub Actions job summary and
 * exits non-zero so the run goes red — a visible, reviewable artifact.
 *
 * Usage: bun scripts/ci/oracle-drift-report.ts <rig-label>
 * Exit:  0 = no drift; 1 = drift detected; 2 = usage error.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const OBS_TREE = 'packages/conformance/observations';
const DOC = 'packages/conformance/docs/how-to-run-the-conformance-system.md';

const label = process.argv[2];
if (!label) {
  console.error('usage: bun scripts/ci/oracle-drift-report.ts <rig-label>');
  process.exit(2);
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Content of a path at HEAD, or null if it did not exist there. */
function headContent(path: string): string | null {
  try {
    return git(['show', `HEAD:${path}`]);
  } catch {
    return null;
  }
}

/** Content of a path in the working tree, or null if it was deleted. */
function workingContent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Parse an observation, drop the volatile `observedAt` stamp wherever it
 *  appears, and re-serialize with sorted keys so formatting never registers
 *  as drift. Non-JSON content is returned verbatim so a malformed capture
 *  still surfaces as a difference rather than being silently swallowed. */
function canonicalize(content: string | null): string | null {
  if (content === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  const stripped = strip(parsed);
  return JSON.stringify(stripped, sortedReplacer(), 2) + '\n';
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'observedAt') continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}

/** Stable key order so re-serialization is deterministic. */
function sortedReplacer() {
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
    }
    return value;
  };
}

/** Changed observation paths (modified, added, or deleted) vs HEAD. */
function changedObservationPaths(): string[] {
  const out = git(['status', '--porcelain', '--', OBS_TREE]);
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // Porcelain: 2 status chars, a space, then the path (possibly "old -> new").
    const path = line.slice(3).split(' -> ').pop()!.trim().replace(/^"|"$/g, '');
    if (path.endsWith('.json')) paths.push(path);
  }
  return paths.sort();
}

/** A timestamp-free unified diff between HEAD and working versions of one
 *  file, or '' when the only difference was the stamp / formatting. */
function normalizedDiff(path: string, tmp: string): string {
  const head = canonicalize(headContent(path));
  const work = canonicalize(workingContent(path));
  if (head === work) return '';

  const headFile = join(tmp, 'HEAD', path);
  const workFile = join(tmp, 'CURRENT', path);
  mkdirSync(dirname(headFile), { recursive: true });
  mkdirSync(dirname(workFile), { recursive: true });
  writeFileSync(headFile, head ?? '');
  writeFileSync(workFile, work ?? '');

  let raw: string;
  try {
    // --no-index diff; exits 1 when the files differ, which execFileSync
    // throws on — the diff text is on the thrown error's stdout.
    raw = git(['--no-pager', 'diff', '--no-index', '--unified=3', '--', headFile, workFile]);
  } catch (err) {
    raw = (err as { stdout?: string }).stdout ?? '';
  }
  // Relabel the temp file headers back to the real observation path.
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

const tmp = mkdtempSync(join(tmpdir(), 'oracle-drift-'));
const drifted: { path: string; diff: string }[] = [];
for (const path of changedObservationPaths()) {
  const diff = normalizedDiff(path, tmp);
  if (diff) drifted.push({ path, diff });
}

if (drifted.length === 0) {
  console.log(`[oracle-drift] ${label}: no drift — production still matches the pinned observations.`);
  process.exit(0);
}

const lines: string[] = [];
lines.push(`## Oracle drift detected — ${label}`);
lines.push('');
lines.push(
  `The re-capture changed **${drifted.length}** committed observation(s) under \`${OBS_TREE}\` ` +
    '(beyond the per-run `observedAt` timestamp). Production behavior moved since these facts were ' +
    'last pinned. Nothing was committed.',
);
lines.push('');
lines.push(`Review the diff below and follow the drift-response procedure in \`${DOC}\` before ` + 're-capturing deliberately on a branch.');
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

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  appendFileSync(summaryPath, report + '\n');
} else {
  console.log(report);
}

console.error(`::error::Oracle observation drift detected for ${label} — see the job summary for the diff.`);
process.exit(1);
