#!/usr/bin/env bun
/**
 * Prove the standalone binary scaffolds a project that installs + builds with
 * the still-unpublished `pyric` / `@pyric/cli` — no registry 404. Runs the real
 * chain a user hits: `pyric init --template web` (vendor mode) -> `bun install`
 * -> `vite build`. Needs network for the published deps (firebase, vite, …);
 * `pyric`/`@pyric/cli` come from the embedded tarballs.
 *
 *   bun scripts/compile.ts host && bun scripts/standalone-vendor-smoke.ts
 *
 * Exits non-zero on the first failure.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PKG_ROOT, 'dist-bin', 'pyric');
if (!existsSync(BIN)) {
  process.stderr.write(`vendor-smoke: no binary at ${BIN}. Run "bun scripts/compile.ts host" first.\n`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'pyric-vendor-'));
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed++;
}
function run(cmd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd: work, encoding: 'utf8', env: process.env });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

process.stdout.write(`standalone vendor smoke (in ${work}):\n`);

const init = run(BIN, ['init', '--template', 'web', '--name', 'vendor-smoke']);
check('pyric init (vendor mode)', init.code === 0 && /vendored/.test(init.out + init.err));
check('vendor/ tarballs written', existsSync(join(work, 'vendor', 'pyric-cli.tgz')) && existsSync(join(work, 'vendor', 'pyric.tgz')));
const pkg = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};
check('package.json uses file: deps', pkg.devDependencies?.['@pyric/cli'] === 'file:vendor/pyric-cli.tgz');
check('package.json pins pyric override', pkg.overrides?.['pyric'] === 'file:vendor/pyric.tgz');

const install = run('bun', ['install']);
check('bun install (no registry 404)', install.code === 0, install.code === 0 ? '' : install.err.split('\n').slice(-3).join(' '));
check('pyric resolved from tarball (no nested stub)', !existsSync(join(work, 'node_modules', '@pyric/cli', 'node_modules', 'pyric')));
check('pyric/rules/node present', existsSync(join(work, 'node_modules', 'pyric', 'dist', 'rules', 'node.js')));

const build = run('bun', ['run', 'build']);
check('vite build', build.code === 0 && existsSync(join(work, 'dist', 'index.html')), build.code === 0 ? '' : build.err.split('\n').slice(-3).join(' '));

process.stdout.write(failed === 0 ? '\n✅ vendor smoke passed\n' : `\n❌ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
