/**
 * Standing child-process and worker-thread guard matrix for `@pyric/cli/register`
 * and `@pyric/live/register`.
 *
 * Verifies two invariants across real Node child processes and `worker_threads`:
 *  1. A foreign register specifier (or decoy path matching the other register)
 *     in `NODE_OPTIONS` or `execArgv` never suppresses injecting the parent's
 *     active register ahead of it.
 *  2. Deleting or mutating `PYRIC_SANDBOX` (or `NODE_OPTIONS`) after
 *     `@pyric/cli/register` activates cannot disable swap-or-stop in child
 *     processes or workers (default env, custom env, `SHARE_ENV`, or `eval`).
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
const liveEvalWorkerFile = join(liveRoot, 'dist/register-eval-worker.js');
const cliRegisterUrl = pathToFileURL(cliRegisterFile).href;
const liveRegisterUrl = pathToFileURL(liveRegisterFile).href;
const realAdminAppUrl = pathToFileURL(join(repoRoot, 'node_modules/firebase-admin/lib/esm/app/index.js')).href;

let fixtureDir = '';
let decoyLivePath = '';

interface ProbeOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runNode(
  args: readonly string[],
  env: Record<string, string | undefined>,
  cwd: string = fixtureDir,
): ProbeOutcome {
  const cleanEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: undefined,
    NODE_OPTIONS: undefined,
    PYRIC_SANDBOX: undefined,
    PYRIC_SANDBOX_FORCE: undefined,
    PYRIC_SANDBOX_INSTANCE: undefined,
    PYRIC_SESSION_TOKEN: undefined,
    PYRIC_BEACON_TOKEN: undefined,
    PYRIC_LIVE_PROJECT_ROOT: undefined,
    PYRIC_LIVE_SDK_ROOT: undefined,
    PYRIC_LIVE_PASS_THROUGH: undefined,
    PYRIC_PROJECT: undefined,
    GOOGLE_CLOUD_PROJECT: undefined,
    GCLOUD_PROJECT: undefined,
    FIREBASE_CONFIG: undefined,
    ...env,
  };
  const result = spawnSync('node', [...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseJsonLine<T>(stdout: string, prefix: string): T {
  const line = stdout
    .split('\n')
    .find((entry) => entry.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`Expected stdout line starting with "${prefix}", got:\n${stdout}`);
  }
  return JSON.parse(line.slice(prefix.length)) as T;
}

beforeAll(() => {
  for (const required of [cliRegisterFile, liveRegisterFile, liveEvalWorkerFile]) {
    if (!existsSync(required)) {
      throw new Error(`Built register file missing: ${required}. Run scripts/build.sh --packages-only first.`);
    }
  }
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-register-guard-matrix-')));
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
    JSON.stringify({ name: 'register-guard-matrix-fixture', type: 'module' }),
  );
  writeFileSync(
    join(fixtureDir, '.firebaserc'),
    JSON.stringify({ projects: { default: 'host-project' } }),
  );

  // Decoy file whose path matches the foreign live-register path pattern.
  const decoyDir = join(fixtureDir, 'decoy/packages/live/dist/register');
  mkdirSync(decoyDir, { recursive: true });
  decoyLivePath = join(decoyDir, 'index.js');
  writeFileSync(decoyLivePath, 'globalThis.__DECOY_PRELOAD_RAN__ = true;\n');

  writeFileSync(
    join(fixtureDir, 'live-child-probe.mjs'),
    [
      'let functionsOutcome = "loaded";',
      'try {',
      '  await import("firebase/functions");',
      '} catch (error) {',
      '  functionsOutcome = error?.code ?? error?.message ?? "error";',
      '}',
      'console.log("PROBE " + JSON.stringify({',
      '  functionsOutcome,',
      '  liveActive: globalThis[Symbol.for("pyric.register.live.active")] === true,',
      '  sandboxActive: globalThis[Symbol.for("pyric.register.active")] === true,',
      '}));',
    ].join('\n'),
  );

  writeFileSync(
    join(fixtureDir, 'live-worker-probe.mjs'),
    [
      'import { parentPort } from "node:worker_threads";',
      'let functionsOutcome = "loaded";',
      'try {',
      '  await import("firebase/functions");',
      '} catch (error) {',
      '  functionsOutcome = error?.code ?? error?.message ?? "error";',
      '}',
      'parentPort?.postMessage({',
      '  functionsOutcome,',
      '  liveActive: globalThis[Symbol.for("pyric.register.live.active")] === true,',
      '  sandboxActive: globalThis[Symbol.for("pyric.register.active")] === true,',
      '});',
    ].join('\n'),
  );

  writeFileSync(
    join(fixtureDir, 'sandbox-child-probe.mjs'),
    [
      `const realAdminAppUrl = ${JSON.stringify(realAdminAppUrl)};`,
      'let swapped = false;',
      'let adminError = null;',
      'try {',
      '  const adminApp = await import("firebase-admin/app");',
      '  swapped = adminApp.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target");',
      '} catch (error) {',
      '  adminError = error?.code ?? error?.message ?? "error";',
      '}',
      'let directStopCode = "loaded";',
      'try {',
      '  await import(realAdminAppUrl);',
      '} catch (error) {',
      '  directStopCode = error?.code ?? error?.message ?? "error";',
      '}',
      'console.log("PROBE " + JSON.stringify({',
      '  swapped,',
      '  adminError,',
      '  directStopCode,',
      '  sandboxEnv: process.env.PYRIC_SANDBOX ?? null,',
      '  instanceEnv: process.env.PYRIC_SANDBOX_INSTANCE ?? null,',
      '  sessionEnv: process.env.PYRIC_SESSION_TOKEN ?? null,',
      '  sandboxActive: globalThis[Symbol.for("pyric.register.active")] === true,',
      '  liveActive: globalThis[Symbol.for("pyric.register.live.active")] === true,',
      '}));',
    ].join('\n'),
  );

  writeFileSync(
    join(fixtureDir, 'sandbox-worker-probe.mjs'),
    [
      'import { parentPort } from "node:worker_threads";',
      `const realAdminAppUrl = ${JSON.stringify(realAdminAppUrl)};`,
      'let swapped = false;',
      'let adminError = null;',
      'try {',
      '  const adminApp = await import("firebase-admin/app");',
      '  swapped = adminApp.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target");',
      '} catch (error) {',
      '  adminError = error?.code ?? error?.message ?? "error";',
      '}',
      'let directStopCode = "loaded";',
      'try {',
      '  await import(realAdminAppUrl);',
      '} catch (error) {',
      '  directStopCode = error?.code ?? error?.message ?? "error";',
      '}',
      'parentPort?.postMessage({',
      '  swapped,',
      '  adminError,',
      '  directStopCode,',
      '  sandboxEnv: process.env.PYRIC_SANDBOX ?? null,',
      '  instanceEnv: process.env.PYRIC_SANDBOX_INSTANCE ?? null,',
      '  sessionEnv: process.env.PYRIC_SESSION_TOKEN ?? null,',
      '  sandboxActive: globalThis[Symbol.for("pyric.register.active")] === true,',
      '  liveActive: globalThis[Symbol.for("pyric.register.live.active")] === true,',
      '});',
    ].join('\n'),
  );
});

afterAll(() => {
  if (fixtureDir !== '') {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('register child-process and worker guard matrix', () => {
  it('enforces @pyric/live/register in children and workers despite foreign @pyric/cli/register preloads', () => {
    const parentScript = join(fixtureDir, 'live-foreign-parent.mjs');
    writeFileSync(
      parentScript,
      [
        'import { spawnSync } from "node:child_process";',
        'import { Worker } from "node:worker_threads";',
        'import { join } from "node:path";',
        `const dir = ${JSON.stringify(fixtureDir)};`,
        'const childProbe = join(dir, "live-child-probe.mjs");',
        'const workerProbe = join(dir, "live-worker-probe.mjs");',
        'function runChild(env) {',
        '  const res = spawnSync(process.execPath, [childProbe], { cwd: dir, encoding: "utf8", env });',
        '  const line = (res.stdout || "").split("\\n").find((l) => l.startsWith("PROBE "));',
        '  return { status: res.status, probe: line ? JSON.parse(line.slice(6)) : null, stderr: res.stderr };',
        '}',
        'function runWorker(options) {',
        '  return new Promise((resolve) => {',
        '    const worker = new Worker(workerProbe, options);',
        '    let message = null;',
        '    worker.on("message", (msg) => { message = msg; });',
        '    worker.on("error", (err) => resolve({ error: err.message, message }));',
        '    worker.on("exit", (code) => resolve({ code, message }));',
        '  });',
        '}',
        'const results = {',
        '  childImportCli: runChild({ PATH: process.env.PATH, NODE_OPTIONS: "--import @pyric/cli/register" }),',
        '  childImportCliWithSandboxEnv: runChild({ PATH: process.env.PATH, PYRIC_SANDBOX: "1", NODE_OPTIONS: "--import @pyric/cli/register" }),',
        '  childRequireCli: runChild({ PATH: process.env.PATH, NODE_OPTIONS: "-r @pyric/cli/register" }),',
        '  childRequireCliWithSandboxEnv: runChild({ PATH: process.env.PATH, PYRIC_SANDBOX: "1", NODE_OPTIONS: "-r @pyric/cli/register" }),',
        '  workerExecArgvCli: await runWorker({ execArgv: ["--import", "@pyric/cli/register"] }),',
        '  workerCustomEnvNodeOptionsCli: await runWorker({ env: { PATH: process.env.PATH, NODE_OPTIONS: "--import @pyric/cli/register" } }),',
        '  workerCustomEnvNodeOptionsCliWithSandbox: await runWorker({ env: { PATH: process.env.PATH, PYRIC_SANDBOX: "1", NODE_OPTIONS: "--import @pyric/cli/register" } }),',
        '};',
        'console.log("MATRIX " + JSON.stringify(results));',
      ].join('\n'),
    );

    const res = runNode(['--import', liveRegisterUrl, parentScript], {});
    expect(res.status, res.stderr).toBe(0);
    const matrix = parseJsonLine<Record<string, {
      status?: number;
      code?: number;
      error?: string;
      stderr?: string;
      probe?: { functionsOutcome: string; liveActive: boolean; sandboxActive: boolean } | null;
      message?: { functionsOutcome: string; liveActive: boolean; sandboxActive: boolean } | null;
    }>>(res.stdout, 'MATRIX ');

    for (const key of ['childImportCli', 'childImportCliWithSandboxEnv', 'childRequireCli'] as const) {
      const entry = matrix[key];
      expect(entry?.status, `${key}: ${entry?.stderr ?? ''}`).toBe(0);
      expect(entry?.probe, key).toEqual({
        functionsOutcome: 'PYRIC_LIVE_REFUSED',
        liveActive: true,
        sandboxActive: false,
      });
    }

    // `-r @pyric/cli/register` with `PYRIC_SANDBOX=1` runs before `--import` and must fail closed.
    const requireWithSandbox = matrix.childRequireCliWithSandboxEnv;
    expect(requireWithSandbox?.status).not.toBe(0);
    expect(requireWithSandbox?.probe).toBeNull();

    for (const key of [
      'workerExecArgvCli',
      'workerCustomEnvNodeOptionsCli',
      'workerCustomEnvNodeOptionsCliWithSandbox',
    ] as const) {
      const entry = matrix[key];
      expect(entry?.error, key).toBeUndefined();
      expect(entry?.code, key).toBe(0);
      expect(entry?.message, key).toEqual({
        functionsOutcome: 'PYRIC_LIVE_REFUSED',
        liveActive: true,
        sandboxActive: false,
      });
    }
  }, 60_000);

  it('enforces @pyric/cli/register in children and workers despite foreign live register or decoy preloads', () => {
    const parentScript = join(fixtureDir, 'sandbox-foreign-parent.mjs');
    writeFileSync(
      parentScript,
      [
        'import { spawnSync } from "node:child_process";',
        'import { Worker } from "node:worker_threads";',
        'import { join } from "node:path";',
        `const dir = ${JSON.stringify(fixtureDir)};`,
        `const decoyPath = ${JSON.stringify(decoyLivePath)};`,
        `const liveUrl = ${JSON.stringify(liveRegisterUrl)};`,
        `const liveEvalWorker = ${JSON.stringify(liveEvalWorkerFile)};`,
        'const childProbe = join(dir, "sandbox-child-probe.mjs");',
        'const workerProbe = join(dir, "sandbox-worker-probe.mjs");',
        'function runChild(env) {',
        '  const res = spawnSync(process.execPath, [childProbe], { cwd: dir, encoding: "utf8", env });',
        '  const line = (res.stdout || "").split("\\n").find((l) => l.startsWith("PROBE "));',
        '  return { status: res.status, probe: line ? JSON.parse(line.slice(6)) : null, stderr: res.stderr };',
        '}',
        'function runWorker(options) {',
        '  return new Promise((resolve) => {',
        '    const worker = new Worker(workerProbe, options);',
        '    let message = null;',
        '    worker.on("message", (msg) => { message = msg; });',
        '    worker.on("error", (err) => resolve({ error: err.message, message }));',
        '    worker.on("exit", (code) => resolve({ code, message }));',
        '  });',
        '}',
        'const results = {',
        '  childDecoyLive: runChild({ PATH: process.env.PATH, NODE_OPTIONS: `--import ${decoyPath}` }),',
        '  workerExecArgvDecoyLive: await runWorker({ execArgv: ["--import", decoyPath] }),',
        '  workerCustomEnvDecoyLive: await runWorker({ env: { PATH: process.env.PATH, NODE_OPTIONS: `--import ${decoyPath}` } }),',
        '  childRealLive: runChild({ PATH: process.env.PATH, NODE_OPTIONS: "--import @pyric/live/register" }),',
        '  childRealLiveBeforeOwn: runChild({ PATH: process.env.PATH, NODE_OPTIONS: "--import @pyric/live/register --import @pyric/cli/register" }),',
        '  childRequireLiveEvalWorker: runChild({ PATH: process.env.PATH, NODE_OPTIONS: `-r ${liveEvalWorker}` }),',
        '  workerExecArgvRealLive: await runWorker({ execArgv: ["--import", liveUrl] }),',
        '  workerCustomEnvRealLive: await runWorker({ env: { PATH: process.env.PATH, NODE_OPTIONS: "--import @pyric/live/register" } }),',
        '  workerExecArgvRequireLiveEval: await runWorker({ execArgv: ["-r", liveEvalWorker] }),',
        '};',
        'console.log("MATRIX " + JSON.stringify(results));',
      ].join('\n'),
    );

    const res = runNode(['--import', cliRegisterUrl, parentScript], { PYRIC_SANDBOX: '1' });
    expect(res.status, res.stderr).toBe(0);
    const matrix = parseJsonLine<Record<string, {
      status?: number;
      code?: number;
      error?: string;
      stderr?: string;
      probe?: { swapped: boolean; directStopCode: string; sandboxActive: boolean; liveActive: boolean } | null;
      message?: { swapped: boolean; directStopCode: string; sandboxActive: boolean; liveActive: boolean } | null;
    }>>(res.stdout, 'MATRIX ');

    // Decoy foreign paths must still run sandbox register and stop direct real SDK imports.
    expect(matrix.childDecoyLive?.status, matrix.childDecoyLive?.stderr).toBe(0);
    expect(matrix.childDecoyLive?.probe?.swapped).toBe(true);
    expect(matrix.childDecoyLive?.probe?.directStopCode).toBe('PYRIC_REAL_SDK_STOPPED');
    expect(matrix.childDecoyLive?.probe?.sandboxActive).toBe(true);

    for (const key of ['workerExecArgvDecoyLive', 'workerCustomEnvDecoyLive'] as const) {
      const entry = matrix[key];
      expect(entry?.error, key).toBeUndefined();
      expect(entry?.code, key).toBe(0);
      expect(entry?.message?.swapped, key).toBe(true);
      expect(entry?.message?.directStopCode, key).toBe('PYRIC_REAL_SDK_STOPPED');
      expect(entry?.message?.sandboxActive, key).toBe(true);
    }

    // Real @pyric/live/register loaded alongside active sandbox parent must fail closed.
    for (const key of ['childRealLive', 'childRealLiveBeforeOwn', 'childRequireLiveEvalWorker'] as const) {
      const entry = matrix[key];
      expect(entry?.status, key).not.toBe(0);
      expect(entry?.probe, key).toBeNull();
      expect(entry?.stderr, key).toContain('@pyric/cli/register is already active');
    }

    for (const key of [
      'workerExecArgvRealLive',
      'workerCustomEnvRealLive',
      'workerExecArgvRequireLiveEval',
    ] as const) {
      const entry = matrix[key];
      expect(entry?.message, key).toBeNull();
      expect(entry?.error, key).toContain('@pyric/cli/register is already active');
    }
  }, 60_000);

  it('pins PYRIC_SANDBOX and sandbox launcher env across child processes and workers even after parent mutates process.env', () => {
    const parentScript = join(fixtureDir, 'sandbox-pin-parent.mjs');
    writeFileSync(
      parentScript,
      [
        'import { spawn, spawnSync } from "node:child_process";',
        'import { SHARE_ENV, Worker } from "node:worker_threads";',
        'import { join } from "node:path";',
        `const dir = ${JSON.stringify(fixtureDir)};`,
        'const childProbe = join(dir, "sandbox-child-probe.mjs");',
        'const workerProbe = join(dir, "sandbox-worker-probe.mjs");',
        // Mutate and delete sandbox env vars after register activation.
        'delete process.env.PYRIC_SANDBOX;',
        'delete process.env.PYRIC_SANDBOX_INSTANCE;',
        'delete process.env.PYRIC_SESSION_TOKEN;',
        'delete process.env.NODE_OPTIONS;',
        'function runChildSync(options) {',
        '  const res = spawnSync(process.execPath, [childProbe], { cwd: dir, encoding: "utf8", ...options });',
        '  const line = (res.stdout || "").split("\\n").find((l) => l.startsWith("PROBE "));',
        '  return { status: res.status, probe: line ? JSON.parse(line.slice(6)) : null, stderr: res.stderr };',
        '}',
        'function runChildAsync(options) {',
        '  return new Promise((resolve) => {',
        '    const child = spawn(process.execPath, [childProbe], { cwd: dir, ...options });',
        '    let stdout = "";',
        '    let stderr = "";',
        '    child.stdout.setEncoding("utf8");',
        '    child.stderr.setEncoding("utf8");',
        '    child.stdout.on("data", (chunk) => { stdout += chunk; });',
        '    child.stderr.on("data", (chunk) => { stderr += chunk; });',
        '    child.on("close", (status) => {',
        '      const line = stdout.split("\\n").find((l) => l.startsWith("PROBE "));',
        '      resolve({ status, probe: line ? JSON.parse(line.slice(6)) : null, stderr });',
        '    });',
        '  });',
        '}',
        'function runWorker(source, options) {',
        '  return new Promise((resolve) => {',
        '    const worker = new Worker(source, options);',
        '    let message = null;',
        '    worker.on("message", (msg) => { message = msg; });',
        '    worker.on("error", (err) => resolve({ error: err.message, message }));',
        '    worker.on("exit", (code) => resolve({ code, message }));',
        '  });',
        '}',
        'const evalWorkerCode = [',
        '  "const { parentPort } = require(\\"node:worker_threads\\");",',
        '  "const adminApp = require(\\"firebase-admin/app\\");",',
        '  "parentPort.postMessage({",',
        '  "  swapped: adminApp.ADMIN_APP_TARGET === Symbol.for(\\"pyric.admin.app.target\\"),",',
        '  "  sandboxEnv: process.env.PYRIC_SANDBOX ?? null,",',
        '  "  instanceEnv: process.env.PYRIC_SANDBOX_INSTANCE ?? null,",',
        '  "  sessionEnv: process.env.PYRIC_SESSION_TOKEN ?? null,",',
        '  "  sandboxActive: globalThis[Symbol.for(\\"pyric.register.active\\")] === true,",',
        '  "});",',
        '].join("\\n");',
        // Also verify in-process dynamic import in parent after deleting PYRIC_SANDBOX.
        'const parentAdmin = await import("firebase-admin/app");',
        'const results = {',
        '  parentSwapped: parentAdmin.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target"),',
        '  syncDefaultEnv: runChildSync({}),',
        '  syncStrippedEnv: runChildSync({ env: { PATH: process.env.PATH, PYRIC_SANDBOX: "" } }),',
        '  syncForgedEnv: runChildSync({ env: { PATH: process.env.PATH, PYRIC_SANDBOX: "local", PYRIC_SANDBOX_INSTANCE: "forged" } }),',
        '  asyncStrippedEnv: await runChildAsync({ env: { PATH: process.env.PATH } }),',
        '  workerDefaultEnv: await runWorker(workerProbe),',
        '  workerCustomEnv: await runWorker(workerProbe, { env: { PATH: process.env.PATH, PYRIC_SANDBOX: "" } }),',
        '  workerSharedEnv: await runWorker(workerProbe, { env: SHARE_ENV }),',
        '  workerEvalCjs: await runWorker(evalWorkerCode, { eval: true, env: { PATH: process.env.PATH } }),',
        '};',
        'console.log("MATRIX " + JSON.stringify(results));',
      ].join('\n'),
    );

    const launchVariants: ReadonlyArray<{
      readonly name: string;
      readonly args: readonly string[];
      readonly env: Record<string, string>;
    }> = [
      {
        name: 'cli-import',
        args: ['--import', cliRegisterUrl, parentScript],
        env: {
          PYRIC_SANDBOX: '1',
          PYRIC_SANDBOX_INSTANCE: 'host-instance-1',
          PYRIC_SESSION_TOKEN: 'session-token-1',
        },
      },
      {
        name: 'node-options-import',
        args: [parentScript],
        env: {
          NODE_OPTIONS: `--import ${cliRegisterUrl}`,
          PYRIC_SANDBOX: '1',
          PYRIC_SANDBOX_INSTANCE: 'host-instance-1',
          PYRIC_SESSION_TOKEN: 'session-token-1',
        },
      },
    ];

    for (const variant of launchVariants) {
      const res = runNode(variant.args, variant.env);
      expect(res.status, `${variant.name}: ${res.stderr}`).toBe(0);
      const matrix = parseJsonLine<{
        parentSwapped: boolean;
        syncDefaultEnv: { status: number; probe: Record<string, unknown> | null; stderr: string };
        syncStrippedEnv: { status: number; probe: Record<string, unknown> | null; stderr: string };
        syncForgedEnv: { status: number; probe: Record<string, unknown> | null; stderr: string };
        asyncStrippedEnv: { status: number; probe: Record<string, unknown> | null; stderr: string };
        workerDefaultEnv: { code?: number; error?: string; message: Record<string, unknown> | null };
        workerCustomEnv: { code?: number; error?: string; message: Record<string, unknown> | null };
        workerSharedEnv: { code?: number; error?: string; message: Record<string, unknown> | null };
        workerEvalCjs: { code?: number; error?: string; message: Record<string, unknown> | null };
      }>(res.stdout, 'MATRIX ');

      expect(matrix.parentSwapped, variant.name).toBe(true);

      const expectedChild = {
        swapped: true,
        adminError: null,
        directStopCode: 'PYRIC_REAL_SDK_STOPPED',
        sandboxEnv: '1',
        instanceEnv: 'host-instance-1',
        sessionEnv: 'session-token-1',
        sandboxActive: true,
        liveActive: false,
      };
      for (const [label, child] of [
        ['syncDefaultEnv', matrix.syncDefaultEnv],
        ['syncStrippedEnv', matrix.syncStrippedEnv],
        ['syncForgedEnv', matrix.syncForgedEnv],
        ['asyncStrippedEnv', matrix.asyncStrippedEnv],
      ] as const) {
        expect(child.status, `${variant.name}/${label}: ${child.stderr}`).toBe(0);
        expect(child.probe, `${variant.name}/${label}`).toEqual(expectedChild);
      }

      for (const [label, worker] of [
        ['workerDefaultEnv', matrix.workerDefaultEnv],
        ['workerCustomEnv', matrix.workerCustomEnv],
        ['workerSharedEnv', matrix.workerSharedEnv],
      ] as const) {
        expect(worker.error, `${variant.name}/${label}`).toBeUndefined();
        expect(worker.code, `${variant.name}/${label}`).toBe(0);
        expect(worker.message, `${variant.name}/${label}`).toEqual(expectedChild);
      }

      expect(matrix.workerEvalCjs.error, `${variant.name}/workerEvalCjs`).toBeUndefined();
      expect(matrix.workerEvalCjs.code, `${variant.name}/workerEvalCjs`).toBe(0);
      expect(matrix.workerEvalCjs.message, `${variant.name}/workerEvalCjs`).toEqual({
        swapped: true,
        sandboxEnv: '1',
        instanceEnv: 'host-instance-1',
        sessionEnv: 'session-token-1',
        sandboxActive: true,
      });
    }
  }, 60_000);
});
