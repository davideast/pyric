/**
 * Oracle conformance for `pyric-admin/app-check` (surface `app-check-admin`),
 * authored red under Conformance Driven Development (docs/conformance/cdd.md,
 * Step 3). One assertion set per `app-check-admin` row in
 * packages/conformance/registry/app-check.ts, replaying the
 * `app-check-admin-` captures through the observation gate.
 *
 * Blocking run: only expected-green rows run. The climb lane
 * (`PYRIC_CLIMB=1`) runs every row and the prefix completeness gate.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  deleteApp as deleteRealAdminApp,
  initializeApp as initializeRealAdminApp,
  type App as RealAdminApp,
  type Credential as RealAdminCredential,
} from 'firebase-admin/app';
import { getAppCheck as getRealAdminAppCheck } from 'firebase-admin/app-check';

/** Token length is not claimed (see the rows' notes): the shape comparison drops it explicitly. */
const WITHOUT_LENGTH = { length: undefined };
import { appCheckRows } from '../../../conformance/registry/app-check.ts';
import { createObservationGate } from '../../../conformance/src/observation-gate.ts';
import { jwtShape, tamperSignature, type Secrets } from '../../../conformance/src/capture/app-check/redact.ts';
import { initializeSandbox } from 'pyric/sandbox';
import { mintAppCheckToken, signAppCheckToken } from 'pyric/sandbox/internal';
import { cert, deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const isClimb = process.env.PYRIC_CLIMB === '1';
const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'app-check-admin');
/** The hunt's `app-check-admin-options-` captures are replayed in a sibling file, under their own rows. */
const HUNT_REPLAY = join(import.meta.dir, 'hunt-captures.test.ts');
const gate = createObservationGate({ dir: OBS_DIR, match: (file) => file.startsWith('app-check-admin-'), siblingSources: [HUNT_REPLAY] });
const obs = gate.load;

/** The oracle project every app-check-admin capture ran against. */
const PROJECT_ID = 'digame-mas';
const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:0a1b2c3d4e5f60718293a4`;
const SECRETS: Secrets = { appId: APP_ID, apiKey: '', projectNumber: PROJECT_NUMBER, values: [] };

type AdminAppCheck = {
  createToken(appId: string, options?: { ttlMillis?: number }): Promise<{ token: string; ttlMillis: number }>;
  verifyToken(token: string, options?: { consume?: boolean }): Promise<{ appId: string; token: Record<string, unknown>; alreadyConsumed?: boolean }>;
};
let appSeq = 0;
/** `null` initializes the admin app with no projectId. */
function appCheck(projectId: string | null = PROJECT_ID): AdminAppCheck {
  appSeq += 1;
  const config = projectId === null ? { sandbox: initializeSandbox() } : { sandbox: initializeSandbox(), projectId };
  const app = initializeApp(config as Parameters<typeof initializeApp>[0], `app-check-admin-${appSeq}`);
  return getAppCheck(app) as unknown as AdminAppCheck;
}
/** Re-encodes one claim and keeps the original signature: the content check runs first. */
function withClaim(token: string, claim: string, value: unknown): string {
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
  claims[claim] = value;
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
}
async function rejection(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { threw: true, code: e.code ?? null, message: String(e.message) };
  }
  return { threw: false };
}

/** The verifier `@pyric/cli/register` installs in production AI mode; absent otherwise. */
const FIREBASE_VERIFIER = Symbol.for('pyric.admin.appCheck.firebaseVerifier');
const NOT_SANDBOX_MESSAGE =
  "This App Check token was not minted by the Pyric sandbox, so the sandbox's firebase-admin/app-check cannot verify it. " +
  'A page in production AI mode gets its App Check tokens from Firebase. Start this server in production AI mode too ' +
  '(PYRIC_AI_MODE=production) and Pyric verifies them with firebase-admin. In sandbox AI mode, page tokens come from the sandbox and verify here.';
const EXPIRED_MESSAGE =
  'The provided App Check token has expired. Get a fresh App Check token from your client app and try again.';

const FIREBASE_KID = 'vlhDMA';
const FIREBASE_RSA_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FIREBASE_JWKS_BODY = JSON.stringify({
  keys: [{ ...FIREBASE_RSA_KEYS.publicKey.export({ format: 'jwk' }), kid: FIREBASE_KID, use: 'sig', alg: 'RS256' }],
});

const requireForHttps = createRequire(import.meta.url);
const cjsHttps = requireForHttps('https') as {
  request: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
};
const originalHttpsRequest = cjsHttps.request;
const originalHttpsGet = cjsHttps.get;
const realVerifierApps: RealAdminApp[] = [];
let realAppSeq = 0;

function extractHttpsTarget(args: unknown[]): { hostname: string; path: string } {
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) {
    const parsed = new URL(String(first));
    return { hostname: parsed.hostname, path: `${parsed.pathname}${parsed.search}` };
  }
  const options = (first ?? {}) as { hostname?: string; host?: string; path?: string };
  let hostname = 'localhost';
  if (typeof options.hostname === 'string') {
    hostname = options.hostname;
  } else if (typeof options.host === 'string') {
    hostname = options.host;
  }
  let path = '/';
  if (typeof options.path === 'string') {
    path = options.path;
  }
  return { hostname, path };
}

function signRs256Jwt(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign('sha256', Buffer.from(signingInput), FIREBASE_RSA_KEYS.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

/** An RS256 App Check token signed with `FIREBASE_RSA_KEYS` (`kid: 'vlhDMA'`) and the claim set of `app-check-admin-create-token-shape`. */
async function firebaseToken(
  projectId: string = PROJECT_ID,
  claimOverrides: Record<string, unknown> = {},
): Promise<string> {
  const { token } = await appCheck(projectId).createToken(APP_ID);
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  return signRs256Jwt({ alg: 'RS256', kid: FIREBASE_KID, typ: 'JWT' }, { ...claims, provider: 'debug', ...claimOverrides });
}

interface RealVerifierHarness {
  calls: { token: string; projectId: string; extra: number }[];
  servedJwks: string[];
  refusedRequests: string[];
}

/**
 * Installs firebase-admin's own `getAppCheck(app).verifyToken(token)` behind
 * `FIREBASE_VERIFIER` with an access-token-refusing credential (matching
 * `packages/cli/src/register/app-bridge-admin-app-check.ts`) and answers
 * `https://firebaseappcheck.googleapis.com/v1/jwks` from `FIREBASE_JWKS_BODY`.
 */
function installRealFirebaseAdminVerifier(): RealVerifierHarness {
  const calls: { token: string; projectId: string; extra: number }[] = [];
  const servedJwks: string[] = [];
  const refusedRequests: string[] = [];
  const appsByProject = new Map<string, RealAdminApp>();
  const noCredentials: RealAdminCredential = {
    getAccessToken: () => Promise.reject(new Error("Pyric's App Check verifier holds no credentials.")),
  };

  cjsHttps.request = (...args: unknown[]) => {
    const callback = args.find((arg) => typeof arg === 'function') as ((res: unknown) => void) | undefined;
    const { hostname, path } = extractHttpsTarget(args);
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: () => unknown;
      destroy: () => unknown;
      write: () => boolean;
      end: () => unknown;
    };
    request.setTimeout = () => request;
    request.destroy = () => request;
    request.write = () => true;
    request.end = () => {
      queueMicrotask(() => {
        if (hostname === 'firebaseappcheck.googleapis.com' && path === '/v1/jwks') {
          servedJwks.push(`${hostname}${path}`);
          const response = Readable.from([FIREBASE_JWKS_BODY]) as Readable & {
            statusCode?: number;
            statusMessage?: string;
            headers?: Record<string, string>;
          };
          response.statusCode = 200;
          response.statusMessage = 'OK';
          response.headers = { 'content-type': 'application/json' };
          callback?.(response);
          return;
        }
        refusedRequests.push(`${hostname}${path}`);
        request.emit('error', new Error(`JWKS stand-in refused ${hostname}${path}`));
      });
      return request;
    };
    return request;
  };
  cjsHttps.get = (...args: unknown[]) => {
    const request = cjsHttps.request(...args) as { end: () => unknown };
    request.end();
    return request;
  };

  (globalThis as Record<symbol, unknown>)[FIREBASE_VERIFIER] = async (
    token: string,
    projectId: string,
    ...rest: unknown[]
  ) => {
    calls.push({ token, projectId, extra: rest.length });
    let verifierApp = appsByProject.get(projectId);
    if (verifierApp === undefined) {
      realAppSeq += 1;
      verifierApp = initializeRealAdminApp(
        { projectId, credential: noCredentials },
        `[pyric-test] app-check verifier ${projectId} ${realAppSeq}`,
      );
      appsByProject.set(projectId, verifierApp);
      realVerifierApps.push(verifierApp);
    }
    return getRealAdminAppCheck(verifierApp).verifyToken(token);
  };

  return { calls, servedJwks, refusedRequests };
}

afterEach(async () => {
  cjsHttps.request = originalHttpsRequest;
  cjsHttps.get = originalHttpsGet;
  delete (globalThis as Record<symbol, unknown>)[FIREBASE_VERIFIER];
  const createdRealApps = realVerifierApps.splice(0, realVerifierApps.length);
  await Promise.all(createdRealApps.map((app) => deleteRealAdminApp(app)));
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const assertions: Record<string, () => Promise<void>> = {
  'app-check-admin#create-token-shape': async () => {
    const o = obs('app-check-admin-create-token-shape');
    const result = await appCheck().createToken(APP_ID);
    expect(Object.keys(result).sort()).toEqual(o.resultKeySet);
    expect(result.ttlMillis).toBe(o.ttlMillis);
    expect({ ...jwtShape(result.token, SECRETS), ...WITHOUT_LENGTH }).toEqual({ ...o.token, ...WITHOUT_LENGTH });
  },
  'app-check-admin#create-token-ttl': async () => {
    const o = obs('app-check-admin-create-token-custom-ttl');
    const service = appCheck();
    const thirty = await service.createToken(APP_ID, { ttlMillis: 30 * 60 * 1000 });
    expect({ ttlMillis: thirty.ttlMillis, ttlSeconds: jwtShape(thirty.token, SECRETS).ttlSeconds }).toEqual(o.thirtyMinutes);
    expect(await rejection(() => service.createToken(APP_ID, { ttlMillis: 29 * 60 * 1000 }))).toEqual(o.twentyNineMinutes);
    expect(await rejection(() => service.createToken(APP_ID, { ttlMillis: 7 * 24 * 60 * 60 * 1000 + 1000 }))).toEqual(o.sevenDaysPlusOneSecond);
  },
  'app-check-admin#create-token-unknown-app': async () => {
    const o = obs('app-check-admin-create-token-unknown-app');
    // Divergence, by design (row app-check-admin#create-token-unknown-app).
    // Production refuses an app id the project does not own:
    expect(o).toEqual({ threw: true, code: 'app-check/unknown-error', message: 'App not registered: 1:<projectNumber>:web:0000000000000000000000.' });
    // The sandbox has no app registrations, so it mints for any non-empty id,
    // and refuses only an empty one.
    const service = appCheck();
    const unknown = `1:${PROJECT_NUMBER}:web:0000000000000000000000`;
    const minted = await service.createToken(unknown);
    expect(jwtShape(minted.token, { ...SECRETS, appId: unknown }).subEqualsAppId).toBe(true);
    expect(await rejection(() => service.createToken(''))).toEqual({ threw: true, code: 'app-check/invalid-argument', message: '`appId` must be a non-empty string.' });
  },
  'app-check-admin#verify-token': async () => {
    const o = obs('app-check-admin-verify-token');
    const service = appCheck();
    const { token } = await service.createToken(APP_ID);
    const describeResult = (result: Awaited<ReturnType<AdminAppCheck['verifyToken']>>) => ({
      resultKeySet: Object.keys(result).sort(),
      appIdEqualsConfig: result.appId === APP_ID,
      decodedClaimNames: Object.keys(result.token).sort(),
      decodedAppIdEqualsConfig: result.token.app_id === APP_ID,
      alreadyConsumed: result.alreadyConsumed ?? null,
    });
    expect(describeResult(await service.verifyToken(token))).toEqual(o.adminMinted);
    // A web-plane token: pyric/app-check's getToken mints through this same
    // shared function, as production's debug exchange mints tokens Admin verifies.
    const web = await mintAppCheckToken({ appId: APP_ID, projectId: PROJECT_ID }, 3600);
    expect(describeResult(await service.verifyToken(web.token))).toEqual(o.debugExchanged);
  },
  'app-check-admin#verify-token-rejections': async () => {
    const o = obs('app-check-admin-verify-tampered');
    const service = appCheck();
    const { token } = await service.createToken(APP_ID);
    expect(await rejection(() => service.verifyToken(tamperSignature(token)))).toEqual(o.tamperedSignature);
    expect(await rejection(() => service.verifyToken('not-a-jwt'))).toEqual(o.notJwt);
    expect(await rejection(() => service.verifyToken(''))).toEqual(o.emptyString);
  },
  'app-check-admin#verify-token-content-checks': async () => {
    const o = obs('app-check-admin-verify-token-content-checks');
    const captureModeOutcome = async (invoke: () => Promise<unknown>) => {
      let pending: Promise<unknown>;
      try {
        pending = invoke();
      } catch (error) {
        const shaped = error as { code?: unknown; message?: unknown };
        let code: string | null = null;
        if (typeof shaped.code === 'string') {
          code = shaped.code;
        }
        return { mode: 'sync-throw', code, message: String(shaped.message) };
      }
      try {
        await pending;
        return { mode: 'resolved', code: null, message: null };
      } catch (error) {
        const shaped = error as { code?: unknown; message?: unknown };
        let code: string | null = null;
        if (typeof shaped.code === 'string') {
          code = shaped.code;
        }
        return { mode: 'rejected', code, message: String(shaped.message) };
      }
    };
    const demoService = appCheck('demo-project');
    const { token } = await demoService.createToken(APP_ID);
    const segments = token.split('.');
    const headerPart = segments[0] ?? '';
    const payloadPart = segments[1] ?? '';
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
    const signed = (h: Record<string, unknown>, c: Record<string, unknown>) => signAppCheckToken(h, c);

    expect(await captureModeOutcome(() => demoService.verifyToken(token, null as never))).toEqual(o.optionsNull);
    expect(await captureModeOutcome(() => demoService.verifyToken(42 as unknown as string))).toEqual(o.nonStringToken);

    const savedGoogle = process.env.GOOGLE_CLOUD_PROJECT;
    const savedGcloud = process.env.GCLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    try {
      expect(await captureModeOutcome(() => appCheck(null).verifyToken(token))).toEqual(o.missingProjectId);
    } finally {
      if (savedGoogle !== undefined) {
        process.env.GOOGLE_CLOUD_PROJECT = savedGoogle;
      }
      if (savedGcloud !== undefined) {
        process.env.GCLOUD_PROJECT = savedGcloud;
      }
    }

    expect(await captureModeOutcome(() => demoService.verifyToken(`${token}=`))).toEqual(o.invalidBase64UrlSegment);
    expect(await captureModeOutcome(async () => demoService.verifyToken(await signed({ ...header, alg: 'HS256' }, claims)))).toEqual(o.wrongAlgorithm);
    expect(await captureModeOutcome(() => appCheck('another-project').verifyToken(token))).toEqual(o.wrongAudience);
    expect(await captureModeOutcome(() => demoService.verifyToken(withClaim(token, 'iss', 'https://example.com/123')))).toEqual(o.wrongIssuer);
    const { sub: _sub, ...withoutSub } = claims;
    expect(await captureModeOutcome(async () => demoService.verifyToken(await signed(header, withoutSub)))).toEqual(o.missingSub);
    expect(await captureModeOutcome(async () => demoService.verifyToken(await signed(header, { ...claims, sub: 123 })))).toEqual(o.nonStringSub);
    expect(await captureModeOutcome(async () => demoService.verifyToken(await signed(header, { ...claims, sub: '' })))).toEqual(o.emptySub);

    const invalid = (message: string) => ({ threw: true, code: 'app-check/invalid-argument', message });
    expect(await rejection(async () => demoService.verifyToken(await signed({ ...header, kid: 'not-a-key' }, claims)))).toEqual(invalid(NOT_SANDBOX_MESSAGE));
    expect(await rejection(async () => demoService.verifyToken(await signed(header, { ...claims, exp: 'soon' })))).toEqual(
      invalid('The provided App Check token has invalid signature.'),
    );
    expect(await rejection(async () => demoService.verifyToken(await signed(header, { ...claims, nbf: Number.MAX_SAFE_INTEGER })))).toEqual(
      invalid('The provided App Check token has invalid signature.'),
    );
  },
  'app-check-admin#verify-token-consume': async () => {
    const o = obs('app-check-admin-verify-consume');
    const service = appCheck();
    const { token } = await service.createToken(APP_ID);
    const describeResult = (r: { alreadyConsumed?: boolean }) => ({ resultKeySet: Object.keys(r).sort(), alreadyConsumed: r.alreadyConsumed ?? null });
    expect(describeResult(await service.verifyToken(token, { consume: true }))).toEqual(o.firstConsume);
    expect(describeResult(await service.verifyToken(token, { consume: true }))).toEqual(o.secondConsume);
    expect(describeResult(await service.verifyToken(token))).toEqual(o.plainVerifyAfterConsume);
  },
  'app-check-admin#verify-token-firebase-token': async () => {
    const o = obs('app-check-admin-verify-token');
    // Production verifies a token its own debug exchange issued:
    expect(o.debugExchanged.resultKeySet).toEqual(['appId', 'token']);
    // Divergence, by design (row app-check-admin#verify-token-firebase-token).
    // With no verifier installed, the sandbox refuses a token from Firebase and says why:
    const token = await firebaseToken();
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual({ threw: true, code: 'app-check/invalid-argument', message: NOT_SANDBOX_MESSAGE });
    // The project check still comes first.
    expect(await rejection(() => appCheck(null).verifyToken(token))).toMatchObject({ threw: true, code: 'app-check/invalid-credential' });
  },
  'app-check-admin#verify-token-firebase-token-production-ai-mode': async () => {
    const o = obs('app-check-admin-verify-token');
    const oTampered = obs('app-check-admin-verify-tampered');
    const oContent = obs('app-check-admin-verify-token-content-checks');
    const harness = installRealFirebaseAdminVerifier();
    const service = appCheck();
    const token = await firebaseToken();
    const result = await service.verifyToken(token);
    expect({
      resultKeySet: Object.keys(result).sort(),
      appIdEqualsConfig: result.appId === APP_ID,
      decodedClaimNames: Object.keys(result.token).sort(),
      decodedAppIdEqualsConfig: result.token.app_id === APP_ID,
      alreadyConsumed: result.alreadyConsumed ?? null,
    }).toEqual(o.debugExchanged);
    expect(harness.calls).toEqual([{ token, projectId: PROJECT_ID, extra: 0 }]);
    expect(harness.servedJwks).toEqual(['firebaseappcheck.googleapis.com/v1/jwks']);
    await service.verifyToken(token);
    expect(harness.servedJwks).toHaveLength(1);

    // Project scoping follows the project resolved by the mirror, including cert().
    appSeq += 1;
    const certApp = initializeApp(
      { sandbox: initializeSandbox(), credential: cert({ project_id: 'demo-cert' }) } as Parameters<typeof initializeApp>[0],
      `app-check-admin-${appSeq}`,
    );
    const certService = getAppCheck(certApp) as unknown as AdminAppCheck;
    const certToken = await firebaseToken('demo-cert');
    const certVerified = await certService.verifyToken(certToken);
    expect(certVerified.appId).toBe(APP_ID);
    expect(harness.calls.at(-1)?.projectId).toBe('demo-cert');

    // Signature, audience, issuer, and expiry errors match production's codes and messages.
    expect(await rejection(() => service.verifyToken(tamperSignature(token)))).toEqual(oTampered.tamperedSignature);
    const demoToken = await firebaseToken('demo-project');
    expect(await rejection(() => appCheck('another-project').verifyToken(demoToken))).toEqual({
      threw: true,
      code: oContent.wrongAudience.code,
      message: oContent.wrongAudience.message,
    });
    expect(await rejection(() => appCheck('demo-project').verifyToken(withClaim(demoToken, 'iss', 'https://example.com/123')))).toEqual({
      threw: true,
      code: oContent.wrongIssuer.code,
      message: oContent.wrongIssuer.message,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredToken = await firebaseToken(PROJECT_ID, { iat: nowSeconds - 3700, exp: nowSeconds - 100 });
    expect(await rejection(() => service.verifyToken(expiredToken))).toEqual({
      threw: true,
      code: 'app-check/app-check-token-expired',
      message: EXPIRED_MESSAGE,
    });

    // Sandbox tokens, tokens with no kid, and malformed tokens keep the sandbox path.
    const callCountBeforeLocal = harness.calls.length;
    const { token: sandboxToken } = await service.createToken(APP_ID);
    expect((await service.verifyToken(sandboxToken)).appId).toBe(APP_ID);
    const sandboxClaims = JSON.parse(Buffer.from(sandboxToken.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const noKidToken = await signAppCheckToken({ alg: 'RS256', typ: 'JWT' }, sandboxClaims);
    expect((await service.verifyToken(noKidToken)).appId).toBe(APP_ID);
    expect(await rejection(() => service.verifyToken('not-a-jwt'))).toEqual(oTampered.notJwt);
    expect(harness.calls).toHaveLength(callCountBeforeLocal);
    expect(harness.refusedRequests).toEqual([]);
  },
  'app-check-admin#verify-token-firebase-token-consume': async () => {
    const o = obs('app-check-admin-verify-consume');
    // Production records consumption on Firebase's servers: false, then true.
    expect([o.firstConsume.alreadyConsumed, o.secondConsume.alreadyConsumed]).toEqual([false, true]);
    // Divergence, by design (row app-check-admin#verify-token-firebase-token-consume):
    // firebase-admin verifies without consume, and the mirror records it in the process.
    const harness = installRealFirebaseAdminVerifier();
    const service = appCheck();
    const token = await firebaseToken();
    const describeResult = (r: { alreadyConsumed?: boolean }) => ({ resultKeySet: Object.keys(r).sort(), alreadyConsumed: r.alreadyConsumed ?? null });
    expect(describeResult(await service.verifyToken(token, { consume: true }))).toEqual(o.firstConsume);
    expect(describeResult(await service.verifyToken(token, { consume: true }))).toEqual(o.secondConsume);
    expect(describeResult(await service.verifyToken(token))).toEqual(o.plainVerifyAfterConsume);
    expect(harness.calls.map((call) => call.extra)).toEqual([0, 0, 0]);
    expect(harness.refusedRequests).toEqual([]);
  },
  'app-check-admin#project-from-cert': async () => {
    const o = obs('app-check-admin-project-from-cert');
    const serviceAccount = { project_id: 'demo-cert', private_key: 'placeholder-private-key', client_email: 'sa@demo-cert.iam.gserviceaccount.com' };
    const inspectProjectResolution = async (options: Record<string, unknown>) => {
      appSeq += 1;
      const app = initializeApp({ sandbox: initializeSandbox(), ...options } as Parameters<typeof initializeApp>[0], `app-check-admin-${appSeq}`);
      const service = getAppCheck(app) as unknown as AdminAppCheck;
      const { token } = await service.createToken(APP_ID);
      const verified = await service.verifyToken(token);
      const audList = verified.token.aud as string[];
      let resolvedProjectId: string | null = null;
      const secondAudience = audList[1];
      if (typeof secondAudience === 'string' && secondAudience.startsWith('projects/')) {
        resolvedProjectId = secondAudience.slice('projects/'.length);
      }
      let appOptionsProjectId: string | null = null;
      if (typeof app.options.projectId === 'string') {
        appOptionsProjectId = app.options.projectId;
      }
      return {
        resolvedProjectId,
        appOptionsHasProjectIdKey: Object.prototype.hasOwnProperty.call(app.options, 'projectId'),
        appOptionsProjectId,
      };
    };
    const savedGoogle = process.env.GOOGLE_CLOUD_PROJECT;
    const savedGcloud = process.env.GCLOUD_PROJECT;
    process.env.GOOGLE_CLOUD_PROJECT = 'demo-env';
    process.env.GCLOUD_PROJECT = 'demo-gcloud';
    try {
      expect(await inspectProjectResolution({ credential: cert(serviceAccount) })).toEqual(o.snakeCaseCertOverEnv);
      expect(await inspectProjectResolution({ credential: cert({ projectId: 'demo-camel' }) })).toEqual(o.camelCaseCertOverEnv);
      expect(await inspectProjectResolution({ projectId: 'demo-option', credential: cert(serviceAccount) })).toEqual(o.explicitOptionOverCert);
      expect(await inspectProjectResolution({})).toEqual(o.googleCloudProjectOverGcloudProject);
    } finally {
      if (savedGoogle === undefined) {
        delete process.env.GOOGLE_CLOUD_PROJECT;
      } else {
        process.env.GOOGLE_CLOUD_PROJECT = savedGoogle;
      }
      if (savedGcloud === undefined) {
        delete process.env.GCLOUD_PROJECT;
      } else {
        process.env.GCLOUD_PROJECT = savedGcloud;
      }
    }
  },
};

const isExpectedGreen = (status: string) => status === 'conforms' || status === 'diverged-documented';
const adminRows = appCheckRows.filter((row) => row.surface === 'app-check-admin');

describe('oracle conformance (app-check admin)', () => {
  for (const row of adminRows) {
    const register = isExpectedGreen(row.status) || isClimb ? it : it.skip;
    register(`${row.id} ${row.api}`, async () => {
      const assertion = assertions[row.id];
      if (!assertion) throw new Error(`no assertion set authored for ${row.id}`);
      await assertion();
    });
  }

  it('completeness: one assertion set per app-check-admin row (partition gate)', () => {
    expect(Object.keys(assertions).sort()).toEqual(adminRows.map((row) => row.id).sort());
  });

  (isClimb ? it : it.skip)('completeness: every observations/app-check-admin/ capture is asserted (prefix gate)', () => {
    const report = gate.report();
    expect(report.committed.length).toBe(10);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
