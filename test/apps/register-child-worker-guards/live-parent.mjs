import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const childProbe = resolve('live-probe-child.mjs');
const workerProbe = resolve('live-probe-worker.mjs');

function runChild(env) {
  const result = spawnSync(process.execPath, [childProbe], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  const line = (result.stdout || '').split('\n').find((entry) => entry.startsWith('PROBE '));
  return {
    status: result.status,
    probe: line ? JSON.parse(line.slice('PROBE '.length)) : null,
  };
}

function runWorker(options) {
  return new Promise((done) => {
    const worker = new Worker(workerProbe, options);
    let message = null;
    worker.on('message', (payload) => {
      message = payload;
    });
    worker.on('error', (error) => done({ error: error.message, message }));
    worker.on('exit', (code) => done({ code, message }));
  });
}

const outcome = {
  childImportCli: runChild({
    PATH: process.env.PATH,
    NODE_OPTIONS: '--import @pyric/cli/register',
  }),
  childImportCliWithSandbox: runChild({
    PATH: process.env.PATH,
    PYRIC_SANDBOX: '1',
    NODE_OPTIONS: '--import @pyric/cli/register',
  }),
  childRequireCli: runChild({
    PATH: process.env.PATH,
    NODE_OPTIONS: '-r @pyric/cli/register',
  }),
  workerExecArgvCli: await runWorker({
    execArgv: ['--import', '@pyric/cli/register'],
  }),
  workerCustomEnvNodeOptionsCli: await runWorker({
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: '--import @pyric/cli/register',
    },
  }),
  workerCustomEnvNodeOptionsCliWithSandbox: await runWorker({
    env: {
      PATH: process.env.PATH,
      PYRIC_SANDBOX: '1',
      NODE_OPTIONS: '--import @pyric/cli/register',
    },
  }),
};

console.log(`OUTCOME ${JSON.stringify(outcome)}`);
