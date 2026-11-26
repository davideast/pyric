import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from '../../scripts/lib/private-job-tmpdir.ts';
import { runTimedCommand } from '../apps/install.ts';
import { listen } from './model-channel.ts';
import { builderRunDirsAt, type BuilderRunDirs } from './round-paths.ts';
import { BUILDER_LOG, phaseResultSchema, runPhase, type Phase } from './run-phase.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const RUN_PHASE_SOURCE = join(REPO_ROOT, 'test', 'builders', 'run-phase.ts');
const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    removePrivateJobTmpDir(dir);
  }
});

function createRunDirs(label: string, phase: Phase): BuilderRunDirs {
  const root = createPrivateJobTmpDir(label);
  tempRoots.push(root);
  const dirs = builderRunDirsAt(root);
  for (const dir of [dirs.app, dirs.home, dirs.logs, dirs.docs]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(dirs.phase, `${JSON.stringify(phase)}\n`);
  return dirs;
}

describe('test/builders/run-phase.ts (#1658, #2140)', () => {
  test('contains no process.exit workaround and stays strictly plain ASCII', () => {
    const raw = readFileSync(RUN_PHASE_SOURCE);
    for (const byte of raw) {
      expect(byte).toBeLessThanOrEqual(127);
    }
    const text = raw.toString('utf8');
    expect(text).not.toContain('process.exit');
  });

  test('exits a child process immediately after a short command under a 60s wallClockMs cap without process.exit(0)', async () => {
    const phase: Phase = {
      command: 'node',
      args: ['-e', "process.stdout.write('builder-finished\\n')"],
      env: {},
      wallClockMs: 60_000,
      modelChannel: true,
      log: BUILDER_LOG,
    };
    const dirs = createRunDirs('phase-exit', phase);
    const forwarder = await listen(
      (server) => server.listen(dirs.modelSocket),
      (socket) => socket.destroy(),
    );

    const runPhaseUrl = new URL('./run-phase.ts', import.meta.url).href;
    const roundPathsUrl = new URL('./round-paths.ts', import.meta.url).href;
    const inline = [
      `import { runPhase } from ${JSON.stringify(runPhaseUrl)};`,
      `import { builderRunDirsAt } from ${JSON.stringify(roundPathsUrl)};`,
      `const dirs = builderRunDirsAt(${JSON.stringify(dirs.root)});`,
      'await runPhase(dirs, {',
      "  startBrowser: async () => ({ wsEndpoint: 'ws://127.0.0.1:9/stub', stop: async () => {} }),",
      '});',
    ].join('\n');

    try {
      const started = performance.now();
      const child = await runTimedCommand(process.execPath, ['-e', inline], {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH },
        timeoutMs: 15_000,
      });
      const elapsedMs = performance.now() - started;
      expect({ code: child.code, timedOut: child.timedOut }).toEqual({ code: 0, timedOut: false });
      expect(elapsedMs).toBeLessThan(15_000);

      const recorded = phaseResultSchema.parse(JSON.parse(readFileSync(dirs.phaseResult, 'utf8')));
      expect(recorded.code).toBe(0);
      expect(recorded.timedOut).toBe(false);
      expect(recorded.error).toBeNull();
      expect(readFileSync(join(dirs.logs, BUILDER_LOG), 'utf8')).toContain('builder-finished');
    } finally {
      await forwarder.close();
    }
  }, 20_000);

  test('records timedOut=true and preserves flushed step output and group diagnostics in logs/builder.log', async () => {
    const phase: Phase = {
      command: 'node',
      args: [
        '-e',
        [
          "process.stdout.write('phase-step: waiting-for-probe\\n');",
          "process.on('SIGTERM', () => { process.stdout.write('phase-step: sigterm-flush\\n', () => process.exit(0)); });",
          'setInterval(() => {}, 10_000);',
        ].join(' '),
      ],
      env: {},
      wallClockMs: 250,
      modelChannel: false,
      log: BUILDER_LOG,
    };
    const dirs = createRunDirs('phase-timeout', phase);

    await runPhase(dirs, {
      startBrowser: async () => ({ wsEndpoint: 'ws://127.0.0.1:9/stub', stop: async () => {} }),
    });

    const recorded = phaseResultSchema.parse(JSON.parse(readFileSync(dirs.phaseResult, 'utf8')));
    expect(recorded.code).toBeNull();
    expect(recorded.timedOut).toBe(true);
    expect(recorded.error).toBeNull();

    const builderLog = readFileSync(join(dirs.logs, BUILDER_LOG), 'utf8');
    expect(builderLog).toContain('phase-step: waiting-for-probe');
    expect(builderLog).toContain('phase-step: sigterm-flush');
    expect(builderLog).toContain('timed out after 0.25s; processes in its group:');
  }, 15_000);
});
