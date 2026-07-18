#!/usr/bin/env bun
/**
 * Prove the compiled standalone binary's full vendored-consumer story
 * (issue #369). Two legs:
 *
 * 1. `pyric vendor` in a fresh dir: the binary produces output (regression:
 *    the generated entry used to no-op silently), lays a tarball for EVERY
 *    embedded workspace package, merges `file:vendor/...` specs + overrides
 *    into package.json, and the manifests carry no `workspace:` deps
 *    (regression: EUNSUPPORTEDPROTOCOL on install). Then `bun install`
 *    resolves the graph, the installed `pyric` matches the binary's version
 *    and carries a probe symbol, the installed CLI bin runs, bun.lock pins
 *    every vendored name to its tarball (never a registry resolution), and a
 *    dead-registry install proves `file:` specs need no registry at all.
 * 2. `pyric init --template web` (vendor mode) → `bun install` → `vite build`,
 *    the original scaffold chain.
 *
 * Needs network for published deps (firebase, vite, …) on first install.
 *
 *   bun run build && bun scripts/compile.ts host && bun scripts/standalone-vendor-smoke.ts
 *
 * Exits non-zero if any check fails.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EMBEDDED_WORKSPACE_PACKAGES } from './standalone-embed.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PKG_ROOT, 'dist-bin', 'pyric');
if (!existsSync(BIN)) {
  process.stderr.write(`vendor-smoke: no binary at ${BIN}. Run "bun scripts/compile.ts host" first.\n`);
  process.exit(1);
}

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed++;
}
function run(
  cwd: string,
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const tail = (s: string): string => s.trim().split('\n').slice(-3).join(' ');

// ── Leg 1: `pyric vendor` consumer story ──────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'pyric-vendor-'));
process.stdout.write(`standalone vendor smoke — leg 1: pyric vendor (in ${work}):\n`);

// `--version` prints "@pyric/cli <semver>" plus a Firebase compat line —
// extract the bare semver for comparison with the installed manifest.
const binVersion = run(work, BIN, ['--version']).out.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? '';

const vendor = run(work, BIN, ['vendor']);
check('pyric vendor exits 0 with output (not silent)', vendor.code === 0 && vendor.out.trim().length > 0, tail(vendor.err));
check('vendor reports what it vendored', /vendored .*@pyric\/cli/.test(vendor.out));

for (const pkg of EMBEDDED_WORKSPACE_PACKAGES) {
  const tgz = join(work, 'vendor', pkg.tarball);
  check(`vendor/${pkg.tarball} laid (${pkg.name})`, existsSync(tgz));
  if (!existsSync(tgz)) continue;
  const manifest = run(work, 'tar', ['-xzOf', tgz, 'package/package.json']);
  check(
    `${pkg.tarball} manifest has no workspace: deps`,
    manifest.code === 0 && !manifest.out.includes('workspace:'),
  );
}

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  version?: string;
}
const pkg = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')) as Pkg;
check('package.json devDeps @pyric/cli = file:vendor/pyric-cli.tgz', pkg.devDependencies?.['@pyric/cli'] === 'file:vendor/pyric-cli.tgz');
check('package.json devDeps pyric = file:vendor/pyric.tgz', pkg.devDependencies?.['pyric'] === 'file:vendor/pyric.tgz');
for (const name of ['pyric', 'pyric-admin', 'create-pyric']) {
  const file = EMBEDDED_WORKSPACE_PACKAGES.find((p) => p.name === name)!.tarball;
  check(`package.json overrides ${name} → file:vendor/${file}`, pkg.overrides?.[name] === `file:vendor/${file}`);
}

const install = run(work, 'bun', ['install']);
check('bun install resolves the full graph', install.code === 0, install.code === 0 ? '' : tail(install.err));

const installedPyric = join(work, 'node_modules', 'pyric');
const installedVersion = existsSync(join(installedPyric, 'package.json'))
  ? (JSON.parse(readFileSync(join(installedPyric, 'package.json'), 'utf8')) as Pkg).version
  : undefined;
check(`installed pyric version matches binary (${binVersion})`, installedVersion === binVersion, `installed ${installedVersion}`);
const probe = run(work, 'grep', ['-rl', 'resetAll', join(installedPyric, 'dist')]);
check('installed pyric dist carries the resetAll probe symbol', probe.code === 0);
check('no nested pyric stub under @pyric/cli', !existsSync(join(work, 'node_modules', '@pyric/cli', 'node_modules', 'pyric')));
for (const name of ['pyric-admin', 'create-pyric']) {
  check(`node_modules/${name} installed`, existsSync(join(work, 'node_modules', name, 'package.json')));
}

const installedCli = run(work, 'node', [join(work, 'node_modules', '.bin', 'pyric'), '--version']);
check('installed CLI bin runs (--version exits 0 with output)', installedCli.code === 0 && installedCli.out.trim().length > 0, installedCli.out.trim() || tail(installedCli.err));

// No-registry resolution proof, two halves (a dead-registry re-install of the
// FULL graph is not provable: bun re-resolves the published deps — firebase,
// esbuild, … — against the registry regardless of cache):
// 1. bun.lock pins every vendored package to its `<name>@vendor/<file>.tgz`
//    tarball (never a registry resolution) — the unpublished names structurally
//    cannot 404 or pull a squatted registry copy.
const lock = readFileSync(join(work, 'bun.lock'), 'utf8');
for (const p of EMBEDDED_WORKSPACE_PACKAGES) {
  check(`bun.lock resolves ${p.name} from vendor/${p.tarball}`, lock.includes(`"${p.name}@vendor/${p.tarball}"`));
}
// 2. A dead-registry install of the vendored zero-dep tarball succeeds — a
//    `file:` spec needs no registry at all (env style: NPM_CONFIG_REGISTRY
//    pointed at a closed local port).
const offlineDir = mkdtempSync(join(tmpdir(), 'pyric-vendor-offline-'));
mkdirSync(join(offlineDir, 'vendor'), { recursive: true });
copyFileSync(join(work, 'vendor', 'create-pyric.tgz'), join(offlineDir, 'vendor', 'create-pyric.tgz'));
writeFileSync(
  join(offlineDir, 'package.json'),
  JSON.stringify({ name: 'offline-probe', private: true, devDependencies: { 'create-pyric': 'file:vendor/create-pyric.tgz' } }),
);
const offline = run(offlineDir, 'bun', ['install'], {
  ...process.env,
  NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
});
check(
  'dead-registry install resolves a file:vendor tarball (no registry needed)',
  offline.code === 0 && existsSync(join(offlineDir, 'node_modules', 'create-pyric', 'package.json')),
  offline.code === 0 ? '' : tail(offline.err),
);

// ── Leg 2: `pyric init` scaffold → install → vite build ───────────────
const scaffold = mkdtempSync(join(tmpdir(), 'pyric-vendor-init-'));
process.stdout.write(`\nleg 2: pyric init scaffold (in ${scaffold}):\n`);

const init = run(scaffold, BIN, ['init', '--template', 'web', '--name', 'vendor-smoke']);
check('pyric init (vendor mode) exits 0 with output', init.code === 0 && /vendored/.test(init.out + init.err), tail(init.err));
check(
  'scaffold vendor/ has every tarball',
  EMBEDDED_WORKSPACE_PACKAGES.every((p) => existsSync(join(scaffold, 'vendor', p.tarball))),
);
const scaffoldPkg = JSON.parse(readFileSync(join(scaffold, 'package.json'), 'utf8')) as Pkg;
check('scaffold package.json uses file: deps', scaffoldPkg.devDependencies?.['@pyric/cli'] === 'file:vendor/pyric-cli.tgz');
check('scaffold package.json pins pyric override', scaffoldPkg.overrides?.['pyric'] === 'file:vendor/pyric.tgz');

const scaffoldInstall = run(scaffold, 'bun', ['install']);
check('bun install (no registry 404)', scaffoldInstall.code === 0, scaffoldInstall.code === 0 ? '' : tail(scaffoldInstall.err));
check('pyric resolved from tarball (no nested stub)', !existsSync(join(scaffold, 'node_modules', '@pyric/cli', 'node_modules', 'pyric')));
check('pyric rules runtime present (dist/rules/internal/node.js)', existsSync(join(scaffold, 'node_modules', 'pyric', 'dist', 'rules', 'internal', 'node.js')));

const build = run(scaffold, 'bun', ['run', 'build']);
check('vite build', build.code === 0 && existsSync(join(scaffold, 'dist', 'index.html')), build.code === 0 ? '' : tail(build.err));

process.stdout.write(failed === 0 ? '\n✅ vendor smoke passed\n' : `\n❌ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
