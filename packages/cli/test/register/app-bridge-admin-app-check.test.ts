/**
 * End-to-end child-process verification for `app-bridge-admin-app-check.ts`
 * under `node --import @pyric/cli/register` in production AI mode
 * (`app-check-admin#verify-token-firebase-token-production-ai-mode`).
 *
 * A preload imported before `@pyric/cli/register` answers
 * `https://firebaseappcheck.googleapis.com/v1/jwks` from an in-memory RSA-2048
 * JWK and refuses every other outbound connection, so `firebase-admin`'s own
 * `AppCheckTokenVerifier` runs unchanged with zero network egress and zero
 * temporary files on disk.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startInMemoryRemoteHost } from './remote-host-test-support.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const registerDist = join(cliRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;
const obsDir = join(repoRoot, 'packages/conformance/observations/app-check-admin');

function readObservation<T>(name: string): T {
  const raw = JSON.parse(readFileSync(join(obsDir, `${name}.json`), 'utf8')) as { behavior: T };
  return raw.behavior;
}

const PROJECT_ID = 'demo-project';
const CERT_PROJECT_ID = 'demo-cert';
const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:0a1b2c3d4e5f60718293a4`;
const KEY_ID = 'vlhDMA';
const EXPIRED_MESSAGE =
  'The provided App Check token has expired. Get a fresh App Check token from your client app and try again.';
const NOT_SANDBOX_MESSAGE =
  "This App Check token was not minted by the Pyric sandbox, so the sandbox's firebase-admin/app-check cannot verify it. " +
  'A page in production AI mode gets its App Check tokens from Firebase. Start this server in production AI mode too ' +
  '(PYRIC_AI_MODE=production) and Pyric verifies them with firebase-admin. In sandbox AI mode, page tokens come from the sandbox and verify here.';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwksJson = JSON.stringify({
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, use: 'sig', alg: 'RS256' }],
});

function signFirebaseAppCheckJwt(
  projectId: string,
  overrides: Record<string, unknown> = {},
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
  const claims = {
    sub: APP_ID,
    aud: [`projects/${PROJECT_NUMBER}`, `projects/${projectId}`],
    provider: 'debug',
    lu: 'fixture',
    iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    jti: randomBytes(18).toString('base64url'),
    ...overrides,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function tamperJwtSignature(token: string): string {
  const [header, payload, signature = ''] = token.split('.');
  const mid = Math.floor(signature.length / 2);
  let replacement = 'A';
  if (signature[mid] === 'A') {
    replacement = 'B';
  }
  return `${header}.${payload}.${signature.slice(0, mid)}${replacement}${signature.slice(mid + 1)}`;
}

function replaceJwtClaim(token: string, claim: string, value: unknown): string {
  const [header, payload = '', signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  claims[claim] = value;
  const nextPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${nextPayload}.${signature}`;
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

const jwksPreloadUrl = `data:text/javascript;base64,${Buffer.from(JWKS_PRELOAD_SOURCE, 'utf8').toString('base64')}`;

const CHILD_SCRIPT = `
import { registerHooks } from 'node:module';

const loadedUrls = [];
registerHooks({
  load(url, context, nextLoad) {
    loadedUrls.push(url);
    return nextLoad(url, context);
  },
});

const { cert, initializeApp } = await import('firebase-admin/app');
const { getAppCheck } = await import('firebase-admin/app-check');
const { signAppCheckToken } = await import('pyric/sandbox/internal');

const payload = JSON.parse(process.env.PYRIC_TEST_INPUT_JSON);
const record = globalThis[Symbol.for('pyric.test.jwksRecord')];

async function captureVerify(service, token, options) {
  const before = record.served.length;
  try {
    const result = await service.verifyToken(token, options);
    let alreadyConsumed = null;
    if (typeof result.alreadyConsumed === 'boolean') {
      alreadyConsumed = result.alreadyConsumed;
    }
    return {
      threw: false,
      resultKeySet: Object.keys(result).sort(),
      appId: result.appId,
      decodedClaimNames: Object.keys(result.token).sort(),
      decodedAppId: result.token.app_id,
      alreadyConsumed,
      jwksRequests: record.served.length - before,
    };
  } catch (error) {
    let code = null;
    if (typeof error?.code === 'string') {
      code = error.code;
    }
    const rawMessage = error?.message ?? error;
    return {
      threw: true,
      code,
      message: String(rawMessage),
      jwksRequests: record.served.length - before,
    };
  }
}

const defaultApp = initializeApp({ projectId: payload.projectId });
const isMirrorApp = Symbol.for('pyric.admin.app.target') in defaultApp;
const defaultService = getAppCheck(defaultApp);

const outcomes = {};
if (payload.mode === 'sandbox') {
  outcomes.valid = await captureVerify(defaultService, payload.validToken);
} else {
  outcomes.valid = await captureVerify(defaultService, payload.validToken);
  outcomes.cached = await captureVerify(defaultService, payload.validToken);
  outcomes.tampered = await captureVerify(defaultService, payload.tamperedToken);
  const otherApp = initializeApp({ projectId: 'another-project' }, 'another-app');
  outcomes.wrongAudience = await captureVerify(getAppCheck(otherApp), payload.validToken);
  outcomes.wrongIssuer = await captureVerify(defaultService, payload.wrongIssuerToken);
  outcomes.expired = await captureVerify(defaultService, payload.expiredToken);

  const certApp = initializeApp({ credential: cert({ project_id: payload.certProjectId }) }, 'cert-app');
  outcomes.certScoped = await captureVerify(getAppCheck(certApp), payload.certToken);

  outcomes.consumeFirst = await captureVerify(defaultService, payload.validToken, { consume: true });
  outcomes.consumeSecond = await captureVerify(defaultService, payload.validToken, { consume: true });
  outcomes.plainAfterConsume = await captureVerify(defaultService, payload.validToken);

  const mintedSandbox = await defaultService.createToken(payload.appId);
  outcomes.sandboxToken = await captureVerify(defaultService, mintedSandbox.token);
  const sandboxPayload = mintedSandbox.token.split('.')[1] ?? '';
  const sandboxClaims = JSON.parse(Buffer.from(sandboxPayload, 'base64url').toString('utf8'));
  const noKid = await signAppCheckToken({ alg: 'RS256', typ: 'JWT' }, sandboxClaims);
  outcomes.noKidToken = await captureVerify(defaultService, noKid);
  outcomes.malformed = await captureVerify(defaultService, 'not-a-jwt');
}

const realAdminLoaded = loadedUrls.some((url) => url.includes('/node_modules/firebase-admin/'));
const bridgeLoaded = loadedUrls.some((url) => url.includes('/register/app-bridge-admin-app-check.js'));
console.log('VERIFY_REPORT ' + JSON.stringify({
  isMirrorApp,
  realAdminLoaded,
  bridgeLoaded,
  served: record.served,
  refused: record.refused,
  outcomes,
}));
`;

interface ChildVerifyOutcome {
  threw: boolean;
  resultKeySet?: string[];
  appId?: string;
  decodedClaimNames?: string[];
  decodedAppId?: string;
  alreadyConsumed?: boolean | null;
  code?: string | null;
  message?: string;
  jwksRequests: number;
}

interface ChildReport {
  stderr: string;
  isMirrorApp: boolean;
  realAdminLoaded: boolean;
  bridgeLoaded: boolean;
  served: string[];
  refused: string[];
  outcomes: Record<string, ChildVerifyOutcome>;
}

async function runRegisteredVerify(
  mode: 'production' | 'passthrough' | 'sandbox',
): Promise<ChildReport> {
  if (!existsSync(registerDist)) {
    throw new Error(`missing built register entry at ${registerDist}; run bun run pretest first`);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const validToken = signFirebaseAppCheckJwt(PROJECT_ID);
  let childMode = 'production';
  if (mode === 'sandbox') {
    childMode = 'sandbox';
  }
  const inputJson = JSON.stringify({
    mode: childMode,
    projectId: PROJECT_ID,
    certProjectId: CERT_PROJECT_ID,
    appId: APP_ID,
    validToken,
    tamperedToken: tamperJwtSignature(validToken),
    wrongIssuerToken: replaceJwtClaim(validToken, 'iss', 'https://example.com/123'),
    expiredToken: signFirebaseAppCheckJwt(PROJECT_ID, {
      iat: nowSeconds - 3700,
      exp: nowSeconds - 100,
    }),
    certToken: signFirebaseAppCheckJwt(CERT_PROJECT_ID),
  });

  const host = await startInMemoryRemoteHost({
    projectKey: repoRoot,
    projectId: PROJECT_ID,
  });
  try {
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PYRIC_SANDBOX: `remote:${host.origin}`,
      PYRIC_SANDBOX_INSTANCE: host.instanceId,
      PYRIC_TEST_JWKS_JSON: jwksJson,
      PYRIC_TEST_INPUT_JSON: inputJson,
    };
    if (mode === 'production') {
      env.PYRIC_AI_MODE = 'production';
    } else if (mode === 'passthrough') {
      env.PYRIC_AI_PASSTHROUGH = '1';
    }

    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolveChild, rejectChild) => {
        const child = spawn(
          'node',
          ['--import', jwksPreloadUrl, '--import', registerUrl, '--input-type=module', '-e', CHILD_SCRIPT],
          {
            cwd: repoRoot,
            env: env as NodeJS.ProcessEnv,
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
    if (result.status !== 0) {
      throw new Error(`registered child exited ${String(result.status)}:\n${result.stderr}\n${result.stdout}`);
    }
    const reportLine = result.stdout.split('\n').find((line) => line.startsWith('VERIFY_REPORT '));
    if (!reportLine) {
      throw new Error(`missing VERIFY_REPORT line:\n${result.stdout}\n${result.stderr}`);
    }
    const parsed = JSON.parse(reportLine.slice('VERIFY_REPORT '.length)) as Omit<ChildReport, 'stderr'>;
    return { ...parsed, stderr: result.stderr };
  } finally {
    await host.stop();
  }
}

describe('app-check-admin#verify-token-firebase-token-production-ai-mode under @pyric/cli/register', () => {
  it('replays app-check-admin-verify-token and error contracts through firebase-admin in production AI mode', async () => {
    const oVerify = readObservation<{
      debugExchanged: {
        resultKeySet: string[];
        appIdEqualsConfig: boolean;
        decodedClaimNames: string[];
        decodedAppIdEqualsConfig: boolean;
        alreadyConsumed: null;
      };
    }>('app-check-admin-verify-token');
    const oTampered = readObservation<{
      tamperedSignature: { threw: boolean; code: string; message: string };
      notJwt: { threw: boolean; code: string; message: string };
    }>('app-check-admin-verify-tampered');
    const oContent = readObservation<{
      wrongAudience: { code: string; message: string };
      wrongIssuer: { code: string; message: string };
    }>('app-check-admin-verify-token-content-checks');
    const oConsume = readObservation<{
      firstConsume: { resultKeySet: string[]; alreadyConsumed: boolean };
      secondConsume: { resultKeySet: string[]; alreadyConsumed: boolean };
      plainVerifyAfterConsume: { resultKeySet: string[]; alreadyConsumed: null };
    }>('app-check-admin-verify-consume');

    const report = await runRegisteredVerify('production');
    expect(report.isMirrorApp).toBe(true);
    expect(report.bridgeLoaded).toBe(true);
    expect(report.realAdminLoaded).toBe(true);
    expect(report.stderr).not.toContain('PYRIC_REAL_SDK_STOPPED');
    expect(report.refused).toEqual([]);
    // One JWKS fetch per verified Firebase project (`demo-project` and `demo-cert`).
    expect(report.served).toEqual([
      'firebaseappcheck.googleapis.com/v1/jwks',
      'firebaseappcheck.googleapis.com/v1/jwks',
    ]);

    const valid = report.outcomes.valid;
    if (!valid) {
      throw new Error('expected valid verification outcome');
    }
    expect({
      resultKeySet: valid.resultKeySet,
      appIdEqualsConfig: valid.appId === APP_ID,
      decodedClaimNames: valid.decodedClaimNames,
      decodedAppIdEqualsConfig: valid.decodedAppId === APP_ID,
      alreadyConsumed: valid.alreadyConsumed,
    }).toEqual(oVerify.debugExchanged);
    expect(valid.jwksRequests).toBe(1);
    expect(report.outcomes.cached?.jwksRequests).toBe(0);

    expect(report.outcomes.certScoped).toMatchObject({
      threw: false,
      appId: APP_ID,
      decodedAppId: APP_ID,
      jwksRequests: 1,
    });

    expect(report.outcomes.tampered).toEqual({
      ...oTampered.tamperedSignature,
      jwksRequests: 0,
    });
    expect(report.outcomes.wrongAudience).toEqual({
      threw: true,
      code: oContent.wrongAudience.code,
      message: oContent.wrongAudience.message,
      jwksRequests: 0,
    });
    expect(report.outcomes.wrongIssuer).toEqual({
      threw: true,
      code: oContent.wrongIssuer.code,
      message: oContent.wrongIssuer.message,
      jwksRequests: 0,
    });
    expect(report.outcomes.expired).toEqual({
      threw: true,
      code: 'app-check/app-check-token-expired',
      message: EXPIRED_MESSAGE,
      jwksRequests: 0,
    });

    expect({
      resultKeySet: report.outcomes.consumeFirst?.resultKeySet,
      alreadyConsumed: report.outcomes.consumeFirst?.alreadyConsumed,
    }).toEqual(oConsume.firstConsume);
    expect({
      resultKeySet: report.outcomes.consumeSecond?.resultKeySet,
      alreadyConsumed: report.outcomes.consumeSecond?.alreadyConsumed,
    }).toEqual(oConsume.secondConsume);
    expect({
      resultKeySet: report.outcomes.plainAfterConsume?.resultKeySet,
      alreadyConsumed: report.outcomes.plainAfterConsume?.alreadyConsumed,
    }).toEqual(oConsume.plainVerifyAfterConsume);

    expect(report.outcomes.sandboxToken).toMatchObject({
      threw: false,
      appId: APP_ID,
      jwksRequests: 0,
    });
    expect(report.outcomes.noKidToken).toMatchObject({
      threw: false,
      appId: APP_ID,
      jwksRequests: 0,
    });
    expect(report.outcomes.malformed).toEqual({
      ...oTampered.notJwt,
      jwksRequests: 0,
    });
  });

  it('activates the same firebase-admin verifier bridge when PYRIC_AI_PASSTHROUGH=1 selects production AI mode', async () => {
    const report = await runRegisteredVerify('passthrough');
    expect(report.bridgeLoaded).toBe(true);
    expect(report.realAdminLoaded).toBe(true);
    expect(report.outcomes.valid?.threw).toBe(false);
    expect(report.outcomes.valid?.appId).toBe(APP_ID);
    expect(report.refused).toEqual([]);
  });

  it('keeps firebase-admin unloaded and refuses foreign-kid tokens in sandbox AI mode', async () => {
    const report = await runRegisteredVerify('sandbox');
    expect(report.bridgeLoaded).toBe(false);
    expect(report.realAdminLoaded).toBe(false);
    expect(report.served).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(report.outcomes.valid).toEqual({
      threw: true,
      code: 'app-check/invalid-argument',
      message: NOT_SANDBOX_MESSAGE,
      jwksRequests: 0,
    });
  });
});
