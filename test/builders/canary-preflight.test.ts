// The canary's preflight, against checkouts built here: it only reads paths.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packedPackageDirs, preflightProblems } from './canary/canary.ts';

const PACKED = ['packages/pyric', 'packages/cli'];

function checkout(options: { playwright?: boolean; dist?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'builders-preflight-'));
  if (options.playwright ?? true) mkdirSync(join(root, 'node_modules/@playwright/test'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/pack-packages.sh'), `#!/usr/bin/env bash\nPACKAGES=(\n${PACKED.map((dir) => `  "${dir}"`).join('\n')}\n)\n`);
  for (const dir of PACKED) mkdirSync(join(root, dir, ...((options.dist ?? true) ? ['dist'] : [])), { recursive: true });
  return root;
}

describe('packedPackageDirs', () => {
  test('reads the list the repo’s pack script packs', () => {
    const repo = fileURLToPath(new URL('../..', import.meta.url));
    expect(packedPackageDirs(repo)).toEqual(['packages/pyric', 'packages/pyric-admin', 'packages/create-pyric', 'packages/cli', 'packages/ui']);
  });
});

describe('preflightProblems', () => {
  test('passes a checkout with its own node_modules and a build', () => {
    expect(preflightProblems(checkout(), { build: false })).toEqual([]);
  });

  test('names a checkout with no node_modules of its own', () => {
    const root = checkout({ playwright: false });
    expect(preflightProblems(root, { build: false })).toEqual([`${root} has no node_modules/@playwright/test of its own: run \`bun install\` there first`]);
  });

  test('names a checkout whose node_modules links outside it', () => {
    const other = checkout();
    const root = checkout({ playwright: false });
    symlinkSync(join(other, 'node_modules'), join(root, 'node_modules'));
    expect(preflightProblems(root, { build: false })[0]).toContain('links outside the repo');
  });

  test('names the unbuilt packages when it would pack the current build, and not with --build', () => {
    const root = checkout({ dist: false });
    expect(preflightProblems(root, { build: false })).toEqual([`no dist/ in ${PACKED.join(', ')}: run with --build, or build first, or pass --packages <dir>`]);
    expect(preflightProblems(root, { build: true })).toEqual([]);
  });

  test('names a --packages directory that does not exist', () => {
    expect(preflightProblems(checkout(), { build: false, packages: '/nonexistent-1613' })).toEqual(['--packages /nonexistent-1613 does not exist']);
  });
});
