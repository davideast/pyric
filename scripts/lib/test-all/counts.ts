// Reads test counts from a job's log, so a parallel run and a serial run can
// be compared total for total. A job can run more than one test command (the
// ui package runs two `bun test` passes, the chat template runs `node --test`),
// so every summary in a log is added up.

export interface TestCounts {
  tests: number;
  files: number;
  pass: number;
  fail: number;
  skip: number;
  todo: number;
}

export function emptyCounts(): TestCounts {
  return { tests: 0, files: 0, pass: 0, fail: 0, skip: 0, todo: 0 };
}

export function addCounts(a: TestCounts, b: TestCounts): TestCounts {
  return {
    tests: a.tests + b.tests,
    files: a.files + b.files,
    pass: a.pass + b.pass,
    fail: a.fail + b.fail,
    skip: a.skip + b.skip,
    todo: a.todo + b.todo,
  };
}

/** `bun test`: ` 735 pass`, and `Ran 741 tests across 92 files.` */
const BUN_STATUS = /^\s*(\d+) (pass|fail|skip|todo)$/gm;
const BUN_RAN = /^Ran (\d+) tests? across (\d+) files?\./gm;
/** `node --test`: `ℹ pass 7` in the spec reporter, `# pass 7` in TAP. */
const NODE_STATUS = /^[ℹ#] (tests|pass|fail|skipped|todo) (\d+)$/gm;

const NODE_FIELD: Record<string, keyof TestCounts> = { tests: 'tests', pass: 'pass', fail: 'fail', skipped: 'skip', todo: 'todo' };

export function readCounts(log: string): TestCounts {
  const counts = emptyCounts();
  for (const [, count, status] of log.matchAll(BUN_STATUS)) {
    counts[status as 'pass' | 'fail' | 'skip' | 'todo'] += Number(count);
  }
  for (const [, tests, files] of log.matchAll(BUN_RAN)) {
    counts.tests += Number(tests);
    counts.files += Number(files);
  }
  for (const [, field, count] of log.matchAll(NODE_STATUS)) {
    const key = NODE_FIELD[field ?? ''];
    if (key !== undefined) counts[key] += Number(count);
  }
  return counts;
}

export function formatCounts(counts: TestCounts): string {
  return `${counts.tests} tests in ${counts.files} bun files: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip, ${counts.todo} todo`;
}
