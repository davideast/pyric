/**
 * What one hourly check leaves in the run's host directory,
 * `<run>.host/checks/hour-<n>.<stamp>/`, a fresh folder for every run of
 * the check:
 *
 *   result.json      the verdict, each gate's line, the commits and the URLs
 *   <gate>.log       a failing gate's output
 *   copy-report.md   every new or changed visible string and its verdict
 *   screenshots/     this hour's captures, with capture.json (commit and time)
 *   gallery.html     each page beside the start commit's
 *
 * `hour-<n>` and `latest` are links to it, each replaced in one rename, so
 * a reader never finds none and a rerun of an hour keeps the earlier folder.
 * A check that throws still writes a failed `result.json` and repoints both.
 * Sessions see this directory read-only at `<run>/checks`.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { runStamp } from '../scratch.ts';
import type { AppPaths } from './app-paths.ts';
import type { GateResult } from './gates.ts';
import { makeHostDir, writeNewFile } from './host-files.ts';
import { writeJson } from './state-files.ts';

export interface CheckRecord {
  hour: number;
  at: string;
  commit?: string;
  startCommit?: string;
  passed: boolean;
  summary: string;
  gates: { gate: string; passed: boolean; summary: string }[];
  /** The served copy on the private network, once one is served and ready. */
  servedUrl?: string;
  /** The same, at the address it listens on. */
  localUrl?: string;
  /** Its status page. */
  statusUrl?: string;
  /** The commit the served copy shows, and the gates it fails. */
  servedCommit?: string;
  servedFailing?: string[];
  serve?: string;
  /** Why the check stopped before it finished, when it did. */
  error?: string;
}

/** A fresh folder for `name` in the host's checks, `<name>.<stamp>`; never one that exists. */
export function freshCheckDir(paths: AppPaths, name: string): string {
  makeHostDir(paths.checks, paths.host, paths.runDir);
  const dir = join(paths.checks, `${name}.${runStamp()}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

export function writeGateLogs(dir: string, gates: readonly GateResult[]): void {
  for (const gate of gates) {
    const hasLog = !gate.passed && gate.output !== undefined && gate.output !== '';
    if (hasLog) writeNewFile(join(dir, `${gate.gate}.log`), gate.output ?? '');
  }
}

export function writeResult(dir: string, record: CheckRecord): void {
  writeJson(join(dir, 'result.json'), record);
}

/** Points the link `link` at `dir`, beside it: a new link renamed over the old one. */
export function pointLink(link: string, dir: string): void {
  const partial = join(dirname(link), `.${randomBytes(12).toString('hex')}.link`);
  symlinkSync(basename(dir), partial);
  renameSync(partial, link);
}

/** Points `hour-<n>` and `latest` at a check's folder. */
export function publishCheck(paths: AppPaths, hour: number, dir: string): void {
  pointLink(join(paths.checks, `hour-${hour}`), dir);
  pointLink(paths.latest, dir);
}
