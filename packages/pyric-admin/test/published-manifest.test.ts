import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '../../..');
const workDirs: string[] = [];

afterEach(() => {
  for (const directory of workDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('published pyric-admin manifest', () => {
  test('exports the messaging mirror required by the shipped chat template', () => {
    const work = mkdtempSync(join(tmpdir(), 'pyric-admin-published-manifest-'));
    workDirs.push(work);
    const manifestPath = join(work, 'package.json');
    writeFileSync(
      manifestPath,
      readFileSync(join(root, 'packages/pyric-admin/package.json'), 'utf8'),
    );

    const rewrite = spawnSync(
      process.execPath,
      [join(root, 'scripts/lib/rewrite-workspace-deps.mjs'), manifestPath, root],
      { encoding: 'utf8' },
    );
    expect(rewrite.status).toBe(0);

    const published = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    expect(Object.keys(published.exports ?? {})).toContain('./messaging');
  });
});
