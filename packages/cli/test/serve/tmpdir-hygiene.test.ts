import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const dedicatedTmps: string[] = [];

afterEach(() => {
  while (dedicatedTmps.length > 0) {
    const dir = dedicatedTmps.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('serve and snapshot test suite TMPDIR hygiene', () => {
  it('leaves dedicated TMPDIR completely empty after running rules, snapshot-promote, and vite-real-path-deny suites', () => {
    const dedicatedTmp = mkdtempSync(join(tmpdir(), 'pyric-tmpdir-regression-'));
    dedicatedTmps.push(dedicatedTmp);

    const suites = [
      'test/serve/rules.test.ts',
      'test/serve/snapshot-promote.test.ts',
      'test/serve/vite-real-path-deny.test.ts',
    ];
    for (const suite of suites) {
      const result = spawnSync('bun', ['test', suite], {
        cwd: CLI_ROOT,
        env: { ...process.env, TMPDIR: dedicatedTmp },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
    }

    expect(readdirSync(dedicatedTmp)).toEqual([]);
  }, 60_000);
});
