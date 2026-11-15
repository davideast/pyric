/**
 * Adversarial matrix for `@pyric/live/register` Admin project gates against real
 * `firebase-admin`, `@google-cloud/firestore`, and `@google-cloud/storage`:
 *
 * 1. Firestore GAPIC `v1.FirestoreClient` with non-plain class instances,
 *    prototype getters, and real protobufjs message instances (`GetDocumentRequest.create`,
 *    `WriteRequest.create`) targeting cross-project and named databases.
 * 2. Cloud Storage (`STORAGE_EMULATOR_HOST` loopback wire probe) across
 *    `requestStream` reentrancy, `/projects/<other>` path URIs, `?project=<other>`
 *    query URIs, non-plain option instances, and request interceptor URI rewrites.
 * 3. File-path and unreadable/malformed `FIREBASE_CONFIG` startup enforcement
 *    across root processes, child processes, and `Worker` threads.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const liveDir = resolve(import.meta.dir, '../..');
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

const HOST_PROJECT = 'org-alpha';
const OTHER_PROJECT = 'org-beta';

interface WireHit {
  readonly method: string;
  readonly url: string;
}

let workDir: string;
let server: Server;
let origin: string;
let port: number;
const hits: WireHit[] = [];

beforeAll(async () => {
  if (!existsSync(liveRegisterDist)) {
    throw new Error(`${liveRegisterDist} missing: build @pyric/cli and @pyric/live first`);
  }
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-admin-adversarial-')));
  const nm = join(workDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(cliDir, join(nm, '@pyric/cli'));
  symlinkSync(liveDir, join(nm, '@pyric/live'));
  symlinkSync(realFirebaseDir, join(nm, 'firebase'));
  symlinkSync(realAdminDir, join(nm, 'firebase-admin'));
  writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'adversarial-app', type: 'module' }));
  writeFileSync(join(workDir, 'firebase.json'), JSON.stringify({}));
  writeFileSync(join(workDir, '.firebaserc'), JSON.stringify({ projects: { default: HOST_PROJECT } }));

  server = createServer((req, res) => {
    hits.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: `projects/${HOST_PROJECT}/databases/(default)/documents/items/1`,
        fields: {},
        items: [],
      }),
    );
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to bind loopback server');
  }
  port = address.port;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

interface ProbeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runProbe(scriptPath: string, extraEnv: Record<string, string> = {}): Promise<ProbeResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('node', ['--import', '@pyric/live/register', scriptPath], {
      cwd: workDir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: workDir,
        STORAGE_EMULATOR_HOST: origin,
        ...extraEnv,
      },
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 25_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

function parseResult<T>(stdout: string): T {
  const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
  if (line === undefined) throw new Error(`Missing RESULT line:\n${stdout}`);
  return JSON.parse(line.slice('RESULT '.length)) as T;
}

describe('Admin live project-gate adversarial matrix', () => {
  test('refuses non-plain and protobufjs GAPIC payloads with zero wire hits while allowing host (default)', async () => {
    if (!adminRowsOn) return;
    hits.length = 0;

    const scriptPath = join(workDir, 'gapic-matrix.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { initializeApp } from 'firebase-admin/app';",
        "import { v1 } from 'firebase-admin/firestore';",
        `const HOST = ${JSON.stringify(HOST_PROJECT)};`,
        `const OTHER = ${JSON.stringify(OTHER_PROJECT)};`,
        `const PORT = ${port};`,
        'initializeApp({ projectId: HOST });',
        'const client = new v1.FirestoreClient({',
        '  projectId: HOST,',
        "  servicePath: '127.0.0.1',",
        '  port: PORT,',
        "  protocol: 'http',",
        "  fallback: 'rest',",
        '  auth: {',
        '    getProjectId: async () => HOST,',
        "    getRequestHeaders: async () => ({ Authorization: 'Bearer test-token' }),",
        "    getUniverseDomain: async () => 'googleapis.com',",
        '  },',
        '});',
        'class GapicRequest {',
        '  constructor(name) { this.name = name; }',
        '}',
        'class GetterRequest {',
        '  #name;',
        '  constructor(name) { this.#name = name; }',
        '  get name() { return this.#name; }',
        '}',
        "const GetDocumentRequest = client._protos.lookupType('google.firestore.v1.GetDocumentRequest');",
        'async function codeOf(promise) {',
        '  try { await promise; return "OK"; } catch (err) { return String(err?.code ?? err?.message ?? err); }',
        '}',
        'const callOpts = { timeout: 2000, retry: null };',
        'const hostPlain = await codeOf(client.getDocument({ name: `projects/${HOST}/databases/(default)/documents/items/1` }, callOpts));',
        'const hostProto = await codeOf(client.getDocument(GetDocumentRequest.create({ name: `projects/${HOST}/databases/(default)/documents/items/1` }), callOpts));',
        'const plainOther = await codeOf(client.getDocument({ name: `projects/${OTHER}/databases/(default)/documents/items/1` }, callOpts));',
        'const classOther = await codeOf(client.getDocument(new GapicRequest(`projects/${OTHER}/databases/(default)/documents/items/1`), callOpts));',
        'const classNamedDb = await codeOf(client.getDocument(new GapicRequest(`projects/${HOST}/databases/other-db/documents/items/1`), callOpts));',
        'const getterOther = await codeOf(client.getDocument(new GetterRequest(`projects/${OTHER}/databases/(default)/documents/items/1`), callOpts));',
        'const protoOther = await codeOf(client.getDocument(GetDocumentRequest.create({ name: `projects/${OTHER}/databases/(default)/documents/items/1` }), callOpts));',
        'const protoNamedDb = await codeOf(client.getDocument(GetDocumentRequest.create({ name: `projects/${HOST}/databases/other-db/documents/items/1` }), callOpts));',
        'process.stdout.write("RESULT " + JSON.stringify({',
        '  hostPlain, hostProto, plainOther, classOther, classNamedDb, getterOther, protoOther, protoNamedDb,',
        '}) + "\\n");',
      ].join('\n'),
    );

    const run = await runProbe(scriptPath);
    expect(run.status, run.stderr).toBe(0);
    const result = parseResult<Record<string, string>>(run.stdout);
    expect(result.hostPlain).toBe('OK');
    expect(result.hostProto).toBe('OK');
    expect(result.plainOther).toBe('PYRIC_LIVE_REFUSED');
    expect(result.classOther).toBe('PYRIC_LIVE_REFUSED');
    expect(result.classNamedDb).toBe('PYRIC_LIVE_REFUSED');
    expect(result.getterOther).toBe('PYRIC_LIVE_REFUSED');
    expect(result.protoOther).toBe('PYRIC_LIVE_REFUSED');
    expect(result.protoNamedDb).toBe('PYRIC_LIVE_REFUSED');

    const badHits = hits.filter(
      (hit) => hit.url.includes(OTHER_PROJECT) || hit.url.includes('/databases/other-db/'),
    );
    expect(badHits).toEqual([]);
  }, 30_000);

  test('refuses all four Storage bypass vectors and interceptor rewrites over STORAGE_EMULATOR_HOST with zero wire hits', async () => {
    if (!adminRowsOn) return;
    hits.length = 0;

    const scriptPath = join(workDir, 'storage-matrix.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { initializeApp } from 'firebase-admin/app';",
        "import { getStorage } from 'firebase-admin/storage';",
        `const HOST = ${JSON.stringify(HOST_PROJECT)};`,
        `const OTHER = ${JSON.stringify(OTHER_PROJECT)};`,
        `const ORIGIN = ${JSON.stringify(origin)};`,
        'const app = initializeApp({ projectId: HOST, storageBucket: `${HOST}.appspot.com` });',
        'const bucket = getStorage(app).bucket(`${HOST}.appspot.com`);',
        'const storage = bucket.storage;',
        'storage.retryOptions = { autoRetry: false };',
        'class BucketQueryOpts {',
        '  constructor(project) { this.project = project; }',
        '}',
        'class UserProjOpts {',
        '  #project;',
        '  constructor(project) { this.#project = project; }',
        '  get userProject() { return this.#project; }',
        '}',
        'function runAuthReq(opts) {',
        '  return new Promise((resolve) => {',
        '    storage.makeAuthenticatedRequest(opts, (err) => resolve(err ? String(err.code ?? err.message) : "OK"));',
        '  });',
        '}',
        'function runStream(target, opts) {',
        '  return new Promise((resolve) => {',
        '    const stream = target.requestStream(opts);',
        '    let done = false;',
        '    const finish = (v) => { if (!done) { done = true; resolve(v); } };',
        '    stream.on("error", (err) => finish(String(err?.code ?? err?.message ?? err)));',
        '    stream.on("data", () => {});',
        '    stream.on("end", () => finish("OK"));',
        '  });',
        '}',
        'async function codeOf(promise) {',
        '  try { await promise; return "OK"; } catch (err) { return String(err?.code ?? err?.message ?? err); }',
        '}',
        'const hostFiles = await codeOf(bucket.getFiles());',
        'const v1StorageStream = await runStream(storage, { uri: `/b/${OTHER}.appspot.com/o` });',
        'const v1BucketStream = await runStream(bucket, { uri: `${ORIGIN}/storage/v1/b/${OTHER}.appspot.com/o` });',
        'const v2AuthReq = await runAuthReq({ uri: `${ORIGIN}/storage/v1/projects/${OTHER}/hmacKeys` });',
        'const v2Request = await codeOf(new Promise((res, rej) => storage.request({ uri: `/projects/${OTHER}/hmacKeys` }, (e, b) => (e ? rej(e) : res(b)))));',
        'const v2Stream = await runStream(storage, { uri: `/projects/${OTHER}/hmacKeys` });',
        'const v3AuthReq = await runAuthReq({ uri: `${ORIGIN}/storage/v1/b?project=${OTHER}` });',
        'const v3Request = await codeOf(new Promise((res, rej) => storage.request({ uri: `/b?project=${OTHER}` }, (e, b) => (e ? rej(e) : res(b)))));',
        'const v3Stream = await runStream(storage, { uri: `/b?userProject=${OTHER}` });',
        'const v4GetBuckets = await codeOf(storage.getBuckets(new BucketQueryOpts(OTHER)));',
        'const v4GetFiles = await codeOf(bucket.getFiles(new UserProjOpts(OTHER)));',
        'const v4Qs = await codeOf(new Promise((res, rej) => storage.request({ uri: "/b", qs: new BucketQueryOpts(OTHER) }, (e, b) => (e ? rej(e) : res(b)))));',
        'const vInterceptor = await runStream(storage, {',
        '  uri: "/b",',
        '  interceptors_: [{ request(reqOpts) { return { ...reqOpts, uri: `${ORIGIN}/storage/v1/b/${OTHER}.appspot.com/o` }; } }],',
        '});',
        'process.stdout.write("RESULT " + JSON.stringify({',
        '  hostFiles, v1StorageStream, v1BucketStream, v2AuthReq, v2Request, v2Stream,',
        '  v3AuthReq, v3Request, v3Stream, v4GetBuckets, v4GetFiles, v4Qs, vInterceptor,',
        '}) + "\\n");',
      ].join('\n'),
    );

    const run = await runProbe(scriptPath);
    expect(run.status, run.stderr).toBe(0);
    const result = parseResult<Record<string, string>>(run.stdout);
    expect(result.hostFiles).toBe('OK');
    expect(result.v1StorageStream).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v1BucketStream).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v2AuthReq).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v2Request).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v2Stream).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v3AuthReq).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v3Request).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v3Stream).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v4GetBuckets).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v4GetFiles).toBe('PYRIC_LIVE_REFUSED');
    expect(result.v4Qs).toBe('PYRIC_LIVE_REFUSED');
    expect(result.vInterceptor).toBe('PYRIC_LIVE_REFUSED');

    const foreignHits = hits.filter((hit) => hit.url.includes(OTHER_PROJECT));
    expect(foreignHits).toEqual([]);
  }, 30_000);

  test('refuses file-path, unreadable, and malformed FIREBASE_CONFIG at root, child, and Worker startup', async () => {
    if (!adminRowsOn) return;

    const hostConfig = join(workDir, 'host-firebase-config.json');
    const otherConfig = join(workDir, 'other-firebase-config.json');
    const badJsonConfig = join(workDir, 'bad-firebase-config.json');
    const missingConfig = join(workDir, 'does-not-exist-config.json');

    writeFileSync(hostConfig, JSON.stringify({ projectId: HOST_PROJECT }));
    writeFileSync(otherConfig, JSON.stringify({ projectId: OTHER_PROJECT }));
    writeFileSync(badJsonConfig, '{ invalid json');

    const rootProbe = join(workDir, 'firebase-config-root.mjs');
    writeFileSync(
      rootProbe,
      [
        "import { initializeApp } from 'firebase-admin/app';",
        'const app = initializeApp();',
        'process.stdout.write("RESULT " + JSON.stringify({ projectId: app.options.projectId ?? null }) + "\\n");',
      ].join('\n'),
    );

    const hostRun = await runProbe(rootProbe, { FIREBASE_CONFIG: hostConfig });
    expect(hostRun.status, hostRun.stderr).toBe(0);
    expect(parseResult<{ projectId: string }>(hostRun.stdout).projectId).toBe(HOST_PROJECT);

    for (const badConfig of [otherConfig, badJsonConfig, missingConfig]) {
      const refusedRun = await runProbe(rootProbe, { FIREBASE_CONFIG: badConfig });
      expect(refusedRun.status).not.toBe(0);
      expect(refusedRun.stderr).toContain('PYRIC_LIVE_REFUSED');
    }

    // Child process and Worker thread spawned from a valid live root with file-path FIREBASE_CONFIG.
    const nestedProbe = join(workDir, 'firebase-config-nested.mjs');
    writeFileSync(
      nestedProbe,
      [
        "import { spawnSync } from 'node:child_process';",
        "import { Worker } from 'node:worker_threads';",
        `const rootProbe = ${JSON.stringify(rootProbe)};`,
        `const otherConfig = ${JSON.stringify(otherConfig)};`,
        `const missingConfig = ${JSON.stringify(missingConfig)};`,
        'function spawnChild(cfg) {',
        '  const res = spawnSync(process.execPath, [rootProbe], {',
        '    env: { ...process.env, FIREBASE_CONFIG: cfg },',
        "    encoding: 'utf8',",
        '  });',
        '  return { status: res.status, refused: res.stderr.includes("PYRIC_LIVE_REFUSED") };',
        '}',
        'function runWorker(src, opts) {',
        '  return new Promise((resolve) => {',
        '    const w = new Worker(src, opts);',
        '    w.once("message", () => resolve({ refused: false }));',
        '    w.once("error", (err) => resolve({ refused: err?.code === "PYRIC_LIVE_REFUSED" || String(err).includes("PYRIC_LIVE_REFUSED") }));',
        '  });',
        '}',
        'const childOther = spawnChild(otherConfig);',
        'const childMissing = spawnChild(missingConfig);',
        'const fileWorkerOther = await runWorker(new URL(`file://${rootProbe}`), {',
        '  env: { ...process.env, FIREBASE_CONFIG: otherConfig },',
        '});',
        'const evalWorkerOther = await runWorker("require(\'node:worker_threads\').parentPort.postMessage(true);", {',
        '  eval: true,',
        '  env: { ...process.env, FIREBASE_CONFIG: otherConfig },',
        '});',
        'process.stdout.write("RESULT " + JSON.stringify({ childOther, childMissing, fileWorkerOther, evalWorkerOther }) + "\\n");',
      ].join('\n'),
    );

    const nestedRun = await runProbe(nestedProbe, { FIREBASE_CONFIG: hostConfig });
    expect(nestedRun.status, nestedRun.stderr).toBe(0);
    const nested = parseResult<{
      childOther: { status: number | null; refused: boolean };
      childMissing: { status: number | null; refused: boolean };
      fileWorkerOther: { refused: boolean };
      evalWorkerOther: { refused: boolean };
    }>(nestedRun.stdout);

    expect(nested.childOther.status).not.toBe(0);
    expect(nested.childOther.refused).toBe(true);
    expect(nested.childMissing.status).not.toBe(0);
    expect(nested.childMissing.refused).toBe(true);
    expect(nested.fileWorkerOther.refused).toBe(true);
    expect(nested.evalWorkerOther.refused).toBe(true);
  }, 30_000);
});
