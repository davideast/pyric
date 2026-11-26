/**
 * Standalone Vite dev SSR verification for Firebase App Check tokens in
 * production AI mode (#1561).
 *
 * Uses an in-memory RSA-2048 JWKS stand-in preloaded before Vite starts so
 * `firebase-admin`'s App Check verifier runs unchanged with zero network egress.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import { resolveNodeExecutable } from './require-node-on-path.js';

const CLI_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VITE_PLUGIN_URL = new URL('../../dist/serve/vite-plugin.js', import.meta.url).href;

const PROJECT_ID = 'demo-ssr-app-check';
const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:abcdef0123456789`;
const KEY_ID = 'ssrKey1';
const SIGNATURE_MESSAGE = 'The provided App Check token has invalid signature.';
const EXPIRED_MESSAGE =
  'The provided App Check token has expired. Get a fresh App Check token from your client app and try again.';
const NOT_SANDBOX_MESSAGE =
  "This App Check token was not minted by the Pyric sandbox, so the sandbox's firebase-admin/app-check cannot verify it. " +
  'A page in production AI mode gets its App Check tokens from Firebase. Start this server in production AI mode too ' +
  '(PYRIC_AI_MODE=production) and Pyric verifies them with firebase-admin. In sandbox AI mode, page tokens come from the sandbox and verify here.';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS_JSON = JSON.stringify({
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, use: 'sig', alg: 'RS256' }],
});

const activeTmpDirs: string[] = [];

afterEach(() => {
  while (activeTmpDirs.length > 0) {
    const dir = activeTmpDirs.pop();
    if (dir !== undefined) {
      removePrivateJobTmpDir(dir);
    }
  }
});

function signFirebaseAppCheckJwt(
  projectId: string,
  overrides: Record<string, unknown> = {},
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
  const claims = {
    sub: APP_ID,
    aud: [`projects/${PROJECT_NUMBER}`, `projects/${projectId}`],
    provider: 'recaptcha_enterprise',
    lu: 'fixture',
    iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
    iat: nowSec,
    exp: nowSec + 3600,
    jti: randomBytes(18).toString('base64url'),
    ...overrides,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const sig = sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${sig}`;
}

function tamperJwtSignature(token: string): string {
  const [header = '', payload = '', sig = ''] = token.split('.');
  const mid = Math.floor(sig.length / 2);
  let replacement = 'A';
  if (sig[mid] === 'A') {
    replacement = 'B';
  }
  return `${header}.${payload}.${sig.slice(0, mid)}${replacement}${sig.slice(mid + 1)}`;
}

const JWKS_PRELOAD_SOURCE = String.raw`
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const record = { served: [], refused: [], loadedUrls: [] };
globalThis[Symbol.for('pyric.test.viteSsrAppCheckRecord')] = record;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    record.loadedUrls.push(resolved.url);
    return resolved;
  },
});

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
  let reqPath = '/';
  if (typeof options.path === 'string') {
    reqPath = options.path;
  }
  return { host, path: reqPath };
}

function fakeClientRequest(callback, body, failure) {
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

function installStandIn(mod, scheme) {
  const realRequest = mod.request;
  mod.request = function patchedRequest(...args) {
    const { host, path } = parseTarget(args);
    if (LOOPBACK.has(host)) return realRequest.apply(this, args);
    const callback = args.find((arg) => typeof arg === 'function');
    if (scheme === 'https' && host === 'firebaseappcheck.googleapis.com' && path === '/v1/jwks') {
      record.served.push(host + path);
      return fakeClientRequest(callback, process.env.PYRIC_TEST_JWKS_JSON, null);
    }
    record.refused.push(host + path);
    return fakeClientRequest(callback, '', new Error('refused outbound request to ' + host + path));
  };
  mod.get = function patchedGet(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

installStandIn(http, 'http');
installStandIn(https, 'https');
`;

const JWKS_PRELOAD_URL = `data:text/javascript;base64,${Buffer.from(JWKS_PRELOAD_SOURCE, 'utf8').toString('base64')}`;

interface AppFixture {
  readonly appRoot: string;
  readonly realAdminAppCheckFile: string;
}

function createFixture(): AppFixture {
  const scratchRoot = createPrivateJobTmpDir('vite-ssr-app-check');
  activeTmpDirs.push(scratchRoot);

  const cliPkgJson = path.join(CLI_ROOT, 'package.json');
  const pyricRoot = fileURLToPath(new URL('../../../pyric', import.meta.url));
  const pyricAdminRoot = fileURLToPath(new URL('../../../pyric-admin', import.meta.url));
  const requireFromCli = createRequire(cliPkgJson);
  const realAdminRoot = path.dirname(requireFromCli.resolve('firebase-admin/package.json'));
  const realAdminAppCheckFile = realpathSync(requireFromCli.resolve('firebase-admin/app-check'));

  const appRoot = path.join(scratchRoot, 'app');
  mkdirSync(path.join(appRoot, 'src'), { recursive: true });
  mkdirSync(path.join(appRoot, 'node_modules', '@pyric'), { recursive: true });
  symlinkSync(CLI_ROOT, path.join(appRoot, 'node_modules', '@pyric', 'cli'));
  symlinkSync(pyricRoot, path.join(appRoot, 'node_modules', 'pyric'));
  symlinkSync(pyricAdminRoot, path.join(appRoot, 'node_modules', 'pyric-admin'));
  symlinkSync(realAdminRoot, path.join(appRoot, 'node_modules', 'firebase-admin'));

  writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({ name: 'ssr-app-check-app', private: true, type: 'module' }, null, 2),
  );
  writeFileSync(
    path.join(appRoot, '.firebaserc'),
    JSON.stringify({ projects: { default: PROJECT_ID } }),
  );
  writeFileSync(path.join(appRoot, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');

  writeFileSync(
    path.join(appRoot, 'src', 'ssr-verify-route.js'),
    [
      "import { getApps, initializeApp } from 'firebase-admin/app';",
      "import { getAppCheck } from 'firebase-admin/app-check';",
      '',
      'function getOrInitApp(projectId, name) {',
      '  const existing = getApps().find((a) => a.name === name);',
      '  if (existing) return existing;',
      '  return initializeApp({ projectId }, name);',
      '}',
      '',
      'export async function verifyOnce(projectId, appName, token, options) {',
      '  const app = getOrInitApp(projectId, appName);',
      '  const appCheck = getAppCheck(app);',
      '  const record = globalThis[Symbol.for("pyric.test.viteSsrAppCheckRecord")];',
      '  const before = record.served.length;',
      '  try {',
      '    const result = await appCheck.verifyToken(token, options);',
      '    let alreadyConsumed = null;',
      '    if (typeof result.alreadyConsumed === "boolean") {',
      '      alreadyConsumed = result.alreadyConsumed;',
      '    }',
      '    return {',
      '      ok: true,',
      '      appId: result.appId,',
      '      decodedAppId: result.token.app_id,',
      '      alreadyConsumed,',
      '      jwksRequests: record.served.length - before,',
      '    };',
      '  } catch (err) {',
      '    return {',
      '      ok: false,',
      '      code: typeof err?.code === "string" ? err.code : null,',
      '      message: String(err?.message ?? err),',
      '      jwksRequests: record.served.length - before,',
      '    };',
      '  }',
      '}',
      '',
      'export async function mintSandboxToken(projectId, appName, appId) {',
      '  const app = getOrInitApp(projectId, appName);',
      '  const minted = await getAppCheck(app).createToken(appId);',
      '  return minted.token;',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    path.join(appRoot, 'src', 'ssr-direct-real-admin.js'),
    `import * as realAdmin from ${JSON.stringify(realAdminAppCheckFile)};\nexport const keys = Object.keys(realAdmin);\n`,
  );

  return { appRoot, realAdminAppCheckFile };
}

const NODE_RUNNER = String.raw`
import { createServer } from 'vite';

const [pluginUrl, appRoot] = process.argv.slice(1);
const payload = JSON.parse(process.env.PYRIC_TEST_INPUT_JSON);
const record = globalThis[Symbol.for('pyric.test.viteSsrAppCheckRecord')];
const VERIFIER_SYM = Symbol.for('pyric.admin.appCheck.firebaseVerifier');
const { pyric } = await import(pluginUrl);

const pluginOptions = {
  ui: false,
  hosted: true,
  persist: false,
  functions: false,
  project: payload.projectId,
};
if (payload.explicitAiMode !== undefined) {
  pluginOptions.ai = { mode: payload.explicitAiMode };
}

const server = await createServer({
  root: appRoot,
  configFile: false,
  envFile: false,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0, strictPort: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [pyric(pluginOptions)],
});

let report;
try {
  await new Promise((resolveListen, rejectListen) => {
    server.httpServer.once('error', rejectListen);
    server.httpServer.listen(0, '127.0.0.1', resolveListen);
  });
  const boundPort = server.httpServer.address().port;
  server.resolvedUrls = { local: ['http://127.0.0.1:' + boundPort + '/'], network: [] };

  const verifierInstalledWhileOpen = typeof globalThis[VERIFIER_SYM] === 'function';
  const routeMod = await server.ssrLoadModule('/src/ssr-verify-route.js');
  const outcomes = {};
  if (payload.scenario === 'production-matrix') {
    outcomes.valid = await routeMod.verifyOnce(payload.projectId, 'primary', payload.validToken);
    outcomes.cached = await routeMod.verifyOnce(payload.projectId, 'primary', payload.validToken);
    outcomes.consumeFirst = await routeMod.verifyOnce(payload.projectId, 'primary', payload.validToken, { consume: true });
    outcomes.consumeSecond = await routeMod.verifyOnce(payload.projectId, 'primary', payload.validToken, { consume: true });
    outcomes.plainAfterConsume = await routeMod.verifyOnce(payload.projectId, 'primary', payload.validToken);
    const sandboxToken = await routeMod.mintSandboxToken(payload.projectId, 'primary', payload.appId);
    outcomes.sandboxToken = await routeMod.verifyOnce(payload.projectId, 'primary', sandboxToken);
    outcomes.tampered = await routeMod.verifyOnce(payload.projectId, 'primary', payload.tamperedToken);
    outcomes.wrongAudience = await routeMod.verifyOnce('wrong-project', 'other', payload.validToken);
    outcomes.wrongIssuer = await routeMod.verifyOnce(payload.projectId, 'primary', payload.wrongIssuerToken);
    outcomes.expired = await routeMod.verifyOnce(payload.projectId, 'primary', payload.expiredToken);
    outcomes.malformed = await routeMod.verifyOnce(payload.projectId, 'primary', 'not-a-jwt');
    try {
      await server.ssrLoadModule('/src/ssr-direct-real-admin.js');
      outcomes.directRealAdmin = 'loaded';
    } catch (err) {
      outcomes.directRealAdmin = typeof err?.code === 'string' ? err.code : String(err?.message ?? err);
    }
  } else {
    outcomes.valid = await routeMod.verifyOnce(payload.projectId, 'primary', payload.validToken);
  }

  await server.close();
  const verifierInstalledAfterClose = typeof globalThis[VERIFIER_SYM] === 'function';
  const afterClose = await routeMod.verifyOnce(payload.projectId, 'primary', payload.validToken);
  const realAdminLoaded = record.loadedUrls.some((url) => url.includes('/firebase-admin/'));
  const bridgeLoaded = record.loadedUrls.some((url) => url.includes('/register/app-bridge-admin-app-check.js'));
  report = {
    verifierInstalledWhileOpen,
    verifierInstalledAfterClose,
    realAdminLoaded,
    bridgeLoaded,
    served: record.served,
    refused: record.refused,
    outcomes,
    afterClose,
  };
} catch (err) {
  await server.close();
  throw err;
}

process.stdout.write('SSR_APP_CHECK_REPORT ' + JSON.stringify(report) + '\n');
`;

interface VerifyOutcome {
  ok: boolean;
  appId?: string;
  decodedAppId?: string;
  alreadyConsumed?: boolean | null;
  code?: string | null;
  message?: string;
  jwksRequests: number;
}

interface RunnerReport {
  verifierInstalledWhileOpen: boolean;
  verifierInstalledAfterClose: boolean;
  realAdminLoaded: boolean;
  bridgeLoaded: boolean;
  served: string[];
  refused: string[];
  outcomes: Record<string, VerifyOutcome | string>;
  afterClose: VerifyOutcome;
  stderr: string;
}

function runViteSsrAppCheck(config: {
  scenario: 'production-matrix' | 'single';
  explicitAiMode?: 'production' | 'sandbox';
  envOverrides?: Record<string, string | undefined>;
}): RunnerReport {
  const fixture = createFixture();
  const nowSec = Math.floor(Date.now() / 1000);
  const validToken = signFirebaseAppCheckJwt(PROJECT_ID);
  const input = {
    scenario: config.scenario,
    projectId: PROJECT_ID,
    appId: APP_ID,
    explicitAiMode: config.explicitAiMode,
    validToken,
    tamperedToken: tamperJwtSignature(validToken),
    wrongIssuerToken: signFirebaseAppCheckJwt(PROJECT_ID, { iss: 'https://example.com/123' }),
    expiredToken: signFirebaseAppCheckJwt(PROJECT_ID, { iat: nowSec - 3700, exp: nowSec - 100 }),
  };

  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_OPTIONS: undefined,
    PYRIC_SANDBOX: undefined,
    PYRIC_AI_MODE: undefined,
    PYRIC_AI_PASSTHROUGH: undefined,
    PYRIC_TEST_JWKS_JSON: JWKS_JSON,
    PYRIC_TEST_INPUT_JSON: JSON.stringify(input),
    ...config.envOverrides,
  };
  const nodeBin = resolveNodeExecutable();
  const child = spawnSync(
    nodeBin,
    ['--import', JWKS_PRELOAD_URL, '--input-type=module', '-e', NODE_RUNNER, VITE_PLUGIN_URL, fixture.appRoot],
    {
      cwd: CLI_ROOT,
      encoding: 'utf8',
      env,
      timeout: 60_000,
    },
  );
  expect(child.status, `stderr:\n${child.stderr}\nstdout:\n${child.stdout}`).toBe(0);
  const line = child.stdout.split('\n').find((entry) => entry.startsWith('SSR_APP_CHECK_REPORT '));
  expect(line, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`).toBeDefined();
  const parsed = JSON.parse((line ?? 'SSR_APP_CHECK_REPORT {}').slice('SSR_APP_CHECK_REPORT '.length)) as Omit<
    RunnerReport,
    'stderr'
  >;
  return { ...parsed, stderr: child.stderr };
}

describe('Vite dev SSR App Check verification in production AI mode (#1561)', () => {
  it('verifies Firebase tokens via firebase-admin with local consume, rejects adversarial tokens, keeps direct real firebase-admin stopped, and clears the verifier on close', () => {
    const report = runViteSsrAppCheck({
      scenario: 'production-matrix',
      explicitAiMode: 'production',
    });

    expect(report.verifierInstalledWhileOpen).toBe(true);
    expect(report.verifierInstalledAfterClose).toBe(false);
    expect(report.bridgeLoaded).toBe(true);
    expect(report.realAdminLoaded).toBe(true);
    expect(report.served).toEqual(['firebaseappcheck.googleapis.com/v1/jwks']);
    expect(report.refused).toEqual([]);

    expect(report.outcomes.valid).toEqual({
      ok: true,
      appId: APP_ID,
      decodedAppId: APP_ID,
      alreadyConsumed: null,
      jwksRequests: 1,
    });
    expect(report.outcomes.cached).toEqual({
      ok: true,
      appId: APP_ID,
      decodedAppId: APP_ID,
      alreadyConsumed: null,
      jwksRequests: 0,
    });
    expect(report.outcomes.consumeFirst).toEqual({
      ok: true,
      appId: APP_ID,
      decodedAppId: APP_ID,
      alreadyConsumed: false,
      jwksRequests: 0,
    });
    expect(report.outcomes.consumeSecond).toEqual({
      ok: true,
      appId: APP_ID,
      decodedAppId: APP_ID,
      alreadyConsumed: true,
      jwksRequests: 0,
    });
    expect(report.outcomes.plainAfterConsume).toEqual({
      ok: true,
      appId: APP_ID,
      decodedAppId: APP_ID,
      alreadyConsumed: null,
      jwksRequests: 0,
    });
    expect(report.outcomes.sandboxToken).toEqual({
      ok: true,
      appId: APP_ID,
      decodedAppId: APP_ID,
      alreadyConsumed: null,
      jwksRequests: 0,
    });
    expect(report.outcomes.tampered).toEqual({
      ok: false,
      code: 'app-check/invalid-argument',
      message: SIGNATURE_MESSAGE,
      jwksRequests: 0,
    });
    expect(report.outcomes.wrongAudience).toMatchObject({
      ok: false,
      code: 'app-check/invalid-argument',
      jwksRequests: 0,
    });
    expect(report.outcomes.wrongIssuer).toMatchObject({
      ok: false,
      code: 'app-check/invalid-argument',
      jwksRequests: 0,
    });
    expect(report.outcomes.expired).toEqual({
      ok: false,
      code: 'app-check/app-check-token-expired',
      message: EXPIRED_MESSAGE,
      jwksRequests: 0,
    });
    expect(report.outcomes.malformed).toMatchObject({
      ok: false,
      code: 'app-check/invalid-argument',
      jwksRequests: 0,
    });
    expect(report.outcomes.directRealAdmin).toBe('PYRIC_REAL_SDK_STOPPED');
    expect(report.afterClose).toEqual({
      ok: false,
      code: 'app-check/invalid-argument',
      message: NOT_SANDBOX_MESSAGE,
      jwksRequests: 0,
    });
  }, 60_000);

  it('activates the verifier when PYRIC_AI_MODE=production selects production AI mode', () => {
    const report = runViteSsrAppCheck({
      scenario: 'single',
      envOverrides: { PYRIC_AI_MODE: 'production' },
    });

    expect(report.verifierInstalledWhileOpen).toBe(true);
    expect(report.verifierInstalledAfterClose).toBe(false);
    expect(report.served).toEqual(['firebaseappcheck.googleapis.com/v1/jwks']);
    expect(report.refused).toEqual([]);
    expect(report.outcomes.valid).toEqual({
      ok: true,
      appId: APP_ID,
      decodedAppId: APP_ID,
      alreadyConsumed: null,
      jwksRequests: 1,
    });
  }, 60_000);

  it('keeps firebase-admin unloaded and fails closed in default sandbox AI mode', () => {
    const report = runViteSsrAppCheck({ scenario: 'single' });

    expect(report.verifierInstalledWhileOpen).toBe(false);
    expect(report.bridgeLoaded).toBe(false);
    expect(report.realAdminLoaded).toBe(false);
    expect(report.served).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(report.outcomes.valid).toEqual({
      ok: false,
      code: 'app-check/invalid-argument',
      message: NOT_SANDBOX_MESSAGE,
      jwksRequests: 0,
    });
  }, 60_000);

  it('respects explicit ai: { mode: "sandbox" } over PYRIC_AI_MODE=production and fails closed', () => {
    const report = runViteSsrAppCheck({
      scenario: 'single',
      explicitAiMode: 'sandbox',
      envOverrides: { PYRIC_AI_MODE: 'production' },
    });

    expect(report.verifierInstalledWhileOpen).toBe(false);
    expect(report.bridgeLoaded).toBe(false);
    expect(report.realAdminLoaded).toBe(false);
    expect(report.served).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(report.outcomes.valid).toEqual({
      ok: false,
      code: 'app-check/invalid-argument',
      message: NOT_SANDBOX_MESSAGE,
      jwksRequests: 0,
    });
  }, 60_000);
});
