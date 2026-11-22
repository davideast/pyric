/**
 * Real-Node child integration checks for #1588 (`--require` preload before
 * main) and #1652 follow-ups:
 *   1. `Module.syncBuiltinESMExports()` updates ESM `{ spawnSync, execFileSync, execSync }`
 *      bindings imported in a preload that ran before `@pyric/cli/register`.
 *   2. Spawning `bun`, `bunx`, or `deno` from a registered Node process throws
 *      `PYRIC_UNSUPPORTED_RUNTIME` before an unswapped runtime can load real SDKs.
 *   3. Passing an explicit empty `PYRIC_GUARD_ALLOW: ''` to a child keeps `''`
 *      instead of refilling the parent's `PYRIC_GUARD_ALLOW`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCanonicalRegisterNodeOptions } from '../../src/register/child-process-guard.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const liveRoot = join(repoRoot, 'packages/live');
const cliRegisterFile = join(cliRoot, 'dist/register/index.js');
const liveRegisterFile = join(liveRoot, 'dist/register.js');
const cliRegisterUrl = pathToFileURL(cliRegisterFile).href;
const liveRegisterUrl = pathToFileURL(liveRegisterFile).href;
const nodeBin = process.env.PYRIC_TEST_NODE ?? 'node';

let fixtureDir = '';
let probeChildPath = '';

interface NodeRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runNode(args: readonly string[], env: Record<string, string | undefined>): NodeRunResult {
  const cleanEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: undefined,
    NODE_OPTIONS: undefined,
    PYRIC_SANDBOX: undefined,
    PYRIC_SANDBOX_FORCE: undefined,
    PYRIC_GUARD: undefined,
    PYRIC_GUARD_ALLOW: undefined,
    PYRIC_LIVE_PROJECT_ROOT: undefined,
    PYRIC_LIVE_SDK_ROOT: undefined,
    PYRIC_LIVE_PASS_THROUGH: undefined,
    PYRIC_PROJECT: undefined,
    GOOGLE_CLOUD_PROJECT: undefined,
    GCLOUD_PROJECT: undefined,
    FIREBASE_CONFIG: undefined,
    ...env,
  };
  const res = spawnSync(nodeBin, [...args], {
    cwd: fixtureDir,
    encoding: 'utf8',
    env: cleanEnv as NodeJS.ProcessEnv,
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function parsePrefixedLine<T>(stdout: string, prefix: string): T {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`Expected line starting with "${prefix}" in:\n${stdout}`);
  }
  return JSON.parse(line.slice(prefix.length)) as T;
}

beforeAll(() => {
  for (const required of [cliRegisterFile, liveRegisterFile]) {
    if (!existsSync(required)) {
      throw new Error(`Missing built register file: ${required}`);
    }
  }
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-preload-esm-bun-')));
  const nm = join(fixtureDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(cliRoot, join(nm, '@pyric/cli'));
  symlinkSync(liveRoot, join(nm, '@pyric/live'));
  symlinkSync(join(repoRoot, 'packages/pyric'), join(nm, 'pyric'));
  symlinkSync(join(repoRoot, 'packages/pyric-admin'), join(nm, 'pyric-admin'));
  symlinkSync(join(repoRoot, 'node_modules/firebase'), join(nm, 'firebase'));
  symlinkSync(join(repoRoot, 'node_modules/firebase-admin'), join(nm, 'firebase-admin'));

  writeFileSync(
    join(fixtureDir, 'package.json'),
    JSON.stringify({ name: 'preload-esm-bun-fixture', private: true, type: 'module' }),
  );
  writeFileSync(join(fixtureDir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));

  probeChildPath = join(fixtureDir, 'probe-child.mjs');
  writeFileSync(
    probeChildPath,
    [
      'const adminApp = await import("firebase-admin/app");',
      'console.log("CHILD_PROBE " + JSON.stringify({',
      '  swapped: adminApp.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target"),',
      '  active: globalThis[Symbol.for("pyric.register.active")] === true,',
      '  guardAllow: process.env.PYRIC_GUARD_ALLOW ?? null,',
      '}));',
    ].join('\n'),
  );
});

afterAll(() => {
  if (fixtureDir !== '') {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('register preload ordering and #1652 child-process follow-ups', () => {
  it('swaps firebase-admin/app in a --require preload when canonical NODE_OPTIONS leads (#1588)', () => {
    const preCjs = join(fixtureDir, 'pre-1588.cjs');
    const mainMjs = join(fixtureDir, 'main-1588.mjs');
    writeFileSync(
      preCjs,
      [
        '"use strict";',
        'const adminApp = require("firebase-admin/app");',
        'globalThis.__PRE_1588__ = {',
        '  swapped: adminApp.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target"),',
        '  active: globalThis[Symbol.for("pyric.register.active")] === true,',
        '};',
      ].join('\n'),
    );
    writeFileSync(
      mainMjs,
      [
        'const adminApp = await import("firebase-admin/app");',
        'console.log("OUT_1588 " + JSON.stringify({',
        '  pre: globalThis.__PRE_1588__ ?? null,',
        '  mainSwapped: adminApp.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target"),',
        '}));',
      ].join('\n'),
    );

    const nodeOptions = withCanonicalRegisterNodeOptions(`--require ${preCjs}`, cliRegisterUrl);
    const envRes = runNode([mainMjs], { NODE_OPTIONS: nodeOptions, PYRIC_SANDBOX: 'local' });
    expect(envRes.status, envRes.stderr).toBe(0);
    expect(parsePrefixedLine(envRes.stdout, 'OUT_1588 ')).toEqual({
      pre: { swapped: true, active: true },
      mainSwapped: true,
    });

    const cliRes = runNode(['--require', preCjs, mainMjs], {
      NODE_OPTIONS: withCanonicalRegisterNodeOptions('', cliRegisterUrl),
      PYRIC_SANDBOX: 'local',
    });
    expect(cliRes.status, cliRes.stderr).toBe(0);
    expect(parsePrefixedLine(cliRes.stdout, 'OUT_1588 ')).toEqual({
      pre: { swapped: true, active: true },
      mainSwapped: true,
    });
  });

  it('syncs ESM spawnSync, execFileSync, and execSync imported in a preload before the register (#1652 item 1)', () => {
    const earlyLoader = join(fixtureDir, 'early-esm-loader.mjs');
    const driver = join(fixtureDir, 'early-esm-driver.mjs');
    writeFileSync(
      earlyLoader,
      [
        'import { execFileSync, execSync, spawnSync } from "node:child_process";',
        'globalThis.__earlyBindings = {',
        '  spawnSync: (...args) => spawnSync(...args),',
        '  execFileSync: (...args) => execFileSync(...args),',
        '  execSync: (...args) => execSync(...args),',
        '};',
      ].join('\n'),
    );
    writeFileSync(
      driver,
      [
        `const probe = ${JSON.stringify(probeChildPath)};`,
        'const strippedEnv = { PATH: process.env.PATH };',
        'const s = globalThis.__earlyBindings.spawnSync(process.execPath, [probe], { encoding: "utf8", env: strippedEnv });',
        'const efOut = globalThis.__earlyBindings.execFileSync(process.execPath, [probe], { encoding: "utf8", env: strippedEnv });',
        'const exOut = globalThis.__earlyBindings.execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}`, { encoding: "utf8", env: strippedEnv });',
        'function pick(text) {',
        '  const line = text.split("\\n").find((l) => l.startsWith("CHILD_PROBE "));',
        '  return line ? JSON.parse(line.slice("CHILD_PROBE ".length)) : null;',
        '}',
        'console.log("ESM_SYNC_OUT " + JSON.stringify({',
        '  spawnSync: pick(s.stdout || ""),',
        '  execFileSync: pick(efOut),',
        '  execSync: pick(exOut),',
        '}));',
      ].join('\n'),
    );

    const res = runNode(
      ['--import', pathToFileURL(earlyLoader).href, '--import', cliRegisterUrl, driver],
      { PYRIC_SANDBOX: 'local' },
    );
    expect(res.status, res.stderr).toBe(0);
    const expected = { swapped: true, active: true, guardAllow: null };
    expect(parsePrefixedLine(res.stdout, 'ESM_SYNC_OUT ')).toEqual({
      spawnSync: expected,
      execFileSync: expected,
      execSync: expected,
    });
  });

  it('refuses bun, bunx, and deno children in both sandbox and live registers (#1652 item 2)', () => {
    const bunDriver = join(fixtureDir, 'bun-child-driver.mjs');
    writeFileSync(
      bunDriver,
      [
        'import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";',
        `const probe = ${JSON.stringify(probeChildPath)};`,
        'function codeOf(fn) {',
        '  try { fn(); return "did-not-throw"; } catch (err) { return err?.code ?? "unknown"; }',
        '}',
        'console.log("BUN_STOP_OUT " + JSON.stringify({',
        '  spawnSyncBun: codeOf(() => spawnSync("bun", [probe])),',
        '  execFileSyncBunx: codeOf(() => execFileSync("bunx", ["tsx", probe])),',
        '  execSyncDeno: codeOf(() => execSync("deno run a.ts")),',
        '  spawnAsyncBun: codeOf(() => spawn("/usr/local/bin/bun", [probe], { argv0: "node" })),',
        '}));',
      ].join('\n'),
    );

    for (const [label, regUrl, env] of [
      ['sandbox', cliRegisterUrl, { PYRIC_SANDBOX: 'local' }],
      ['live', liveRegisterUrl, {}],
    ] as const) {
      const res = runNode(['--import', regUrl, bunDriver], env);
      expect(res.status, `${label}: ${res.stderr}`).toBe(0);
      expect(parsePrefixedLine(res.stdout, 'BUN_STOP_OUT ')).toEqual({
        spawnSyncBun: 'PYRIC_UNSUPPORTED_RUNTIME',
        execFileSyncBunx: 'PYRIC_UNSUPPORTED_RUNTIME',
        execSyncDeno: 'PYRIC_UNSUPPORTED_RUNTIME',
        spawnAsyncBun: 'PYRIC_UNSUPPORTED_RUNTIME',
      });
    }
  });

  it('preserves an explicit empty PYRIC_GUARD_ALLOW in child processes without warning (#1652 item 3)', () => {
    const allowDriver = join(fixtureDir, 'empty-allow-driver.mjs');
    writeFileSync(
      allowDriver,
      [
        'import { spawnSync } from "node:child_process";',
        `const probe = ${JSON.stringify(probeChildPath)};`,
        'const cleared = spawnSync(process.execPath, [probe], {',
        '  encoding: "utf8",',
        '  env: { PATH: process.env.PATH, PYRIC_GUARD_ALLOW: "" },',
        '});',
        'const inherited = spawnSync(process.execPath, [probe], {',
        '  encoding: "utf8",',
        '  env: { PATH: process.env.PATH },',
        '});',
        'function pick(text) {',
        '  const line = text.split("\\n").find((l) => l.startsWith("CHILD_PROBE "));',
        '  return line ? JSON.parse(line.slice("CHILD_PROBE ".length)) : null;',
        '}',
        'console.log("ALLOW_OUT " + JSON.stringify({',
        '  cleared: pick(cleared.stdout || ""),',
        '  clearedWarned: (cleared.stderr || "").includes("PYRIC_GUARD_ALLOW"),',
        '  inherited: pick(inherited.stdout || ""),',
        '  inheritedWarned: (inherited.stderr || "").includes("PYRIC_GUARD_ALLOW"),',
        '}));',
      ].join('\n'),
    );

    const res = runNode(['--import', cliRegisterUrl, allowDriver], {
      PYRIC_SANDBOX: 'local',
      PYRIC_GUARD_ALLOW: 'example.com',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(parsePrefixedLine(res.stdout, 'ALLOW_OUT ')).toEqual({
      cleared: { swapped: true, active: true, guardAllow: '' },
      clearedWarned: false,
      inherited: { swapped: true, active: true, guardAllow: 'example.com' },
      inheritedWarned: true,
    });
  });
});
