import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';

const childProbe = resolve('sandbox-probe-child.mjs');
const workerProbe = resolve('sandbox-probe-worker.mjs');
const liveRegisterUrl = pathToFileURL(resolve('node_modules/@pyric/live/dist/register.js')).href;
const liveEvalWorkerPath = resolve('node_modules/@pyric/live/dist/register-eval-worker.js');

// Create a decoy script whose path matches the foreign live-register pattern.
const decoyDir = resolve('decoy/packages/live/dist/register');
mkdirSync(decoyDir, { recursive: true });
const decoyLivePath = resolve(decoyDir, 'index.js');
writeFileSync(decoyLivePath, 'globalThis.__DECOY_PRELOAD_RAN__ = true;\n');

function runChildSync(options) {
  const result = spawnSync(process.execPath, [childProbe], {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options,
  });
  const line = (result.stdout || '').split('\n').find((entry) => entry.startsWith('PROBE '));
  return {
    status: result.status,
    probe: line ? JSON.parse(line.slice('PROBE '.length)) : null,
    hasConflictError: (result.stderr || '').includes('@pyric/cli/register is already active'),
  };
}

function runChildAsync(options) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [childProbe], {
      cwd: process.cwd(),
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      const line = stdout.split('\n').find((entry) => entry.startsWith('PROBE '));
      done({
        status,
        probe: line ? JSON.parse(line.slice('PROBE '.length)) : null,
        hasConflictError: stderr.includes('@pyric/cli/register is already active'),
      });
    });
  });
}

function runWorker(source, options) {
  return new Promise((done) => {
    const worker = new Worker(source, options);
    let message = null;
    worker.on('message', (payload) => {
      message = payload;
    });
    worker.on('error', (error) => {
      done({
        hasConflictError: error.message.includes('@pyric/cli/register is already active'),
        errorMessage: error.message,
        message,
      });
    });
    worker.on('exit', (code) => done({ code, message }));
  });
}

const foreignPreload = {
  childDecoyLive: runChildSync({
    env: { PATH: process.env.PATH, NODE_OPTIONS: `--import ${decoyLivePath}` },
  }),
  workerExecArgvDecoyLive: await runWorker(workerProbe, {
    execArgv: ['--import', decoyLivePath],
  }),
  workerCustomEnvDecoyLive: await runWorker(workerProbe, {
    env: { PATH: process.env.PATH, NODE_OPTIONS: `--import ${decoyLivePath}` },
  }),
  childRealLive: runChildSync({
    env: { PATH: process.env.PATH, NODE_OPTIONS: '--import @pyric/live/register' },
  }),
  childRequireLiveEval: runChildSync({
    env: { PATH: process.env.PATH, NODE_OPTIONS: `-r ${liveEvalWorkerPath}` },
  }),
  workerExecArgvRealLive: await runWorker(workerProbe, {
    execArgv: ['--import', liveRegisterUrl],
  }),
  workerCustomEnvRealLive: await runWorker(workerProbe, {
    env: { PATH: process.env.PATH, NODE_OPTIONS: '--import @pyric/live/register' },
  }),
};

// Now delete sandbox activation env and NODE_OPTIONS in the parent process.
delete process.env.PYRIC_SANDBOX;
delete process.env.PYRIC_SANDBOX_INSTANCE;
delete process.env.PYRIC_SESSION_TOKEN;
delete process.env.NODE_OPTIONS;

const evalWorkerCode = [
  'const { parentPort } = require("node:worker_threads");',
  'const adminApp = require("firebase-admin/app");',
  'parentPort.postMessage({',
  '  swapped: adminApp.ADMIN_APP_TARGET === Symbol.for("pyric.admin.app.target"),',
  '  sandboxEnv: process.env.PYRIC_SANDBOX ?? null,',
  '  instanceEnv: process.env.PYRIC_SANDBOX_INSTANCE ?? null,',
  '  sessionEnv: process.env.PYRIC_SESSION_TOKEN ?? null,',
  '  sandboxActive: globalThis[Symbol.for("pyric.register.active")] === true,',
  '});',
].join('\n');

const envPinning = {
  syncDefaultEnv: runChildSync({}),
  syncStrippedEnv: runChildSync({
    env: { PATH: process.env.PATH, PYRIC_SANDBOX: '' },
  }),
  asyncStrippedEnv: await runChildAsync({
    env: { PATH: process.env.PATH },
  }),
  workerDefaultEnv: await runWorker(workerProbe),
  workerCustomEnv: await runWorker(workerProbe, {
    env: { PATH: process.env.PATH, PYRIC_SANDBOX: '' },
  }),
  workerSharedEnv: await runWorker(workerProbe, {
    env: SHARE_ENV,
  }),
  workerEvalCjs: await runWorker(evalWorkerCode, {
    eval: true,
    env: { PATH: process.env.PATH },
  }),
};

console.log(`OUTCOME ${JSON.stringify({ foreignPreload, envPinning })}`);
