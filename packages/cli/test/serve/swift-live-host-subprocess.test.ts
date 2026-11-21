import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  buildSwiftLiveHostTests,
  collectProcessEnv,
  formatSubprocessFailure,
  runManagedSubprocess,
  waitForProcessExit,
  type ManagedSubprocessResult,
} from './swift-live-host-subprocess.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

describe('swift-live-host-subprocess', () => {
  test(
    'detects zero-output startup stalls and terminates POSIX process groups on timeout',
    async () => {
      const env = collectProcessEnv();

      const stalled = await runManagedSubprocess({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30_000)'],
        cwd: REPO_ROOT,
        env,
        startupStallTimeoutMs: 300,
        timeoutMs: 5_000,
        killGraceMs: 300,
      });
      expect(stalled.timedOut).toBe(true);
      expect(stalled.timeoutReason).toBe('startup-stall');
      expect(stalled.receivedOutput).toBe(false);
      expect(formatSubprocessFailure('build', 1, stalled)).toContain('timeoutReason=startup-stall');

      const outputThenHangScript = [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });',
        'process.stdout.write(`GRANDCHILD_PID=${child.pid}\\n`);',
        'setTimeout(() => {}, 30_000);',
      ].join('\n');
      const hungAfterOutput = await runManagedSubprocess({
        command: process.execPath,
        args: ['-e', outputThenHangScript],
        cwd: REPO_ROOT,
        env,
        startupStallTimeoutMs: 1_000,
        timeoutMs: 2_200,
        killGraceMs: 500,
      });
      const match = /GRANDCHILD_PID=(\d+)/.exec(hungAfterOutput.stdout);
      if (match === null || match[1] === undefined) {
        throw new Error(`Expected GRANDCHILD_PID in stdout, got: ${hungAfterOutput.stdout}`);
      }
      const grandchildPid = Number(match[1]);
      try {
        expect(hungAfterOutput.receivedOutput).toBe(true);
        expect(hungAfterOutput.timedOut).toBe(true);
        expect(hungAfterOutput.timeoutReason).toBe('timeout');
        if (process.platform !== 'win32') {
          expect(await waitForProcessExit(grandchildPid, 1_500)).toBe(true);
        }
      } finally {
        if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
          try {
            process.kill(grandchildPid, 'SIGKILL');
          } catch {
            // Already exited.
          }
        }
      }
    },
    15_000,
  );

  test('retries build once on startup-stall and never retries real compile failures', async () => {
    let stallCalls = 0;
    const recovered = await buildSwiftLiveHostTests({
      swiftBinary: 'swift',
      repoRoot: REPO_ROOT,
      swiftPackageDir: '/repo/packages/swift-client',
      swiftScratchDir: '/repo/packages/swift-client/.build/live-host',
      env: {},
      runSubprocess: async (): Promise<ManagedSubprocessResult> => {
        stallCalls += 1;
        if (stallCalls === 1) {
          return {
            exitCode: null,
            signal: 'SIGTERM',
            stdout: '',
            stderr: '',
            elapsedMs: 60_001,
            timedOut: true,
            timeoutReason: 'startup-stall',
            receivedOutput: false,
          };
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: 'Build complete!',
          stderr: '',
          elapsedMs: 4_200,
          timedOut: false,
          timeoutReason: 'none',
          receivedOutput: true,
        };
      },
    });
    expect(stallCalls).toBe(2);
    expect(recovered.attempt).toBe(2);
    expect(recovered.result.exitCode).toBe(0);

    let compileCalls = 0;
    const failedCompile = await buildSwiftLiveHostTests({
      swiftBinary: 'swift',
      repoRoot: REPO_ROOT,
      swiftPackageDir: '/repo/packages/swift-client',
      swiftScratchDir: '/repo/packages/swift-client/.build/live-host',
      env: {},
      runSubprocess: async (): Promise<ManagedSubprocessResult> => {
        compileCalls += 1;
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'error: cannot find type in scope',
          elapsedMs: 1_500,
          timedOut: false,
          timeoutReason: 'none',
          receivedOutput: true,
        };
      },
    });
    expect(compileCalls).toBe(1);
    expect(failedCompile.attempt).toBe(1);
    expect(failedCompile.result.exitCode).toBe(1);
  });
});
