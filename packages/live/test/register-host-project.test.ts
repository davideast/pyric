/**
 * `@pyric/live/register` project resolution when local Firebase config names no
 * default project (for example `.firebaserc` holds `"projects": {}` with
 * multi-environment `targets`, while the live host started with `--project` or
 * `pyricLive({ project })`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const liveDir = resolve(import.meta.dir, '..');
const repoRoot = resolve(liveDir, '../..');
const cliDir = join(repoRoot, 'packages/cli');
const liveRegisterDist = join(liveDir, 'dist/register.js');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));
const realAdminDir = realpathSync(dirname(requireFromRepo.resolve('firebase-admin/package.json')));
const nodeMajor = Number(spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.split('.')[0]);
const adminRowsOn = nodeMajor >= 23;

const HOST_PROJECT = 'acme-live';
const OTHER_PROJECT = 'other-project';
const HOST_INSTANCE = 'live-host-project-test';

let projectDir: string;
let counter: NetServer;
let counterPort = 0;
const servers: Server[] = [];

async function listenHttp(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return (server.address() as AddressInfo).port;
}

async function startHealthServer(body: Record<string, unknown> | null): Promise<{ url: string; port: number }> {
  const server = createServer((req, res) => {
    if (body !== null && req.url === '/__pyric/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  const port = await listenHttp(server);
  return { url: `http://127.0.0.1:${port}`, port };
}

function startLiveHost(projectId: string = HOST_PROJECT): Promise<{ url: string; port: number }> {
  return startHealthServer({
    status: 'ok',
    mode: 'sandbox',
    instanceId: HOST_INSTANCE,
    live: {
      projectId,
      configProjectId: projectId,
      configSource: 'option',
      appProjectIds: [],
      billed: { reads: 0, writes: 0, deliveries: 0 },
    },
  });
}

function startSandboxHost(): Promise<{ url: string; port: number }> {
  return startHealthServer({
    status: 'ok',
    mode: 'sandbox',
    instanceId: HOST_INSTANCE,
  });
}

interface NodeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  outcome: Record<string, unknown>;
}

async function runNodeScript(
  name: string,
  source: string,
  env: Record<string, string | undefined> = {},
  cwd: string = projectDir,
): Promise<NodeRunResult> {
  const file = join(cwd, name);
  writeFileSync(file, source);
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: projectDir,
    COUNTER_PORT: String(counterPort),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  const child: ChildProcess = spawn('node', ['--import', '@pyric/live/register', file], {
    cwd,
    env: childEnv,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const code = await new Promise<number | null>((done) => child.once('close', (exitCode) => done(exitCode)));
  clearTimeout(timer);
  const line = stdout.split('\n').find((entry) => entry.startsWith('OUTCOME '));
  const outcome = line ? (JSON.parse(line.slice('OUTCOME '.length)) as Record<string, unknown>) : {};
  return { code, stdout, stderr, outcome };
}

function writeEmptyProjectsRc(dir: string = projectDir): void {
  writeFileSync(
    join(dir, '.firebaserc'),
    JSON.stringify({
      projects: {},
      targets: {
        [HOST_PROJECT]: { hosting: { app: ['acme-web'] } },
      },
    }),
  );
}

beforeAll(async () => {
  if (!existsSync(liveRegisterDist)) {
    throw new Error(`${liveRegisterDist} missing: build @pyric/cli and @pyric/live first`);
  }
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-host-proj-')));
  const nm = join(projectDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(cliDir, join(nm, '@pyric/cli'));
  symlinkSync(liveDir, join(nm, '@pyric/live'));
  symlinkSync(realFirebaseDir, join(nm, 'firebase'));
  symlinkSync(realAdminDir, join(nm, 'firebase-admin'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'acme-backend', type: 'module' }));
  writeEmptyProjectsRc();

  counter = createNetServer((socket) => socket.destroy());
  await new Promise<void>((done) => counter.listen(0, '127.0.0.1', () => done()));
  counterPort = (counter.address() as AddressInfo).port;
});

afterEach(async () => {
  writeEmptyProjectsRc();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

afterAll(async () => {
  await new Promise<void>((done) => counter.close(() => done()));
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('@pyric/live/register project fallback to the live host', () => {
  test('inherits reach.projectId when .firebaserc has empty projects and gates calls and process health to it', async () => {
    const host = await startLiveHost(HOST_PROJECT);
    const script = `import { createServer } from 'node:http';
import { initializeApp } from 'firebase/app';
import { doc, getDocFromCache, initializeFirestore } from 'firebase/firestore';

const settings = { host: '127.0.0.1:' + process.env.COUNTER_PORT, ssl: false };
const hostDb = initializeFirestore(initializeApp({ projectId: '${HOST_PROJECT}', apiKey: 'k', appId: '1:1:web:1' }, 'host'), settings);
const otherDb = initializeFirestore(initializeApp({ projectId: '${OTHER_PROJECT}', apiKey: 'k', appId: '1:1:web:1' }, 'other'), settings);

const codeOf = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    return error?.code ?? String(error);
  }
};

const hostCall = await codeOf(() => getDocFromCache(doc(hostDb, 'items/a')));
const otherCall = await codeOf(() => getDocFromCache(doc(otherDb, 'items/a')));

const srv = createServer((_req, res) => res.writeHead(200).end('app'));
await new Promise((done) => srv.listen(0, '127.0.0.1', done));
const port = srv.address().port;
const healthRes = await fetch('http://127.0.0.1:' + port + '/__pyric/health', {
  headers: { 'x-pyric-process-health': '1' },
});
const health = await healthRes.json();
await new Promise((done) => srv.close(done));

console.log('OUTCOME ' + JSON.stringify({
  gcloudProject: process.env.GOOGLE_CLOUD_PROJECT,
  pyricProject: process.env.PYRIC_PROJECT,
  hostCall,
  otherCall,
  processHealth: health.pyricProcess,
}));
process.exit(0);
`;
    const res = await runNodeScript('inherit-host-project.mjs', script, {
      PYRIC_SANDBOX: `remote:${host.url}`,
      PYRIC_SANDBOX_INSTANCE: HOST_INSTANCE,
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain(`@pyric/live/register: live mode for the Firebase project ${HOST_PROJECT}.`);
    expect(res.stderr).toContain(`@pyric/live/register: reporting calls to the live host at ${host.url}.`);
    expect(res.outcome.gcloudProject).toBe(HOST_PROJECT);
    expect(res.outcome.pyricProject).toBe(HOST_PROJECT);
    expect(res.outcome.hostCall).not.toBe('PYRIC_LIVE_REFUSED');
    expect(res.outcome.otherCall).toBe('PYRIC_LIVE_REFUSED');
    expect(res.outcome.processHealth).toMatchObject({
      mode: 'live',
      projectId: HOST_PROJECT,
    });
  });

  test('propagates the inherited host project to child_process and worker_threads under empty .firebaserc projects', async () => {
    const host = await startLiveHost(HOST_PROJECT);
    const probeFile = join(projectDir, 'child-or-worker-probe.mjs');
    writeFileSync(
      probeFile,
      `import { parentPort } from 'node:worker_threads';
import { initializeApp } from 'firebase/app';
import { doc, getDocFromCache, initializeFirestore } from 'firebase/firestore';

const settings = { host: '127.0.0.1:${counterPort}', ssl: false };
const hostDb = initializeFirestore(initializeApp({ projectId: '${HOST_PROJECT}', apiKey: 'k', appId: '1:1:web:1' }, 'host'), settings);
const otherDb = initializeFirestore(initializeApp({ projectId: '${OTHER_PROJECT}', apiKey: 'k', appId: '1:1:web:1' }, 'other'), settings);

const codeOf = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    return error?.code ?? String(error);
  }
};

const hostCall = await codeOf(() => getDocFromCache(doc(hostDb, 'items/a')));
const otherCall = await codeOf(() => getDocFromCache(doc(otherDb, 'items/a')));

let adminOther = 'skipped';
let adminHost = 'skipped';
if (Number(process.versions.node.split('.')[0]) >= 23) {
  const adminApp = await import('firebase-admin/app');
  const adminFs = await import('firebase-admin/firestore');
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:${counterPort}';
  const appOther = adminApp.initializeApp({ projectId: '${OTHER_PROJECT}' }, 'admin-other');
  adminOther = await codeOf(() => adminFs.getFirestore(appOther).doc('items/a').get());
  const appHost = adminApp.initializeApp({}, 'admin-default-env');
  adminHost = await codeOf(() => {
    // Synchronous project gate runs before network; race short timeout since counterPort closes TCP immediately.
    return Promise.race([
      adminFs.getFirestore(appHost).doc('items/a').get(),
      new Promise((r) => setTimeout(() => r('allowed'), 60)),
    ]);
  });
}

const payload = {
  pyricProject: process.env.PYRIC_PROJECT,
  gcloudProject: process.env.GOOGLE_CLOUD_PROJECT,
  hostCall,
  otherCall,
  adminOther,
  adminHost,
};
if (parentPort) parentPort.postMessage(payload);
else console.log('PROBE ' + JSON.stringify(payload));
process.exit(0);
`,
    );

    const parentScript = `import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const parseProbe = (res) => {
  const line = res.stdout.split('\\n').find((l) => l.startsWith('PROBE '));
  if (!line) throw new Error('missing PROBE line: ' + res.stderr + '\\n' + res.stdout);
  return JSON.parse(line.slice('PROBE '.length));
};

const childDefault = parseProbe(spawnSync(process.execPath, [${JSON.stringify(probeFile)}], { encoding: 'utf8' }));
const childStripped = parseProbe(spawnSync(process.execPath, [${JSON.stringify(probeFile)}], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
}));

const runWorker = (options) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL(${JSON.stringify(`file://${probeFile}`)}), options);
  worker.once('message', resolve);
  worker.once('error', reject);
});

const workerDefault = await runWorker(undefined);
const workerStripped = await runWorker({ env: { PATH: process.env.PATH, HOME: process.env.HOME } });

console.log('OUTCOME ' + JSON.stringify({ childDefault, childStripped, workerDefault, workerStripped }));
process.exit(0);
`;

    const res = await runNodeScript('parent-propagation.mjs', parentScript, {
      PYRIC_SANDBOX: `remote:${host.url}`,
      PYRIC_SANDBOX_INSTANCE: HOST_INSTANCE,
    });
    expect(res.code, res.stderr).toBe(0);
    for (const label of ['childDefault', 'childStripped', 'workerDefault', 'workerStripped'] as const) {
      const entry = res.outcome[label] as Record<string, string>;
      expect(entry.pyricProject, label).toBe(HOST_PROJECT);
      expect(entry.gcloudProject, label).toBe(HOST_PROJECT);
      expect(entry.hostCall, label).not.toBe('PYRIC_LIVE_REFUSED');
      expect(entry.otherCall, label).toBe('PYRIC_LIVE_REFUSED');
      if (adminRowsOn) {
        expect(entry.adminOther, label).toBe('PYRIC_LIVE_REFUSED');
        expect(entry.adminHost, label).not.toBe('PYRIC_LIVE_REFUSED');
      }
    }
  }, 30_000);

  test('local PYRIC_PROJECT and .firebaserc take precedence over reach.projectId, warn on mismatch, and gate calls to the local project', async () => {
    const host = await startLiveHost(HOST_PROJECT);
    const script = `import { initializeApp } from 'firebase/app';
import { doc, getDocFromCache, initializeFirestore } from 'firebase/firestore';

const settings = { host: '127.0.0.1:' + process.env.COUNTER_PORT, ssl: false };
const localDb = initializeFirestore(initializeApp({ projectId: '${OTHER_PROJECT}', apiKey: 'k', appId: '1:1:web:1' }, 'local'), settings);
const hostDb = initializeFirestore(initializeApp({ projectId: '${HOST_PROJECT}', apiKey: 'k', appId: '1:1:web:1' }, 'host'), settings);

const codeOf = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    return error?.code ?? String(error);
  }
};

const localCall = await codeOf(() => getDocFromCache(doc(localDb, 'items/a')));
const hostCall = await codeOf(() => getDocFromCache(doc(hostDb, 'items/a')));

let adminHostRefused = 'skipped';
if (Number(process.versions.node.split('.')[0]) >= 23) {
  const adminApp = await import('firebase-admin/app');
  const adminFs = await import('firebase-admin/firestore');
  const appHost = adminApp.initializeApp({ projectId: '${HOST_PROJECT}' }, 'admin-host');
  adminHostRefused = await codeOf(() => adminFs.getFirestore(appHost).doc('items/a').get());
}

console.log('OUTCOME ' + JSON.stringify({
  pyricProject: process.env.PYRIC_PROJECT,
  gcloudProject: process.env.GOOGLE_CLOUD_PROJECT,
  localCall,
  hostCall,
  adminHostRefused,
}));
process.exit(0);
`;
    const fromEnv = await runNodeScript('mismatch-env.mjs', script, {
      PYRIC_PROJECT: OTHER_PROJECT,
      PYRIC_SANDBOX: `remote:${host.url}`,
      PYRIC_SANDBOX_INSTANCE: HOST_INSTANCE,
    });
    expect(fromEnv.code, fromEnv.stderr).toBe(0);
    expect(fromEnv.stderr).toContain(`@pyric/live/register: live mode for the Firebase project ${OTHER_PROJECT}.`);
    expect(fromEnv.stderr).toContain(
      `@pyric/live/register: the live host at ${host.url} is for the Firebase project ${HOST_PROJECT}, and this process talks to ${OTHER_PROJECT}.`,
    );
    expect(fromEnv.outcome.pyricProject).toBe(OTHER_PROJECT);
    expect(fromEnv.outcome.gcloudProject).toBe(OTHER_PROJECT);
    expect(fromEnv.outcome.localCall).not.toBe('PYRIC_LIVE_REFUSED');
    expect(fromEnv.outcome.hostCall).toBe('PYRIC_LIVE_REFUSED');
    if (adminRowsOn) {
      expect(fromEnv.outcome.adminHostRefused).toBe('PYRIC_LIVE_REFUSED');
    }

    writeFileSync(join(projectDir, '.firebaserc'), JSON.stringify({ projects: { default: OTHER_PROJECT } }));
    const fromRc = await runNodeScript('mismatch-rc.mjs', script, {
      PYRIC_SANDBOX: `remote:${host.url}`,
      PYRIC_SANDBOX_INSTANCE: HOST_INSTANCE,
    });
    expect(fromRc.code, fromRc.stderr).toBe(0);
    expect(fromRc.stderr).toContain(`@pyric/live/register: live mode for the Firebase project ${OTHER_PROJECT}.`);
    expect(fromRc.stderr).toContain(
      `@pyric/live/register: the live host at ${host.url} is for the Firebase project ${HOST_PROJECT}, and this process talks to ${OTHER_PROJECT}.`,
    );
    expect(fromRc.outcome.localCall).not.toBe('PYRIC_LIVE_REFUSED');
    expect(fromRc.outcome.hostCall).toBe('PYRIC_LIVE_REFUSED');
  }, 30_000);

  test('still throws LiveProjectMissingError when local config names no project and no live host answers', async () => {
    const script = `console.log('OUTCOME {"started":true}');\n`;
    const noHost = await runNodeScript('no-host.mjs', script);
    expect(noHost.code).not.toBe(0);
    expect(noHost.stderr).toContain(`No Firebase project is set for ${projectDir}`);

    const sandbox = await startSandboxHost();
    const sandboxHost = await runNodeScript('sandbox-host.mjs', script, {
      PYRIC_SANDBOX: `remote:${sandbox.url}`,
      PYRIC_SANDBOX_INSTANCE: HOST_INSTANCE,
    });
    expect(sandboxHost.code).not.toBe(0);
    expect(sandboxHost.stderr).toContain(`No Firebase project is set for ${projectDir}`);
  });
});
