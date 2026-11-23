// Reads test counts from a job's log, so a parallel run and a serial run can
// be compared total for total. A job can run more than one test command (the
// ui package runs two `bun test` passes, the chat template runs `node --test`),
// so every summary in a log is added up.

export interface TestCounts {
  tests: number;
  files: number;
  pass: number;
  fail: number;
  errors: number;
  skip: number;
  todo: number;
  /** `*.test.*` / `*_test.*` files whose `bun test` section registered 0 tests. */
  emptyTestFiles: string[];
}

export function emptyCounts(): TestCounts {
  return { tests: 0, files: 0, pass: 0, fail: 0, errors: 0, skip: 0, todo: 0, emptyTestFiles: [] };
}

export function addCounts(a: TestCounts, b: TestCounts): TestCounts {
  return {
    tests: a.tests + b.tests,
    files: a.files + b.files,
    pass: a.pass + b.pass,
    fail: a.fail + b.fail,
    errors: a.errors + b.errors,
    skip: a.skip + b.skip,
    todo: a.todo + b.todo,
    emptyTestFiles: [...a.emptyTestFiles, ...b.emptyTestFiles],
  };
}

const ANSI = /\u001b\[[0-9;]*m/g;
/** `bun test`: ` 735 pass`, ` 1 error`, and `Ran 741 tests across 92 files.` */
const BUN_STATUS = /^\s*(\d+) (pass|fail|skip|todo)$/gm;
const BUN_ERROR = /^\s*(\d+) errors?$/gm;
const BUN_RAN = /^Ran (\d+) tests? across (\d+) files?\./gm;
const BUN_RAN_LINE = /^Ran \d+ tests? across \d+ files?\./;
const FILE_HEADER = /^(\S+(?:\.test|\.spec|_test|_spec)\.[cm]?[jt]sx?):$/;
const MUST_REGISTER_FILE = /(?:\.test|_test)\.[cm]?[jt]sx?$/;
const OUTCOME_LINE = /^(?:\((?:pass|fail|skip|todo)\)|[\u2713\u2717\u2716\u00bb\u270e])\s/;
/** `node --test`: `\u2139 pass 7` in the spec reporter, `# pass 7` in TAP. */
const NODE_STATUS = /^[\u2139#] (tests|pass|fail|skipped|todo) (\d+)$/gm;

type NumericCountKey = 'tests' | 'files' | 'pass' | 'fail' | 'errors' | 'skip' | 'todo';
const NODE_FIELD: Record<string, NumericCountKey> = {
  tests: 'tests',
  pass: 'pass',
  fail: 'fail',
  skipped: 'skip',
  todo: 'todo',
};

function findEmptyTestFiles(cleanLog: string): string[] {
  if (!BUN_RAN_LINE.test(cleanLog) && !cleanLog.includes('\nRan ')) {
    let hasAnyRan = false;
    for (const line of cleanLog.split('\n')) {
      if (BUN_RAN_LINE.test(line)) {
        hasAnyRan = true;
        break;
      }
    }
    if (!hasAnyRan) {
      return [];
    }
  }

  const empty: string[] = [];
  let currentFile: string | undefined;
  let sawOutcome = false;

  const flushCurrent = (): void => {
    if (currentFile !== undefined && !sawOutcome && MUST_REGISTER_FILE.test(currentFile)) {
      empty.push(currentFile);
    }
    currentFile = undefined;
    sawOutcome = false;
  };

  for (const rawLine of cleanLog.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const header = FILE_HEADER.exec(line);
    if (header) {
      flushCurrent();
      currentFile = header[1];
      continue;
    }
    if (BUN_RAN_LINE.test(line)) {
      flushCurrent();
      continue;
    }
    if (currentFile !== undefined && OUTCOME_LINE.test(line)) {
      sawOutcome = true;
    }
  }
  return empty;
}

export function readCounts(log: string): TestCounts {
  const cleanLog = log.replace(ANSI, '');
  const counts = emptyCounts();
  for (const [, count, status] of cleanLog.matchAll(BUN_STATUS)) {
    counts[status as 'pass' | 'fail' | 'skip' | 'todo'] += Number(count);
  }
  for (const [, count] of cleanLog.matchAll(BUN_ERROR)) {
    counts.errors += Number(count);
  }
  for (const [, tests, files] of cleanLog.matchAll(BUN_RAN)) {
    counts.tests += Number(tests);
    counts.files += Number(files);
  }
  for (const [, field, count] of cleanLog.matchAll(NODE_STATUS)) {
    const key = NODE_FIELD[field ?? ''];
    if (key !== undefined) counts[key] += Number(count);
  }
  counts.emptyTestFiles = findEmptyTestFiles(cleanLog);
  return counts;
}

export function formatCounts(counts: TestCounts): string {
  const base = `${counts.tests} tests in ${counts.files} bun files: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip, ${counts.todo} todo`;
  if (counts.errors > 0) {
    return `${base}, ${counts.errors} error`;
  }
  return base;
}
