/**
 * What one hourly check leaves in `checks/hour-<n>/`:
 *
 *   result.json      the verdict, each gate's line, the commits and the URLs
 *   <gate>.log       a failing gate's output
 *   copy-report.md   every new or changed visible string and its verdict
 *   screenshots/     this hour's captures, with capture.json (commit and time)
 *   gallery.html     each page beside the start commit's
 *
 * and points `checks/latest` at it, by a link replaced in one rename.
 */
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { GateResult } from './gates.ts';
import { writeJsonFile } from './run-dir.ts';

export interface CheckRecord {
  hour: number;
  at: string;
  commit: string;
  startCommit: string;
  passed: boolean;
  summary: string;
  gates: { gate: string; passed: boolean; summary: string }[];
  /** The last good version on the tailnet, once one exists. */
  servedUrl?: string;
  /** The same, on this machine. */
  localUrl?: string;
  serve?: string;
}

export function writeGateLogs(dir: string, gates: readonly GateResult[]): void {
  for (const gate of gates) {
    const hasLog = !gate.passed && gate.output !== undefined && gate.output !== '';
    if (hasLog) writeFileSync(join(dir, `${gate.gate}.log`), gate.output ?? '');
  }
}

export function writeResult(dir: string, record: CheckRecord): void {
  writeJsonFile(join(dir, 'result.json'), record);
}

/** Points `latest` at `dir`: a new link beside it, renamed over the old one, so a reader never finds none. */
export function pointLatest(latest: string, dir: string): void {
  mkdirSync(join(latest, '..'), { recursive: true });
  const partial = `${latest}.partial`;
  // A link a crash left behind; it is the harness's own, in the run directory.
  rmSync(partial, { force: true });
  symlinkSync(relative(join(latest, '..'), dir) || basename(dir), partial);
  renameSync(partial, latest);
}
