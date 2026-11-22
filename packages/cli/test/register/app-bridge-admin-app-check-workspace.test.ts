/**
 * Isolated workspace resolution test for `app-bridge-admin-app-check.ts` (#1563):
 * when `@pyric/cli` lives at a repo root that has NO `firebase-admin` installed
 * and `firebase-admin` lives only under `functions/node_modules/`, production
 * AI mode must resolve the real App Check verifier from the server's location
 * (`lastAppImporterUrl`, `process.argv[1]`, `process.cwd()`), then fall back
 * to `@pyric/cli`'s location.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startInMemoryRemoteHost } from './remote-host-test-support.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const registerDist = join(cliRoot, 'dist/register/index.js');

const PROJECT_ID = 'demo-workspace-project';
const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:0a1b2c3d4e5f60718293a4`;
const KEY_ID = 'wsKey1';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwksJson = JSON.stringify({
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, use: 'sig', alg: 'RS256' }],
});

function signFirebaseToken(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      sub: APP_ID,
      aud: [`projects/${PROJECT_NUMBER}`, `projects/${PROJECT_ID}`],
      provider: 'debug',
      lu: 'fixture',
      iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
      iat: nowSec,
      exp: nowSec + 3600,
      jti: randomBytes(16).toString('base64url'),
    }),
  ).toString('base64url');
  const input = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${sig}`;
}

const JWKS_PRELOAD_SOURCE = `
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const record = { served: [], refused: [] };
globalThis[Symbol.for('pyric.test.jwksRecord')] = record;

function parseTarget(args) {
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) {
    const parsed = new URL(String(first));
    return { host: parsed.hostname, path: parsed.pathname + parsed.search };
  }
  const options = first ?? {};
  let host = 'localhost';
  if (typeof options.hostname === 'string') {
    host = options.hostname;
  } else if (typeof options.host === 'string') {
    host = options.host;
  }
  let path = '/';
  if (typeof options.path === 'string') {
    path = options.path;
  }
  return { host, path };
}

function fakeRequest(callback, body, failure) {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => req;
  req.write = () => true;
  req.end = () => {
    process.nextTick(() => {
      if (failure) {
        req.emit('error', failure);
        return;
      }
      const res = Readable.from([body]);
      res.statusCode = 200;
      res.statusMessage = 'OK';
      res.headers = { 'content-type': 'application/json' };
      if (typeof callback === 'function') callback(res);
    });
    return req;
  };
  return req;
}

function patch(mod, scheme) {
  const orig = mod.request;
  mod.request = function (...args) {
    const { host, path } = parseTarget(args);
    if (LOOPBACK.has(host)) return orig.apply(this, args);
    const cb = args.find((arg) => typeof arg === 'function');
    if (scheme === 'https' && host === 'firebaseappcheck.googleapis.com' && path === '/v1/jwks') {
      record.served.push(host + path);
      return fakeRequest(cb, process.env.PYRIC_TEST_JWKS_JSON, null);
    }
    record.refused.push(host + path);
    return fakeRequest(cb, '', new Error('refused ' + host + path));
  };
  mod.get = function (...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

patch(http, 'http');
patch(https, 'https');
`;

const jwksPreloadUrl = `data:text/javascript;base64,${Buffer.from(JWKS_PRELOAD_SOURCE, 'utf8').toString('base64')}`;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Creates a real `@pyric/cli` package directory inside `rootDir/node_modules`
 * containing copied files for `register/` (so `realpath` stays inside `rootDir`,
 * with NO `firebase-admin` in any ancestor directory). `firebase-admin` is
 * symlinked only under `rootDir/functions/node_modules/` when requested.
 */
function linkWorkspacePackages(rootDir: string, includeFunctionsFirebaseAdmin: boolean): {
  registerEntryUrl: string;
  functionsDir: string;
} {
  const nm = join(rootDir, 'node_modules');
  const cliDir = join(nm, '@pyric/cli');
  const cliDist = join(cliDir, 'dist');
  const cliReg = join(cliDist, 'register');
  mkdirSync(cliReg, { recursive: true });
  copyFileSync(join(repoRoot, 'packages/cli/package.json'), join(cliDir, 'package.json'));
  const realCliDist = join(repoRoot, 'packages/cli/dist');
  for (const entry of readdirSync(realCliDist)) {
    if (entry === 'register' || entry === 'serve') continue;
    const src = join(realCliDist, entry);
    symlinkSync(src, join(cliDist, entry));
  }
  const realServeDir = join(realCliDist, 'serve');
  const cliServeDir = join(cliDist, 'serve');
  mkdirSync(cliServeDir, { recursive: true });
  for (const entry of readdirSync(realServeDir)) {
    const src = join(realServeDir, entry);
    if (entry === 'firebase-module-swap.js') {
      copyFileSync(src, join(cliServeDir, entry));
    } else {
      symlinkSync(src, join(cliServeDir, entry));
    }
  }
  const realRegDir = join(realCliDist, 'register');
  for (const entry of readdirSync(realRegDir)) {
    const src = join(realRegDir, entry);
    if (entry.endsWith('.js')) {
      copyFileSync(src, join(cliReg, entry));
    } else {
      symlinkSync(src, join(cliReg, entry));
    }
  }
  symlinkSync(join(repoRoot, 'packages/rules'), join(nm, '@pyric/rules'), 'dir');
  symlinkSync(join(repoRoot, 'packages/pyric'), join(nm, 'pyric'), 'dir');
  symlinkSync(join(repoRoot, 'packages/pyric-admin'), join(nm, 'pyric-admin'), 'dir');
  writeFileSync(join(rootDir, 'package.json'), JSON.stringify({ name: 'ws-root', private: true, type: 'module' }));

  const functionsDir = join(rootDir, 'functions');
  mkdirSync(functionsDir, { recursive: true });
  writeFileSync(
    join(functionsDir, 'package.json'),
    JSON.stringify({ name: 'ws-functions', private: true, type: 'module' }),
  );

  if (includeFunctionsFirebaseAdmin) {
    const fnNm = join(functionsDir, 'node_modules');
    mkdirSync(fnNm, { recursive: true });
    const adminTarget = realpathSync(join(repoRoot, 'node_modules/firebase-admin'));
    symlinkSync(adminTarget, join(fnNm, 'firebase-admin'), 'dir');
  }

  return {
    registerEntryUrl: pathToFileURL(join(cliReg, 'index.js')).href,
    functionsDir,
  };
}

interface WorkspaceReport {
  ok: boolean;
  appId?: string;
  code?: string;
  message?: string;
  loadedAdminUrls: string[];
  served: string[];
  refused: string[];
  status: number | null;
  stderr: string;
}

async function runNodeInWorkspace(
  cwd: string,
  registerEntryUrl: string,
  nodeArgs: string[],
  hostOrigin: string,
  instanceId: string,
  token: string,
): Promise<WorkspaceReport> {
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolveChild, rejectChild) => {
      const child = spawn(
        'node',
        ['--import', jwksPreloadUrl, '--import', registerEntryUrl, ...nodeArgs],
        {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            PYRIC_SANDBOX: `remote:${hostOrigin}`,
            PYRIC_SANDBOX_INSTANCE: instanceId,
            PYRIC_AI_MODE: 'production',
            PYRIC_TEST_JWKS_JSON: jwksJson,
            PYRIC_TEST_TOKEN: token,
          },
        },
      );
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
      child.on('error', rejectChild);
      child.on('close', (status) => {
        resolveChild({ status, stdout, stderr });
      });
    },
  );
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('WS_REPORT '));
  if (line === undefined) {
    throw new Error(`missing WS_REPORT (status=${String(result.status)}):\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  }
  const parsed = JSON.parse(line.slice('WS_REPORT '.length)) as Omit<WorkspaceReport, 'status' | 'stderr'>;
  return { ...parsed, status: result.status, stderr: result.stderr };
}

describe('#1563: app-bridge-admin-app-check resolves firebase-admin from server location first', () => {
  it('resolves firebase-admin installed only under functions/node_modules for ESM, mixed sibling imports, CJS, and cwd fallback', async () => {
    if (!existsSync(registerDist)) {
      throw new Error(`missing built register entry at ${registerDist}`);
    }
    const token = signFirebaseToken();
    const host = await startInMemoryRemoteHost({ projectKey: repoRoot, projectId: PROJECT_ID });

    try {
      // 1. With NO firebase-admin at root or under functions/, verify reports the install message.
      const emptyRoot = mkdtempSync(join(tmpdir(), 'pyric-ac-ws-empty-'));
      tempDirs.push(emptyRoot);
      const emptyWs = linkWorkspacePackages(emptyRoot, false);
      const emptyScript = join(emptyWs.functionsDir, 'server.mjs');
      writeFileSync(
        emptyScript,
        `
        import { initializeApp } from 'firebase-admin/app';
        import { getAppCheck } from 'firebase-admin/app-check';
        const app = initializeApp({ projectId: ${JSON.stringify(PROJECT_ID)} });
        try {
          await getAppCheck(app).verifyToken(process.env.PYRIC_TEST_TOKEN);
          console.log('WS_REPORT ' + JSON.stringify({ ok: true, loadedAdminUrls: [], served: [], refused: [] }));
        } catch (err) {
          console.log('WS_REPORT ' + JSON.stringify({ ok: false, code: err?.code, message: err?.message, loadedAdminUrls: [], served: [], refused: [] }));
        }
        `,
      );
      const missingReport = await runNodeInWorkspace(
        emptyRoot,
        emptyWs.registerEntryUrl,
        [emptyScript],
        host.origin,
        host.instanceId,
        token,
      );
      expect(missingReport.status).toBe(0);
      expect(missingReport.ok).toBe(false);
      expect(missingReport.code).toBe('app-check/invalid-argument');
      expect(missingReport.message).toContain('firebase-admin, which is not installed beside this server');

      // 2. With firebase-admin installed ONLY under functions/node_modules/ (NOT at root!):
      const wsRoot = mkdtempSync(join(tmpdir(), 'pyric-ac-ws-fn-'));
      tempDirs.push(wsRoot);
      const ws = linkWorkspacePackages(wsRoot, true);
      mkdirSync(join(wsRoot, 'shared'), { recursive: true });
      writeFileSync(
        join(wsRoot, 'shared/helper.mjs'),
        `export { getApps } from 'firebase-admin/app';\n`,
      );

      // 2a. ESM server.mjs launched from repo root, after a root sibling also imports firebase-admin/app.
      const esmServer = join(ws.functionsDir, 'server.mjs');
      writeFileSync(
        esmServer,
        `
        import { registerHooks } from 'node:module';
        const loaded = [];
        registerHooks({
          load(url, context, nextLoad) {
            loaded.push(url);
            return nextLoad(url, context);
          },
        });
        const { initializeApp } = await import('firebase-admin/app');
        const { getAppCheck } = await import('firebase-admin/app-check');
        // Import from outside functions/ AFTER functions/server.mjs so the most-recent importer lacks firebase-admin.
        await import('../shared/helper.mjs');
        const app = initializeApp({ projectId: ${JSON.stringify(PROJECT_ID)} });
        const result = await getAppCheck(app).verifyToken(process.env.PYRIC_TEST_TOKEN);
        const rec = globalThis[Symbol.for('pyric.test.jwksRecord')];
          console.log('WS_REPORT ' + JSON.stringify({
            ok: true,
            appId: result.appId,
            loadedAdminUrls: loaded.filter((u) => u.includes('/firebase-admin/')),
            served: rec.served,
            refused: rec.refused,
          }));
          process.exit(0);
        `,
      );
      const esmReport = await runNodeInWorkspace(
        wsRoot,
        ws.registerEntryUrl,
        ['functions/server.mjs'],
        host.origin,
        host.instanceId,
        token,
      );
      expect(esmReport.status).toBe(0);
      expect(esmReport.ok).toBe(true);
      expect(esmReport.appId).toBe(APP_ID);
      expect(esmReport.refused).toEqual([]);
      expect(esmReport.served).toEqual(['firebaseappcheck.googleapis.com/v1/jwks']);
      expect(esmReport.stderr).not.toContain('PYRIC_REAL_SDK_STOPPED');
      expect(esmReport.loadedAdminUrls.some((url) => url.includes('/firebase-admin/'))).toBe(true);

      // 2b. CJS server.cjs launched from repo root using require('firebase-admin/*').
      const cjsServer = join(ws.functionsDir, 'server.cjs');
      writeFileSync(
        cjsServer,
        `
        const { initializeApp } = require('firebase-admin/app');
        const { getAppCheck } = require('firebase-admin/app-check');
        (async () => {
          const app = initializeApp({ projectId: ${JSON.stringify(PROJECT_ID)} });
          const result = await getAppCheck(app).verifyToken(process.env.PYRIC_TEST_TOKEN);
          const rec = globalThis[Symbol.for('pyric.test.jwksRecord')];
          console.log('WS_REPORT ' + JSON.stringify({
            ok: true,
            appId: result.appId,
            loadedAdminUrls: [],
            served: rec.served,
            refused: rec.refused,
          }));
        })().catch((err) => {
          console.error(err);
          process.exit(1);
        });
        `,
      );
      const cjsReport = await runNodeInWorkspace(
        wsRoot,
        ws.registerEntryUrl,
        ['functions/server.cjs'],
        host.origin,
        host.instanceId,
        token,
      );
      expect(cjsReport.status).toBe(0);
      expect(cjsReport.ok).toBe(true);
      expect(cjsReport.appId).toBe(APP_ID);
      expect(cjsReport.refused).toEqual([]);
      expect(cjsReport.served).toEqual(['firebaseappcheck.googleapis.com/v1/jwks']);
      expect(cjsReport.stderr).not.toContain('PYRIC_REAL_SDK_STOPPED');

      // 2c. Inline `-e` launched with cwd = functions/.
      const inlineReport = await runNodeInWorkspace(
        ws.functionsDir,
        ws.registerEntryUrl,
        [
          '--input-type=module',
          '-e',
          `
          const { initializeApp } = await import('firebase-admin/app');
          const { getAppCheck } = await import('firebase-admin/app-check');
          const app = initializeApp({ projectId: ${JSON.stringify(PROJECT_ID)} });
          const result = await getAppCheck(app).verifyToken(process.env.PYRIC_TEST_TOKEN);
          const rec = globalThis[Symbol.for('pyric.test.jwksRecord')];
          console.log('WS_REPORT ' + JSON.stringify({
            ok: true,
            appId: result.appId,
            loadedAdminUrls: [],
            served: rec.served,
            refused: rec.refused,
          }));
          `,
        ],
        host.origin,
        host.instanceId,
        token,
      );
      expect(inlineReport.status).toBe(0);
      expect(inlineReport.ok).toBe(true);
      expect(inlineReport.appId).toBe(APP_ID);
      expect(inlineReport.refused).toEqual([]);
      expect(inlineReport.served).toEqual(['firebaseappcheck.googleapis.com/v1/jwks']);
    } finally {
      await host.stop();
    }
  }, 30_000);
});
