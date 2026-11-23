import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  buildSwiftLiveHostTests,
  collectProcessEnv,
  formatSubprocessFailure,
  probeSwiftLiveToolchain,
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

  test('probeSwiftLiveToolchain skips broken or missing swift with visible reason off CI and fails closed under PYRIC_REQUIRE_SWIFT_LIVE=1', () => {
    const runnable = probeSwiftLiveToolchain({
      env: {},
      whichSwift: () => '/usr/local/bin/swift',
      runVersionProbe: () => ({ status: 0, stdout: 'Swift Package Manager - Swift 6.4.2\n', stderr: '' }),
    });
    expect(runnable).toEqual({ skip: false, swiftBinary: '/usr/local/bin/swift', skipReason: null });

    const brokenLocal = probeSwiftLiveToolchain({
      env: {},
      whichSwift: () => '/opt/swift/bin/swift',
      runVersionProbe: () => ({
        status: 127,
        stdout: '',
        stderr: '/opt/swift/bin/swift-build: error while loading shared libraries: libxml2.so.2: cannot open shared object file\n',
      }),
    });
    expect(brokenLocal.skip).toBe(true);
    expect(brokenLocal.swiftBinary).toBeNull();
    expect(brokenLocal.skipReason).toContain('swift test --version exited 127:');
    expect(brokenLocal.skipReason).toContain('libxml2.so.2');

    const missingLocal = probeSwiftLiveToolchain({
      env: {},
      whichSwift: () => null,
    });
    expect(missingLocal).toEqual({ skip: true, swiftBinary: null, skipReason: 'swift binary not found in PATH' });

    const genericCi = probeSwiftLiveToolchain({
      env: { CI: 'true' },
      whichSwift: () => '/usr/local/bin/swift',
    });
    expect(genericCi.skip).toBe(true);
    expect(genericCi.skipReason).toContain('CI=true without PYRIC_REQUIRE_SWIFT_LIVE=1');

    const requiredBroken = probeSwiftLiveToolchain({
      env: { CI: 'true', PYRIC_REQUIRE_SWIFT_LIVE: '1' },
      whichSwift: () => '/opt/swift/bin/swift',
      runVersionProbe: () => ({ status: 127, stdout: '', stderr: 'missing libxml2.so.2\n' }),
    });
    expect(requiredBroken).toEqual({ skip: false, swiftBinary: '/opt/swift/bin/swift', skipReason: null });

    const requiredMissing = probeSwiftLiveToolchain({
      env: { PYRIC_REQUIRE_SWIFT_LIVE: '1' },
      whichSwift: () => null,
    });
    expect(requiredMissing).toEqual({ skip: false, swiftBinary: null, skipReason: null });
  });
});
