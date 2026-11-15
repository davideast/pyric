/**
 * Verifies that packed `@pyric/live/register` and `@pyric/cli/register`
 * preserve active register enforcement across child processes and
 * `worker_threads` even when callers supply foreign register preloads, decoy
 * register paths, or mutate/delete `PYRIC_SANDBOX` and `NODE_OPTIONS` after
 * activation.
 */
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface LiveProbe {
  readonly functionsOutcome: string;
  readonly liveActive: boolean;
  readonly sandboxActive: boolean;
}

interface SandboxProbe {
  readonly swapped: boolean;
  readonly adminError: string | null;
  readonly directStopCode: string;
  readonly sandboxEnv: string | null;
  readonly instanceEnv: string | null;
  readonly sessionEnv: string | null;
  readonly sandboxActive: boolean;
  readonly liveActive: boolean;
}

interface ChildRun<T> {
  readonly status: number | null;
  readonly probe: T | null;
  readonly hasConflictError?: boolean;
}

interface WorkerRun<T> {
  readonly code?: number;
  readonly error?: string;
  readonly errorMessage?: string;
  readonly hasConflictError?: boolean;
  readonly message: T | null;
}

function parseOutcome<T>(output: string): T {
  const line = output.split('\n').find((entry) => entry.startsWith('OUTCOME '));
  assert.ok(line, `expected an OUTCOME line:\n${output}`);
  return JSON.parse(line.slice('OUTCOME '.length)) as T;
}

export default scenario(async (app) => {
  await app.step(
    'live parent enforces @pyric/live/register in children and workers despite foreign @pyric/cli/register preloads',
    async () => {
      const run = await app.command('node', ['--import', '@pyric/live/register', 'live-parent.mjs'], {
        timeoutMs: 60_000,
      });
      assert.equal(run.code, 0, run.output);
      const outcome = parseOutcome<{
        readonly childImportCli: ChildRun<LiveProbe>;
        readonly childImportCliWithSandbox: ChildRun<LiveProbe>;
        readonly childRequireCli: ChildRun<LiveProbe>;
        readonly workerExecArgvCli: WorkerRun<LiveProbe>;
        readonly workerCustomEnvNodeOptionsCli: WorkerRun<LiveProbe>;
        readonly workerCustomEnvNodeOptionsCliWithSandbox: WorkerRun<LiveProbe>;
      }>(run.output);

      const expectedLive: LiveProbe = {
        functionsOutcome: 'PYRIC_LIVE_REFUSED',
        liveActive: true,
        sandboxActive: false,
      };

      for (const [label, child] of [
        ['childImportCli', outcome.childImportCli],
        ['childImportCliWithSandbox', outcome.childImportCliWithSandbox],
        ['childRequireCli', outcome.childRequireCli],
      ] as const) {
        assert.equal(child.status, 0, `${label} exited with ${String(child.status)}`);
        assert.deepEqual(child.probe, expectedLive, label);
      }

      for (const [label, worker] of [
        ['workerExecArgvCli', outcome.workerExecArgvCli],
        ['workerCustomEnvNodeOptionsCli', outcome.workerCustomEnvNodeOptionsCli],
        ['workerCustomEnvNodeOptionsCliWithSandbox', outcome.workerCustomEnvNodeOptionsCliWithSandbox],
      ] as const) {
        assert.equal(worker.error, undefined, label);
        assert.equal(worker.code, 0, label);
        assert.deepEqual(worker.message, expectedLive, label);
      }
    },
  );

  const launches: ReadonlyArray<{
    readonly label: string;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
  }> = [
    {
      label: 'CLI --import @pyric/cli/register',
      args: ['--import', '@pyric/cli/register', 'sandbox-parent.mjs'],
      env: {
        PYRIC_SANDBOX: '1',
        PYRIC_SANDBOX_INSTANCE: 'host-instance-1',
        PYRIC_SESSION_TOKEN: 'session-token-1',
      },
    },
    {
      label: 'NODE_OPTIONS --import @pyric/cli/register',
      args: ['sandbox-parent.mjs'],
      env: {
        NODE_OPTIONS: '--import @pyric/cli/register',
        PYRIC_SANDBOX: '1',
        PYRIC_SANDBOX_INSTANCE: 'host-instance-1',
        PYRIC_SESSION_TOKEN: 'session-token-1',
      },
    },
  ];

  for (const launch of launches) {
    await app.step(
      `sandbox parent (${launch.label}) blocks foreign/decoy preloads and pins sandbox env across children and workers`,
      async () => {
        const run = await app.command('node', [...launch.args], {
          env: launch.env,
          timeoutMs: 60_000,
        });
        assert.equal(run.code, 0, run.output);

        const outcome = parseOutcome<{
          readonly foreignPreload: {
            readonly childDecoyLive: ChildRun<SandboxProbe>;
            readonly workerExecArgvDecoyLive: WorkerRun<SandboxProbe>;
            readonly workerCustomEnvDecoyLive: WorkerRun<SandboxProbe>;
            readonly childRealLive: ChildRun<SandboxProbe>;
            readonly childRequireLiveEval: ChildRun<SandboxProbe>;
            readonly workerExecArgvRealLive: WorkerRun<SandboxProbe>;
            readonly workerCustomEnvRealLive: WorkerRun<SandboxProbe>;
          };
          readonly envPinning: {
            readonly syncDefaultEnv: ChildRun<SandboxProbe>;
            readonly syncStrippedEnv: ChildRun<SandboxProbe>;
            readonly asyncStrippedEnv: ChildRun<SandboxProbe>;
            readonly workerDefaultEnv: WorkerRun<SandboxProbe>;
            readonly workerCustomEnv: WorkerRun<SandboxProbe>;
            readonly workerSharedEnv: WorkerRun<SandboxProbe>;
            readonly workerEvalCjs: WorkerRun<{
              readonly swapped: boolean;
              readonly sandboxEnv: string | null;
              readonly instanceEnv: string | null;
              readonly sessionEnv: string | null;
              readonly sandboxActive: boolean;
            }>;
          };
        }>(run.output);

        const expectedSandbox: SandboxProbe = {
          swapped: true,
          adminError: null,
          directStopCode: 'PYRIC_REAL_SDK_STOPPED',
          sandboxEnv: '1',
          instanceEnv: 'host-instance-1',
          sessionEnv: 'session-token-1',
          sandboxActive: true,
          liveActive: false,
        };

        assert.equal(outcome.foreignPreload.childDecoyLive.status, 0);
        assert.deepEqual(outcome.foreignPreload.childDecoyLive.probe, expectedSandbox);

        for (const [label, worker] of [
          ['workerExecArgvDecoyLive', outcome.foreignPreload.workerExecArgvDecoyLive],
          ['workerCustomEnvDecoyLive', outcome.foreignPreload.workerCustomEnvDecoyLive],
        ] as const) {
          assert.equal(worker.errorMessage, undefined, label);
          assert.equal(worker.code, 0, label);
          assert.deepEqual(worker.message, expectedSandbox, label);
        }

        for (const [label, child] of [
          ['childRealLive', outcome.foreignPreload.childRealLive],
          ['childRequireLiveEval', outcome.foreignPreload.childRequireLiveEval],
        ] as const) {
          assert.notEqual(child.status, 0, label);
          assert.equal(child.probe, null, label);
          assert.equal(child.hasConflictError, true, label);
        }

        for (const [label, worker] of [
          ['workerExecArgvRealLive', outcome.foreignPreload.workerExecArgvRealLive],
          ['workerCustomEnvRealLive', outcome.foreignPreload.workerCustomEnvRealLive],
        ] as const) {
          assert.equal(worker.message, null, label);
          assert.equal(worker.hasConflictError, true, label);
        }

        for (const [label, child] of [
          ['syncDefaultEnv', outcome.envPinning.syncDefaultEnv],
          ['syncStrippedEnv', outcome.envPinning.syncStrippedEnv],
          ['asyncStrippedEnv', outcome.envPinning.asyncStrippedEnv],
        ] as const) {
          assert.equal(child.status, 0, label);
          assert.deepEqual(child.probe, expectedSandbox, label);
        }

        for (const [label, worker] of [
          ['workerDefaultEnv', outcome.envPinning.workerDefaultEnv],
          ['workerCustomEnv', outcome.envPinning.workerCustomEnv],
          ['workerSharedEnv', outcome.envPinning.workerSharedEnv],
        ] as const) {
          assert.equal(worker.errorMessage, undefined, label);
          assert.equal(worker.code, 0, label);
          assert.deepEqual(worker.message, expectedSandbox, label);
        }

        assert.equal(outcome.envPinning.workerEvalCjs.errorMessage, undefined);
        assert.equal(outcome.envPinning.workerEvalCjs.code, 0);
        assert.deepEqual(outcome.envPinning.workerEvalCjs.message, {
          swapped: true,
          sandboxEnv: '1',
          instanceEnv: 'host-instance-1',
          sessionEnv: 'session-token-1',
          sandboxActive: true,
        });
      },
    );
  }
});
