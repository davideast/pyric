/**
 * What changed since the run's start commit, line by line. The UI gates
 * judge only these lines, so Studio's existing violations never fail a
 * check, and a violation a role adds always does.
 */
import { bareGit } from './git.ts';

/** The added or changed lines of each file, by its path in the repo, numbered from 1. */
export type ChangedLines = Map<string, Set<number>>;

const FILE_HEADER = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Reads `git diff -U0` output: the new side's line numbers of each hunk. */
export function parseChangedLines(diff: string): ChangedLines {
  const changed: ChangedLines = new Map();
  let lines: Set<number> | undefined;
  for (const line of diff.split('\n')) {
    const file = FILE_HEADER.exec(line)?.[1];
    if (file !== undefined) {
      lines = new Set();
      changed.set(file, lines);
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk === null || lines === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
  }
  return changed;
}

const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];

/** The lines added or changed under `pathspec` between two commits of the harness's repo. Deleted files drop out. */
export function changedLines(gitDir: string, from: string, to: string, pathspec: string): ChangedLines {
  const diff = bareGit(gitDir, [...DIFF, '-U0', '--diff-filter=AMR', `${from}..${to}`, '--', pathspec]);
  return parseChangedLines(diff);
}

/** Files added under `pathspec` between two commits. */
export function addedFiles(gitDir: string, from: string, to: string, pathspec: string): string[] {
  const names = bareGit(gitDir, [...DIFF, '--name-only', '--no-renames', '--diff-filter=A', `${from}..${to}`, '--', pathspec]);
  return names.split('\n').filter((name) => name !== '');
}

/** Whether any line from `first` to `last` was added or changed. */
export function touches(changed: ChangedLines, file: string, first: number, last: number): boolean {
  const lines = changed.get(file);
  if (lines === undefined) return false;
  for (let line = first; line <= last; line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}
