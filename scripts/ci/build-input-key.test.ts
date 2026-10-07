import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const script = resolve(import.meta.dir, 'build-input-key.sh');

let repo: string;

function git(...args: string[]): void {
  const run = Bun.spawnSync(['git', ...args], { cwd: repo });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function keys(): { packages: string; site: string } {
  const run = Bun.spawnSync(['bash', script], { cwd: repo });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  const out = run.stdout.toString();
  return {
    packages: /^packages-key=(\w+)$/m.exec(out)![1]!,
    site: /^site-key=(\w+)$/m.exec(out)![1]!,
  };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'build-input-key-'));
  git('init', '-q');
  write('packages/lib/src/index.ts', 'export const a = 1;\n');
  write('packages/lib/test/index.test.ts', 'test\n');
  write('packages/lib/test/unit/deep/nested.test.ts', 'nested\n');
  write('packages/lib/test/fixtures/data.json', '{}\n');
  write('scripts/build.sh', '#!/bin/sh\n');
  write('scripts/build-site.sh', '#!/bin/sh\n');
  write('scripts/site/page.ts', 'site\n');
  write('bun.lock', 'lock\n');
  git('add', '-A');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('build input key', () => {
  test('a test-only edit leaves both keys unchanged', () => {
    const before = keys();
    write('packages/lib/test/index.test.ts', 'edited\n');
    write('packages/lib/test/unit/deep/nested.test.ts', 'edited nested\n');
    write('packages/lib/test/fixtures/data.json', '{"edited":true}\n');
    git('add', '-A');
    expect(keys()).toEqual(before);
  });

  test('a source edit changes both keys', () => {
    const before = keys();
    write('packages/lib/src/index.ts', 'export const a = 2;\n');
    git('add', '-A');
    const after = keys();
    expect(after.packages).not.toBe(before.packages);
    expect(after.site).not.toBe(before.site);
  });
});
