import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { harnessView, packageClosure } from './harness-view.ts';
import { sandboxArgs } from './namespace.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

describe('harnessView', () => {
  const view = harnessView(REPO_ROOT);

  test('binds the harness’s own files, never the repo or a package’s source', () => {
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

describe('packageClosure', () => {
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
