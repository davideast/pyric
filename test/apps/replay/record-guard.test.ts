/**
 * A recording never runs in CI: `record.ts` refuses when `CI` or
 * `GITHUB_ACTIONS` is set, before it loads the recorder, the SDK or the run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { recordingRefusal } from './record-guard.ts';

const RECORD = join(import.meta.dir, 'record.ts');
const RUN = join(import.meta.dir, 'fixtures', 'live-mode-traffic.run.ts');

describe('where a recording refuses', () => {
  test('a person may record with neither variable set, or with either empty', () => {
    expect(recordingRefusal({})).toBeNull();
    expect(recordingRefusal({ CI: '', GITHUB_ACTIONS: '' })).toBeNull();
  });

  test('CI or GITHUB_ACTIONS, with any value, refuses and names what is set', () => {
    expect(recordingRefusal({ CI: 'true' })).toContain('(CI is set)');
    expect(recordingRefusal({ GITHUB_ACTIONS: 'true' })).toContain('(GITHUB_ACTIONS is set)');
    expect(recordingRefusal({ CI: '1', GITHUB_ACTIONS: 'true' })).toContain('(CI and GITHUB_ACTIONS are set)');
  });

  for (const variable of ['CI', 'GITHUB_ACTIONS']) {
    test(`record.ts with ${variable} set exits before it records, with every argument it needs`, () => {
      const out = join(mkdtempSync(join(tmpdir(), 'pyric-record-guard-')), 'recording.json');
      const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', [variable]: 'true' };
      const run = spawnSync(process.execPath, [RECORD, '--project', 'demo-guard', '--out', out, RUN], { env, encoding: 'utf8', timeout: 30_000 });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('does not run in CI');
      expect(run.stdout).not.toContain('recording');
      expect(existsSync(out)).toBe(false);
    });
  }
});
