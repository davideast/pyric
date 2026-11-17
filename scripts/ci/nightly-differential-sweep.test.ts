import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildNightlySweepInvocation,
  computeNightlySweepWindow,
  runNightlySweepCli,
} from './nightly-differential-sweep.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');

describe('nightly-differential-sweep UTC seed rotation', () => {
  test('derives deterministic disjoint 2000-seed windows from the UTC calendar date', () => {
    const jan1Morning = computeNightlySweepWindow(new Date('2026-01-01T00:05:00.000Z'));
    const jan1Evening = computeNightlySweepWindow(new Date('2026-01-01T23:59:59.999Z'));
    expect(jan1Morning).toEqual({
      utcDate: '2026-01-01',
      dayOffset: 0,
      start: 1000,
      count: 2000,
      steps: 40,
      chunks: 2,
    });
    expect(jan1Evening.start).toBe(jan1Morning.start);

    const jan2 = computeNightlySweepWindow(new Date('2026-01-02T09:17:00.000Z'));
    expect(jan2.utcDate).toBe('2026-01-02');
    expect(jan2.start).toBe(3000);
    expect(jan2.start).toBe(jan1Morning.start + jan1Morning.count);

    const nov17 = computeNightlySweepWindow(new Date('2026-11-17T09:17:00.000Z'));
    expect(nov17.utcDate).toBe('2026-11-17');
    expect(nov17.dayOffset).toBe(320);
    expect(nov17.start).toBe(641000);
  });

  test('builds exact rtdb and firestore differential CLI invocations and rejects unknown targets', () => {
    const window = computeNightlySweepWindow(new Date('2026-11-17T09:17:00.000Z'));
    const rtdbInv = buildNightlySweepInvocation('rtdb', window);
    expect(rtdbInv.script).toBe('packages/cli/test/serve/rtdb-differential/differential.ts');
    expect(rtdbInv.args).toEqual(['--start=641000', '--count=2000', '--steps=40', '--chunks=2']);
    expect(rtdbInv.replayCommand).toBe(
      'bun packages/cli/test/serve/rtdb-differential/differential.ts --start=641000 --count=2000 --steps=40 --chunks=2',
    );

    const fsInv = buildNightlySweepInvocation('firestore', window);
    expect(fsInv.script).toBe('packages/cli/test/serve/firestore-differential/differential.ts');
    expect(fsInv.args).toEqual(['--start=641000', '--count=2000', '--steps=40', '--chunks=2']);

    expect(() => buildNightlySweepInvocation('unknown', window)).toThrow(
      /expected 'rtdb' or 'firestore'/,
    );
  });

  test('prints start seed and replay command, writes GITHUB_STEP_SUMMARY, and honors env overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-sweep-test-'));
    const summaryPath = join(dir, 'summary.md');
    const logs: string[] = [];
    const spawned: Array<{ cmd: string; args: string[] }> = [];

    try {
      const code = runNightlySweepCli({
        argv: ['rtdb'],
        env: {
          NIGHTLY_SWEEP_DATE: '2026-11-17',
          GITHUB_STEP_SUMMARY: summaryPath,
        },
        log: (line) => logs.push(line),
        spawnRunner: (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
      });

      expect(code).toBe(0);
      expect(spawned).toEqual([
        {
          cmd: 'bun',
          args: [
            'packages/cli/test/serve/rtdb-differential/differential.ts',
            '--start=641000',
            '--count=2000',
            '--steps=40',
            '--chunks=2',
          ],
        },
      ]);
      const joinedLogs = logs.join('\n');
      expect(joinedLogs).toContain('start=641000');
      expect(joinedLogs).toContain(
        'bun packages/cli/test/serve/rtdb-differential/differential.ts --start=641000 --count=2000 --steps=40 --chunks=2',
      );
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toContain('641000');
      expect(summary).toContain('rtdb-differential/differential.ts');

      expect(() =>
        runNightlySweepCli({
          argv: ['rtdb'],
          env: { NIGHTLY_SWEEP_DATE: '2026-02-99' },
          log: () => {},
          spawnRunner: () => 0,
        }),
      ).toThrow(/Invalid NIGHTLY_SWEEP_DATE/);

      expect(() =>
        runNightlySweepCli({
          argv: ['rtdb'],
          env: { NIGHTLY_SWEEP_DATE: '2026-02-31' },
          log: () => {},
          spawnRunner: () => 0,
        }),
      ).toThrow(/Invalid NIGHTLY_SWEEP_DATE/);

      expect(() =>
        runNightlySweepCli({
          argv: ['rtdb'],
          env: { NIGHTLY_SWEEP_DATE: 'not-a-timestamp' },
          log: () => {},
          spawnRunner: () => 0,
        }),
      ).toThrow(/Invalid NIGHTLY_SWEEP_DATE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('wires scheduled nightly sweeps in .github/workflows/build.yml without growing build.yml past 1454 lines', () => {
    const raw = readFileSync(join(REPO_ROOT, '.github/workflows/build.yml'), 'utf8');
    let lineCount = raw.split('\n').length;
    if (raw.endsWith('\n')) {
      lineCount -= 1;
    }
    expect(lineCount).toBeLessThanOrEqual(1454);

    const parsed = Bun.YAML.parse(raw) as {
      jobs: Record<string, { steps?: Array<{ name?: string; if?: string; run?: string }> }>;
    };

    const rtdbSweep = parsed.jobs['rtdb-differential']?.steps?.find(
      (s) => s.name === 'Nightly sweep',
    );
    expect(rtdbSweep?.if).toBe("github.event_name == 'schedule'");
    expect(rtdbSweep?.run).toBe('bun scripts/ci/nightly-differential-sweep.ts rtdb');

    const fsSweep = parsed.jobs['firestore-differential']?.steps?.find(
      (s) => s.name === 'Nightly sweep',
    );
    expect(fsSweep?.if).toBe("github.event_name == 'schedule'");
    expect(fsSweep?.run).toBe('bun scripts/ci/nightly-differential-sweep.ts firestore');

    const planTests = parsed.jobs.plan?.steps?.find(
      (s) => s.name === 'Test fail-closed selection policy',
    );
    expect(planTests?.run).toContain('scripts/ci/nightly-differential-sweep.test.ts');
  });
});
