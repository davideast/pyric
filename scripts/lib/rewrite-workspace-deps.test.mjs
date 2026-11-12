import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findRangedPins, rewriteWorkspaceDependencies } from './rewrite-workspace-deps.mjs';

const root = resolve(import.meta.dir, '../..');
const script = join(root, 'scripts/lib/rewrite-workspace-deps.mjs');
const versions = new Map([
  ['@pyric/rules', '0.1.0'],
  ['pyric', '0.1.0-alpha.35'],
]);
const workDirs = [];

afterEach(() => {
  for (const directory of workDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeManifest(manifest) {
  const work = mkdtempSync(join(tmpdir(), 'rewrite-workspace-deps-'));
  workDirs.push(work);
  const path = join(work, 'package.json');
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

describe('packing workspace dependencies', () => {
  test('a dependency on @pyric/rules packs at its exact version', () => {
    const pkg = { name: 'pyric', dependencies: { '@pyric/rules': 'workspace:*', zod: '^3.23.0' } };
    expect(rewriteWorkspaceDependencies(pkg, versions).unresolved).toEqual([]);
    expect(pkg.dependencies).toEqual({ '@pyric/rules': '0.1.0', zod: '^3.23.0' });
  });

  test('peer and optional dependencies on @pyric/rules pack exact as well', () => {
    const pkg = {
      name: 'x',
      peerDependencies: { '@pyric/rules': 'workspace:^' },
      optionalDependencies: { '@pyric/rules': 'workspace:*' },
    };
    rewriteWorkspaceDependencies(pkg, versions);
    expect(pkg.peerDependencies['@pyric/rules']).toBe('0.1.0');
    expect(pkg.optionalDependencies['@pyric/rules']).toBe('0.1.0');
  });

  test('a dependency on a package of the pyric release line keeps its caret', () => {
    const pkg = { name: 'pyric-admin', dependencies: { pyric: 'workspace:*' } };
    rewriteWorkspaceDependencies(pkg, versions);
    expect(pkg.dependencies.pyric).toBe('^0.1.0-alpha.35');
  });

  test('a workspace dependency on no workspace package is reported', () => {
    const pkg = { name: 'x', dependencies: { '@pyric/gone': 'workspace:*' } };
    expect(rewriteWorkspaceDependencies(pkg, versions).unresolved).toHaveLength(1);
  });
});

describe('the pinned-dependency check on a packed manifest', () => {
  test('passes an exact @pyric/rules dependency', () => {
    expect(findRangedPins({ name: 'pyric', dependencies: { '@pyric/rules': '0.1.0' } }, versions)).toEqual([]);
  });

  test('refuses a range, another version, or a dependency left on the workspace protocol', () => {
    for (const spec of ['^0.1.0', '~0.1.0', '>=0.1.0', '0.1.1', 'workspace:*']) {
      expect(findRangedPins({ name: 'pyric', dependencies: { '@pyric/rules': spec } }, versions)).toEqual([
        `pyric dependencies["@pyric/rules"] is "${spec}", expected exactly "0.1.0"`,
      ]);
    }
  });

  test('refuses a ranged peer dependency on @pyric/rules', () => {
    expect(findRangedPins({ name: 'x', peerDependencies: { '@pyric/rules': '^0.1.0' } }, versions)).toHaveLength(1);
  });

  test('the command line rewrites the real pyric manifest and its check passes the result', () => {
    const path = writeManifest(JSON.parse(readFileSync(join(root, 'packages/pyric/package.json'), 'utf8')));
    const rewrite = spawnSync(process.execPath, [script, path, root], { encoding: 'utf8' });
    expect(rewrite.status).toBe(0);
    const rulesVersion = JSON.parse(readFileSync(join(root, 'packages/rules/package.json'), 'utf8')).version;
    expect(JSON.parse(readFileSync(path, 'utf8')).dependencies['@pyric/rules']).toBe(rulesVersion);
    const check = spawnSync(process.execPath, [script, '--check', path, root], { encoding: 'utf8' });
    expect(check.status).toBe(0);
  });

  test('the command line check exits 1 and names a caret dependency on @pyric/rules', () => {
    const path = writeManifest({ name: 'pyric', dependencies: { '@pyric/rules': '^0.1.0' } });
    const check = spawnSync(process.execPath, [script, '--check', path, root], { encoding: 'utf8' });
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('pyric dependencies["@pyric/rules"] is "^0.1.0"');
  });
});
