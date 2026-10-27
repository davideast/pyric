import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // Stands in for the conformance projection's line finder: it reports the
  // line the evidence link to the one cited test file points at.
  write('packages/conformance/src/test-line-anchors.ts', [
    "import { readFileSync } from 'node:fs';",
    "const lines = readFileSync('packages/lib/test/cited.test.ts', 'utf8').split('\\n');",
    "console.log(`lib#M1\\tpackages/lib/test/cited.test.ts\\t${lines.findIndex((line) => line.includes('lib#M1')) + 1}`);",
    '',
  ].join('\n'));
  write('packages/lib/test/cited.test.ts', "test('lib#M1 reads the thing')\n");
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

  test('moving a line the conformance projection links to changes both keys', () => {
    const before = keys();
    write('packages/lib/test/cited.test.ts', "// a new first line\ntest('lib#M1 reads the thing')\n");
    git('add', '-A');
    const after = keys();
    expect(after.packages).not.toBe(before.packages);
    expect(after.site).not.toBe(before.site);
  });

  test('editing a cited test file below the linked line leaves both keys unchanged', () => {
    const before = keys();
    write('packages/lib/test/cited.test.ts', "// a new first line\ntest('lib#M1 reads the thing')\ntest('another case')\n");
    git('add', '-A');
    expect(keys()).toEqual(before);
  });

  test('the keys are not computed when the cited test lines cannot be listed, or the list is empty', () => {
    const finder = join(repo, 'packages/conformance/src/test-line-anchors.ts');
    const source = readFileSync(finder, 'utf8');
    try {
      for (const broken of ['process.exit(3);\n', '// prints nothing\n']) {
        writeFileSync(finder, broken);
        const run = Bun.spawnSync(['bash', script], { cwd: repo });
        expect(run.exitCode).not.toBe(0);
      }
    } finally {
      writeFileSync(finder, source);
    }
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
