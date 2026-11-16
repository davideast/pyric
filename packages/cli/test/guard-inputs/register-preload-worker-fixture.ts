/**
 * Temporary Node project fixture and subprocess runner for the register,
 * Worker options, and preload ordering generative guard suite.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildAiModeDriverSource,
  buildEvalDriverSource,
  buildNodeEnvDriverSource,
  buildPreloadDriverSource,
  buildRequireSpoofDriverSource,
} from './register-preload-worker-drivers.js';
import {
  TARGET_FIREBASE_SPECIFIERS,
  generateCanonicalizerPreloadMatrix,
  generateDashDashBoundaryMatrix,
  generateImporterOriginMatrix,
  generatePostBootAiModeMatrix,
  generatePostBootNodeEnvMatrix,
  generatePreloadOrderingMatrix,
  generateWorkerEvalMatrix,
  type CanonicalizerPreloadCase,
  type DashDashBoundaryCase,
  type ImporterOriginKind,
  type PreloadOrderingCase,
  type TargetFirebaseSpecifier,
} from './register-preload-worker-gen.js';

const cliPkgDir = resolve(import.meta.dir, '../..');
const repoDir = resolve(cliPkgDir, '../..');
const cliRegisterFile = realpathSync(join(cliPkgDir, 'dist/register/index.js'));
const cliRoot = resolve(cliRegisterFile, '../../..');
const liveRegisterFile = realpathSync(join(repoDir, 'packages/live/dist/register.js'));
const liveRoot = resolve(liveRegisterFile, '../..');
const pyricPkgRoot = realpathSync(join(repoDir, 'packages/pyric'));
const pyricAdminPkgRoot = realpathSync(join(repoDir, 'packages/pyric-admin'));
const rootNodeModules = realpathSync(join(repoDir, 'node_modules'));
const nodeBin = process.env.PYRIC_TEST_NODE ?? 'node';

export const cliRegisterUrl = pathToFileURL(cliRegisterFile).href;
export const liveRegisterUrl = pathToFileURL(liveRegisterFile).href;
export const liveSyncRegisterUrl = pathToFileURL(join(liveRoot, 'dist/register-eval-worker.js')).href;

export const bridgeFiles: Readonly<
  Record<Exclude<ImporterOriginKind, 'app-module' | 'app-decoy-bridge'>, string>
> = {
  'app-bridge': realpathSync(join(cliPkgDir, 'dist/register/app-bridge.js')),
  'app-bridge-shadow': realpathSync(join(cliPkgDir, 'dist/register/app-bridge-shadow.js')),
  'app-check-bridge': realpathSync(join(cliPkgDir, 'dist/register/app-bridge-app-check.js')),
  'admin-app-check-bridge': realpathSync(
    join(cliPkgDir, 'dist/register/app-bridge-admin-app-check.js'),
  ),
};

function resolveInstalledFirebaseEntryUrls(): Record<TargetFirebaseSpecifier, string> {
  const clientReq = createRequire(realpathSync(join(rootNodeModules, 'firebase/package.json')));
  const adminReq = createRequire(
    realpathSync(join(rootNodeModules, 'firebase-admin/package.json')),
  );
  const out = {} as Record<TargetFirebaseSpecifier, string>;
  for (const specifier of TARGET_FIREBASE_SPECIFIERS) {
    let resolvedFile = '';
    if (specifier.startsWith('firebase-admin/')) {
      resolvedFile = realpathSync(adminReq.resolve(specifier));
    } else {
      resolvedFile = realpathSync(clientReq.resolve(specifier));
    }
    out[specifier] = pathToFileURL(resolvedFile).href;
  }
  return out;
}

export const realSdkEntryUrls = resolveInstalledFirebaseEntryUrls();

export interface DriverRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runNodeAsync(
  args: readonly string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<DriverRun> {
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
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(nodeBin, [...args], {
      cwd,
      env: cleanEnv as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectRun);
    child.once('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

export function extractJsonLine<T>(run: DriverRun, prefix: string): T {
  const line = run.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  if (line === undefined) {
    throw new Error(
      `Missing "${prefix}" line (exit=${String(run.status)}):\nSTDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`,
    );
  }
  return JSON.parse(line.slice(prefix.length)) as T;
}

export async function runPair<A, B>(
  runA: () => Promise<A>,
  runB: () => Promise<B>,
): Promise<readonly [A, B]> {
  if (availableParallelism() <= 4) {
    const first = await runA();
    const second = await runB();
    return [first, second];
  }
  return Promise.all([runA(), runB()]);
}

export interface RegisterGuardFixture {
  readonly fixtureDir: string;
  readonly appModulePath: string;
  readonly appDecoyBridgePath: string;
  readonly driverSandboxEval: string;
  readonly driverLiveEval: string;
  readonly driverSandboxPreload: string;
  readonly driverLivePreload: string;
  readonly driverSandboxNodeEnv: string;
  readonly driverLiveNodeEnv: string;
  readonly driverSandboxAi: string;
  readonly spoofDriver: string;
  readonly canonicalPreloadCases: readonly CanonicalizerPreloadCase[];
  readonly preloadCases: readonly PreloadOrderingCase[];
  readonly dashCases: readonly DashDashBoundaryCase[];
}

export function createRegisterGuardFixture(): RegisterGuardFixture {
  for (const required of [cliRegisterFile, liveRegisterFile, ...Object.values(bridgeFiles)]) {
    if (!existsSync(required)) {
      throw new Error(`Missing built artifact: ${required}`);
    }
  }
  const fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-gen-reg-family-')));
  writeFileSync(
    join(fixtureDir, 'package.json'),
    JSON.stringify({ name: 'gen-register-fixture', private: true, type: 'module' }),
  );
  writeFileSync(
    join(fixtureDir, '.firebaserc'),
    JSON.stringify({ projects: { default: 'demo-project' } }),
  );
  writeFileSync(join(fixtureDir, 'firebase.json'), JSON.stringify({}));
  const appModulePath = join(fixtureDir, 'src-app.mjs');
  writeFileSync(appModulePath, 'export const appReady = true;\n');
  mkdirSync(join(fixtureDir, 'dist/register'), { recursive: true });
  const appDecoyBridgePath = join(fixtureDir, 'dist/register/app-bridge.js');
  writeFileSync(appDecoyBridgePath, 'export const decoyBridge = true;\n');

  const nm = join(fixtureDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(cliRoot, join(nm, '@pyric/cli'), 'dir');
  symlinkSync(liveRoot, join(nm, '@pyric/live'), 'dir');
  symlinkSync(pyricPkgRoot, join(nm, 'pyric'), 'dir');
  symlinkSync(pyricAdminPkgRoot, join(nm, 'pyric-admin'), 'dir');
  for (const extPkg of ['firebase', 'firebase-admin', '@firebase', '@google-cloud']) {
    const srcPkg = join(rootNodeModules, ...extPkg.split('/'));
    if (existsSync(srcPkg)) {
      const dstPkg = join(nm, ...extPkg.split('/'));
      mkdirSync(resolve(dstPkg, '..'), { recursive: true });
      symlinkSync(realpathSync(srcPkg), dstPkg, 'dir');
    }
  }

  const sandboxEarlyEsm = join(fixtureDir, 'sandbox-early.mjs');
  writeFileSync(
    sandboxEarlyEsm,
    'const m = await import("firebase-admin/app"); globalThis.__EARLY_GUARDED__ = "ADMIN_APP_TARGET" in m;\n',
  );
  const sandboxEarlyCjs = join(fixtureDir, 'sandbox-early.cjs');
  writeFileSync(
    sandboxEarlyCjs,
    'const m = require("firebase-admin/app"); globalThis.__EARLY_GUARDED__ = "ADMIN_APP_TARGET" in m;\n',
  );
  const liveEarlyEsm = join(fixtureDir, 'live-early.mjs');
  writeFileSync(
    liveEarlyEsm,
    'let c = null; try { await import("firebase/functions"); } catch (e) { c = e?.code ?? null; } globalThis.__EARLY_GUARDED__ = c === "PYRIC_LIVE_REFUSED";\n',
  );
  const liveEarlyCjs = join(fixtureDir, 'live-early.cjs');
  writeFileSync(
    liveEarlyCjs,
    'let c = null; try { require("firebase/functions"); } catch (e) { c = e?.code ?? null; } globalThis.__EARLY_GUARDED__ = c === "PYRIC_LIVE_REFUSED";\n',
  );

  const sandboxWorker = join(fixtureDir, 'sandbox-worker.mjs');
  writeFileSync(
    sandboxWorker,
    'import { parentPort } from "node:worker_threads"; const m = await import("firebase-admin/app"); parentPort?.postMessage({ guarded: "ADMIN_APP_TARGET" in m, earlyGuarded: globalThis.__EARLY_GUARDED__ ?? null, leakedForce: false });\n',
  );
  const sandboxChild = join(fixtureDir, 'sandbox-child.mjs');
  writeFileSync(
    sandboxChild,
    'const m = await import("firebase-admin/app"); console.log("CHILD " + JSON.stringify({ guarded: "ADMIN_APP_TARGET" in m, earlyGuarded: globalThis.__EARLY_GUARDED__ ?? null, leakedForce: false }));\n',
  );
  const liveWorker = join(fixtureDir, 'live-worker.mjs');
  writeFileSync(
    liveWorker,
    'import { parentPort } from "node:worker_threads"; let c = null; try { await import("firebase/functions"); } catch (e) { c = e?.code ?? null; } parentPort?.postMessage({ guarded: c === "PYRIC_LIVE_REFUSED", earlyGuarded: globalThis.__EARLY_GUARDED__ ?? null, leakedForce: "PYRIC_SANDBOX_FORCE" in process.env });\n',
  );
  const liveChild = join(fixtureDir, 'live-child.mjs');
  writeFileSync(
    liveChild,
    'let c = null; try { await import("firebase/functions"); } catch (e) { c = e?.code ?? null; } console.log("CHILD " + JSON.stringify({ guarded: c === "PYRIC_LIVE_REFUSED", earlyGuarded: globalThis.__EARLY_GUARDED__ ?? null, leakedForce: "PYRIC_SANDBOX_FORCE" in process.env }));\n',
  );
  const aiWorker = join(fixtureDir, 'ai-worker.mjs');
  writeFileSync(
    aiWorker,
    'import { parentPort } from "node:worker_threads"; const u = import.meta.resolve("firebase/ai"); await import("firebase/ai"); parentPort?.postMessage({ loadedRealAi: u.includes("/node_modules/firebase/") });\n',
  );
  const aiChild = join(fixtureDir, 'ai-child.mjs');
  writeFileSync(
    aiChild,
    'const u = import.meta.resolve("firebase/ai"); await import("firebase/ai"); console.log("AI_CHILD " + JSON.stringify({ loadedRealAi: u.includes("/node_modules/firebase/") }));\n',
  );

  const preloadInput = {
    sandboxRegisterUrl: cliRegisterUrl,
    liveRegisterUrl,
    sandboxEsmPreloadUrl: pathToFileURL(sandboxEarlyEsm).href,
    sandboxCjsPreloadPath: sandboxEarlyCjs,
    liveEsmPreloadUrl: pathToFileURL(liveEarlyEsm).href,
    liveCjsPreloadPath: liveEarlyCjs,
  };
  const evalMatrix = generateWorkerEvalMatrix();
  const canonicalPreloadCases = generateCanonicalizerPreloadMatrix(preloadInput);
  const preloadCases = generatePreloadOrderingMatrix(preloadInput);
  const dashCases = generateDashDashBoundaryMatrix({
    sandboxRegisterUrl: cliRegisterUrl,
    liveRegisterUrl,
    sandboxCjsPreloadPath: sandboxEarlyCjs,
    liveCjsPreloadPath: liveEarlyCjs,
  });
  const nodeEnvMatrix = generatePostBootNodeEnvMatrix();
  const aiMatrix = generatePostBootAiModeMatrix();
  const spoofMatrix = generateImporterOriginMatrix();

  const driverSandboxEval = join(fixtureDir, 'driver-sandbox-eval.mjs');
  writeFileSync(
    driverSandboxEval,
    buildEvalDriverSource({
      surface: 'sandbox',
      workerFile: sandboxWorker,
      earlyCjsPath: sandboxEarlyCjs,
      evalCasesJson: JSON.stringify(evalMatrix.filter((c) => c.surface === 'sandbox')),
    }),
  );
  const driverLiveEval = join(fixtureDir, 'driver-live-eval.mjs');
  writeFileSync(
    driverLiveEval,
    buildEvalDriverSource({
      surface: 'live',
      workerFile: liveWorker,
      earlyCjsPath: liveEarlyCjs,
      evalCasesJson: JSON.stringify(evalMatrix.filter((c) => c.surface === 'live')),
    }),
  );

  const driverSandboxPreload = join(fixtureDir, 'driver-sandbox-preload.mjs');
  writeFileSync(
    driverSandboxPreload,
    buildPreloadDriverSource({
      workerFile: sandboxWorker,
      childFile: sandboxChild,
      preloadCasesJson: JSON.stringify(preloadCases.filter((c) => c.surface === 'sandbox')),
      dashCasesJson: JSON.stringify(dashCases.filter((c) => c.surface === 'sandbox')),
    }),
  );
  const driverLivePreload = join(fixtureDir, 'driver-live-preload.mjs');
  writeFileSync(
    driverLivePreload,
    buildPreloadDriverSource({
      workerFile: liveWorker,
      childFile: liveChild,
      preloadCasesJson: JSON.stringify(preloadCases.filter((c) => c.surface === 'live')),
      dashCasesJson: JSON.stringify(dashCases.filter((c) => c.surface === 'live')),
    }),
  );

  const driverSandboxNodeEnv = join(fixtureDir, 'driver-sandbox-node-env.mjs');
  writeFileSync(
    driverSandboxNodeEnv,
    buildNodeEnvDriverSource({
      surface: 'sandbox',
      workerFile: sandboxWorker,
      childFile: sandboxChild,
      nodeEnvCasesJson: JSON.stringify(nodeEnvMatrix.filter((c) => c.surface === 'sandbox')),
    }),
  );
  const driverLiveNodeEnv = join(fixtureDir, 'driver-live-node-env.mjs');
  writeFileSync(
    driverLiveNodeEnv,
    buildNodeEnvDriverSource({
      surface: 'live',
      workerFile: liveWorker,
      childFile: liveChild,
      nodeEnvCasesJson: JSON.stringify(nodeEnvMatrix.filter((c) => c.surface === 'live')),
    }),
  );

  const driverSandboxAi = join(fixtureDir, 'driver-sandbox-ai.mjs');
  writeFileSync(
    driverSandboxAi,
    buildAiModeDriverSource({
      aiWorkerFile: aiWorker,
      aiChildFile: aiChild,
      aiCasesJson: JSON.stringify(aiMatrix),
    }),
  );

  const importerMap: Record<ImporterOriginKind, string> = {
    'app-module': appModulePath,
    'app-decoy-bridge': appDecoyBridgePath,
    ...bridgeFiles,
  };
  const spoofDriver = join(fixtureDir, 'driver-spoof.mjs');
  writeFileSync(
    spoofDriver,
    buildRequireSpoofDriverSource(importerMap, JSON.stringify(spoofMatrix)),
  );

  return {
    fixtureDir,
    appModulePath,
    appDecoyBridgePath,
    driverSandboxEval,
    driverLiveEval,
    driverSandboxPreload,
    driverLivePreload,
    driverSandboxNodeEnv,
    driverLiveNodeEnv,
    driverSandboxAi,
    spoofDriver,
    canonicalPreloadCases,
    preloadCases,
    dashCases,
  };
}
