// Post-run integrity checks for `runBunTest` and `runBunTestVerdict` (#1207).
// Catches `bun test` runs that exit 0 (or forgive quarantined failures) when
// the process exited before printing its `Ran N tests across M files.` summary,
// ran fewer files than scheduled, reported unhandled errors outside tests, or
// loaded a `*.test.*` / `*_test.*` file that registered 0 tests (for example an
// unawaited timer crash or early return before any `test(...)` call).

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { REPO_ROOT, type TestResult } from './entries.ts';
import { repoPath, type ConsoleTotals } from './junit.ts';

const ANSI = /\u001b\[[0-9;]*m/g;
const BUN_RAN = /^Ran (\d+) tests? across (\d+) files?\./gm;
const BUN_TEST_FILE = /(\.test|_test|\.spec|_spec)\.(c|m)?(j|t)sx?$/;
const MUST_REGISTER_TEST_FILE = /(\.test|_test)\.(c|m)?(j|t)sx?$/;

const VALUE_FLAGS = new Set([
  '--cwd',
  '-t',
  '--test-name-pattern',
  '--timeout',
  '--preload',
  '-r',
  '--bail',
  '--rerun-each',
  '--max-concurrency',
  '--seed',
  '--reporter',
  '--reporter-outfile',
  '--coverage-reporter',
  '--coverage-dir',
]);

export interface ExpectedSuiteFiles {
  allFiles: string[];
  mustRegisterFiles: string[];
  filteredByName: boolean;
}

function collectDiscoveredFiles(baseCwd: string, dirPath: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const childPath = join(dirPath, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      found.push(...collectDiscoveredFiles(baseCwd, childPath));
    } else if (entry.isFile() && BUN_TEST_FILE.test(entry.name)) {
      found.push(relative(baseCwd, childPath).replace(/\\/g, '/'));
    }
  }
  return found.sort();
}

export function expectedSuiteFiles(cwd: string, args: readonly string[]): ExpectedSuiteFiles {
  let effectiveCwd = cwd;
  let filteredByName = false;
  const targets: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '-t' || arg === '--test-name-pattern' || arg.startsWith('--test-name-pattern=')) {
      filteredByName = true;
    }
    if (arg === '--cwd') {
      const next = args[i + 1];
      if (next !== undefined) {
        effectiveCwd = resolve(cwd, next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      effectiveCwd = resolve(cwd, arg.slice('--cwd='.length));
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    targets.push(arg);
  }

  const relFromBase: string[] = [];
  if (targets.length === 0) {
    if (existsSync(effectiveCwd)) {
      relFromBase.push(...collectDiscoveredFiles(effectiveCwd, effectiveCwd));
    }
  } else {
    for (const target of targets) {
      const resolved = resolve(effectiveCwd, target);
      if (existsSync(resolved)) {
        const stats = statSync(resolved);
        if (stats.isDirectory()) {
          relFromBase.push(...collectDiscoveredFiles(effectiveCwd, resolved));
        } else if (stats.isFile()) {
          relFromBase.push(relative(effectiveCwd, resolved).replace(/\\/g, '/'));
        }
      } else if (BUN_TEST_FILE.test(target)) {
        relFromBase.push(target.replace(/^\.\//, ''));
      }
    }
  }

  const repoCwd = relative(REPO_ROOT, effectiveCwd).replace(/\\/g, '/');
  const uniqueAll = [...new Set(relFromBase.map((f) => repoPath(repoCwd, f)))].sort();
  let mustRegisterFiles: string[] = [];
  if (!filteredByName) {
    mustRegisterFiles = uniqueAll.filter((f) => MUST_REGISTER_TEST_FILE.test(f));
  }
  return { allFiles: uniqueAll, mustRegisterFiles, filteredByName };
}

function ranFilesCount(output: string): number | undefined {
  const clean = output.replace(ANSI, '');
  let totalFiles = 0;
  let matched = false;
  for (const [, , files] of clean.matchAll(BUN_RAN)) {
    totalFiles += Number(files);
    matched = true;
  }
  if (!matched) {
    return undefined;
  }
  return totalFiles;
}

function addReportedFileVariants(set: Set<string>, reportedFile: string, cwd: string): void {
  const repoCwd = relative(REPO_ROOT, cwd).replace(/\\/g, '/').replace(/\/$/, '');
  let gluedPrefix = '/';
  if (repoCwd !== '' && repoCwd !== '.') {
    gluedPrefix = `${repoCwd}//`;
  }
  let absCandidate: string | undefined;
  if (reportedFile.startsWith(gluedPrefix)) {
    let sliceOffset = 0;
    if (repoCwd !== '' && repoCwd !== '.') {
      sliceOffset = repoCwd.length + 1;
    }
    absCandidate = reportedFile.slice(sliceOffset);
  } else if (isAbsolute(reportedFile)) {
    absCandidate = reportedFile;
  }

  if (absCandidate !== undefined) {
    set.add(posix.normalize(relative(REPO_ROOT, absCandidate).replace(/\\/g, '/')));
    if (existsSync(absCandidate) && existsSync(REPO_ROOT)) {
      set.add(
        posix.normalize(
          relative(realpathSync(REPO_ROOT), realpathSync(absCandidate)).replace(/\\/g, '/'),
        ),
      );
    }
    return;
  }
  set.add(posix.normalize(reportedFile.replace(/\\/g, '/')));
}

export function suiteIntegrityProblem(params: {
  cwd: string;
  exitCode: number | null;
  stderrTail: string;
  results: TestResult[] | undefined;
  totals: ConsoleTotals;
  expected: ExpectedSuiteFiles;
}): string | undefined {
  if (params.totals.errors > 0) {
    return `bun reported ${params.totals.errors} error(s) outside a test`;
  }
  const ranFiles = ranFilesCount(params.stderrTail);
  if (ranFiles === undefined) {
    return 'bun test exited without printing a "Ran N tests across M files" summary';
  }
  if (ranFiles < params.expected.allFiles.length) {
    return `bun test ran ${ranFiles} of ${params.expected.allFiles.length} expected file(s)`;
  }
  if (params.results === undefined) {
    if (params.expected.mustRegisterFiles.length > 0 || params.exitCode !== 0) {
      return 'the JUnit file is missing or did not parse (test file crashed or registered 0 tests)';
    }
    return undefined;
  }
  const filesWithTests = new Set<string>();
  for (const r of params.results) {
    addReportedFileVariants(filesWithTests, r.file, params.cwd);
  }
  const zeroTestFiles = params.expected.mustRegisterFiles.filter(
    (f) => !filesWithTests.has(posix.normalize(f.replace(/\\/g, '/'))),
  );
  if (zeroTestFiles.length > 0) {
    return `${zeroTestFiles.length} test file(s) registered 0 tests: ${zeroTestFiles.join(', ')}`;
  }
  return undefined;
}
