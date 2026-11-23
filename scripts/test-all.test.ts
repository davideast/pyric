// test-all through its real entry point, against a scratch checkout whose
// package.json holds a chain of its own (`--root`).
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testAll = fileURLToPath(new URL('./test-all.ts', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A run of a scratch checkout takes its heavy-run slot there, never the machine's. */
function envFor(root: string): NodeJS.ProcessEnv {
  return { ...process.env, PYRIC_HEAVY_RUN_DIR: join(root, '.heavy-runs') };
}

function checkout(chain: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pyric-test-all-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:serial': chain } }));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

/** A job that records its pid and a grandchild's, then waits to be stopped. */
const SLEEPER = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
writeFileSync(\`pids/\${process.pid}\`, '');
writeFileSync(\`pids/\${grandchild.pid}\`, '');
setTimeout(() => {}, 120000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

function recordedPids(root: string): number[] {
  return readdirSync(join(root, 'pids')).map(Number);
}

describe('stopping test-all stops every job and what the jobs started', () => {
  const cases: Array<{ signal: NodeJS.Signals; target: 'test-all' | 'its process group' }> = [
    { signal: 'SIGTERM', target: 'test-all' },
    { signal: 'SIGHUP', target: 'test-all' },
    { signal: 'SIGINT', target: 'test-all' },
    { signal: 'SIGKILL', target: 'its process group' },
  ];
  for (const { signal, target } of cases) {
    test(`${signal} to ${target} leaves no job running`, async () => {
      const root = checkout('bun sleeper.ts && bun sleeper.ts', { 'sleeper.ts': SLEEPER });
      mkdirSync(join(root, 'pids'));
      // Its own process group, as a shell gives a command it runs.
      const runner = spawn('bun', [testAll, `--root=${root}`, '--jobs=2'], { cwd: root, env: envFor(root), stdio: 'ignore', detached: true });
      const pid = runner.pid ?? 0;
      expect(await until(() => recordedPids(root).length === 4, 20_000)).toBe(true);
      const pids = recordedPids(root);
      const isGroupKill = target === 'its process group';
      process.kill(isGroupKill ? -pid : pid, signal);
      expect(await until(() => pids.every((each) => !isAlive(each)), 10_000)).toBe(true);
    }, 40_000);
  }
});

describe('a bun test job that ends before its summary', () => {
  test('fails the run, though the process exited 0', () => {
    const root = checkout('bun test', {
      'a.test.ts': "import { test } from 'bun:test';\ntest('exits the process', () => { process.exit(0); });\n",
      'b.test.ts': "import { test } from 'bun:test';\ntest('never runs', () => {});\n",
    });
    const run = spawnSync('bun', [testAll, `--root=${root}`, '--jobs=1'], { cwd: root, env: envFor(root), encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('printed no "Ran N tests across M files" summary');
    const log = join(root, 'test-results/test-all/bun-test.log');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).not.toContain('Ran ');
  });
});

describe('PYRIC_TEST_JOBS environment fallback when --jobs= is unset', () => {
  test('uses PYRIC_TEST_JOBS when --jobs is omitted, lets --jobs override it, and rejects invalid values', () => {
    const root = checkout('bun test a.test.ts && bun test b.test.ts', {
      'a.test.ts': "import { test } from 'bun:test';\ntest('a', () => {});\n",
      'b.test.ts': "import { test } from 'bun:test';\ntest('b', () => {});\n",
    });
    const envOne = spawnSync('bun', [testAll, `--root=${root}`], {
      cwd: root,
      env: { ...envFor(root), PYRIC_TEST_JOBS: '1' },
      encoding: 'utf8',
    });
    expect(envOne.status).toBe(0);
    expect(envOne.stdout).toContain('2 jobs, 1 at a time');

    const flagWins = spawnSync('bun', [testAll, `--root=${root}`, '--jobs=2'], {
      cwd: root,
      env: { ...envFor(root), PYRIC_TEST_JOBS: 'not-a-number' },
      encoding: 'utf8',
    });
    expect(flagWins.status).toBe(0);
    expect(flagWins.stdout).toContain('2 jobs, 2 at a time');

    for (const invalid of ['0', '-2', 'abc']) {
      const bad = spawnSync('bun', [testAll, `--root=${root}`], {
        cwd: root,
        env: { ...envFor(root), PYRIC_TEST_JOBS: invalid },
        encoding: 'utf8',
      });
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain('PYRIC_TEST_JOBS takes a whole number of at least 1');
    }
  });
});
