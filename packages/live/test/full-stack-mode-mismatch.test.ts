/**
 * Regression suite for #2304: full-stack live-mode Admin SDK observation and
 * bidirectional frontend/backend mode-mismatch detection:
 *
 * 1. Live-side `observeAdminAuth` (run in an isolated Node module graph so
 *    shared `bun test` CJS caches stay untouched) refuses sandbox-issued ID
 *    tokens (`kid: 'pyric-sandbox'`) on both `BaseAuth` and `TenantAwareAuth`
 *    (`verifyIdToken` and `verifySessionCookie`) with
 *    `{ code: 'auth/argument-error', pyricCode: 'PYRIC_MODE_MISMATCH' }`,
 *    making zero HTTP requests and zero observed call records.
 * 2. Sandbox-side `@pyric/cli/register` (`firebase-admin/auth`) refuses
 *    production-issued Google RS256 ID tokens with `pyricCode: 'PYRIC_MODE_MISMATCH'`.
 * 3. Full-stack Vite `pyricLive()` host paired via `server.proxy` with loopback
 *    HTTP backends classifies `same` (live backend on the same project started
 *    after the host and discovered on the first proxied request), `other-mode`
 *    (sandbox backend under `@pyric/cli/register`), `other-project` (live backend
 *    on another project), and `not-pyric` (plain unregistered HTTP server), while
 *    observing the live backend's `firebase-admin` calls and listing its
 *    `unobservedAdmin` and `gatedAdmin` coverage on `/__pyric/health`.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const liveDir = resolve(import.meta.dir, '..');
const repoRoot = resolve(liveDir, '../..');
const cliDir = join(repoRoot, 'packages/cli');
const nodeMajor = Number(spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.split('.')[0]);
const adminRowsOn = nodeMajor >= 23;

function jwtSegment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sandboxIssuedToken(projectId: string, uid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = jwtSegment({ alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' });
  const payload = jwtSegment({
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    auth_time: now,
    user_id: uid,
    sub: uid,
    iat: now,
    exp: now + 3600,
  });
  return `${header}.${payload}.c2lnbmF0dXJl`;
}

function productionIssuedToken(projectId: string, uid: string): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(20).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const header = jwtSegment({ alg: 'RS256', kid, typ: 'JWT' });
  const payload = jwtSegment({
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    auth_time: now,
    user_id: uid,
    sub: uid,
    iat: now,
    exp: now + 3600,
    firebase: { identities: {}, sign_in_provider: 'password' },
  });
  const input = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}

interface MismatchErrorShape {
  code?: unknown;
  pyricCode?: unknown;
  message?: unknown;
}

describe('#2304 bidirectional ID-token mode-mismatch guards', () => {
  const PROJECT = 'demo-2304-tokens';

  test('live BaseAuth and TenantAwareAuth refuse sandbox-issued tokens on verifyIdToken and verifySessionCookie with zero requests or records', () => {
    for (const built of [join(liveDir, 'dist/admin/auth.js'), join(liveDir, 'dist/admin/project-gate.js')]) {
      if (!existsSync(built)) throw new Error(`${built} missing: build packages first`);
    }
    const adminAuthUrl = pathToFileURL(join(liveDir, 'dist/admin/auth.js')).href;
    const gateUrl = pathToFileURL(join(liveDir, 'dist/admin/project-gate.js')).href;
    const token = sandboxIssuedToken(PROJECT, 'user-1');
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-2304-live-token-')));
    try {
      mkdirSync(join(workDir, 'node_modules'), { recursive: true });
      symlinkSync(realpathSync(join(repoRoot, 'node_modules/firebase-admin')), join(workDir, 'node_modules/firebase-admin'));
      writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'live-token-check', type: 'module' }));
      const probe = join(workDir, 'check-live.mjs');
      writeFileSync(
        probe,
        [
          "import { createServer } from 'node:http';",
          "import { createRequire } from 'node:module';",
          `const { observeAdminAuth } = await import(${JSON.stringify(adminAuthUrl)});`,
          `const { adminProjectGate } = await import(${JSON.stringify(gateUrl)});`,
          'let hits = 0;',
          'const recorded = [];',
          'const srv = createServer((req, res) => { hits += 1; req.resume(); res.writeHead(404).end("{}"); });',
          'await new Promise((r) => srv.listen(0, "127.0.0.1", r));',
          'process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:" + String(srv.address().port);',
          'const req = createRequire(import.meta.url);',
          'const authEntry = req.resolve("firebase-admin/auth");',
          'const baseAuthModule = createRequire(authEntry)("./base-auth");',
          `observeAdminAuth(baseAuthModule, { observer: (rec) => recorded.push(rec), gate: adminProjectGate(${JSON.stringify(PROJECT)}, () => undefined, {}), hostProjectId: ${JSON.stringify(PROJECT)} }, authEntry);`,
          'const { initializeApp } = req("firebase-admin/app");',
          'const { getAuth } = req("firebase-admin/auth");',
          `const auth = getAuth(initializeApp({ projectId: ${JSON.stringify(PROJECT)} }, "live-tenant-mismatch"));`,
          'const tenantAuth = auth.tenantManager().authForTenant("tenant-alpha");',
          'async function catchOne(p) {',
          '  try { await p; return { ok: true }; }',
          '  catch (e) { return { code: e.code, pyricCode: e.pyricCode, message: e.message }; }',
          '}',
          `const tok = ${JSON.stringify(token)};`,
          'const results = [',
          '  await catchOne(auth.verifyIdToken(tok)),',
          '  await catchOne(auth.verifySessionCookie(tok)),',
          '  await catchOne(tenantAuth.verifyIdToken(tok)),',
          '  await catchOne(tenantAuth.verifySessionCookie(tok)),',
          '];',
          'srv.close();',
          'console.log("LIVE_TOK_OUT " + JSON.stringify({ results, hits, records: recorded.length }));',
          'process.exit(0);',
        ].join('\n'),
      );
      const run = spawnSync('node', [probe], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: workDir },
      });
      expect(run.status, run.stderr).toBe(0);
      const outLine = run.stdout.split('\n').find((line) => line.startsWith('LIVE_TOK_OUT '));
      if (outLine === undefined) throw new Error(`missing LIVE_TOK_OUT: ${run.stdout}\n${run.stderr}`);
      const parsed = JSON.parse(outLine.slice('LIVE_TOK_OUT '.length)) as {
        results: MismatchErrorShape[];
        hits: number;
        records: number;
      };
      expect(parsed.results).toHaveLength(4);
      for (const entry of parsed.results) {
        expect({ code: entry.code, pyricCode: entry.pyricCode }).toEqual({
          code: 'auth/argument-error',
          pyricCode: 'PYRIC_MODE_MISMATCH',
        });
        expect(String(entry.message)).toContain(`live mode for ${PROJECT}`);
      }
      expect(parsed.hits).toBe(0);
      expect(parsed.records).toBe(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('sandbox @pyric/cli/register backend refuses a production-issued ID token with PYRIC_MODE_MISMATCH', () => {
    const cliRegister = pathToFileURL(join(cliDir, 'dist/register/index.js')).href;
    const prodToken = productionIssuedToken(PROJECT, 'prod-user-1');
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-2304-sbx-token-')));
    try {
      mkdirSync(join(workDir, 'node_modules/@pyric'), { recursive: true });
      symlinkSync(cliDir, join(workDir, 'node_modules/@pyric/cli'));
      symlinkSync(join(repoRoot, 'packages/pyric'), join(workDir, 'node_modules/pyric'));
      symlinkSync(realpathSync(join(repoRoot, 'node_modules/firebase-admin')), join(workDir, 'node_modules/firebase-admin'));
      writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'sbx-token-check', type: 'module' }));
      const probe = join(workDir, 'check.mjs');
      writeFileSync(
        probe,
        [
          "import { initializeSandbox } from 'pyric/sandbox';",
          "import { initializeApp } from 'firebase-admin/app';",
          "import { getAuth } from 'firebase-admin/auth';",
          `const app = initializeApp({ sandbox: initializeSandbox(), projectId: ${JSON.stringify(PROJECT)} });`,
          'try {',
          `  await getAuth(app).verifyIdToken(${JSON.stringify(prodToken)});`,
          "  console.log('SBX_OUT ' + JSON.stringify({ ok: true }));",
          '} catch (err) {',
          "  console.log('SBX_OUT ' + JSON.stringify({ code: err.code, pyricCode: err.pyricCode, message: err.message }));",
          '}',
          'process.exit(0);',
        ].join('\n'),
      );
      const run = spawnSync('node', ['--import', cliRegister, probe], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: workDir, PYRIC_SANDBOX: '1' },
      });
      expect(run.status, run.stderr).toBe(0);
      const outLine = run.stdout.split('\n').find((line) => line.startsWith('SBX_OUT '));
      if (outLine === undefined) throw new Error(`missing SBX_OUT: ${run.stdout}\n${run.stderr}`);
      const parsed = JSON.parse(outLine.slice('SBX_OUT '.length)) as MismatchErrorShape;
      expect({ code: parsed.code, pyricCode: parsed.pyricCode }).toEqual({
        code: 'auth/argument-error',
        pyricCode: 'PYRIC_MODE_MISMATCH',
      });
      expect(String(parsed.message)).toContain('sandbox');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('#2304 full-stack Vite pyricLive() host, observed Admin backend, and server.proxy mode-mismatch verdicts', () => {
  test.skipIf(!adminRowsOn)(
    'observes proxied firebase-admin backend calls, forwards unobservedAdmin/gatedAdmin health, and classifies same, other-mode, other-project, and not-pyric proxy targets',
    () => {
      for (const built of [join(liveDir, 'dist/vite.js'), join(liveDir, 'dist/register.js'), join(cliDir, 'dist/register/index.js')]) {
        if (!existsSync(built)) throw new Error(`${built} missing: build packages first`);
      }
      const liveRequire = createRequire(join(liveDir, 'package.json'));
      const cliRequire = createRequire(join(cliDir, 'package.json'));
      const viteDir = dirname(liveRequire.resolve('vite/package.json'));
      const viteEntryUrl = pathToFileURL(join(viteDir, 'dist/node/index.js')).href;
      const liveViteUrl = pathToFileURL(join(liveDir, 'dist/vite.js')).href;
      const firebaseDir = dirname(cliRequire.resolve('firebase/package.json'));
      const fbRequire = createRequire(join(firebaseDir, 'package.json'));
      const atFirebaseDir = dirname(dirname(fbRequire.resolve('@firebase/app/package.json')));
      const adminDir = realpathSync(join(repoRoot, 'node_modules/firebase-admin'));

      const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-2304-fullstack-')));
      const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-2304-otherproj-')));
      try {
        for (const [dir, proj] of [[root, 'demo-fullstack-2304'], [otherRoot, 'other-live-project']] as const) {
          mkdirSync(join(dir, 'node_modules/@pyric'), { recursive: true });
          symlinkSync(cliDir, join(dir, 'node_modules/@pyric/cli'));
          symlinkSync(liveDir, join(dir, 'node_modules/@pyric/live'));
          symlinkSync(firebaseDir, join(dir, 'node_modules/firebase'));
          symlinkSync(atFirebaseDir, join(dir, 'node_modules/@firebase'));
          symlinkSync(adminDir, join(dir, 'node_modules/firebase-admin'));
          writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: proj, type: 'module' }));
          writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: proj } }));
        }
        writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>fullstack</body></html>');

        writeFileSync(
          join(root, 'backend.mjs'),
          [
            "import { createServer } from 'node:http';",
            'const port = Number(process.env.BACKEND_PORT);',
            'const useAdmin = process.env.USE_ADMIN === "1";',
            'let auth = null;',
            'if (useAdmin) {',
            "  const { initializeApp } = await import('firebase-admin/app');",
            "  const { getAuth } = await import('firebase-admin/auth');",
            "  await import('firebase-admin/app-check');",
            "  await import('firebase-admin/remote-config');",
            '  const app = initializeApp({ projectId: process.env.BACKEND_PROJECT });',
            '  auth = getAuth(app);',
            '}',
            'const srv = createServer(async (req, res) => {',
            '  const chunks = [];',
            '  for await (const c of req) chunks.push(c);',
            '  if (auth !== null && req.method === "POST") {',
            '    const token = String(req.headers.authorization ?? "").replace(/^Bearer\\s+/i, "");',
            '    try {',
            '      const decoded = await auth.verifyIdToken(token);',
            '      res.writeHead(200, { "content-type": "application/json" });',
            '      res.end(JSON.stringify({ uid: decoded.uid }));',
            '    } catch (err) {',
            '      res.writeHead(401, { "content-type": "application/json" });',
            '      res.end(JSON.stringify({ code: err.code, pyricCode: err.pyricCode ?? null }));',
            '    }',
            '    return;',
            '  }',
            '  res.writeHead(200, { "content-type": "application/json" });',
            '  res.end(JSON.stringify({ ok: true }));',
            '});',
            'srv.listen(port, "127.0.0.1", () => console.log("READY " + String(port)));',
          ].join('\n'),
        );

        const sbxToken = sandboxIssuedToken('demo-fullstack-2304', 'uid-fullstack');
        const emuHeader = jwtSegment({ alg: 'none', typ: 'JWT' });
        const now = Math.floor(Date.now() / 1000);
        const emuClaims = jwtSegment({
          iss: 'https://securetoken.google.com/demo-fullstack-2304',
          aud: 'demo-fullstack-2304',
          auth_time: now,
          user_id: 'uid-fullstack',
          sub: 'uid-fullstack',
          iat: now,
          exp: now + 3600,
        });
        const emuToken = `${emuHeader}.${emuClaims}.`;

        const driverPath = join(root, 'drive-fullstack.mjs');
        writeFileSync(
          driverPath,
          [
            "import { spawn } from 'node:child_process';",
            "import { readFileSync } from 'node:fs';",
            "import { createServer as createHttpServer } from 'node:http';",
            "import { createServer as createNetServer } from 'node:net';",
            "import { join } from 'node:path';",
            `const { createServer: createViteServer } = await import(${JSON.stringify(viteEntryUrl)});`,
            `const { pyricLive } = await import(${JSON.stringify(liveViteUrl)});`,
            `const root = ${JSON.stringify(root)};`,
            `const otherRoot = ${JSON.stringify(otherRoot)};`,
            'const freePort = () => new Promise((res, rej) => {',
            '  const s = createNetServer();',
            '  s.once("error", rej);',
            '  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });',
            '});',
            'const children = [];',
            'function startChild(cwd, args, env) {',
            '  return new Promise((res, rej) => {',
            '    const c = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, HOME: cwd, ...env } });',
            '    children.push(c);',
            '    let err = "";',
            '    c.stderr.setEncoding("utf8");',
            '    c.stderr.on("data", (d) => { err += d; });',
            '    c.stdout.setEncoding("utf8");',
            '    c.stdout.on("data", (d) => { if (d.includes("READY ")) res(c); });',
            '    c.once("exit", (code) => rej(new Error("child exited " + String(code) + ": " + err)));',
            '  });',
            '}',
            'const authStub = createHttpServer((req, res) => {',
            '  req.resume();',
            '  req.on("end", () => {',
            '    res.writeHead(200, { "content-type": "application/json" });',
            '    res.end(JSON.stringify({ users: [{ localId: "uid-fullstack" }] }));',
            '  });',
            '});',
            'await new Promise((r) => authStub.listen(0, "127.0.0.1", r));',
            'const authPort = authStub.address().port;',
            'const [vitePort, liveApiPort, sbxApiPort, otherProjPort, plainPort, closedSbxHostPort] = await Promise.all([',
            '  freePort(), freePort(), freePort(), freePort(), freePort(), freePort(),',
            ']);',
            'await startChild(root, ["--import", "@pyric/cli/register", join(root, "backend.mjs")], {',
            '  BACKEND_PORT: String(sbxApiPort),',
            '  PYRIC_SANDBOX: "remote:http://127.0.0.1:" + String(closedSbxHostPort),',
            '  PYRIC_SANDBOX_INSTANCE: "sbx-check",',
            '});',
            'await startChild(otherRoot, ["--import", "@pyric/live/register", join(root, "backend.mjs")], {',
            '  BACKEND_PORT: String(otherProjPort),',
            '});',
            'await startChild(root, [join(root, "backend.mjs")], { BACKEND_PORT: String(plainPort) });',
            'const vite = await createViteServer({',
            '  root, configFile: false, logLevel: "silent",',
            '  server: {',
            '    host: "127.0.0.1", port: vitePort, strictPort: true, ws: false,',
            '    proxy: {',
            '      "/api/live": "http://127.0.0.1:" + String(liveApiPort),',
            '      "/api/sandbox": "http://127.0.0.1:" + String(sbxApiPort),',
            '      "/api/other-project": "http://127.0.0.1:" + String(otherProjPort),',
            '      "/api/plain": "http://127.0.0.1:" + String(plainPort),',
            '    },',
            '  },',
            '  optimizeDeps: { noDiscovery: true, include: [] },',
            '  plugins: [pyricLive({ project: "demo-fullstack-2304" })],',
            '});',
            'try {',
            '  await vite.listen();',
            '  await startChild(root, ["--import", "@pyric/live/register", join(root, "backend.mjs")], {',
            '    BACKEND_PORT: String(liveApiPort),',
            '    BACKEND_PROJECT: "demo-fullstack-2304",',
            '    USE_ADMIN: "1",',
            '    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:" + String(authPort),',
            '  });',
            '  const base = "http://127.0.0.1:" + String(vitePort);',
            `  const okRes = await fetch(base + "/api/live/verify", { method: "POST", headers: { authorization: "Bearer " + ${JSON.stringify(emuToken)} } });`,
            '  const okBody = await okRes.json();',
            `  const badRes = await fetch(base + "/api/live/verify", { method: "POST", headers: { authorization: "Bearer " + ${JSON.stringify(sbxToken)} } });`,
            '  const badBody = await badRes.json();',
            '  const { token: sessionToken } = JSON.parse(readFileSync(join(root, ".pyric/serve.json"), "utf8"));',
            '  const headers = { "x-pyric-session-token": sessionToken };',
            '  let health = null;',
            '  let adminEvents = [];',
            '  const deadline = Date.now() + 10000;',
            '  while (Date.now() < deadline) {',
            '    health = await fetch(base + "/__pyric/health", { headers }).then((r) => r.json());',
            '    const capRes = await fetch(base + "/__pyric/capture", { headers });',
            '    let cap = { events: [] };',
            '    if (capRes.status === 200) cap = await capRes.json();',
            '    adminEvents = (cap.events ?? []).filter((e) => e.kind === "operation" && e.detail?.sdk === "admin");',
            '    const verdicts = Object.fromEntries((health.proxyTargets ?? []).map((t) => [t.context, t.verdict]));',
            '    const nodeClient = (health.live?.clients ?? []).find((c) => c.kind === "node" && Array.isArray(c.unobservedAdmin));',
            '    if (verdicts["/api/live"] === "same" && adminEvents.length >= 1 && nodeClient) break;',
            '    await new Promise((r) => setTimeout(r, 100));',
            '  }',
            '  console.log("FULLSTACK_OUT " + JSON.stringify({ okStatus: okRes.status, okBody, badStatus: badRes.status, badBody, health, adminEvents }));',
            '} finally {',
            '  for (const c of children) c.kill("SIGTERM");',
            '  authStub.close();',
            '  await vite.close();',
            '}',
            'process.exit(0);',
          ].join('\n'),
        );

        const run = spawnSync('node', [driverPath], {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
          env: { PATH: process.env.PATH, HOME: root },
        });
        expect(run.status, `stdout=${run.stdout}\nstderr=${run.stderr}`).toBe(0);
        const line = run.stdout.split('\n').find((entry) => entry.startsWith('FULLSTACK_OUT '));
        if (line === undefined) {
          throw new Error(`missing FULLSTACK_OUT:\n${run.stdout}\n${run.stderr}`);
        }
        const out = JSON.parse(line.slice('FULLSTACK_OUT '.length)) as {
          okStatus: number;
          okBody: { uid: string };
          badStatus: number;
          badBody: { code: string; pyricCode: string };
          health: {
            live?: {
              admin?: { mode: string; observed: boolean; bypassesRules: boolean };
              clients?: Array<{ kind: string; unobservedAdmin?: string[]; gatedAdmin?: string[] }>;
            };
            proxyTargets?: Array<{ context: string; verdict: string }>;
          };
          adminEvents: Array<{
            service?: string;
            method?: string;
            caller?: { kind?: string };
            auth?: { uid?: string };
            rulesDisposition?: { kind?: string; reason?: string };
          }>;
        };

        expect(out.okStatus).toBe(200);
        expect(out.okBody).toEqual({ uid: 'uid-fullstack' });
        expect(out.badStatus).toBe(401);
        expect(out.badBody).toEqual({ code: 'auth/argument-error', pyricCode: 'PYRIC_MODE_MISMATCH' });

        expect(out.health.live?.admin).toEqual({ mode: 'observed', observed: true, bypassesRules: true });
        const verdicts = Object.fromEntries((out.health.proxyTargets ?? []).map((t) => [t.context, t.verdict]));
        expect(verdicts).toEqual({
          '/api/live': 'same',
          '/api/sandbox': 'other-mode',
          '/api/other-project': 'other-project',
          '/api/plain': 'not-pyric',
        });

        expect(out.adminEvents).toHaveLength(1);
        expect(out.adminEvents[0]).toMatchObject({
          service: 'auth',
          method: 'Auth.verifyIdToken',
          caller: { kind: 'node' },
          auth: { uid: 'uid-fullstack' },
          rulesDisposition: { kind: 'bypassed', reason: 'admin' },
        });

        const nodeClients = (out.health.live?.clients ?? []).filter((c) => c.kind === 'node');
        const withLists = nodeClients.find((c) => c.unobservedAdmin !== undefined);
        expect(withLists?.unobservedAdmin).toEqual(['firebase-admin/remote-config']);
        expect(withLists?.gatedAdmin).toEqual(['firebase-admin/app-check']);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(otherRoot, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
