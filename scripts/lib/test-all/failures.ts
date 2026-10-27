// Names each failing test with the file it ran in. `bun test` prints a
// `path/to/file.test.ts:` header before each file's results, and a failure
// line (`(fail) …`, or `# Unhandled error between tests`) only names the
// test, which in a shard of 92 files is not enough to find it.

/** The line `bun test` prints before a file's results. */
const FILE_HEADER = /^(\S+(\.test|\.spec|_test|_spec)\.[cm]?[jt]sx?):$/;
const UNHANDLED_ERROR = '# Unhandled error between tests';

function isFailureLine(line: string): boolean {
  return line.startsWith('(fail)') || line.startsWith('✖') || line === UNHANDLED_ERROR;
}

/** Each failure line in `output`, prefixed with the file whose header came last before it. */
export function failuresWithFiles(output: string): string[] {
  let file: string | undefined;
  const failures: string[] = [];
  for (const line of output.split('\n')) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    if (!isFailureLine(line)) continue;
    failures.push(file === undefined ? line : `${file}: ${line}`);
  }
  return failures;
}
