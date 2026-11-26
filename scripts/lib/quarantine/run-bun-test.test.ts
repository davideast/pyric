// Runs real `bun test` processes on small suites written to a temporary
// directory, through the quarantine runner, and checks the exit code each ends
// with. No browser and no network.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from '../private-job-tmpdir.ts';
import { REPO_ROOT, addDays, entryFileName, type LoadedEntry } from './entries.ts';
import { runBunTest, runBunTestVerdict, splitBatchArgs } from './run-bun-test.ts';

const TODAY = '2026-10-29';
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) removePrivateJobTmpDir(dir);
});

function suite(files: Record<string, string>): { cwd: string; id: (file: string, name?: string) => string } {
  const cwd = createPrivateJobTmpDir('quarantine-suite');
  dirs.push(cwd);
  for (const [name, text] of Object.entries(files)) {
    const filePath = join(cwd, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, text);
  }
  const base = relative(REPO_ROOT, cwd);
  return {
    cwd,
    id: (file, name) => {
      if (name === undefined) {
        return `${base}/${file}`;
      }
      return `${base}/${file} > ${name}`;
    },
  };
}

function entry(test: string, expires: string = addDays(TODAY, 14)): LoadedEntry {
  return { test, issue: 1, owner: 'test', reason: 'test', added: TODAY, expires, renewals: [], file: entryFileName(test) };
}

const FLAKY = `import { describe, expect, test } from 'bun:test';
describe('flaky', () => { test('fails', () => { expect(1).toBe(2); }); });
test('passes', () => {});
`;
const OTHER_FAILURE = `import { test } from 'bun:test';
test('also fails', () => { throw new Error('real'); });
`;
const LOAD_ERROR = `import './missing-module';
`;
const BROKEN_HOOK = `import { beforeAll, describe, test } from 'bun:test';
describe('setup', () => { beforeAll(() => { throw new Error('hook broke'); }); test('never', () => {}); });
`;

const TWO_HOOKS = `import { beforeAll, describe, expect, test } from 'bun:test';
describe('flaky setup', () => { beforeAll(() => { throw new Error('flaky'); }); test('a', () => {}); });
describe('real regression', () => { beforeAll(() => { throw new Error('always'); }); test('important', () => { expect(1).toBe(1); }); });
`;
const DUPLICATE_NAMES = `import { describe, expect, test } from 'bun:test';
describe('d', () => {
  test('works', () => { throw new Error('the flake'); });
  test('works', () => { expect('regression').toBe('fixed'); });
});
`;
const EACH_SAME_NAME = `import { expect, test } from 'bun:test';
test.each([1, 2, 3])('handles input', (n) => { expect(n).toBe(0); });
`;
const NESTING_COLLISION = `import { describe, test } from 'bun:test';
describe('d', () => { describe('same', () => { test('x', () => { throw new Error('flake'); }); }); });
describe('d > same', () => { test('x', () => { throw new Error('regression'); }); });
`;
const RETRIED_FLAKE = `import { test } from 'bun:test';
let attempts = 0;
test('flaky with retry', () => { attempts += 1; if (attempts === 1) throw new Error('flake'); }, { retry: 2 });
test('other', () => { throw new Error('quarantined elsewhere'); });
`;

async function exitCode(cwd: string, entries: LoadedEntry[]): Promise<number> {
  const verdict = await runBunTestVerdict({ cwd, args: ['./'], suite: 'test', entries, today: TODAY, forward: () => {}, env: {}, quarantine: true });
  return verdict.exitCode;
}

describe('the quarantine runner on real bun test runs', () => {
  test('a run whose only failure is quarantined exits 0', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY });
    expect(await exitCode(run.cwd, [entry(run.id('flaky.test.ts', 'flaky > fails'))])).toBe(0);
  });

  test('the same run with no entry exits 1', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY });
    expect(await exitCode(run.cwd, [])).toBe(1);
  });

  test('a failure no entry covers keeps exit code 1', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY, 'other.test.ts': OTHER_FAILURE });
    expect(await exitCode(run.cwd, [entry(run.id('flaky.test.ts', 'flaky > fails'))])).toBe(1);
  });

  test('a file that fails to load, which JUnit leaves out, keeps exit code 1', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY, 'load.test.ts': LOAD_ERROR });
    expect(await exitCode(run.cwd, [entry(run.id('flaky.test.ts', 'flaky > fails'))])).toBe(1);
  });

  test('an expired entry keeps exit code 1', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY });
    expect(await exitCode(run.cwd, [entry(run.id('flaky.test.ts', 'flaky > fails'), '2026-10-28')])).toBe(1);
  });

  test('an unnamed entry forgives its own describe\'s hook failure', async () => {
    const hook = suite({ 'hook.test.ts': BROKEN_HOOK });
    expect(await exitCode(hook.cwd, [entry(hook.id('hook.test.ts', 'setup > (unnamed)'))])).toBe(0);
  });

  // Regressions from the review of #1663: each of these exited 0 before.
  test('an unnamed entry for one describe\'s hook does not forgive another describe\'s broken hook', async () => {
    const run = suite({ 'hooks.test.ts': TWO_HOOKS });
    expect(await exitCode(run.cwd, [entry(run.id('hooks.test.ts', 'flaky setup > (unnamed)'))])).toBe(1);
  });

  test('a file-level unnamed entry does not forgive a describe\'s broken hook', async () => {
    const run = suite({ 'hooks.test.ts': TWO_HOOKS });
    expect(await exitCode(run.cwd, [entry(run.id('hooks.test.ts', '(unnamed)'))])).toBe(1);
  });

  test('two tests with one name forgive neither', async () => {
    const run = suite({ 'dup.test.ts': DUPLICATE_NAMES });
    expect(await exitCode(run.cwd, [entry(run.id('dup.test.ts', 'd > works'))])).toBe(1);
  });

  test('test.each cases that share a name forgive none', async () => {
    const run = suite({ 'each.test.ts': EACH_SAME_NAME });
    expect(await exitCode(run.cwd, [entry(run.id('each.test.ts', 'handles input'))])).toBe(1);
  });

  test('a describe named "d > same" beside describe d > same forgives neither', async () => {
    const run = suite({ 'gt.test.ts': NESTING_COLLISION });
    expect(await exitCode(run.cwd, [entry(run.id('gt.test.ts', 'd > same > x'))])).toBe(1);
  });

  test('a quarantined test that passes on retry reports passed; a load error beside it still blocks', async () => {
    const run = suite({ 'retry.test.ts': RETRIED_FLAKE });
    const entries = [entry(run.id('retry.test.ts', 'flaky with retry')), entry(run.id('retry.test.ts', 'other'))];
    const verdict = await runBunTestVerdict({ cwd: run.cwd, args: ['./'], suite: 'test', entries, today: TODAY, forward: () => {}, env: {}, quarantine: true });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.outcomes.map((outcome) => outcome.outcome)).toEqual(['passed', 'failed']);
    const broken = suite({ 'retry.test.ts': RETRIED_FLAKE, 'broken.test.ts': LOAD_ERROR });
    const brokenEntries = [entry(broken.id('retry.test.ts', 'flaky with retry')), entry(broken.id('retry.test.ts', 'other'))];
    expect(await exitCode(broken.cwd, brokenEntries)).toBe(1);
  });

  test('without --quarantine the runner is plain bun test and forgives nothing', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY });
    const entries = [entry(run.id('flaky.test.ts', 'flaky > fails'))];
    expect(await runBunTest({ cwd: run.cwd, args: ['./'], suite: 'test', entries, today: TODAY, forward: () => {}, env: {}, quarantine: false })).toBe(1);
  });

  test('no .env file can turn quarantine on: a bun child that loads every old switch variable still fails', () => {
    // bun loads these files from its working directory into process.env.
    const switches = [
      'PYRIC_QUARANTINE=1', 'GITHUB_EVENT_NAME=push', 'GITHUB_REF=refs/heads/main',
      'PYRIC_QUARANTINE_BASE_ENTRIES=[]', '',
    ].join('\n');
    const run = suite({ 'flaky.test.ts': FLAKY, '.env': switches, '.env.local': switches, '.env.development': switches, 'drive.ts': '' });
    // The child judges expiry against the real date, not TODAY, so the entry expires relative to it.
    const realToday = new Date().toISOString().slice(0, 10);
    const entries = [entry(run.id('flaky.test.ts', 'flaky > fails'), addDays(realToday, 14))];
    const drive = [
      `const { main } = await import(${JSON.stringify(join(REPO_ROOT, 'scripts/ci/quarantine-test.ts'))});`,
      `console.log('switch', process.env.PYRIC_QUARANTINE, process.env.GITHUB_REF);`,
      `process.exit(await main([...process.argv.slice(2), '--cwd', ${JSON.stringify(run.cwd)}, '--suite', 'env'], ${JSON.stringify(entries)}));`,
      '',
    ].join('\n');
    writeFileSync(join(run.cwd, 'drive.ts'), drive);
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    const plain = Bun.spawnSync(['bun', 'drive.ts'], { cwd: run.cwd, env, stdout: 'pipe', stderr: 'pipe' });
    expect(plain.stdout.toString()).toContain('switch 1 refs/heads/main');
    expect(plain.exitCode).toBe(1);
    // The control: the same child with the flag forgives the quarantined failure.
    const flagged = Bun.spawnSync(['bun', 'drive.ts', '--quarantine'], { cwd: run.cwd, env, stdout: 'pipe', stderr: 'pipe' });
    expect(flagged.exitCode).toBe(0);
  });

  test('a passing run exits 0 and removes its temporary JUnit file', async () => {
    const runnerTempRoot = createPrivateJobTmpDir('quarantine-runner-temp');
    dirs.push(runnerTempRoot);
    const runnerTemp = join(runnerTempRoot, 'runner-temp');
    mkdirSync(runnerTemp, { recursive: true });
    const savedRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = runnerTemp;
    try {
      const run = suite({ 'pass.test.ts': "import { test } from 'bun:test';\ntest('ok', () => {});\n" });
      expect(await exitCode(run.cwd, [])).toBe(0);
      expect(readdirSync(runnerTemp)).toEqual([]);
    } finally {
      if (savedRunnerTemp === undefined) {
        delete process.env.RUNNER_TEMP;
      } else {
        process.env.RUNNER_TEMP = savedRunnerTemp;
      }
    }
  });

  test('isolates child bun test TMPDIR under ~/.cache/pyric-tmp/<suite> and removes it on exit', async () => {
    const recordDir = createPrivateJobTmpDir('quarantine-tmp-check');
    dirs.push(recordDir);
    const recordPath = join(recordDir, 'observed.json');
    const probeTest = [
      "import { mkdtempSync, writeFileSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "import { test } from 'bun:test';",
      "test('records tmpdir', () => {",
      '  const observedTmp = tmpdir();',
      "  const sub = mkdtempSync(join(observedTmp, 'inner-'));",
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ observedTmp, sub }));`,
      '});',
      '',
    ].join('\n');
    const run = suite({ 'tmp.test.ts': probeTest });
    expect(
      await runBunTest({
        cwd: run.cwd,
        args: ['./'],
        suite: 'privsuite',
        entries: [],
        today: TODAY,
        forward: () => {},
        env: {},
        quarantine: false,
      }),
    ).toBe(0);
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      observedTmp: string;
      sub: string;
    };
    expect(parsed.observedTmp.startsWith(join(homedir(), '.cache', 'pyric-tmp', ''))).toBe(true);
    expect(existsSync(parsed.observedTmp)).toBe(false);
    expect(existsSync(parsed.sub)).toBe(false);
  });

  test('fails when a *.test.* file crashes or exits before registering any test, with or without --quarantine (#1207)', async () => {
    const passing = "import { expect, test } from 'bun:test';\ntest('ok', () => { expect(1).toBe(1); });\n";
    const asyncCrashBeforeRegister = "setTimeout(() => { throw new Error('crash before registering'); }, 0);\n";
    const run = suite({ 'z_ok.test.ts': passing, 'a_crash.test.ts': asyncCrashBeforeRegister });
    const plainLogs: string[] = [];
    expect(
      await runBunTest({
        cwd: run.cwd,
        args: ['./'],
        suite: 'plain-crash',
        entries: [],
        today: TODAY,
        forward: (c) => plainLogs.push(c),
        env: {},
        quarantine: false,
      }),
    ).toBe(1);
    expect(plainLogs.join('')).toContain('a_crash.test.ts');

    const verdict = await runBunTestVerdict({
      cwd: run.cwd,
      args: ['./'],
      suite: 'quarantine-crash',
      entries: [],
      today: TODAY,
      forward: () => {},
      env: {},
      quarantine: true,
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.forgiven).toBe(false);
    expect(verdict.reason).toContain('a_crash.test.ts');

    const withQuarantinedFlake = suite({
      'flaky.test.ts': FLAKY,
      'a_crash.test.ts': asyncCrashBeforeRegister,
    });
    expect(
      await exitCode(withQuarantinedFlake.cwd, [
        entry(withQuarantinedFlake.id('flaky.test.ts', 'flaky > fails')),
      ]),
    ).toBe(1);
  });

  test('fails when a test file calls process.exit(0) before all files run, with or without --quarantine (#1207)', async () => {
    const earlyExit = 'process.exit(0);\n';
    const passing = "import { test } from 'bun:test';\ntest('never reached', () => {});\n";
    const run = suite({ 'a_exit.test.ts': earlyExit, 'z_ok.test.ts': passing });
    expect(
      await runBunTest({
        cwd: run.cwd,
        args: ['./'],
        suite: 'plain-early-exit',
        entries: [],
        today: TODAY,
        forward: () => {},
        env: {},
        quarantine: false,
      }),
    ).toBe(1);
    const verdict = await runBunTestVerdict({
      cwd: run.cwd,
      args: ['./'],
      suite: 'quarantine-early-exit',
      entries: [],
      today: TODAY,
      forward: () => {},
      env: {},
      quarantine: true,
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.forgiven).toBe(false);
  });

  test('allows non-test *.spec.ts contract files alongside passing *.test.ts suites (#1207)', async () => {
    const run = suite({
      'src/atoms.spec.ts': 'export const ATOM_SPECS = { auth: "auth != null" };\n',
      'test/atoms.test.ts': "import { expect, test } from 'bun:test';\ntest('ok', () => { expect(1).toBe(1); });\n",
    });
    expect(
      await runBunTest({
        cwd: run.cwd,
        args: ['./'],
        suite: 'spec-contract',
        entries: [],
        today: TODAY,
        forward: () => {},
        env: {},
        quarantine: false,
      }),
    ).toBe(0);
    expect(await exitCode(run.cwd, [])).toBe(0);
  });

  test('handles test files that call process.chdir() in beforeAll, where bun JUnit emits absolute file paths (#1207)', async () => {
    const chdirDir = createPrivateJobTmpDir('quarantine-chdir-target');
    dirs.push(chdirDir);
    const chdirTest = [
      "import { afterAll, beforeAll, expect, test } from 'bun:test';",
      'const orig = process.cwd();',
      `beforeAll(() => process.chdir(${JSON.stringify(chdirDir)}));`,
      'afterAll(() => process.chdir(orig));',
      "test('runs from another directory', () => { expect(process.cwd()).not.toBe(orig); });",
      '',
    ].join('\n');
    const run = suite({ 'test/chdir.test.ts': chdirTest });
    expect(
      await runBunTest({
        cwd: run.cwd,
        args: ['./test/chdir.test.ts'],
        suite: 'chdir-plain',
        entries: [],
        today: TODAY,
        forward: () => {},
        env: {},
        quarantine: false,
      }),
    ).toBe(0);
    expect(await exitCode(run.cwd, [])).toBe(0);
  });

  test('splits large explicit file lists into bounded child processes and combines verdicts (#3392)', async () => {
    expect(
      splitBatchArgs(['--timeout', '15000', './a.test.ts', './b.test.ts', './c.test.ts', './d.test.ts', './e.test.ts'], 2),
    ).toEqual([
      ['--timeout', '15000', './a.test.ts', './b.test.ts'],
      ['--timeout', '15000', './c.test.ts', './d.test.ts'],
      ['--timeout', '15000', './e.test.ts'],
    ]);
    expect(splitBatchArgs(['./'], 2)).toEqual([['./']]);
    expect(splitBatchArgs(['--bail', './a.test.ts', './b.test.ts', './c.test.ts'], 2)).toEqual([
      ['--bail', './a.test.ts', './b.test.ts', './c.test.ts'],
    ]);

    const pidRecordDir = createPrivateJobTmpDir('quarantine-batch-pids');
    dirs.push(pidRecordDir);
    const makePidTest = (slot: string) => [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { expect, test } from 'bun:test';",
      `test(${JSON.stringify(slot)}, () => {`,
      `  writeFileSync(join(${JSON.stringify(pidRecordDir)}, ${JSON.stringify(`${slot}.pid`)}), String(process.pid));`,
      '  expect(1).toBe(1);',
      '});',
      '',
    ].join('\n');

    const batchedPassing = suite({
      'f1.test.ts': makePidTest('f1'),
      'f2.test.ts': makePidTest('f2'),
      'f3.test.ts': makePidTest('f3'),
      'f4.test.ts': makePidTest('f4'),
      'f5.test.ts': makePidTest('f5'),
    });
    const explicitArgs = ['./f1.test.ts', './f2.test.ts', './f3.test.ts', './f4.test.ts', './f5.test.ts'];
    expect(
      await runBunTest({
        cwd: batchedPassing.cwd,
        args: explicitArgs,
        suite: 'batched-plain',
        entries: [],
        today: TODAY,
        forward: () => {},
        env: {},
        quarantine: false,
        maxFilesPerBatch: 2,
      }),
    ).toBe(0);
    const pids = ['f1', 'f2', 'f3', 'f4', 'f5'].map((slot) =>
      readFileSync(join(pidRecordDir, `${slot}.pid`), 'utf8'),
    );
    expect(pids[0]).toBe(pids[1]);
    expect(pids[2]).toBe(pids[3]);
    expect(new Set([pids[0], pids[2], pids[4]]).size).toBe(3);

    const batchedQuarantined = suite({
      'a.test.ts': "import { test } from 'bun:test';\ntest('ok-a', () => {});\n",
      'b.test.ts': FLAKY,
      'c.test.ts': "import { test } from 'bun:test';\ntest('ok-c', () => {});\n",
    });
    const qEntry = entry(batchedQuarantined.id('b.test.ts', 'flaky > fails'));
    const forgivenVerdict = await runBunTestVerdict({
      cwd: batchedQuarantined.cwd,
      args: ['./a.test.ts', './b.test.ts', './c.test.ts'],
      suite: 'batched-forgiven',
      entries: [qEntry],
      today: TODAY,
      forward: () => {},
      env: {},
      quarantine: true,
      maxFilesPerBatch: 1,
    });
    expect(forgivenVerdict.exitCode).toBe(0);
    expect(forgivenVerdict.forgiven).toBe(true);
    expect(forgivenVerdict.outcomes.map((o) => o.outcome)).toEqual(['failed']);

    const batchedMixed = suite({
      'a.test.ts': FLAKY,
      'b.test.ts': OTHER_FAILURE,
      'c.test.ts': "import { test } from 'bun:test';\ntest('ok-c', () => {});\n",
    });
    const blockedVerdict = await runBunTestVerdict({
      cwd: batchedMixed.cwd,
      args: ['./a.test.ts', './b.test.ts', './c.test.ts'],
      suite: 'batched-blocked',
      entries: [entry(batchedMixed.id('a.test.ts', 'flaky > fails'))],
      today: TODAY,
      forward: () => {},
      env: {},
      quarantine: true,
      maxFilesPerBatch: 1,
    });
    expect(blockedVerdict.exitCode).toBe(1);
    expect(blockedVerdict.forgiven).toBe(false);

    const batchedEarlyExit = suite({
      'a.test.ts': FLAKY,
      'b.test.ts': 'process.exit(0);\n',
      'c.test.ts': "import { test } from 'bun:test';\ntest('never', () => {});\n",
    });
    const earlyExitVerdict = await runBunTestVerdict({
      cwd: batchedEarlyExit.cwd,
      args: ['./a.test.ts', './b.test.ts', './c.test.ts'],
      suite: 'batched-early-exit',
      entries: [entry(batchedEarlyExit.id('a.test.ts', 'flaky > fails'))],
      today: TODAY,
      forward: () => {},
      env: {},
      quarantine: true,
      maxFilesPerBatch: 2,
    });
    expect(earlyExitVerdict.exitCode).toBe(1);
    expect(earlyExitVerdict.forgiven).toBe(false);
  });
});
