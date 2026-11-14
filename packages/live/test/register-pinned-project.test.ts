/**
 * `@pyric/live/register` pins the root process's resolved `projectId` across all
 * child processes (`spawn`, `spawnSync`, `exec`, `execSync`, `execFile`,
 * `execFileSync`, `fork`) and `Worker` threads (both file and `eval: true`,
 * with or without custom `env` options), preventing `PYRIC_PROJECT` or `cwd`
 * rebinding and enforcing `adminEnvRefusal` on `GOOGLE_CLOUD_PROJECT`,
 * `GCLOUD_PROJECT`, and `FIREBASE_CONFIG` in every child and worker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LIVE_PINNED_PROJECT_VARIABLE } from '../src/admin/project-gate.js';
import { buildLiveChildEnv, liveRegisterModuleUrl } from '../src/run.js';

const liveDir = resolve(import.meta.dir, '..');
const repoRoot = resolve(liveDir, '../..');
const cliDir = join(repoRoot, 'packages/cli');
const liveRegisterDist = join(liveDir, 'dist/register.js');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));
const realAdminDir = realpathSync(dirname(requireFromRepo.resolve('firebase-admin/package.json')));
const nodeMajor = Number(
  spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.split('.')[0],
);
const adminRowsOn = nodeMajor >= 23;

let rootDir: string;
let otherDir: string;

beforeAll(() => {
  if (!existsSync(liveRegisterDist)) {
    throw new Error(`${liveRegisterDist} missing: build @pyric/cli and @pyric/live first`);
  }
  rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-pinned-root-')));
  otherDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-pinned-other-')));

  for (const [dir, projectId] of [
    [rootDir, 'org-alpha'],
    [otherDir, 'org-beta'],
  ] as const) {
    const nm = join(dir, 'node_modules');
    mkdirSync(join(nm, '@pyric'), { recursive: true });
    symlinkSync(cliDir, join(nm, '@pyric/cli'));
    symlinkSync(liveDir, join(nm, '@pyric/live'));
    symlinkSync(realFirebaseDir, join(nm, 'firebase'));
    symlinkSync(realAdminDir, join(nm, 'firebase-admin'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'synthetic-app', type: 'module' }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({}));
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: projectId } }));
  }
});

afterAll(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  if (otherDir) rmSync(otherDir, { recursive: true, force: true });
});

describe('@pyric/live/register pinned project across child processes and workers', () => {
  test('prevents PYRIC_PROJECT, cwd, and parent env tampering from rebinding AdminProjectGate and enforces adminEnvRefusal in children and workers', () => {
    if (!adminRowsOn) return;

    const probePath = join(otherDir, 'probe-gate.mjs');
    writeFileSync(
      probePath,
      [
        "import { parentPort } from 'node:worker_threads';",
        "import { initializeApp } from 'firebase-admin/app';",
        "import { getAppCheck } from 'firebase-admin/app-check';",
        'const appBeta = initializeApp({ projectId: "org-beta" }, "probe-beta");',
        'let betaCode = "NONE";',
        'try {',
        '  await getAppCheck(appBeta).verifyToken("");',
        '} catch (err) {',
        '  betaCode = String(err?.code ?? err?.message ?? err);',
        '}',
        'const appAlpha = initializeApp({ projectId: "org-alpha" }, "probe-alpha");',
        'let alphaCode = "NONE";',
        'try {',
        '  await getAppCheck(appAlpha).verifyToken("");',
        '} catch (err) {',
        '  alphaCode = String(err?.code ?? err?.message ?? err);',
        '}',
        'const out = { betaCode, alphaCode };',
        'if (parentPort) parentPort.postMessage(out);',
        'else process.stdout.write("PROBE " + JSON.stringify(out) + "\\n");',
      ].join('\n'),
    );

    const mainPath = join(rootDir, 'main-pinned.mjs');
    writeFileSync(
      mainPath,
      [
        "import { execFileSync, fork, spawnSync } from 'node:child_process';",
        "import { Worker } from 'node:worker_threads';",
        `const probePath = ${JSON.stringify(probePath)};`,
        `const otherDir = ${JSON.stringify(otherDir)};`,
        '',
        'const evalCode = `',
        "  const { initializeApp } = require('firebase-admin/app');",
        "  const { getAppCheck } = require('firebase-admin/app-check');",
        "  const { parentPort } = require('node:worker_threads');",
        '  (async () => {',
        '    const appBeta = initializeApp({ projectId: "org-beta" }, "eval-beta");',
        '    let betaCode = "NONE";',
        '    try { await getAppCheck(appBeta).verifyToken(""); } catch (e) { betaCode = String(e?.code ?? e?.message ?? e); }',
        '    parentPort.postMessage({ betaCode });',
        '  })();',
        '`;',
        '',
        'function runWorker(src, opts) {',
        '  return new Promise((resolve) => {',
        '    const w = new Worker(src, opts);',
        '    w.once("message", resolve);',
        '    w.once("error", (err) => resolve({ startupRefused: String(err?.code ?? err?.message ?? err) }));',
        '  });',
        '}',
        '',
        'function parseChild(res) {',
        '  if (res.status !== 0) {',
        '    return { startupRefused: res.stderr.includes("PYRIC_LIVE_REFUSED") ? "PYRIC_LIVE_REFUSED" : `EXIT_${res.status}` };',
        '  }',
        '  const line = res.stdout.split("\\n").find((l) => l.startsWith("PROBE "));',
        '  return line ? JSON.parse(line.slice("PROBE ".length)) : { raw: res.stdout };',
        '}',
        '',
        '// 1. Rebind attempts via PYRIC_PROJECT + external cwd (.firebaserc = org-beta).',
        'const evalRebind = await runWorker(evalCode, {',
        '  eval: true,',
        '  env: { ...process.env, PYRIC_PROJECT: "org-beta" },',
        '});',
        'const fileWorkerRebind = await runWorker(new URL(`file://${probePath}`), {',
        '  env: { ...process.env, PYRIC_PROJECT: "org-beta" },',
        '});',
        'const childRebind = parseChild(spawnSync(process.execPath, [probePath], {',
        '  cwd: otherDir,',
        '  env: { ...process.env, PYRIC_PROJECT: "org-beta" },',
        '  encoding: "utf8",',
        '}));',
        'const forkRebind = await new Promise((resolve) => {',
        '  const f = fork(probePath, [], {',
        '    cwd: otherDir,',
        '    env: { ...process.env, PYRIC_PROJECT: "org-beta" },',
        '    silent: true,',
        '  });',
        '  let stdout = "", stderr = "";',
        '  f.stdout?.on("data", (c) => (stdout += c));',
        '  f.stderr?.on("data", (c) => (stderr += c));',
        '  f.once("close", (status) => resolve(parseChild({ status, stdout, stderr })));',
        '});',
        '',
        '// 2. Startup adminEnvRefusal enforcement on conflicting GCLOUD_PROJECT / FIREBASE_CONFIG.',
        'const evalEnvConflict = await runWorker("require(\'node:worker_threads\').parentPort.postMessage({ started: true });", {',
        '  eval: true,',
        '  env: { ...process.env, GCLOUD_PROJECT: "org-beta" },',
        '});',
        'const fileWorkerEnvConflict = await runWorker(new URL(`file://${probePath}`), {',
        '  env: { ...process.env, FIREBASE_CONFIG: JSON.stringify({ projectId: "org-beta" }) },',
        '});',
        'const childEnvConflict = parseChild(spawnSync(process.execPath, [probePath], {',
        '  cwd: otherDir,',
        '  env: { ...process.env, GCLOUD_PROJECT: "org-beta" },',
        '  encoding: "utf8",',
        '}));',
        '',
        '// 3. Parent process.env tampering before default-env Worker and execFileSync.',
        'process.env.PYRIC_PROJECT = "org-beta";',
        'delete process.env.PYRIC_LIVE_HOST_PROJECT;',
        'const evalAfterTamper = await runWorker(evalCode, { eval: true });',
        'const execFileOut = execFileSync(process.execPath, [probePath], { cwd: otherDir, encoding: "utf8" });',
        'const execFileAfterTamper = parseChild({ status: 0, stdout: execFileOut, stderr: "" });',
        '',
        'process.stdout.write("OUTCOME " + JSON.stringify({',
        '  evalRebind,',
        '  fileWorkerRebind,',
        '  childRebind,',
        '  forkRebind,',
        '  evalEnvConflict,',
        '  fileWorkerEnvConflict,',
        '  childEnvConflict,',
        '  evalAfterTamper,',
        '  execFileAfterTamper,',
        '}) + "\\n");',
      ].join('\n'),
    );

    const run = spawnSync('node', ['--import', '@pyric/live/register', mainPath], {
      cwd: rootDir,
      env: { PATH: process.env.PATH ?? '', HOME: rootDir },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    const line = run.stdout.split('\n').find((l) => l.startsWith('OUTCOME '));
    expect(line, run.stdout).toBeDefined();
    const outcome = JSON.parse(line!.slice('OUTCOME '.length));

    expect(outcome.evalRebind.betaCode).toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.fileWorkerRebind.betaCode).toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.fileWorkerRebind.alphaCode).not.toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.childRebind.betaCode).toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.childRebind.alphaCode).not.toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.forkRebind.betaCode).toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.forkRebind.alphaCode).not.toBe('PYRIC_LIVE_REFUSED');

    expect(outcome.evalEnvConflict.startupRefused).toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.fileWorkerEnvConflict.startupRefused).toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.childEnvConflict.startupRefused).toBe('PYRIC_LIVE_REFUSED');

    expect(outcome.evalAfterTamper.betaCode).toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.execFileAfterTamper.betaCode).toBe('PYRIC_LIVE_REFUSED');
  }, 30_000);

  test('buildLiveChildEnv clears inherited PYRIC_LIVE_HOST_PROJECT so pyric-live run resolves fresh host policy', () => {
    const env = buildLiveChildEnv(
      { [LIVE_PINNED_PROJECT_VARIABLE]: 'stale-parent-project' },
      {
        serveUrl: 'http://127.0.0.1:3473',
        registerUrl: liveRegisterModuleUrl(),
        projectId: 'org-alpha',
      },
    );
    expect(env[LIVE_PINNED_PROJECT_VARIABLE]).toBeUndefined();
    expect(env.PYRIC_PROJECT).toBe('org-alpha');
  });
});
