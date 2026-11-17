import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOracleDriftReport } from './oracle-drift-report.ts';

function initObservationGitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'drift-report-repo-'));
  execFileSync('git', ['init'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  const obsDir = join(cwd, 'packages', 'conformance', 'observations', 'app');
  mkdirSync(obsDir, { recursive: true });
  writeFileSync(
    join(obsDir, 'sample-probe.json'),
    `${JSON.stringify(
      {
        name: 'sample-probe',
        matrixRow: '',
        rowIds: ['app#1'],
        description: 'sample observation',
        observedAt: '2026-11-01T00:00:00.000Z',
        behavior: { allowed: true, count: 2 },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync('git', ['add', '.'], { cwd });
  execFileSync('git', ['commit', '-m', 'seed observation'], { cwd });
  return cwd;
}

describe('oracle-drift-report CLI and step summary actionability', () => {
  test('returns 2 when rig label is missing', () => {
    const errs: string[] = [];
    const code = runOracleDriftReport({
      label: '',
      cwd: process.cwd(),
      env: {},
      log: () => {},
      error: (msg) => errs.push(msg),
    });
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('usage:');
  });

  test('ignores observedAt-only rewrites and exits 0', () => {
    const cwd = initObservationGitRepo();
    try {
      const obsFile = join(cwd, 'packages', 'conformance', 'observations', 'app', 'sample-probe.json');
      writeFileSync(
        obsFile,
        `${JSON.stringify(
          {
            behavior: { count: 2, allowed: true },
            observedAt: '2026-11-17T20:00:00.000Z',
            description: 'sample observation',
            rowIds: ['app#1'],
            matrixRow: '',
            name: 'sample-probe',
          },
          null,
          2,
        )}\n`,
      );
      const logs: string[] = [];
      const code = runOracleDriftReport({
        label: 'unattended',
        cwd,
        env: {},
        log: (msg) => logs.push(msg),
        error: () => {},
      });
      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('no drift');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('writes actionable unified diff to BOTH stdout and GITHUB_STEP_SUMMARY when drift occurs', () => {
    const cwd = initObservationGitRepo();
    try {
      const obsFile = join(cwd, 'packages', 'conformance', 'observations', 'app', 'sample-probe.json');
      writeFileSync(
        obsFile,
        `${JSON.stringify(
          {
            name: 'sample-probe',
            matrixRow: '',
            rowIds: ['app#1'],
            description: 'sample observation',
            observedAt: '2026-11-17T20:00:00.000Z',
            behavior: { allowed: false, count: 3 },
          },
          null,
          2,
        )}\n`,
      );
      const summaryFile = join(cwd, 'step-summary.md');
      const outputFile = join(cwd, 'github-output.txt');
      const logs: string[] = [];
      const errs: string[] = [];

      const code = runOracleDriftReport({
        label: 'messaging-send',
        cwd,
        env: {
          GITHUB_STEP_SUMMARY: summaryFile,
          GITHUB_OUTPUT: outputFile,
          GITHUB_RUN_ID: '123456789',
          RIG: 'messaging-send',
        },
        log: (msg) => logs.push(msg),
        error: (msg) => errs.push(msg),
      });

      expect(code).toBe(1);
      const stdoutText = logs.join('\n');
      const summaryText = readFileSync(summaryFile, 'utf8');
      const ghOutputText = readFileSync(outputFile, 'utf8');

      // Both stdout (for gh run view --log-failed) AND GITHUB_STEP_SUMMARY carry the full diff & artifact command!
      for (const rendered of [stdoutText, summaryText]) {
        expect(rendered).toContain('packages/conformance/observations/app/sample-probe.json');
        expect(rendered).toContain('-    "allowed": true,');
        expect(rendered).toContain('+    "allowed": false,');
        expect(rendered).toContain('gh run download 123456789 -n observation-drift-messaging-send');
      }
      expect(ghOutputText).toContain('found=true');
      expect(errs.join('\n')).toContain('::error::');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
