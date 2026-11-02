// The real `factory` command, killed with SIGKILL partway and started again
// with --resume: the second process keeps the first one's deadline and runs
// to it. Sessions come from fixtures/quick-runner.ts; the run takes about
// eight seconds of real time.
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readRun, runPaths } from './run-dir.ts';
import { readTimeline, type TimelineLine } from './timeline.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const RUNNER = resolve(import.meta.dir, 'fixtures/quick-runner.ts');
const HOURS = '0.002';
const POLL_MS = 50;

type SessionLine = Extract<TimelineLine, { type: 'session' }>;

function factoryArgs(runDir: string, extra: readonly string[]): string[] {
  return ['test/builders/harness.ts', 'factory', '--run-dir', runDir, '--runner', RUNNER, ...extra];
}

function sessionLines(runDir: string): SessionLine[] {
  return readTimeline(runPaths(runDir).timeline).filter((line): line is SessionLine => line.type === 'session');
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

describe('factory, as a process', () => {
  test('a supervisor killed with SIGKILL resumes with --resume and the same deadline', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'factory-process-'));
    const first = spawn(process.execPath, factoryArgs(runDir, ['--hours', HOURS]), { cwd: REPO_ROOT, stdio: 'ignore' });
    await waitFor(() => sessionLines(runDir).length >= 3, 5_000);
    const exited = new Promise((done) => first.once('exit', done));
    first.kill('SIGKILL');
    await exited;
    const deadline = readRun(runPaths(runDir)).deadline;
    const sessionsBefore = sessionLines(runDir).length;

    const second = spawnSync(process.execPath, factoryArgs(runDir, ['--resume']), { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`factory run until ${deadline}`);
    expect(readRun(runPaths(runDir)).deadline).toBe(deadline);

    const timeline = readTimeline(runPaths(runDir).timeline);
    const restart = timeline.find((line) => line.type === 'restart');
    expect(restart).toMatchObject({ type: 'restart', deadline, pid: second.pid });
    expect(sessionLines(runDir).length).toBeGreaterThan(sessionsBefore);
    expect(sessionLines(runDir).every((line) => Date.parse(line.end) <= Date.parse(deadline) + 1_000)).toBe(true);
    expect(timeline.at(-1)?.type).toBe('end');

    const again = spawnSync(process.execPath, factoryArgs(runDir, ['--resume']), { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(`ended at ${deadline}`);
  }, 30_000);
});
