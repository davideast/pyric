/**
 * A registered process says what it is on its own HTTP servers (#2304 G-4):
 * a loopback `GET /__pyric/health` that asks for the process health is
 * answered before the app, as a sandbox under `@pyric/cli/register` and as
 * live under `@pyric/live/register`. Every other request reaches the app:
 * the plain health path a pyric host serves, another path, a request from
 * another machine, and every request under `PYRIC_PROCESS_HEALTH=off`.
 *
 * Each case starts a plain `node:http` server under a real `node --import`.
 * Requires the CLI and `@pyric/live` to be built (`dist/`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { closedPort } from '../closed-port.js';

const cliDir = resolve(import.meta.dir, '../..');
const liveDir = resolve(cliDir, '../live');
/** Live mode starts only in a project that installs firebase. */
const realFirebaseDir = realpathSync(dirname(createRequire(join(cliDir, '../../package.json')).resolve('firebase/package.json')));
const PROJECT_ID = 'process-health-fixture';
const HEALTH_PATH = '/__pyric/health';
const ASK_HEADER = { 'x-pyric-process-health': '1' };

/**
 * The app answers every request with the path it saw. Under `REMOTE_PEER`
 * every connection reports a peer on another machine, so the parser and the
 * request stay real without a second address.
 */
const SERVER = `
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ app: req.url }));
});
if (process.env.REMOTE_PEER === '1') {
  server.on('connection', (socket) => Object.defineProperty(socket, 'remoteAddress', { value: '192.0.2.1' }));
}
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

let projectDir: string;
let child: ChildProcess | undefined;

beforeAll(() => {
  for (const built of [join(cliDir, 'dist/register/index.js'), join(liveDir, 'dist/register.js')]) {
    if (!existsSync(built)) throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
  }
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-process-health-')));
  mkdirSync(join(projectDir, 'node_modules/@pyric'), { recursive: true });
  symlinkSync(cliDir, join(projectDir, 'node_modules/@pyric/cli'));
  symlinkSync(liveDir, join(projectDir, 'node_modules/@pyric/live'));
  symlinkSync(realFirebaseDir, join(projectDir, 'node_modules/firebase'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: PROJECT_ID, type: 'module' }));
  writeFileSync(join(projectDir, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  writeFileSync(join(projectDir, 'server.mjs'), SERVER);
});

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

afterEach(() => {
  child?.kill();
  child = undefined;
});

/** Starts the app under `register` and resolves its port. */
function startServer(register: string, env: Record<string, string> = {}): Promise<number> {
  const started = spawn('node', ['--import', register, 'server.mjs'], {
    cwd: projectDir,
    env: { PATH: process.env.PATH, HOME: projectDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = started;
  let stderr = '';
  started.stderr.setEncoding('utf8');
  started.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolvePort, reject) => {
    started.stdout.setEncoding('utf8');
    started.stdout.on('data', (chunk: string) => {
      const port = /PORT (\d+)/.exec(chunk)?.[1];
      if (port !== undefined) resolvePort(Number(port));
    });
    started.once('exit', (code) => reject(new Error(`the server exited with ${String(code)}: ${stderr}`)));
  });
}

interface Answer {
  status: number | undefined;
  body: unknown;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolveAnswer, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolveAnswer({ status: res.statusCode, body: JSON.parse(text) as unknown }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /__pyric/health on a registered process', () => {
  it('answers sandbox, with the host and its instance, under @pyric/cli/register', async () => {
    const host = `http://127.0.0.1:${await closedPort()}`;
    const port = await startServer('@pyric/cli/register', { PYRIC_SANDBOX: `remote:${host}`, PYRIC_SANDBOX_INSTANCE: 'instance-1' });
    const answer = await get(port, HEALTH_PATH, ASK_HEADER);
    expect(answer).toEqual({ status: 200, body: { pyricProcess: { mode: 'sandbox', instanceId: 'instance-1', host } } });
  }, 30_000);

  it('answers live, with the project, under @pyric/live/register', async () => {
    const port = await startServer('@pyric/live/register');
    const answer = await get(port, HEALTH_PATH, ASK_HEADER);
    expect(answer).toEqual({ status: 200, body: { pyricProcess: { mode: 'live', projectId: PROJECT_ID } } });
  }, 30_000);

  it('passes every other request to the app', async () => {
    const host = `http://127.0.0.1:${await closedPort()}`;
    const port = await startServer('@pyric/cli/register', { PYRIC_SANDBOX: `remote:${host}` });
    // A pyric host's own health, which a `withPyric` rewrite forwards, is not this process's to answer.
    expect(await get(port, HEALTH_PATH)).toEqual({ status: 404, body: { app: HEALTH_PATH } });
    expect(await get(port, '/api/users', ASK_HEADER)).toEqual({ status: 404, body: { app: '/api/users' } });
  }, 30_000);

  it('passes a request from another machine to the app', async () => {
    const host = `http://127.0.0.1:${await closedPort()}`;
    const port = await startServer('@pyric/cli/register', { PYRIC_SANDBOX: `remote:${host}`, REMOTE_PEER: '1' });
    expect(await get(port, HEALTH_PATH, ASK_HEADER)).toEqual({ status: 404, body: { app: HEALTH_PATH } });
  }, 30_000);

  it('leaves the path to an app that serves it under PYRIC_PROCESS_HEALTH=off', async () => {
    const port = await startServer('@pyric/live/register', { PYRIC_PROCESS_HEALTH: 'off' });
    expect(await get(port, HEALTH_PATH, ASK_HEADER)).toEqual({ status: 404, body: { app: HEALTH_PATH } });
  }, 30_000);
});
