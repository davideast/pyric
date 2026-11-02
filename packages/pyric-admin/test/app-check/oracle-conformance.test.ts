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
import { join } from 'node:path';

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

/** A token shaped like Firebase's: a production-style `kid` and the claim set of `app-check-admin-create-token-shape`. */
async function firebaseToken(): Promise<string> {
  const { token } = await appCheck().createToken(APP_ID);
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  return signAppCheckToken({ alg: 'RS256', kid: 'vlhDMA', typ: 'JWT' }, { ...claims, provider: 'debug' });
}

/**
 * Stands in for firebase-admin's `verifyToken` the way the register installs
 * it: `(token, projectId)`, resolving `{ appId, token }` with `app_id` added,
 * as token-verifier.js and app-check.js build it. Records each call.
 */
function installStandInVerifier(): { token: string; projectId: string; extra: number }[] {
  const calls: { token: string; projectId: string; extra: number }[] = [];
  (globalThis as Record<symbol, unknown>)[FIREBASE_VERIFIER] = async (token: string, projectId: string, ...rest: unknown[]) => {
    calls.push({ token, projectId, extra: rest.length });
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return { appId: claims.sub, token: { ...claims, app_id: claims.sub } };
  };
  return calls;
}

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[FIREBASE_VERIFIER];
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
    // Upstream-documented (firebase-admin token-verifier.js verifyContent); no capture.
    const { token } = await appCheck().createToken(APP_ID);
    const aud = JSON.stringify([`projects/${PROJECT_NUMBER}`, `projects/${PROJECT_ID}`].join(','));
    expect(await rejection(() => appCheck('another-project').verifyToken(token))).toEqual({
      threw: true,
      code: 'app-check/invalid-argument',
      message: `The provided App Check token has incorrect "aud" (audience) claim. Expected "projects/another-project" but got ${aud}. Make sure the App Check token comes from the same Firebase project as the service account used to authenticate this SDK.`,
    });
    expect(await rejection(() => appCheck().verifyToken(withClaim(token, 'iss', 'https://example.com/123')))).toEqual({
      threw: true,
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has incorrect "iss" (issuer) claim.',
    });
    const noProject = await rejection(() => appCheck(null).verifyToken(token));
    expect(noProject).toMatchObject({ threw: true, code: 'app-check/invalid-credential' });
    const invalid = (message: string) => ({ threw: true, code: 'app-check/invalid-argument', message });
    expect(await rejection(() => appCheck().verifyToken(42 as unknown as string))).toEqual(invalid('App check token must be a non-null string.'));
    const [headerPart, payloadPart] = token.split('.');
    const header = JSON.parse(Buffer.from(headerPart!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(payloadPart!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const signed = (h: Record<string, unknown>, c: Record<string, unknown>) => signAppCheckToken(h, c);
    expect(await rejection(async () => appCheck().verifyToken(await signed({ ...header, alg: 'HS256' }, claims)))).toEqual(
      invalid('The provided App Check token has incorrect algorithm. Expected "RS256" but got "HS256".'),
    );
    const { sub: _sub, ...withoutSub } = claims;
    expect(await rejection(async () => appCheck().verifyToken(await signed(header, withoutSub)))).toEqual(
      invalid('The provided App Check token has no "sub" (subject) claim.'),
    );
    expect(await rejection(async () => appCheck().verifyToken(await signed(header, { ...claims, sub: '' })))).toEqual(
      invalid('The provided App Check token has an empty string "sub" (subject) claim.'),
    );
    expect(await rejection(async () => appCheck().verifyToken(await signed({ ...header, kid: 'not-a-key' }, claims)))).toEqual(invalid(NOT_SANDBOX_MESSAGE));
    expect(await rejection(async () => appCheck().verifyToken(await signed(header, { ...claims, exp: 'soon' })))).toEqual(
      invalid('The provided App Check token has invalid signature.'),
    );
    expect(await rejection(async () => appCheck().verifyToken(await signed(header, { ...claims, nbf: Number.MAX_SAFE_INTEGER })))).toEqual(
      invalid('The provided App Check token has invalid signature.'),
    );
    expect(await rejection(() => appCheck().verifyToken(token, null as never))).toEqual(invalid('VerifyAppCheckTokenOptions must be a non-null object.'));
    expect(await rejection(() => appCheck().verifyToken(`${token}=`))).toEqual({
      threw: true,
      code: 'app-check/invalid-argument',
      message: 'Decoding App Check token failed. Make sure you passed the entire string JWT which represents the Firebase App Check token.',
    });
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
    const calls = installStandInVerifier();
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
    expect(calls).toEqual([{ token, projectId: PROJECT_ID, extra: 0 }]);
    // firebase-admin's errors pass through unchanged.
    const failure = Object.assign(new Error('The provided App Check token has invalid signature.'), { code: 'app-check/invalid-argument' });
    (globalThis as Record<symbol, unknown>)[FIREBASE_VERIFIER] = async () => {
      throw failure;
    };
    expect(await rejection(() => service.verifyToken(token))).toEqual({ threw: true, code: 'app-check/invalid-argument', message: failure.message });
    // A sandbox token keeps the sandbox path.
    const sandboxCalls = installStandInVerifier();
    const { token: sandboxToken } = await service.createToken(APP_ID);
    expect((await service.verifyToken(sandboxToken)).appId).toBe(APP_ID);
    expect(sandboxCalls).toEqual([]);
  },
  'app-check-admin#verify-token-firebase-token-consume': async () => {
    const o = obs('app-check-admin-verify-consume');
    // Production records consumption on Firebase's servers: false, then true.
    expect([o.firstConsume.alreadyConsumed, o.secondConsume.alreadyConsumed]).toEqual([false, true]);
    // Divergence, by design (row app-check-admin#verify-token-firebase-token-consume):
    // firebase-admin verifies without consume, and the mirror records it in the process.
    const calls = installStandInVerifier();
    const service = appCheck();
    const token = await firebaseToken();
    const describeResult = (r: { alreadyConsumed?: boolean }) => ({ resultKeySet: Object.keys(r).sort(), alreadyConsumed: r.alreadyConsumed ?? null });
    expect(describeResult(await service.verifyToken(token, { consume: true }))).toEqual(o.firstConsume);
    expect(describeResult(await service.verifyToken(token, { consume: true }))).toEqual(o.secondConsume);
    expect(describeResult(await service.verifyToken(token))).toEqual(o.plainVerifyAfterConsume);
    expect(calls.map((call) => call.extra)).toEqual([0, 0, 0]);
  },
  'app-check-admin#project-from-cert': async () => {
    // Upstream-documented (firebase-admin getExplicitProjectId); no capture.
    const serviceAccount = { project_id: 'demo-cert', private_key: 'placeholder-private-key', client_email: 'sa@demo-cert.iam.gserviceaccount.com' };
    const audience = async (options: Record<string, unknown>) => {
      appSeq += 1;
      const app = initializeApp({ sandbox: initializeSandbox(), ...options } as Parameters<typeof initializeApp>[0], `app-check-admin-${appSeq}`);
      const service = getAppCheck(app) as unknown as AdminAppCheck;
      const { token } = await service.createToken(APP_ID);
      return { aud: (await service.verifyToken(token)).token.aud, options: app.options };
    };
    const savedEnv = process.env.GOOGLE_CLOUD_PROJECT;
    process.env.GOOGLE_CLOUD_PROJECT = 'demo-env';
    try {
      expect(await audience({ credential: cert(serviceAccount) })).toEqual({ aud: [`projects/${PROJECT_NUMBER}`, 'projects/demo-cert'], options: {} });
      expect((await audience({ credential: cert({ projectId: 'demo-camel' }) })).aud).toContain('projects/demo-camel');
      expect((await audience({ projectId: 'demo-option', credential: cert(serviceAccount) })).aud).toContain('projects/demo-option');
    } finally {
      if (savedEnv === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = savedEnv;
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
    expect(report.committed.length).toBe(8);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
