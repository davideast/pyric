/**
 * Standing integration checks for Node register preload ordering (`-r` /
 * `--require` ahead of caller preloads), end-of-options `--` boundaries,
 * single-read `Worker` options snapshotting against TOCTOU getters and
 * Proxies, and CommonJS `eval: true` hoisting resistance across sandbox and
 * live modes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const liveRoot = join(repoRoot, 'packages/live');
const cliRegisterFile = join(cliRoot, 'dist/register/index.js');
const liveRegisterFile = join(liveRoot, 'dist/register.js');
const cliRegisterUrl = pathToFileURL(cliRegisterFile).href;
const liveRegisterUrl = pathToFileURL(liveRegisterFile).href;
const nodeBin = process.env.PYRIC_TEST_NODE ?? 'node';

let fixtureDir = '';
let sandboxEarlyCjs = '';
let liveEarlyCjs = '';
let sandboxWorkerFile = '';
let liveWorkerFile = '';
let sandboxChildFile = '';
let liveChildFile = '';
let scriptCounter = 0;

interface ProbeOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runNodeScript(
  registerSpecifier: string,
  source: string,
  env: Record<string, string | undefined>,
): ProbeOutcome {
  scriptCounter += 1;
  const scriptPath = join(fixtureDir, `driver-${scriptCounter}.mjs`);
  writeFileSync(scriptPath, source);
  const cleanEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: undefined,
    NODE_OPTIONS: undefined,
    PYRIC_SANDBOX: undefined,
    PYRIC_SANDBOX_FORCE: undefined,
    PYRIC_SANDBOX_INSTANCE: undefined,
    PYRIC_SESSION_TOKEN: undefined,
    PYRIC_BEACON_TOKEN: undefined,
    PYRIC_AI_MODE: undefined,
    PYRIC_AI_PASSTHROUGH: undefined,
    PYRIC_LIVE_PROJECT_ROOT: undefined,
    PYRIC_LIVE_SDK_ROOT: undefined,
    PYRIC_LIVE_PASS_THROUGH: undefined,
    PYRIC_PROJECT: undefined,
    GOOGLE_CLOUD_PROJECT: undefined,
    GCLOUD_PROJECT: undefined,
    FIREBASE_CONFIG: undefined,
    ...env,
  };
  const res = spawnSync(nodeBin, ['--import', registerSpecifier, scriptPath], {
    cwd: fixtureDir,
    encoding: 'utf8',
    env: cleanEnv,
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function parseJsonLine<T>(stdout: string, prefix: string): T {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`Missing "${prefix}" line in stdout:\n${stdout}`);
  }
  return JSON.parse(line.slice(prefix.length)) as T;
}

function linkNodeModule(targetDir: string, pkgName: string): void {
  const src = join(repoRoot, 'node_modules', ...pkgName.split('/'));
  if (!existsSync(src)) return;
  const dest = join(targetDir, 'node_modules', ...pkgName.split('/'));
  mkdirSync(resolve(dest, '..'), { recursive: true });
  symlinkSync(src, dest, 'dir');
}

const RUN_WORKER_SNIPPET = [
  'function runWorker(target, opts) {',
  '  return new Promise((resolve) => {',
  '    const w = new Worker(target, opts);',
  '    w.once("message", (msg) => resolve({ ok: true, msg }));',
  '    w.once("error", (err) => resolve({ ok: false, err: String(err) }));',
  '  });',
  '}',
].join('\n');

const RUN_CHILD_SNIPPETS = [
  'function runChild(args, env) {',
  '  const child = spawnSync(process.execPath, args, { encoding: "utf8", env });',
  '  const line = (child.stdout || "").split("\\n").find((l) => l.startsWith("CHILD "));',
  '  return { status: child.status, data: line ? JSON.parse(line.slice(6)) : null, stderr: child.stderr };',
  '}',
  'function runFork(target, execArgv) {',
  '  return new Promise((resolve) => {',
  '    const child = fork(target, [], { execArgv, stdio: ["ignore", "pipe", "pipe", "ipc"] });',
  '    let stdout = "";',
  '    let stderr = "";',
  '    child.stdout.on("data", (d) => { stdout += d; });',
  '    child.stderr.on("data", (d) => { stderr += d; });',
  '    child.once("exit", (code) => {',
  '      const line = stdout.split("\\n").find((l) => l.startsWith("CHILD "));',
  '      resolve({ status: code, data: line ? JSON.parse(line.slice(6)) : null, stderr });',
  '    });',
  '  });',
  '}',
].join('\n');

beforeAll(() => {
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-preload-toctou-')));
  writeFileSync(
    join(fixtureDir, 'package.json'),
    JSON.stringify({ name: 'preload-toctou-fixture', private: true, type: 'module' }),
  );
  writeFileSync(
    join(fixtureDir, '.firebaserc'),
    JSON.stringify({ projects: { default: 'demo-project' } }),
  );
  writeFileSync(join(fixtureDir, 'firebase.json'), JSON.stringify({}));

  const nm = join(fixtureDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(cliRoot, join(nm, '@pyric', 'cli'), 'dir');
  symlinkSync(liveRoot, join(nm, '@pyric', 'live'), 'dir');
  for (const pkg of ['firebase', 'firebase-admin', '@firebase', '@google-cloud']) {
    linkNodeModule(fixtureDir, pkg);
  }

  sandboxEarlyCjs = join(fixtureDir, 'sandbox-early.cjs');
  writeFileSync(
    sandboxEarlyCjs,
    [
      'const app = require("firebase-admin/app");',
      'globalThis.__EARLY_SANDBOX_REAL__ = !("ADMIN_APP_TARGET" in app);',
      'globalThis.__EARLY_SAW_ACTIVE__ = Boolean(globalThis[Symbol.for("pyric.register.active")]);',
    ].join('\n'),
  );

  liveEarlyCjs = join(fixtureDir, 'live-early.cjs');
  writeFileSync(
    liveEarlyCjs,
    [
      'let outcome = "loaded";',
      'try {',
      '  require("firebase/functions");',
      '} catch (err) {',
      '  outcome = err && err.code ? err.code : String(err);',
      '}',
      'globalThis.__EARLY_LIVE_OUTCOME__ = outcome;',
      'globalThis.__EARLY_LIVE_ACTIVE__ = Boolean(globalThis[Symbol.for("pyric.register.live.active")]);',
    ].join('\n'),
  );

  sandboxWorkerFile = join(fixtureDir, 'sandbox-worker.mjs');
  writeFileSync(
    sandboxWorkerFile,
    [
      'import { parentPort } from "node:worker_threads";',
      'import * as adminApp from "firebase-admin/app";',
      'parentPort?.postMessage({',
      '  isReal: !("ADMIN_APP_TARGET" in adminApp),',
      '  active: Boolean(globalThis[Symbol.for("pyric.register.active")]),',
      '  earlyReal: globalThis.__EARLY_SANDBOX_REAL__ ?? null,',
      '  earlySawActive: globalThis.__EARLY_SAW_ACTIVE__ ?? null,',
      '});',
    ].join('\n'),
  );

  liveWorkerFile = join(fixtureDir, 'live-worker.mjs');
  writeFileSync(
    liveWorkerFile,
    [
      'import { parentPort } from "node:worker_threads";',
      'let outcome = "loaded";',
      'try {',
      '  await import("firebase/functions");',
      '} catch (err) {',
      '  outcome = err && typeof err === "object" && "code" in err ? err.code : String(err);',
      '}',
      'parentPort?.postMessage({',
      '  outcome,',
      '  liveActive: Boolean(globalThis[Symbol.for("pyric.register.live.active")]),',
      '  earlyOutcome: globalThis.__EARLY_LIVE_OUTCOME__ ?? null,',
      '  earlyLiveActive: globalThis.__EARLY_LIVE_ACTIVE__ ?? null,',
      '});',
    ].join('\n'),
  );

  sandboxChildFile = join(fixtureDir, 'sandbox-child.mjs');
  writeFileSync(
    sandboxChildFile,
    [
      'import * as adminApp from "firebase-admin/app";',
      'console.log("CHILD " + JSON.stringify({',
      '  isReal: !("ADMIN_APP_TARGET" in adminApp),',
      '  active: Boolean(globalThis[Symbol.for("pyric.register.active")]),',
      '  earlyReal: globalThis.__EARLY_SANDBOX_REAL__ ?? null,',
      '  earlySawActive: globalThis.__EARLY_SAW_ACTIVE__ ?? null,',
      '}));',
    ].join('\n'),
  );

  liveChildFile = join(fixtureDir, 'live-child.mjs');
  writeFileSync(
    liveChildFile,
    [
      'let outcome = "loaded";',
      'try {',
      '  await import("firebase/functions");',
      '} catch (err) {',
      '  outcome = err && typeof err === "object" && "code" in err ? err.code : String(err);',
      '}',
      'console.log("CHILD " + JSON.stringify({',
      '  outcome,',
      '  liveActive: Boolean(globalThis[Symbol.for("pyric.register.live.active")]),',
      '  earlyOutcome: globalThis.__EARLY_LIVE_OUTCOME__ ?? null,',
      '  earlyLiveActive: globalThis.__EARLY_LIVE_ACTIVE__ ?? null,',
      '}));',
    ].join('\n'),
  );
});

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe('Worker options TOCTOU getters, Proxies, and -- end-of-options', () => {
  it('blocks TOCTOU execArgv/env getters, Proxy options, env: null, and -- execArgv in sandbox mode', () => {
    const res = runNodeScript(
      cliRegisterFile,
      [
        'import { Worker } from "node:worker_threads";',
        `const workerFile = ${JSON.stringify(sandboxWorkerFile)};`,
        `const earlyCjs = ${JSON.stringify(sandboxEarlyCjs)};`,
        `const registerUrl = ${JSON.stringify(cliRegisterUrl)};`,
        RUN_WORKER_SNIPPET,
        'let execReads = 0;',
        'const getterExec = {',
        '  get execArgv() {',
        '    execReads += 1;',
        '    return execReads === 1 ? undefined : ["-r", earlyCjs];',
        '  },',
        '};',
        'let elemReads = 0;',
        'const elemArgv = [];',
        'Object.defineProperty(elemArgv, 0, { enumerable: true, get() { elemReads += 1; return elemReads === 1 ? "--no-warnings" : "-r"; } });',
        'Object.defineProperty(elemArgv, 1, { enumerable: true, get() { elemReads += 1; return elemReads <= 2 ? "--no-warnings" : earlyCjs; } });',
        'process.env.NODE_ENV = "production";',
        'let envReads = 0;',
        'const getterEnv = {',
        '  get env() {',
        '    envReads += 1;',
        '    return envReads === 1 ? null : { PATH: process.env.PATH, NODE_ENV: "production" };',
        '  },',
        '};',
        'let proxyReads = 0;',
        'const proxyOpts = new Proxy({}, {',
        '  get(_target, prop) {',
        '    if (prop === "execArgv") {',
        '      proxyReads += 1;',
        '      return proxyReads === 1 ? undefined : ["-r", earlyCjs];',
        '    }',
        '    return undefined;',
        '  },',
        '});',
        'const results = {',
        '  getterExec: await runWorker(workerFile, getterExec),',
        '  elemArgv: await runWorker(workerFile, { execArgv: elemArgv }),',
        '  getterEnv: await runWorker(workerFile, getterEnv),',
        '  nullEnvProd: await runWorker(workerFile, { env: null }),',
        '  proxyOpts: await runWorker(workerFile, proxyOpts),',
        '  dashDashOnly: await runWorker(workerFile, { execArgv: ["--"] }),',
        '  dashDashDecoy: await runWorker(workerFile, { execArgv: ["--", "--import", registerUrl] }),',
        '  execReads,',
        '  envReads,',
        '  proxyReads,',
        '};',
        'console.log("OUT " + JSON.stringify(results));',
      ].join('\n'),
      { PYRIC_SANDBOX: 'local' },
    );
    expect(res.status, res.stderr).toBe(0);
    const out = parseJsonLine<{
      getterExec: { ok: boolean; msg: { isReal: boolean; active: boolean; earlyReal: boolean | null } };
      elemArgv: { ok: boolean; msg: { isReal: boolean; active: boolean; earlyReal: boolean | null } };
      getterEnv: { ok: boolean; msg: { isReal: boolean; active: boolean } };
      nullEnvProd: { ok: boolean; msg: { isReal: boolean; active: boolean } };
      proxyOpts: { ok: boolean; msg: { isReal: boolean; active: boolean; earlyReal: boolean | null } };
      dashDashOnly: { ok: boolean; msg: { isReal: boolean; active: boolean } };
      dashDashDecoy: { ok: boolean; msg: { isReal: boolean; active: boolean } };
      execReads: number;
      envReads: number;
      proxyReads: number;
    }>(res.stdout, 'OUT ');

    expect(out.execReads).toBe(1);
    expect(out.envReads).toBe(1);
    expect(out.proxyReads).toBe(1);
    for (const entry of [
      out.getterExec,
      out.elemArgv,
      out.getterEnv,
      out.nullEnvProd,
      out.proxyOpts,
      out.dashDashOnly,
      out.dashDashDecoy,
    ]) {
      expect(entry.ok).toBe(true);
      expect(entry.msg.isReal).toBe(false);
      expect(entry.msg.active).toBe(true);
    }
    expect(out.getterExec.msg.earlyReal).toBeNull();
    expect(out.elemArgv.msg.earlyReal).toBeNull();
    expect(out.proxyOpts.msg.earlyReal).toBeNull();
  }, 60_000);

  it('blocks TOCTOU getters and -- execArgv in live mode', () => {
    const res = runNodeScript(
      liveRegisterFile,
      [
        'import { Worker } from "node:worker_threads";',
        `const workerFile = ${JSON.stringify(liveWorkerFile)};`,
        `const earlyCjs = ${JSON.stringify(liveEarlyCjs)};`,
        `const registerUrl = ${JSON.stringify(liveRegisterUrl)};`,
        RUN_WORKER_SNIPPET,
        'let execReads = 0;',
        'const getterExec = {',
        '  get execArgv() {',
        '    execReads += 1;',
        '    return execReads === 1 ? undefined : ["-r", earlyCjs];',
        '  },',
        '};',
        'const results = {',
        '  getterExec: await runWorker(workerFile, getterExec),',
        '  dashDashOnly: await runWorker(workerFile, { execArgv: ["--"] }),',
        '  dashDashDecoy: await runWorker(workerFile, { execArgv: ["--", "--import", registerUrl] }),',
        '  execReads,',
        '};',
        'console.log("OUT " + JSON.stringify(results));',
      ].join('\n'),
      {},
    );
    expect(res.status, res.stderr).toBe(0);
    const out = parseJsonLine<{
      getterExec: { ok: boolean; msg: { outcome: string; liveActive: boolean } };
      dashDashOnly: { ok: boolean; msg: { outcome: string; liveActive: boolean } };
      dashDashDecoy: { ok: boolean; msg: { outcome: string; liveActive: boolean } };
      execReads: number;
    }>(res.stdout, 'OUT ');

    expect(out.execReads).toBe(1);
    for (const entry of [out.getterExec, out.dashDashOnly, out.dashDashDecoy]) {
      expect(entry.ok).toBe(true);
      expect(entry.msg.outcome).toBe('PYRIC_LIVE_REFUSED');
      expect(entry.msg.liveActive).toBe(true);
    }
  }, 60_000);
});

describe('-r / --require preload ordering across Worker, spawnSync, and fork', () => {
  it('activates sandbox register before caller -r/--require across Worker, spawnSync, and fork', () => {
    const res = runNodeScript(
      cliRegisterFile,
      [
        'import { fork, spawnSync } from "node:child_process";',
        'import { Worker } from "node:worker_threads";',
        `const workerFile = ${JSON.stringify(sandboxWorkerFile)};`,
        `const childFile = ${JSON.stringify(sandboxChildFile)};`,
        `const earlyCjs = ${JSON.stringify(sandboxEarlyCjs)};`,
        `const registerUrl = ${JSON.stringify(cliRegisterUrl)};`,
        RUN_WORKER_SNIPPET,
        RUN_CHILD_SNIPPETS,
        'const results = {',
        '  workerExecR: await runWorker(workerFile, { execArgv: ["-r", earlyCjs] }),',
        '  workerExecImportThenR: await runWorker(workerFile, { execArgv: ["--import", registerUrl, "-r", earlyCjs] }),',
        '  workerNodeOptsR: await runWorker(workerFile, { env: { PATH: process.env.PATH, NODE_OPTIONS: `-r ${earlyCjs}` } }),',
        '  workerNodeOptsReqEq: await runWorker(workerFile, { env: { PATH: process.env.PATH, NODE_OPTIONS: `--require=${earlyCjs}` } }),',
        '  spawnCliR: runChild(["-r", earlyCjs, childFile], { PATH: process.env.PATH }),',
        '  spawnNodeOptsR: runChild([childFile], { PATH: process.env.PATH, NODE_OPTIONS: `-r ${earlyCjs}` }),',
        '  forkExecR: await runFork(childFile, ["-r", earlyCjs]),',
        '};',
        'console.log("OUT " + JSON.stringify(results));',
      ].join('\n'),
      { PYRIC_SANDBOX: 'local' },
    );
    expect(res.status, res.stderr).toBe(0);
    const out = parseJsonLine<{
      workerExecR: { ok: boolean; msg: { isReal: boolean; active: boolean; earlyReal: boolean; earlySawActive: boolean } };
      workerExecImportThenR: { ok: boolean; msg: { isReal: boolean; active: boolean; earlyReal: boolean; earlySawActive: boolean } };
      workerNodeOptsR: { ok: boolean; msg: { isReal: boolean; active: boolean; earlyReal: boolean; earlySawActive: boolean } };
      workerNodeOptsReqEq: { ok: boolean; msg: { isReal: boolean; active: boolean; earlyReal: boolean; earlySawActive: boolean } };
      spawnCliR: { status: number; data: { isReal: boolean; active: boolean; earlyReal: boolean; earlySawActive: boolean } };
      spawnNodeOptsR: { status: number; data: { isReal: boolean; active: boolean; earlyReal: boolean; earlySawActive: boolean } };
      forkExecR: { status: number; data: { isReal: boolean; active: boolean; earlyReal: boolean; earlySawActive: boolean } };
    }>(res.stdout, 'OUT ');

    for (const workerEntry of [
      out.workerExecR,
      out.workerExecImportThenR,
      out.workerNodeOptsR,
      out.workerNodeOptsReqEq,
    ]) {
      expect(workerEntry.ok).toBe(true);
      expect(workerEntry.msg).toEqual({
        isReal: false,
        active: true,
        earlyReal: false,
        earlySawActive: true,
      });
    }
    for (const childEntry of [out.spawnCliR, out.spawnNodeOptsR, out.forkExecR]) {
      expect(childEntry.status).toBe(0);
      expect(childEntry.data).toEqual({
        isReal: false,
        active: true,
        earlyReal: false,
        earlySawActive: true,
      });
    }
  }, 60_000);

  it('activates live register before caller -r/--require across Worker, spawnSync, and fork', () => {
    const res = runNodeScript(
      liveRegisterFile,
      [
        'import { fork, spawnSync } from "node:child_process";',
        'import { Worker } from "node:worker_threads";',
        `const workerFile = ${JSON.stringify(liveWorkerFile)};`,
        `const childFile = ${JSON.stringify(liveChildFile)};`,
        `const earlyCjs = ${JSON.stringify(liveEarlyCjs)};`,
        RUN_WORKER_SNIPPET,
        RUN_CHILD_SNIPPETS,
        'const results = {',
        '  workerExecR: await runWorker(workerFile, { execArgv: ["-r", earlyCjs] }),',
        '  workerNodeOptsR: await runWorker(workerFile, { env: { PATH: process.env.PATH, NODE_OPTIONS: `-r ${earlyCjs}` } }),',
        '  spawnCliR: runChild(["-r", earlyCjs, childFile], { PATH: process.env.PATH }),',
        '  spawnNodeOptsR: runChild([childFile], { PATH: process.env.PATH, NODE_OPTIONS: `-r ${earlyCjs}` }),',
        '  forkExecR: await runFork(childFile, ["-r", earlyCjs]),',
        '};',
        'console.log("OUT " + JSON.stringify(results));',
      ].join('\n'),
      {},
    );
    expect(res.status, res.stderr).toBe(0);
    const out = parseJsonLine<{
      workerExecR: { ok: boolean; msg: { outcome: string; liveActive: boolean; earlyOutcome: string; earlyLiveActive: boolean } };
      workerNodeOptsR: { ok: boolean; msg: { outcome: string; liveActive: boolean; earlyOutcome: string; earlyLiveActive: boolean } };
      spawnCliR: { status: number; data: { outcome: string; liveActive: boolean; earlyOutcome: string; earlyLiveActive: boolean } };
      spawnNodeOptsR: { status: number; data: { outcome: string; liveActive: boolean; earlyOutcome: string; earlyLiveActive: boolean } };
      forkExecR: { status: number; data: { outcome: string; liveActive: boolean; earlyOutcome: string; earlyLiveActive: boolean } };
    }>(res.stdout, 'OUT ');

    const expected = {
      outcome: 'PYRIC_LIVE_REFUSED',
      liveActive: true,
      earlyOutcome: 'PYRIC_LIVE_REFUSED',
      earlyLiveActive: true,
    };
    expect(out.workerExecR.ok).toBe(true);
    expect(out.workerExecR.msg).toEqual(expected);
    expect(out.workerNodeOptsR.ok).toBe(true);
    expect(out.workerNodeOptsR.msg).toEqual(expected);
    for (const childEntry of [out.spawnCliR, out.spawnNodeOptsR, out.forkExecR]) {
      expect(childEntry.status).toBe(0);
      expect(childEntry.data).toEqual(expected);
    }
  }, 60_000);
});

describe('CommonJS eval: true worker hoisting resistance', () => {
  it('defeats function require() {} and function module() {} hoisting in sandbox eval workers', () => {
    const res = runNodeScript(
      cliRegisterFile,
      [
        'import { SHARE_ENV, Worker } from "node:worker_threads";',
        'const hoistedRequire = [',
        '  "function require() {}",',
        '  "const app = module.require(\'firebase-admin/app\');",',
        '  "const { parentPort } = module.require(\'node:worker_threads\');",',
        '  "parentPort.postMessage({ isReal: !(\'ADMIN_APP_TARGET\' in app), active: Boolean(globalThis[Symbol.for(\'pyric.register.active\')]) });",',
        '].join("\\n");',
        'const hoistedBoth = [',
        '  "function require() {}",',
        '  "function module() {}",',
        '  "const mod = process.getBuiltinModule(\'node:module\');",',
        '  "const req = mod.createRequire(process.cwd() + \'/package.json\');",',
        '  "const app = req(\'firebase-admin/app\');",',
        '  "const { parentPort } = process.getBuiltinModule(\'node:worker_threads\');",',
        '  "parentPort.postMessage({ isReal: !(\'ADMIN_APP_TARGET\' in app), active: Boolean(globalThis[Symbol.for(\'pyric.register.active\')]) });",',
        '].join("\\n");',
        RUN_WORKER_SNIPPET,
        'const results = {',
        '  defaultEnv: await runWorker(hoistedRequire, { eval: true }),',
        '  customEnv: await runWorker(hoistedRequire, { eval: true, env: { PATH: process.env.PATH } }),',
        '  shareEnv: await runWorker(hoistedRequire, { eval: true, env: SHARE_ENV }),',
        '  nullExecArgv: await runWorker(hoistedRequire, { eval: true, execArgv: null }),',
        '  bothHoisted: await runWorker(hoistedBoth, { eval: true }),',
        '};',
        'console.log("OUT " + JSON.stringify(results));',
      ].join('\n'),
      { PYRIC_SANDBOX: 'local' },
    );
    expect(res.status, res.stderr).toBe(0);
    const out = parseJsonLine<
      Record<string, { ok: boolean; msg: { isReal: boolean; active: boolean } }>
    >(res.stdout, 'OUT ');

    for (const key of ['defaultEnv', 'customEnv', 'shareEnv', 'nullExecArgv', 'bothHoisted']) {
      expect(out[key]?.ok, key).toBe(true);
      expect(out[key]?.msg, key).toEqual({ isReal: false, active: true });
    }
  }, 60_000);

  it('defeats function require() {} hoisting in live eval workers', () => {
    const res = runNodeScript(
      liveRegisterFile,
      [
        'import { SHARE_ENV, Worker } from "node:worker_threads";',
        'const hoistedLive = [',
        '  "function require() {}",',
        '  "let outcome = \'loaded\';",',
        '  "try { module.require(\'firebase/functions\'); } catch (err) { outcome = err && err.code ? err.code : String(err); }",',
        '  "const { parentPort } = module.require(\'node:worker_threads\');",',
        '  "parentPort.postMessage({ outcome, liveActive: Boolean(globalThis[Symbol.for(\'pyric.register.live.active\')]) });",',
        '].join("\\n");',
        RUN_WORKER_SNIPPET,
        'const results = {',
        '  defaultEnv: await runWorker(hoistedLive, { eval: true }),',
        '  customEnv: await runWorker(hoistedLive, { eval: true, env: { PATH: process.env.PATH } }),',
        '  shareEnv: await runWorker(hoistedLive, { eval: true, env: SHARE_ENV }),',
        '  nullExecArgv: await runWorker(hoistedLive, { eval: true, execArgv: null }),',
        '};',
        'console.log("OUT " + JSON.stringify(results));',
      ].join('\n'),
      {},
    );
    expect(res.status, res.stderr).toBe(0);
    const out = parseJsonLine<
      Record<string, { ok: boolean; msg: { outcome: string; liveActive: boolean } }>
    >(res.stdout, 'OUT ');

    for (const key of ['defaultEnv', 'customEnv', 'shareEnv', 'nullExecArgv']) {
      expect(out[key]?.ok, key).toBe(true);
      expect(out[key]?.msg, key).toEqual({
        outcome: 'PYRIC_LIVE_REFUSED',
        liveActive: true,
      });
    }
  }, 60_000);
});
