// Reads the failing tests out of a Build & Test job log: the `bun test`
// `##[group]<file>:` header, the `(fail)` line, and the last error line before
// it with its stack location. A job whose log names no test is reported by
// job name with its last error. Used by scripts/ci/main-failure.ts.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One failing test, or a failing job whose log names no test. */
export interface Failure {
  job: string;
  /** `<repo path of the file> > <test name>`, or undefined when the log names no test. */
  test?: string;
  /** The error line the failure printed, with its source location. */
  assertion?: string;
}

/** Jobs that fail only because another job failed. */
const SUMMARY_JOBS: readonly string[] = ['CI / required'];

const ANSI = /\u001b\[[0-9;]*m/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_GROUP = /^##\[group\](.+\.(?:test|spec)\.[cm]?[jt]sx?):$/;
const FAIL_LINE = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
const ERROR_LINE = /^(?:error|[A-Za-z]*Error)(?::\s|:$)/;
const STACK_LOCATION = /^at .*?\(?(?:file:\/\/)?\/home\/runner\/work\/[^/]+\/[^/]+\/([^)\s]+:\d+:\d+)\)?$/;
const FAILED_SUMMARY = /^\d+ tests? failed:$/;
const HOOK_NOTE = /^\^ (.+)$/;
const ACTIONS_ERROR = /^##\[error\](.+)$/;
/** `bun run` reports the script it ran exiting, which names no failure. */
const SCRIPT_EXIT = /^error: script ".*" exited with code \d+$/;

/** Turns a test file path, relative to the directory `bun test` ran in, into
 *  its path in the repository. */
export type FileResolver = (relative: string) => string;

function isErrorLine(line: string): boolean {
  return ERROR_LINE.test(line) && !SCRIPT_EXIT.test(line);
}

function isResultLine(line: string): boolean {
  return line.startsWith('(pass) ') || line.startsWith('(skip) ');
}

function logLines(log: string): string[] {
  return log.replace(ANSI, '').split('\n').map((line) => line.replace(TIMESTAMP, '').replace(/\r$/, ''));
}

function withLocation(error: string, location: string | undefined): string {
  if (location === undefined) return error;
  return `${error} (at ${location})`;
}

function stackLocation(line: string): string | undefined {
  return STACK_LOCATION.exec(line.trim())?.[1];
}

/** The last error line in a log and where it was thrown, for a job whose
 *  log names no test. Falls back to the last Actions error annotation. */
function lastError(lines: string[]): string | undefined {
  const index = lines.findLastIndex((line) => isErrorLine(line));
  if (index !== -1) {
    const location = lines.slice(index + 1, index + 12).map(stackLocation).find((found) => found !== undefined);
    return withLocation(lines[index] ?? '', location);
  }
  const annotations = lines.map((line) => ACTIONS_ERROR.exec(line)?.[1]).filter((text) => text !== undefined);
  return annotations.at(-1);
}

/** What the parser remembers between lines of a log. */
interface ParseState {
  /** The repository path of the test file whose group is open. */
  file?: string;
  /** The last error line since the previous test result. */
  error?: string;
  /** Where `error` was thrown. */
  location?: string;
  /** The failure just recorded, which a hook note on the next line explains. */
  lastFailure?: Failure;
}

function clearError(state: ParseState): void {
  state.error = undefined;
  state.location = undefined;
}

function clearTest(state: ParseState): void {
  clearError(state);
  state.lastFailure = undefined;
}

function clearGroup(state: ParseState): void {
  clearTest(state);
  state.file = undefined;
}

function testId(state: ParseState, name: string): string {
  if (state.file === undefined) return name;
  return `${state.file} > ${name}`;
}

function withAssertion(failure: Failure, assertion: string | undefined): Failure {
  if (assertion === undefined) return failure;
  return { ...failure, assertion };
}

function currentAssertion(state: ParseState): string | undefined {
  if (state.error === undefined) return undefined;
  return withLocation(state.error, state.location);
}

/** The failing `bun test` tests a job log names, each with the last error line
 *  it printed, or the job itself with its last error when the log names none.
 *  A test that fails twice in one log keeps its first failure. */
export function parseFailures(job: string, log: string, resolveFile: FileResolver = (file) => file): Failure[] {
  const lines = logLines(log);
  const failures = new Map<string, Failure>();
  const state: ParseState = {};

  for (const line of lines) {
    if (FAILED_SUMMARY.test(line)) break;
    const group = TEST_GROUP.exec(line);
    if (group) {
      clearGroup(state);
      state.file = resolveFile(group[1] ?? '');
      continue;
    }
    if (line.startsWith('##[endgroup]')) {
      clearGroup(state);
      continue;
    }
    const failed = FAIL_LINE.exec(line);
    if (failed) {
      const test = testId(state, failed[1] ?? '(unnamed)');
      if (!failures.has(test)) failures.set(test, withAssertion({ job, test }, currentAssertion(state)));
      clearError(state);
      state.lastFailure = failures.get(test);
      continue;
    }
    if (isResultLine(line)) {
      clearTest(state);
      continue;
    }
    const note = HOOK_NOTE.exec(line.trim());
    const explainsLastFailure = note !== null && state.lastFailure?.assertion === undefined;
    if (explainsLastFailure && state.lastFailure) {
      state.lastFailure.assertion = note[1];
      continue;
    }
    if (isErrorLine(line)) {
      state.error = line;
      state.location = undefined;
      continue;
    }
    if (state.error !== undefined && state.location === undefined) state.location = stackLocation(line);
  }

  if (failures.size > 0) return [...failures.values()];
  return [withAssertion({ job }, lastError(lines))];
}

/** The jobs worth naming: summary jobs drop out when another job failed. */
export function namedFailedJobs(jobs: string[]): string[] {
  const real = jobs.filter((job) => !SUMMARY_JOBS.includes(job));
  return real.length > 0 ? real : jobs;
}

function packageDirs(root: string): string[] {
  const packages = join(root, 'packages');
  if (!existsSync(packages)) return [];
  return readdirSync(packages).map((name) => `packages/${name}`);
}

function repoPath(dir: string, file: string): string {
  if (dir === '') return file;
  return `${dir}/${file}`;
}

/** `bun test --cwd packages/<name>` prints paths relative to the package, so
 *  a path is placed in the one directory of the checkout that holds it. */
export function checkoutResolver(root: string): FileResolver {
  const dirs = ['', ...packageDirs(root)];
  return (file) => {
    const holders = dirs.filter((dir) => existsSync(join(root, dir, file)));
    if (holders.length !== 1) return file;
    return repoPath(holders[0] ?? '', file);
  };
}
