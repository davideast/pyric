/**
 * Standing integration checks for Node register guards, worker threads,
 * bridge importer restrictions, pinned AI mode, and CJS `firebase-admin`
 * facade parity.
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
const appBridgeFile = join(cliRoot, 'dist/register/app-bridge.js');
const appBridgeShadowFile = join(cliRoot, 'dist/register/app-bridge-shadow.js');
const appCheckBridgeFile = join(cliRoot, 'dist/register/app-bridge-app-check.js');
const adminAppCheckBridgeFile = join(cliRoot, 'dist/register/app-bridge-admin-app-check.js');

let fixtureDir = '';
let callerPreloadUrl = '';
let sandboxWorkerFile = '';
let liveWorkerFile = '';
let aiModeProbeFile = '';
let aiModeWorkerFile = '';
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
  extraNodeArgs: readonly string[] = [],
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
  const result = spawnSync('node', [...extraNodeArgs, '--import', registerSpecifier, scriptPath], {
    cwd: fixtureDir,
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

function expectOk(outcome: ProbeOutcome): void {
  if (outcome.status !== 0) {
    throw new Error(`Expected exit 0, got ${String(outcome.status)}\nSTDOUT:\n${outcome.stdout}\nSTDERR:\n${outcome.stderr}`);
  }
}

function parseJsonLine<T>(stdout: string, prefix: string): T {
  const line = stdout.split('\n').find((entry) => entry.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`Expected stdout line starting with "${prefix}", got:\n${stdout}`);
  }
  return JSON.parse(line.slice(prefix.length)) as T;
}

beforeAll(() => {
  for (const required of [cliRegisterFile, liveRegisterFile, appBridgeFile, adminAppCheckBridgeFile]) {
    if (!existsSync(required)) {
      throw new Error(`Built register artifact missing: ${required}. Run scripts/build.sh --packages-only first.`);
    }
  }
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-register-guards-standing-')));
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
    JSON.stringify({ name: 'register-guards-standing-fixture', type: 'module' }),
  );
  writeFileSync(
    join(fixtureDir, '.firebaserc'),
    JSON.stringify({ projects: { default: 'demo-project' } }),
  );

  const preloadFile = join(fixtureDir, 'caller-preload.mjs');
  writeFileSync(
    preloadFile,
    [
      'let isRealAdminApp = false;',
      'let liveCode = null;',
      'try {',
      '  const mod = await import("firebase-admin/app");',
      '  isRealAdminApp = typeof mod.initializeApp === "function" && String(mod.initializeApp).includes("defaultAppStore");',
      '  const fs = await import("firebase-admin/firestore");',
      '  const app = mod.initializeApp({ projectId: "other-project" }, "preload-app");',
      '  await fs.getFirestore(app).doc("items/doc-1").get();',
      '} catch (error) {',
      '  liveCode = error?.code ?? null;',
      '}',
      'globalThis.__EARLY_LOAD__ = {',
      '  isRealAdminApp,',
      '  liveCode,',
      '};',
    ].join('\n'),
  );
  callerPreloadUrl = pathToFileURL(preloadFile).href;

  sandboxWorkerFile = join(fixtureDir, 'sandbox-worker.mjs');
  writeFileSync(
    sandboxWorkerFile,
    [
      'import { parentPort } from "node:worker_threads";',
      'const mod = await import("firebase-admin/app");',
      'parentPort?.postMessage({',
      '  isRealAdminApp: typeof mod.initializeApp === "function" && String(mod.initializeApp).includes("defaultAppStore"),',
      '  early: globalThis.__EARLY_LOAD__ ?? null,',
      '});',
    ].join('\n'),
  );

  liveWorkerFile = join(fixtureDir, 'live-worker.mjs');
  writeFileSync(
    liveWorkerFile,
    [
      'import { parentPort } from "node:worker_threads";',
      'let errorCode = null;',
      'try {',
      '  const mod = await import("firebase-admin/app");',
      '  const fs = await import("firebase-admin/firestore");',
      '  const app = mod.initializeApp({ projectId: "other-project" }, "worker-app");',
      '  await fs.getFirestore(app).doc("items/doc-1").get();',
      '} catch (error) {',
      '  errorCode = error?.code ?? null;',
      '}',
      'parentPort?.postMessage({',
      '  errorCode,',
      '  hasSandboxForce: "PYRIC_SANDBOX_FORCE" in process.env,',
      '  early: globalThis.__EARLY_LOAD__ ?? null,',
      '});',
    ].join('\n'),
  );

  aiModeProbeFile = join(fixtureDir, 'ai-mode-probe.mjs');
  writeFileSync(
    aiModeProbeFile,
    [
      'const ai = await import("firebase/ai");',
      'console.log("AI_CHILD " + JSON.stringify({',
      '  hasImagenModel: "ImagenModel" in ai,',
      '  aiModeEnv: process.env.PYRIC_AI_MODE ?? null,',
      '  passthroughEnv: process.env.PYRIC_AI_PASSTHROUGH ?? null,',
      '}));',
    ].join('\n'),
  );

  aiModeWorkerFile = join(fixtureDir, 'ai-mode-worker.mjs');
  writeFileSync(
    aiModeWorkerFile,
    [
      'import { parentPort } from "node:worker_threads";',
      'const ai = await import("firebase/ai");',
      'parentPort?.postMessage({',
      '  hasImagenModel: "ImagenModel" in ai,',
      '  aiModeEnv: process.env.PYRIC_AI_MODE ?? null,',
      '  passthroughEnv: process.env.PYRIC_AI_PASSTHROUGH ?? null,',
      '});',
    ].join('\n'),
  );
});

afterAll(() => {
  if (fixtureDir !== '') rmSync(fixtureDir, { recursive: true, force: true });
});

describe('truthy worker options.eval and accessor TOCTOU', () => {
  it('guards non-boolean truthy eval values and getter/proxy eval in sandbox and live modes', () => {
    const sandboxParent = [
      'import { Worker } from "node:worker_threads";',
      'const cjsCode = "const { parentPort } = require(\'node:worker_threads\'); const app = require(\'firebase-admin/app\'); parentPort.postMessage({ isReal: typeof app.initializeApp === \'function\' && String(app.initializeApp).includes(\'defaultAppStore\') });";',
      'function run(options) {',
      '  return new Promise((resolve, reject) => {',
      '    const w = new Worker(cjsCode, options);',
      '    w.once("message", resolve);',
      '    w.once("error", reject);',
      '  });',
      '}',
      'let reads = 0;',
      'const flippingGetter = { get eval() { reads += 1; return reads > 1; } };',
      'let proxyReads = 0;',
      'const flippingProxy = new Proxy({}, { get(_t, prop) { if (prop === "eval") { proxyReads += 1; return proxyReads > 1; } return undefined; } });',
      'const results = {',
      '  evalNum: await run({ eval: 1 }),',
      '  evalStr: await run({ eval: "yes" }),',
      '  evalObj: await run({ eval: {} }),',
      '};',
      'let getterRejectedPath = false;',
      'try { await run(flippingGetter); } catch { getterRejectedPath = true; }',
      'let proxyRejectedPath = false;',
      'try { await run(flippingProxy); } catch { proxyRejectedPath = true; }',
      'console.log("OUTCOME " + JSON.stringify({ results, getterRejectedPath, proxyRejectedPath }));',
    ].join('\n');

    const sandboxRes = runNodeScript('@pyric/cli/register', sandboxParent, { PYRIC_SANDBOX: '1' });
    expectOk(sandboxRes);
    const sandboxData = parseJsonLine<{
      results: Record<string, { isReal: boolean }>;
      getterRejectedPath: boolean;
      proxyRejectedPath: boolean;
    }>(sandboxRes.stdout, 'OUTCOME ');
    expect(sandboxData.results).toEqual({
      evalNum: { isReal: false },
      evalStr: { isReal: false },
      evalObj: { isReal: false },
    });
    expect(sandboxData.getterRejectedPath).toBe(true);
    expect(sandboxData.proxyRejectedPath).toBe(true);

    const liveParent = [
      'import { Worker } from "node:worker_threads";',
      'const cjsCode = "const { parentPort } = require(\'node:worker_threads\'); (async () => { let code = null; try { const app = require(\'firebase-admin/app\'); const fs = require(\'firebase-admin/firestore\'); const a = app.initializeApp({ projectId: \'other-project\' }, \'eval-app\'); await fs.getFirestore(a).doc(\'items/doc-1\').get(); } catch (e) { code = e?.code ?? null; } parentPort.postMessage({ code }); })();";',
      'function run(options) {',
      '  return new Promise((resolve, reject) => {',
      '    const w = new Worker(cjsCode, options);',
      '    w.once("message", resolve);',
      '    w.once("error", reject);',
      '  });',
      '}',
      'console.log("OUTCOME " + JSON.stringify({',
      '  evalNum: await run({ eval: 1 }),',
      '  evalStr: await run({ eval: "yes" }),',
      '}));',
    ].join('\n');

    const liveRes = runNodeScript('@pyric/live/register', liveParent, {});
    expectOk(liveRes);
    const liveData = parseJsonLine<Record<string, { code: string | null }>>(liveRes.stdout, 'OUTCOME ');
    expect(liveData).toEqual({
      evalNum: { code: 'PYRIC_LIVE_REFUSED' },
      evalStr: { code: 'PYRIC_LIVE_REFUSED' },
    });
  }, 30_000);
});

describe('NODE_ENV production mutation in active parent processes', () => {
  it('keeps workers and children guarded in sandbox and live modes while fresh production boots still refuse', () => {
    const sandboxParent = [
      'import { Worker, SHARE_ENV } from "node:worker_threads";',
      'import { spawnSync } from "node:child_process";',
      'process.env.NODE_ENV = "production";',
      'function runWorker(file, options) {',
      '  return new Promise((resolve, reject) => {',
      '    const w = new Worker(file, options);',
      '    w.once("message", resolve);',
      '    w.once("error", reject);',
      '  });',
      '}',
      'const defaultWorker = await runWorker(process.env.SANDBOX_WORKER);',
      'const shareEnvWorker = await runWorker(process.env.SANDBOX_WORKER, { env: SHARE_ENV });',
      'const customEnvWorker = await runWorker(process.env.SANDBOX_WORKER, { env: { PATH: process.env.PATH, NODE_ENV: "production" } });',
      'const evalWorker = await runWorker("const { parentPort } = require(\'node:worker_threads\'); const app = require(\'firebase-admin/app\'); parentPort.postMessage({ isRealAdminApp: typeof app.initializeApp === \'function\' && String(app.initializeApp).includes(\'defaultAppStore\') });", { eval: true });',
      'const child = spawnSync(process.execPath, ["--input-type=module", "-e", "const m = await import(\'firebase-admin/app\'); console.log(\'CHILD \' + JSON.stringify({ isRealAdminApp: typeof m.initializeApp === \'function\' && String(m.initializeApp).includes(\'defaultAppStore\') }));"], { encoding: "utf8" });',
      'const childLine = child.stdout.split("\\n").find((l) => l.startsWith("CHILD "));',
      'console.log("OUTCOME " + JSON.stringify({',
      '  defaultWorker: defaultWorker.isRealAdminApp,',
      '  shareEnvWorker: shareEnvWorker.isRealAdminApp,',
      '  customEnvWorker: customEnvWorker.isRealAdminApp,',
      '  evalWorker: evalWorker.isRealAdminApp,',
      '  child: childLine ? JSON.parse(childLine.slice(6)).isRealAdminApp : null,',
      '}));',
    ].join('\n');

    const sandboxRes = runNodeScript('@pyric/cli/register', sandboxParent, {
      PYRIC_SANDBOX: '1',
      SANDBOX_WORKER: sandboxWorkerFile,
    });
    expectOk(sandboxRes);
    expect(parseJsonLine<Record<string, unknown>>(sandboxRes.stdout, 'OUTCOME ')).toEqual({
      defaultWorker: false,
      shareEnvWorker: false,
      customEnvWorker: false,
      evalWorker: false,
      child: false,
    });

    const liveParent = [
      'import { Worker, SHARE_ENV } from "node:worker_threads";',
      'import { spawnSync } from "node:child_process";',
      'process.env.NODE_ENV = "production";',
      'function runWorker(file, options) {',
      '  return new Promise((resolve, reject) => {',
      '    const w = new Worker(file, options);',
      '    w.once("message", resolve);',
      '    w.once("error", reject);',
      '  });',
      '}',
      'const defaultWorker = await runWorker(process.env.LIVE_WORKER);',
      'const shareEnvWorker = await runWorker(process.env.LIVE_WORKER, { env: SHARE_ENV });',
      'const customEnvWorker = await runWorker(process.env.LIVE_WORKER, { env: { PATH: process.env.PATH, NODE_ENV: "production" } });',
      'const child = spawnSync(process.execPath, ["--input-type=module", "-e", "let code = null; try { const m = await import(\'firebase-admin/app\'); const fs = await import(\'firebase-admin/firestore\'); const a = m.initializeApp({ projectId: \'other-project\' }, \'c\'); await fs.getFirestore(a).doc(\'items/doc-1\').get(); } catch (e) { code = e?.code ?? null; } console.log(\'CHILD \' + JSON.stringify({ errorCode: code, hasSandboxForce: \'PYRIC_SANDBOX_FORCE\' in process.env }));"], { encoding: "utf8" });',
      'const childLine = child.stdout.split("\\n").find((l) => l.startsWith("CHILD "));',
      'console.log("OUTCOME " + JSON.stringify({',
      '  defaultWorker,',
      '  shareEnvWorker,',
      '  customEnvWorker,',
      '  child: childLine ? JSON.parse(childLine.slice(6)) : null,',
      '}));',
    ].join('\n');

    const liveRes = runNodeScript('@pyric/live/register', liveParent, {
      LIVE_WORKER: liveWorkerFile,
    });
    expectOk(liveRes);
    const liveData = parseJsonLine<Record<string, { errorCode: string | null; hasSandboxForce: boolean }>>(
      liveRes.stdout,
      'OUTCOME ',
    );
    for (const key of ['defaultWorker', 'shareEnvWorker', 'customEnvWorker', 'child']) {
      expect(liveData[key]?.errorCode).toBe('PYRIC_LIVE_REFUSED');
      expect(liveData[key]?.hasSandboxForce).toBe(false);
    }

    const freshSandboxProd = runNodeScript(
      '@pyric/cli/register',
      'console.log("ACTIVE " + Boolean(globalThis[Symbol.for("pyric.register.active")]));',
      { PYRIC_SANDBOX: '1', NODE_ENV: 'production' },
    );
    expectOk(freshSandboxProd);
    expect(freshSandboxProd.stdout).toContain('ACTIVE false');

    const freshLiveProd = runNodeScript(
      '@pyric/live/register',
      'console.log("ACTIVE " + Boolean(globalThis[Symbol.for("pyric.register.live.active")]));',
      { NODE_ENV: 'production' },
    );
    expectOk(freshLiveProd);
    expect(freshLiveProd.stdout).toContain('ACTIVE false');
  }, 60_000);
});

describe('caller preload ordering ahead of active register', () => {
  it('runs the active register before caller --import preloads in workers and children (sandbox and live)', () => {
    const sandboxParent = [
      'import { Worker, SHARE_ENV } from "node:worker_threads";',
      'import { spawnSync } from "node:child_process";',
      'const preload = process.env.CALLER_PRELOAD;',
      'function runWorker(options) {',
      '  return new Promise((resolve, reject) => {',
      '    const w = new Worker(process.env.SANDBOX_WORKER, options);',
      '    w.once("message", resolve);',
      '    w.once("error", reject);',
      '  });',
      '}',
      'const execArgvSplit = await runWorker({ execArgv: ["--import", preload] });',
      'const execArgvAttached = await runWorker({ execArgv: [`--import=${preload}`] });',
      'const customEnvNodeOpts = await runWorker({ env: { PATH: process.env.PATH, NODE_OPTIONS: `--import ${preload}` } });',
      'process.env.NODE_OPTIONS = `--import ${preload}`;',
      'const defaultEnvNodeOpts = await runWorker(undefined);',
      'const shareEnvNodeOpts = await runWorker({ env: SHARE_ENV });',
      'const child = spawnSync(process.execPath, ["--input-type=module", "-e", "const m = await import(\'firebase-admin/app\'); console.log(\'CHILD \' + JSON.stringify({ isRealAdminApp: typeof m.initializeApp === \'function\' && String(m.initializeApp).includes(\'defaultAppStore\'), early: globalThis.__EARLY_LOAD__ ?? null }));"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import ${preload}` } });',
      'const childLine = child.stdout.split("\\n").find((l) => l.startsWith("CHILD "));',
      'console.log("OUTCOME " + JSON.stringify({',
      '  execArgvSplit,',
      '  execArgvAttached,',
      '  customEnvNodeOpts,',
      '  defaultEnvNodeOpts,',
      '  shareEnvNodeOpts,',
      '  child: childLine ? JSON.parse(childLine.slice(6)) : null,',
      '}));',
    ].join('\n');

    const sandboxRes = runNodeScript('@pyric/cli/register', sandboxParent, {
      PYRIC_SANDBOX: '1',
      SANDBOX_WORKER: sandboxWorkerFile,
      CALLER_PRELOAD: callerPreloadUrl,
    });
    expectOk(sandboxRes);
    const sandboxData = parseJsonLine<
      Record<string, { isRealAdminApp: boolean; early: { isRealAdminApp: boolean } | null }>
    >(sandboxRes.stdout, 'OUTCOME ');
    for (const key of [
      'execArgvSplit',
      'execArgvAttached',
      'customEnvNodeOpts',
      'defaultEnvNodeOpts',
      'shareEnvNodeOpts',
      'child',
    ]) {
      expect(sandboxData[key]?.isRealAdminApp).toBe(false);
      expect(sandboxData[key]?.early?.isRealAdminApp).toBe(false);
    }

    const liveParent = [
      'import { Worker } from "node:worker_threads";',
      'import { spawnSync } from "node:child_process";',
      'const preload = process.env.CALLER_PRELOAD;',
      'const worker = await new Promise((resolve, reject) => {',
      '  const w = new Worker(process.env.LIVE_WORKER, { execArgv: ["--import", preload] });',
      '  w.once("message", resolve);',
      '  w.once("error", reject);',
      '});',
      'const child = spawnSync(process.execPath, ["--input-type=module", "-e", "console.log(\'CHILD \' + JSON.stringify({ early: globalThis.__EARLY_LOAD__ ?? null }));"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import ${preload}` } });',
      'const childLine = child.stdout.split("\\n").find((l) => l.startsWith("CHILD "));',
      'console.log("OUTCOME " + JSON.stringify({',
      '  worker,',
      '  child: childLine ? JSON.parse(childLine.slice(6)) : null,',
      '}));',
    ].join('\n');

    const liveRes = runNodeScript('@pyric/live/register', liveParent, {
      LIVE_WORKER: liveWorkerFile,
      CALLER_PRELOAD: callerPreloadUrl,
    });
    expectOk(liveRes);
    const liveData = parseJsonLine<{
      worker: { errorCode: string | null; early: { liveCode: string | null } | null };
      child: { early: { liveCode: string | null } | null };
    }>(liveRes.stdout, 'OUTCOME ');
    expect(liveData.worker.errorCode).toBe('PYRIC_LIVE_REFUSED');
    expect(liveData.worker.early?.liveCode).toBe('PYRIC_LIVE_REFUSED');
    expect(liveData.child.early?.liveCode).toBe('PYRIC_LIVE_REFUSED');
  }, 30_000);
});

describe('bridge importer allowlist, pinned AI mode, and CJS firebase-admin facade', () => {
  it('blocks createRequire bridge forgery in sandbox and production AI modes', () => {
    const probe = [
      'import { createRequire } from "node:module";',
      'function tryReq(importer, specifier) {',
      '  try {',
      '    const mod = createRequire(importer)(specifier);',
      '    const isRealClientApp = specifier === "firebase/app" && typeof mod.initializeApp === "function" && String(mod.initializeApp).includes("INTERNAL");',
      '    const isRealAdminApp = specifier.startsWith("firebase-admin/") && typeof mod.initializeApp === "function" && String(mod.initializeApp).includes("defaultAppStore");',
      '    const isRealAppCheck = specifier === "firebase/app-check" && typeof mod.initializeAppCheck === "function" && String(mod.initializeAppCheck).includes("_getProvider");',
      '    return { blocked: false, isReal: isRealClientApp || isRealAdminApp || isRealAppCheck };',
      '  } catch (error) {',
      '    return { blocked: true, isReal: false, code: error?.code ?? null };',
      '  }',
      '}',
      'console.log("OUTCOME " + JSON.stringify({',
      '  appFromBridge: tryReq(process.env.APP_BRIDGE, "firebase/app"),',
      '  appFromShadow: tryReq(process.env.APP_SHADOW, "firebase/app"),',
      '  appCheckFromAppBridge: tryReq(process.env.APP_BRIDGE, "firebase/app-check"),',
      '  appCheckFromAppCheckBridge: tryReq(process.env.APP_CHECK_BRIDGE, "firebase/app-check"),',
      '  adminAppFromAdminBridge: tryReq(process.env.ADMIN_BRIDGE, "firebase-admin/app"),',
      '  adminAppFromAppBridge: tryReq(process.env.APP_BRIDGE, "firebase-admin/app"),',
      '}));',
    ].join('\n');

    for (const aiMode of ['sandbox', 'production']) {
      const res = runNodeScript('@pyric/cli/register', probe, {
        PYRIC_SANDBOX: '1',
        PYRIC_AI_MODE: aiMode,
        APP_BRIDGE: appBridgeFile,
        APP_SHADOW: appBridgeShadowFile,
        APP_CHECK_BRIDGE: appCheckBridgeFile,
        ADMIN_BRIDGE: adminAppCheckBridgeFile,
      });
      expectOk(res);
      const data = parseJsonLine<Record<string, { isReal: boolean }>>(res.stdout, 'OUTCOME ');
      for (const value of Object.values(data)) {
        expect(value.isReal).toBe(false);
      }
    }
  }, 30_000);

  it('pins PYRIC_AI_MODE and PYRIC_AI_PASSTHROUGH at activation across in-process, child, and workers', () => {
    const parent = [
      'import { Worker, SHARE_ENV } from "node:worker_threads";',
      'import { spawnSync } from "node:child_process";',
      'process.env.PYRIC_AI_MODE = "production";',
      'process.env.PYRIC_AI_PASSTHROUGH = "1";',
      'const ai = await import("firebase/ai");',
      'const child = spawnSync(process.execPath, [process.env.AI_CHILD_PROBE], { encoding: "utf8" });',
      'const childLine = child.stdout.split("\\n").find((l) => l.startsWith("AI_CHILD "));',
      'function runWorker(options) {',
      '  return new Promise((resolve, reject) => {',
      '    const w = new Worker(process.env.AI_WORKER_PROBE, options);',
      '    w.once("message", resolve);',
      '    w.once("error", reject);',
      '  });',
      '}',
      'const defaultWorker = await runWorker(undefined);',
      'const shareEnvWorker = await runWorker({ env: SHARE_ENV });',
      'console.log("OUTCOME " + JSON.stringify({',
      '  inProcessHasImagen: "ImagenModel" in ai,',
      '  child: childLine ? JSON.parse(childLine.slice(9)) : null,',
      '  defaultWorker,',
      '  shareEnvWorker,',
      '}));',
    ].join('\n');

    const res = runNodeScript('@pyric/cli/register', parent, {
      PYRIC_SANDBOX: '1',
      AI_CHILD_PROBE: aiModeProbeFile,
      AI_WORKER_PROBE: aiModeWorkerFile,
    });
    expectOk(res);
    const data = parseJsonLine<{
      inProcessHasImagen: boolean;
      child: { hasImagenModel: boolean; aiModeEnv: string | null; passthroughEnv: string | null };
      defaultWorker: { hasImagenModel: boolean; aiModeEnv: string | null; passthroughEnv: string | null };
      shareEnvWorker: { hasImagenModel: boolean; aiModeEnv: string | null; passthroughEnv: string | null };
    }>(res.stdout, 'OUTCOME ');
    expect(data.inProcessHasImagen).toBe(false);
    for (const sub of [data.child, data.defaultWorker, data.shareEnvWorker]) {
      expect(sub.hasImagenModel).toBe(false);
      expect(sub.aiModeEnv).toBe('sandbox');
      expect(sub.passthroughEnv).toBe('');
    }
  }, 30_000);

  it('exposes live getApps() and SDK_VERSION through CJS require("firebase-admin")', () => {
    const script = [
      'import { createRequire } from "node:module";',
      'import esmAdmin from "firebase-admin";',
      'import * as adminApp from "firebase-admin/app";',
      'const req = createRequire(import.meta.url);',
      'const cjsAdmin = req("firebase-admin");',
      'const initialCjsApps = cjsAdmin.getApps().length;',
      'const initialEsmApps = esmAdmin.getApps().length;',
      'cjsAdmin.initializeApp({ projectId: "demo-project" }, "docs-app");',
      'console.log("OUTCOME " + JSON.stringify({',
      '  initialCjsApps,',
      '  initialEsmApps,',
      '  afterCjsApps: cjsAdmin.getApps().length,',
      '  afterEsmApps: esmAdmin.getApps().length,',
      '  hasLegacyAppsGetter: "apps" in cjsAdmin,',
      '  cjsSdkVersion: typeof cjsAdmin.SDK_VERSION,',
      '  esmSdkVersion: typeof esmAdmin.SDK_VERSION,',
      '  sameSdkVersion: cjsAdmin.SDK_VERSION === esmAdmin.SDK_VERSION,',
      '  defaultSelf: cjsAdmin.default === cjsAdmin,',
      '  modularHasSdkVersion: "SDK_VERSION" in adminApp,',
      '}));',
    ].join('\n');

    const res = runNodeScript('@pyric/cli/register', script, { PYRIC_SANDBOX: '1' });
    expectOk(res);
    expect(parseJsonLine<Record<string, unknown>>(res.stdout, 'OUTCOME ')).toEqual({
      initialCjsApps: 0,
      initialEsmApps: 0,
      afterCjsApps: 1,
      afterEsmApps: 1,
      hasLegacyAppsGetter: false,
      cjsSdkVersion: 'string',
      esmSdkVersion: 'string',
      sameSdkVersion: true,
      defaultSelf: true,
      modularHasSdkVersion: true,
    });
  });
});
