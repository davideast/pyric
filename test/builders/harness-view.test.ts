import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { HARNESS_FILES, HARNESS_PACKAGES, harnessView, packageClosure } from './harness-view.ts';
import { sandboxArgs } from './namespace.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

describe('harnessView', () => {
  const view = harnessView(REPO_ROOT);

  test('binds the harness’s own files, never the repo or the repo’s packages’ source', () => {
    expect(view.readOnly).not.toContain(REPO_ROOT);
    expect(view.readOnly.filter((path) => isUnder(path, join(REPO_ROOT, 'packages')))).toEqual([
      join(REPO_ROOT, 'packages', 'cli', 'test', 'blackholed-port.ts'),
      join(REPO_ROOT, 'packages', 'cli', 'src', 'google-endpoints.ts'),
      join(REPO_ROOT, 'packages', 'cli', 'package.json'),
    ]);
    expect(view.readOnly.every((path) => existsSync(path))).toBe(true);
  });

  test('binds zod and Playwright’s client, with their dependencies, at node_modules/<name>', () => {
    const names = view.views.map((entry) => entry.dest.slice(join(REPO_ROOT, 'node_modules').length + 1)).sort();
    expect(names).toEqual(['@playwright/test', 'playwright', 'playwright-core', 'zod']);
    expect(view.views.every((entry) => existsSync(join(entry.source, 'package.json')))).toBe(true);
  });
});

/**
 * Every file that runs inside a sandbox, from where the harness names it:
 * namespace.ts' HOLDER and INVENTORY, scratch.ts' RECORDER_PRELOAD,
 * builder-run.ts' RUN_PHASE and DOCS_EXPORT, browser-server.ts (which starts
 * itself with node), the canary's PLANT_PHASE and BROWSER_PLANTS, and the
 * fake builder.
 */
const SANDBOX_ENTRY_POINTS = [
  'recorder/holder.mjs', 'sandbox-inventory.ts', 'recorder/node-egress.mjs', 'run-phase.ts', 'docs-export.mjs',
  'browser-server.ts', 'canary/plant-phase.ts', 'canary/browser-plants.ts', 'fixtures/fake-builder.mjs',
];

const isBuiltin = (specifier: string) => specifier.startsWith('node:') || specifier.startsWith('bun:');
const packageName = (specifier: string) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

/** The files an entry point imports at run time, transitively, and the packages they name. Type-only imports are erased. */
function importGraph(entries: readonly string[]): { files: Set<string>; packages: Set<string> } {
  const transpiler = new Bun.Transpiler({ loader: 'tsx' });
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (isBuiltin(path)) continue;
      const isRelative = path.startsWith('.') || path.startsWith('/');
      if (isRelative) pending.push(resolve(dirname(file), path));
      else packages.add(packageName(path));
    }
  }
  return { files, packages };
}

describe('the in-sandbox import graph', () => {
  const graph = importGraph(SANDBOX_ENTRY_POINTS.map((entry) => join(import.meta.dir, entry)));
  const bound = HARNESS_FILES.map((path) => join(REPO_ROOT, path));

  test('every file it reaches is bound by HARNESS_FILES and exists', () => {
    const unbound = [...graph.files].filter((file) => !bound.some((path) => isUnder(file, path)) || !existsSync(file));
    expect(unbound.map((file) => relative(REPO_ROOT, file))).toEqual([]);
  });

  test('every package it names is in HARNESS_PACKAGES', () => {
    expect([...graph.packages].filter((name) => !HARNESS_PACKAGES.includes(name))).toEqual([]);
  });
});

/** A package directory with a manifest naming `dependencies`. */
function fakePackage(dir: string, dependencies: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: dir, dependencies }));
}

describe('packageClosure', () => {
  test('refuses two copies of one package, since the view binds one per name', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-view-'));
    fakePackage(join(root, 'node_modules', 'a'), { shared: '1' });
    fakePackage(join(root, 'node_modules', 'a', 'node_modules', 'shared'));
    fakePackage(join(root, 'node_modules', 'c'), { shared: '2' });
    fakePackage(join(root, 'node_modules', 'shared'));
    expect(() => packageClosure(root, ['a', 'c'])).toThrow('the harness needs two copies of shared inside the sandbox');
  });

  test('names a package no node_modules has', () => {
    const empty = mkdtempSync(join(tmpdir(), 'harness-view-'));
    expect(() => packageClosure(empty, ['no-such-package-for-the-harness'])).toThrow('the harness needs no-such-package-for-the-harness inside the sandbox');
  });
});

describe('sandboxArgs with views', () => {
  test('binds each view’s source at its destination, shorter destinations first', () => {
    const args = sandboxArgs({
      runRoot: '/r',
      readOnly: ['/repo/test/builders'],
      views: [{ source: '/repo/node_modules/.bun/zod@3/node_modules/zod', dest: '/repo/node_modules/zod' }],
      resolvConf: '/r/resolv.conf',
      hosts: '/r/hosts',
      etc: [],
    });
    const binds = args.flatMap((arg, index) => (arg === '--ro-bind' && (args[index + 2] ?? '').startsWith('/repo') ? [`${args[index + 1]} ${args[index + 2]}`] : []));
    expect(binds).toEqual(['/repo/test/builders /repo/test/builders', '/repo/node_modules/.bun/zod@3/node_modules/zod /repo/node_modules/zod']);
  });
});
