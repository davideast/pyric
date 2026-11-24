/**
 * Regression suite for #2445: `@pyric/live/register` running an instrumented
 * Node backend with `firebase-admin` (ADR 0022 Amendment 2026-11-07, ADR 0023):
 *
 * 1. HTTP instrumentation (`https.request` wrappers via assignment and
 *    `Object.defineProperty`, plus stacked `import-in-the-middle` `?iitm=true`
 *    and `require-in-the-middle` hooks in both `--import` orders) permits
 *    `firebase-admin` OAuth2 (`oauth2.googleapis.com`), `cert()`
 *    (`www.googleapis.com/oauth2/v4/token`), and metadata (`169.254.169.254`)
 *    credential fetches without `PYRIC_GUARD_BLOCKED` or `PYRIC_REAL_SDK_STOPPED`.
 * 2. `firebase-admin/app-check` (`gatedAdmin`), `firebase-admin/messaging`
 *    (`Messaging.send` with zero token/topic leakage), and unserved
 *    `firebase-admin/*` subpaths (`unobservedAdmin` on process health and bridge)
 *    load and run without `PYRIC_LIVE_REFUSED`, while cross-project Admin calls
 *    still fail closed with `PYRIC_LIVE_REFUSED`.
 * 3. `getDatabaseWithUrl` permits sharded / non-default RTDB instances declared
 *    in `firebase.json` (`database[].instance` and `.firebaserc` `database[].target`)
 *    while refusing undeclared `<project>-*` instances before opening any socket.
 * 4. Server-side Google Cloud APIs (`firebaseappcheck.googleapis.com`,
 *    `cloudtrace.googleapis.com`, `aiplatform.googleapis.com`) pass unimpeded
 *    without `PYRIC_GUARD_BLOCKED`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { DEFAULT_SANDBOX_PATH, WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { createSilentLogger } from '../../src/bridge/server/logger.js';
import { attachPeer } from '../../src/bridge/server/peer.js';

const cliDir = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliDir, '../..');
const liveDir = join(repoRoot, 'packages/live');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));
const realAdminDir = realpathSync(join(repoRoot, 'node_modules/firebase-admin'));
const requireFromAdmin = createRequire(join(realAdminDir, 'package.json'));
const nodeMajor = Number(spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.split('.')[0]);
const adminRowsOn = nodeMajor >= 23;

function packageDir(fromFile: string, name: string): string {
  let dir = dirname(fromFile);
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name === name) return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(`no ${name} above ${fromFile}`);
}

const RITM_STANDIN = [
  "'use strict';",
  "const Module = require('node:module');",
  'function Hook(onrequire) {',
  '  if (!(this instanceof Hook)) return new Hook(onrequire);',
  '  const orig = Module.prototype.require;',
  '  Module.prototype.require = function wrappedRequire(id) {',
  '    const exports = orig.apply(this, arguments);',
  '    if (typeof onrequire === "function") return onrequire(exports, String(id));',
  '    return exports;',
  '  };',
  '}',
  'module.exports = Hook;',
  'module.exports.Hook = Hook;',
].join('\n');

const IITM_STANDIN = [
  'const INCLUDED = /^(?:.*\\/)?node_modules\\/(?:@firebase\\/[^/]+|firebase|firebase-admin)\\//;',
  'export async function resolve(specifier, context, nextResolve) {',
  '  if (specifier.includes("?iitm=true")) return { url: specifier, format: "module", shortCircuit: true };',
  '  if (specifier.includes("?iitm=ignore")) return { url: specifier.replace("?iitm=ignore", ""), format: "module", shortCircuit: true };',
  '  let parentURL = context.parentURL;',
  '  if (typeof parentURL === "string" && parentURL.includes("?iitm=true")) parentURL = parentURL.replace("?iitm=true", "");',
  '  const result = await nextResolve(specifier, { ...context, parentURL });',
  '  if (result.url.startsWith("file://") && INCLUDED.test(result.url) && result.format === "module") {',
  '    return { url: result.url + "?iitm=true", format: "module", shortCircuit: true };',
  '  }',
  '  return result;',
  '}',
  'export async function load(url, context, nextLoad) {',
  '  if (!url.includes("?iitm=true")) return nextLoad(url, context);',
  '  const target = JSON.stringify(url.replace("?iitm=true", "") + "?iitm=ignore");',
  '  const src = "import * as ns from " + target + ";\\nexport * from " + target + ";\\nexport default ns.default;\\n";',
  '  return { format: "module", source: src, shortCircuit: true };',
  '}',
].join('\n');

const PROJECT = 'demo-2445-backend';
const INSTANCE_ID = 'demo-2445-instance';
const SECRET_TOPIC = 'orders-private-topic';

interface ObservedFrame {
  readonly service: string;
  readonly method: string;
  readonly sdk?: string;
  readonly raw: string;
}

interface UnobservedFrame {
  readonly unobservedAdmin?: string[];
  readonly gatedAdmin?: string[];
}

let projectDir = '';
let standInServer: Server | undefined;
let standInPort = 0;
let closedTrapPort = 0;
let wsServer: WebSocketServer | undefined;
let bridgeHttpUrl = '';
let answeredPaths: string[] = [];
let observedFrames: ObservedFrame[] = [];
let unobservedFrames: UnobservedFrame[] = [];

async function allocateClosedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
  const addr = probe.address();
  if (addr === null || typeof addr === 'string') throw new Error('expected TCP port');
  const { port } = addr;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

function answerStandIn(pathname: string): { code: number; body: unknown } {
  if (pathname === '/__pyric/health') {
    return {
      code: 200,
      body: {
        status: 'ok',
        mode: 'sandbox',
        instanceId: INSTANCE_ID,
        live: {
          projectId: PROJECT,
          configProjectId: PROJECT,
          configSource: '.firebaserc',
          appProjectIds: [PROJECT],
          billed: { reads: 0, writes: 0, deliveries: 0 },
          admin: { mode: 'observed', observed: true, bypassesRules: true },
        },
      },
    };
  }
  if (pathname === '/__pyric/init.json') {
    return {
      code: 200,
      body: {
        instanceId: INSTANCE_ID,
        sessionToken: 'test-session',
        hosted: true,
        projectKey: PROJECT,
        bridgeUrl: `ws://127.0.0.1:${standInPort}${DEFAULT_SANDBOX_PATH}`,
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        seed: null,
      },
    };
  }
  if (pathname.endsWith('/token') || pathname.startsWith('/computeMetadata/v1/')) {
    return { code: 200, body: { access_token: 'standin-oauth-token', expires_in: 3600, token_type: 'Bearer' } };
  }
  if (pathname === `/v1/projects/${PROJECT}/accounts:lookup`) {
    return { code: 200, body: { users: [{ localId: 'uid-1' }] } };
  }
  if (pathname === `/v1/projects/${PROJECT}/messages:send`) {
    return { code: 200, body: { name: `projects/${PROJECT}/messages/msg-1` } };
  }
  return { code: 404, body: { error: { code: 404, message: 'NOT_FOUND' } } };
}

beforeAll(async () => {
  for (const built of [join(liveDir, 'dist/register.js'), join(cliDir, 'dist/register/supplied-entry.js')]) {
    if (!existsSync(built)) throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
  }
  closedTrapPort = await allocateClosedPort();

  standInServer = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      answeredPaths.push(pathname);
      const reply = answerStandIn(pathname);
      res.writeHead(reply.code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((done) => {
    if (standInServer === undefined) throw new Error('missing standInServer');
    standInServer.listen(0, '127.0.0.1', () => done());
  });
  const addr = standInServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('expected standInServer TCP port');
  standInPort = addr.port;
  bridgeHttpUrl = `http://127.0.0.1:${standInPort}`;

  const bridge = createBridge({ version: 'test', projectKey: PROJECT, logger: createSilentLogger() });
  bridge.registerSandboxPeer(
    (message: BridgeMessage) => {
      if (message.type !== 'worker-message') return;
      const inner = message.message as unknown as {
        t?: string;
        call?: { service: string; method: string; sdk?: string };
        unobservedAdmin?: string[];
        gatedAdmin?: string[];
      };
      if (inner.t === 'observe' && inner.call !== undefined) {
        observedFrames.push({
          service: inner.call.service,
          method: inner.call.method,
          sdk: inner.call.sdk,
          raw: JSON.stringify(inner.call),
        });
      }
      if (inner.t === 'unobserved') {
        const frame: { unobservedAdmin?: string[]; gatedAdmin?: string[] } = {};
        if (inner.unobservedAdmin !== undefined) frame.unobservedAdmin = inner.unobservedAdmin;
        if (inner.gatedAdmin !== undefined) frame.gatedAdmin = inner.gatedAdmin;
        unobservedFrames.push(frame);
      }
    },
    [],
    'host',
    [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY],
  );

  wsServer = new WebSocketServer({ noServer: true });
  standInServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === DEFAULT_SANDBOX_PATH && wsServer !== undefined) {
      wsServer.handleUpgrade(req, socket, head, (ws) => wsServer?.emit('connection', ws, req));
      return;
    }
    socket.destroy();
  });
  wsServer.on('connection', (socket) => {
    attachPeer(bridge, socket);
    socket.on('message', (raw) => {
      const text = String(raw);
      if (!text.startsWith('{')) return;
      try {
        const parsed = JSON.parse(text) as { type?: string; message?: { t?: string; id?: string } };
        const msgType = parsed.message?.t;
        const msgId = parsed.message?.id;
        const needsAck = parsed.type === 'worker-message' && (msgType === 'observe' || msgType === 'unobserved');
        if (needsAck && typeof msgId === 'string') {
          socket.send(JSON.stringify({ type: 'worker-message', message: { t: 'res', id: msgId, ok: true, value: null } }));
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    });
  });

  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-2445-backend-')));
  const nm = join(projectDir, 'node_modules');
  for (const sub of ['@pyric', '@google-cloud', '@firebase', 'require-in-the-middle', 'import-in-the-middle/lib']) {
    mkdirSync(join(nm, sub), { recursive: true });
  }
  symlinkSync(cliDir, join(nm, '@pyric/cli'));
  symlinkSync(liveDir, join(nm, '@pyric/live'));
  symlinkSync(realFirebaseDir, join(nm, 'firebase'));
  symlinkSync(realAdminDir, join(nm, 'firebase-admin'));
  symlinkSync(packageDir(requireFromAdmin.resolve('@google-cloud/firestore'), '@google-cloud/firestore'), join(nm, '@google-cloud/firestore'));
  symlinkSync(packageDir(requireFromAdmin.resolve('@google-cloud/storage'), '@google-cloud/storage'), join(nm, '@google-cloud/storage'));
  symlinkSync(packageDir(requireFromAdmin.resolve('@firebase/database-compat/standalone'), '@firebase/database-compat'), join(nm, '@firebase/database-compat'));

  writeFileSync(join(nm, 'require-in-the-middle/package.json'), JSON.stringify({ name: 'require-in-the-middle', version: '0.0.0-test', main: 'index.js' }));
  writeFileSync(join(nm, 'require-in-the-middle/index.js'), RITM_STANDIN);
  writeFileSync(join(nm, 'import-in-the-middle/package.json'), JSON.stringify({ name: 'import-in-the-middle', version: '0.0.0-test', type: 'module' }));
  writeFileSync(join(nm, 'import-in-the-middle/lib/register.js'), IITM_STANDIN);
  writeFileSync(join(projectDir, 'ritm-hook.mjs'), "import Hook from 'require-in-the-middle';\nnew Hook((exports) => exports);\n");
  writeFileSync(join(projectDir, 'iitm-hook.mjs'), "import Module from 'node:module';\nModule.register('import-in-the-middle/lib/register.js', import.meta.url);\n");
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'backend-2445', type: 'module' }));
  writeFileSync(
    join(projectDir, '.firebaserc'),
    JSON.stringify({ projects: { default: PROJECT }, targets: { [PROJECT]: { database: { regional: [`${PROJECT}-eu`] } } } }),
  );
  writeFileSync(
    join(projectDir, 'firebase.json'),
    JSON.stringify({ database: [{ instance: `${PROJECT}-shard-01`, rules: 'a.json' }, { target: 'regional', rules: 'b.json' }] }),
  );
});

afterAll(async () => {
  wsServer?.close();
  if (standInServer !== undefined) await new Promise<void>((done) => standInServer?.close(() => done()));
  if (projectDir !== '') rmSync(projectDir, { recursive: true, force: true });
});

const BACKEND_PROBE = [
  "import { generateKeyPairSync } from 'node:crypto';",
  "import dns from 'node:dns';",
  "import { writeFileSync } from 'node:fs';",
  "import http, { createServer } from 'node:http';",
  "import https from 'node:https';",
  "import net from 'node:net';",
  "import tls from 'node:tls';",
  "import { join } from 'node:path';",
  'const PROJECT = process.env.TEST_PROJECT;',
  'const STANDIN_PORT = Number(process.env.STANDIN_PORT);',
  'const CLOSED_PORT = Number(process.env.CLOSED_PORT);',
  'const WRAP_MODE = process.env.WRAP_MODE;',
  'const SECRET_TOPIC = process.env.SECRET_TOPIC;',
  'const trappedHosts = [];',
  'dns.lookup = function lookupTrap(_host, options, callback) {',
  '  const done = typeof options === "function" ? options : callback;',
  '  const all = typeof options === "object" && options !== null && options.all === true;',
  '  if (all) process.nextTick(done, null, [{ address: "127.0.0.1", family: 4 }]);',
  '  else process.nextTick(done, null, "127.0.0.1", 4);',
  '};',
  'const realTlsConnect = tls.connect;',
  'tls.connect = function trappedTlsConnect(...args) {',
  '  const first = args[0];',
  '  if (typeof first === "object" && first !== null) {',
  '    trappedHosts.push(String(first.servername ?? first.host ?? ""));',
  '    args[0] = { ...first, host: "127.0.0.1", port: CLOSED_PORT };',
  '  } else {',
  '    const opts = typeof args[2] === "object" && args[2] !== null ? args[2] : {};',
  '    trappedHosts.push(String(opts.servername ?? args[1] ?? ""));',
  '    args[0] = CLOSED_PORT;',
  '    args[1] = "127.0.0.1";',
  '  }',
  '  return realTlsConnect.apply(this, args);',
  '};',
  'let wrappedHttpsCount = 0;',
  'const origHttpsRequest = https.request;',
  'function instrumentedHttpsRequest(...args) { wrappedHttpsCount += 1; return origHttpsRequest.apply(this, args); }',
  'if (WRAP_MODE === "define") Object.defineProperty(https, "request", { configurable: true, writable: true, value: instrumentedHttpsRequest });',
  'else https.request = instrumentedHttpsRequest;',
  'class StandInAgent extends https.Agent { createConnection() { return net.connect({ host: "127.0.0.1", port: STANDIN_PORT }); } }',
  'const agent = new StandInAgent({ keepAlive: false });',
  'const adcPath = join(process.cwd(), "adc.json");',
  'writeFileSync(adcPath, JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "csec", refresh_token: "cref" }));',
  'process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;',
  'const codeOf = (e) => e?.cause?.code ?? e?.code ?? String(e?.message ?? e);',
  "const { initializeApp, applicationDefault, cert } = await import('firebase-admin/app');",
  "const { getAuth } = await import('firebase-admin/auth');",
  "const { getDatabaseWithUrl } = await import('firebase-admin/database');",
  "const { getAppCheck } = await import('firebase-admin/app-check');",
  "const { getMessaging } = await import('firebase-admin/messaging');",
  "await import('firebase-admin/remote-config');",
  "await import('firebase-admin/functions');",
  'const adcApp = initializeApp({ projectId: PROJECT, credential: applicationDefault(agent), httpAgent: agent }, "adc-" + WRAP_MODE);',
  'const adcUid = await getAuth(adcApp).getUser("uid-1").then((u) => u.uid, codeOf);',
  'const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });',
  'const certCred = cert({ projectId: PROJECT, clientEmail: "svc@" + PROJECT + ".iam.gserviceaccount.com", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }, agent);',
  'const certApp = initializeApp({ projectId: PROJECT, credential: certCred, httpAgent: agent }, "cert-" + WRAP_MODE);',
  'const certOutcome = await getAuth(certApp).getUser("uid-1").then((u) => u.uid, codeOf);',
  'const metadataOutcome = await new Promise((resolveMeta) => {',
  '  const req = http.request({ host: "127.0.0.1", port: STANDIN_PORT, path: "/computeMetadata/v1/instance/service-accounts/default/token", headers: { host: "169.254.169.254", "Metadata-Flavor": "Google" } }, (res) => {',
  '    res.resume();',
  '    if (res.statusCode === 200) {',
  '      resolveMeta("ok");',
  '    } else {',
  '      resolveMeta("status-" + String(res.statusCode));',
  '    }',
  '  });',
  '  req.on("error", (err) => resolveMeta(codeOf(err)));',
  '  req.end();',
  '});',
  'const messaging = getMessaging(adcApp);',
  'messaging.enableLegacyHttpTransport();',
  'const messagingSend = await messaging.send({ topic: SECRET_TOPIC, data: { item: "1" } }).then(() => "ok", codeOf);',
  'const otherApp = initializeApp({ projectId: "other-project", credential: applicationDefault(agent), httpAgent: agent }, "other-" + WRAP_MODE);',
  'const otherMessaging = getMessaging(otherApp);',
  'otherMessaging.enableLegacyHttpTransport();',
  'const otherMessagingCode = await otherMessaging.send({ topic: SECRET_TOPIC }).then(() => "ok", codeOf);',
  'const otherAppCheckVerify = await getAppCheck(otherApp).verifyToken("bad-token").then(() => "ok", codeOf);',
  'const otherAppCheckCreate = await getAppCheck(otherApp).createToken("1:1:web:1").then(() => "ok", codeOf);',
  'const ownAppCheckVerify = await getAppCheck(adcApp).verifyToken("bad-token").then(() => "ok", codeOf);',
  'function checkRtdbUrl(url) {',
  '  try { const db = getDatabaseWithUrl(url, adcApp); db.ref("items/probe"); db.goOffline(); return "ok"; }',
  '  catch (err) {',
  '    const code = codeOf(err);',
  '    if (String(err?.message ?? "").includes("firebase.json")) {',
  '      return code + ":firebase.json";',
  '    }',
  '    return code;',
  '  }',
  '}',
  'const rtdb = {',
  '  shard01: checkRtdbUrl("https://" + PROJECT + "-shard-01.firebaseio.com"),',
  '  regionalTarget: checkRtdbUrl("https://" + PROJECT + "-eu.europe-west1.firebasedatabase.app"),',
  '  shard02: checkRtdbUrl("https://" + PROJECT + "-shard-02.firebaseio.com"),',
  '  prodSibling: checkRtdbUrl("https://" + PROJECT + "-prod-default-rtdb.firebaseio.com"),',
  '};',
  'const googleApis = {};',
  'for (const url of ["https://www.googleapis.com/oauth2/v4/token", "https://firebaseappcheck.googleapis.com/v1/jwks", "https://cloudtrace.googleapis.com/v1/projects/" + PROJECT + "/traces", "https://aiplatform.googleapis.com/"]) {',
  '  googleApis[url] = await fetch(url).then(() => "200", codeOf);',
  '}',
  'const healthServer = createServer((_req, res) => res.end("app"));',
  'await new Promise((r) => healthServer.listen(0, "127.0.0.1", r));',
  'const healthBody = await new Promise((resolveBody, rejectBody) => {',
  '  const req = http.get({ host: "127.0.0.1", port: healthServer.address().port, path: "/__pyric/health", headers: { "x-pyric-process-health": "1" } }, (res) => {',
  '    let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolveBody(text));',
  '  });',
  '  req.on("error", rejectBody);',
  '});',
  'healthServer.close();',
  'await new Promise((r) => setTimeout(r, 150));',
  'console.log("PROBE_2445 " + JSON.stringify({ adcUid, certOutcome, metadataOutcome, wrappedHttpsCount, messagingSend, otherMessagingCode, otherAppCheckVerify, otherAppCheckCreate, ownAppCheckVerify, rtdb, googleApis, trappedHosts: [...new Set(trappedHosts)].sort(), processHealth: JSON.parse(healthBody).pyricProcess }));',
  'process.exit(0);',
].join('\n');

async function runProbe(imports: readonly string[], wrapMode: 'assign' | 'define') {
  answeredPaths = [];
  observedFrames = [];
  unobservedFrames = [];
  const scriptFile = join(projectDir, `probe-${wrapMode}.mjs`);
  writeFileSync(scriptFile, BACKEND_PROBE);
  const child = spawn('node', [...imports.flatMap((entry) => ['--import', entry]), scriptFile], {
    cwd: projectDir,
    env: {
      PATH: process.env.PATH,
      HOME: projectDir,
      CLOUDSDK_CONFIG: projectDir,
      PYRIC_SANDBOX: `remote:${bridgeHttpUrl}`,
      PYRIC_SANDBOX_INSTANCE: INSTANCE_ID,
      TEST_PROJECT: PROJECT,
      STANDIN_PORT: String(standInPort),
      CLOSED_PORT: String(closedTrapPort),
      WRAP_MODE: wrapMode,
      SECRET_TOPIC,
    },
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
  const status = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`probe timed out:\nstdout=${stdout}\nstderr=${stderr}`));
    }, 45_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectExit(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  const line = stdout.split('\n').find((entry) => entry.startsWith('PROBE_2445 '));
  if (line === undefined) {
    throw new Error(`missing PROBE_2445 output (status=${String(status)}):\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return {
    status,
    stderr,
    result: JSON.parse(line.slice('PROBE_2445 '.length)) as Record<string, unknown>,
    answered: [...answeredPaths],
    observed: [...observedFrames],
    unobserved: [...unobservedFrames],
  };
}

describe('#2445 instrumented Node backend under @pyric/live/register', () => {
  it.skipIf(!adminRowsOn)(
    'permits OAuth2/cert/metadata credentials, App Check & Messaging rows, configured sharded RTDB URLs, and Google Cloud APIs across stacked iitm + ritm + https.request wrappers',
    async () => {
      const iitmUrl = pathToFileURL(join(projectDir, 'iitm-hook.mjs')).href;
      const ritmUrl = pathToFileURL(join(projectDir, 'ritm-hook.mjs')).href;
      const runs: Array<readonly [readonly string[], 'assign' | 'define']> = [
        [[iitmUrl, ritmUrl, '@pyric/live/register'], 'assign'],
        [['@pyric/live/register', iitmUrl, ritmUrl], 'define'],
      ];

      for (const [imports, wrapMode] of runs) {
        const run = await runProbe(imports, wrapMode);
        expect(run.status, run.stderr).toBe(0);
        expect(run.stderr).not.toContain('PYRIC_GUARD_BLOCKED');
        expect(run.stderr).not.toContain('PYRIC_REAL_SDK_STOPPED');
        expect(run.stderr).toContain('@pyric/live/register: firebase-admin/remote-config loads unobserved.');
        expect(run.stderr).toContain('@pyric/live/register: firebase-admin/functions loads unobserved.');

        expect(run.result.adcUid).toBe('uid-1');
        expect(run.result.certOutcome).not.toBe('PYRIC_GUARD_BLOCKED');
        expect(run.result.metadataOutcome).toBe('ok');
        expect(Number(run.result.wrappedHttpsCount)).toBeGreaterThan(0);
        expect(run.answered.some((p) => p.endsWith('/token'))).toBe(true);

        expect(run.result.messagingSend).toBe('ok');
        expect(run.result.otherMessagingCode).toBe('PYRIC_LIVE_REFUSED');
        expect(run.result.otherAppCheckVerify).toBe('PYRIC_LIVE_REFUSED');
        expect(run.result.otherAppCheckCreate).toBe('PYRIC_LIVE_REFUSED');
        expect(run.result.ownAppCheckVerify).toBe('app-check/invalid-argument');

        expect(run.result.rtdb).toEqual({
          shard01: 'ok',
          regionalTarget: 'ok',
          shard02: 'PYRIC_LIVE_REFUSED:firebase.json',
          prodSibling: 'PYRIC_LIVE_REFUSED:firebase.json',
        });

        for (const code of Object.values(run.result.googleApis as Record<string, string>)) {
          expect(code).toBe('ECONNREFUSED');
        }
        const trapped = run.result.trappedHosts as string[];
        for (const host of ['oauth2.googleapis.com', 'www.googleapis.com', 'firebaseappcheck.googleapis.com', 'cloudtrace.googleapis.com', 'aiplatform.googleapis.com']) {
          expect(trapped).toContain(host);
        }
        for (const refusedHost of [`${PROJECT}-shard-02.firebaseio.com`, `${PROJECT}-prod-default-rtdb.firebaseio.com`]) {
          expect(trapped).not.toContain(refusedHost);
        }

        expect(run.result.processHealth).toEqual({
          mode: 'live',
          projectId: PROJECT,
          unobservedAdmin: ['firebase-admin/remote-config', 'firebase-admin/functions'],
          gatedAdmin: ['firebase-admin/app-check'],
        });

        const methods = run.observed.map((frame) => `${frame.service}:${frame.method}:${frame.sdk ?? ''}`);
        expect(methods).toContain('auth:Auth.getUser:admin');
        expect(methods).toContain('messaging:Messaging.send:admin');
        for (const frame of run.observed) {
          expect(frame.raw).not.toContain(SECRET_TOPIC);
          expect(frame.raw).not.toContain('standin-oauth-token');
        }
        expect(run.unobserved.at(-1)).toEqual({
          unobservedAdmin: ['firebase-admin/remote-config', 'firebase-admin/functions'],
          gatedAdmin: ['firebase-admin/app-check'],
        });
      }
    },
    90_000,
  );
});
