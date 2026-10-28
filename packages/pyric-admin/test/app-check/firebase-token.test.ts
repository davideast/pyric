/**
 * A token whose `kid` is not the sandbox's came from Firebase (#1552, #1301).
 *
 * In production AI mode `@pyric/cli/register` installs a verifier behind
 * `Symbol.for('pyric.admin.appCheck.firebaseVerifier')` that runs
 * firebase-admin's own `verifyToken`; the mirror hands such a token to it.
 * With no verifier installed (sandbox AI mode, or no register), the token is
 * refused with a message that says why. Sandbox tokens never reach the
 * verifier.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { signAppCheckToken } from 'pyric/sandbox/internal';
import { cert, deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const VERIFIER = Symbol.for('pyric.admin.appCheck.firebaseVerifier');
const PROJECT_ID = 'my-real-project';
const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:abcdef0123456789`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** The claim set of capture `app-check-admin-create-token-shape`, with a production-style `kid`. */
const FIREBASE_HEADER = { alg: 'RS256', kid: 'vlhDMA', typ: 'JWT' };
const CLAIMS = () => ({
  sub: APP_ID,
  aud: [`projects/${PROJECT_NUMBER}`, `projects/${PROJECT_ID}`],
  provider: 'debug',
  iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
  iat: nowSeconds(),
  exp: nowSeconds() + 3600,
  jti: `jti-${Math.random()}`,
});

const NOT_SANDBOX_MESSAGE =
  "This App Check token was not minted by the Pyric sandbox, so the sandbox's firebase-admin/app-check cannot verify it. " +
  'A page in production AI mode gets its App Check tokens from Firebase. Start this server in production AI mode too ' +
  '(PYRIC_AI_MODE=production) and Pyric verifies them with firebase-admin. In sandbox AI mode, page tokens come from the sandbox and verify here.';
const INSTALL_MESSAGE =
  'Production AI mode verifies App Check tokens from Firebase with firebase-admin, which is not installed beside this server. ' +
  'Install it in the project that runs the server (npm install firebase-admin) and restart.';
const SIGNATURE_MESSAGE = 'The provided App Check token has invalid signature.';

type Verifier = (token: string, projectId: string) => Promise<unknown>;
interface Call {
  token: string;
  projectId: string;
  extra: number;
}

function install(verifier: Verifier | undefined): void {
  const global = globalThis as Record<symbol, unknown>;
  if (verifier === undefined) delete global[VERIFIER];
  else global[VERIFIER] = verifier;
}

/** A verifier that records its calls and resolves with firebase-admin's shape. */
function stubVerifier(): { calls: Call[]; verifier: Verifier } {
  const calls: Call[] = [];
  const verifier = async (token: string, projectId: string, ...rest: unknown[]) => {
    calls.push({ token, projectId, extra: rest.length });
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return { appId: claims.sub, token: { ...claims, app_id: claims.sub } };
  };
  return { calls, verifier: verifier as Verifier };
}

let appSeq = 0;
function appCheck(options: Record<string, unknown> = { projectId: PROJECT_ID }) {
  appSeq += 1;
  const config = { sandbox: initializeSandbox(), ...options } as Parameters<typeof initializeApp>[0];
  return getAppCheck(initializeApp(config, `app-check-firebase-token-${appSeq}`));
}

async function rejection(operation: () => Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await operation();
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: String(e.code), message: String(e.message) };
  }
  return null;
}

const firebaseToken = () => signAppCheckToken(FIREBASE_HEADER, CLAIMS());

afterEach(async () => {
  install(undefined);
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('a Firebase App Check token with no verifier installed', () => {
  it('is refused with app-check/invalid-argument and a message that says why', async () => {
    expect(await rejection(async () => appCheck().verifyToken(await firebaseToken()))).toEqual({
      code: 'app-check/invalid-argument',
      message: NOT_SANDBOX_MESSAGE,
    });
  });

  it('meets the project check first, as firebase-admin resolves the project before decoding', async () => {
    const saved = { g: process.env.GOOGLE_CLOUD_PROJECT, gc: process.env.GCLOUD_PROJECT };
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    try {
      const refused = await rejection(async () => appCheck({}).verifyToken(await firebaseToken()));
      expect(refused?.code).toBe('app-check/invalid-credential');
    } finally {
      if (saved.g !== undefined) process.env.GOOGLE_CLOUD_PROJECT = saved.g;
      if (saved.gc !== undefined) process.env.GCLOUD_PROJECT = saved.gc;
    }
  });
});

describe('a Firebase App Check token with a verifier installed', () => {
  it("hands the token and the app's project to the verifier, and returns its result unchanged", async () => {
    const { calls, verifier } = stubVerifier();
    const sentinel = { appId: APP_ID, token: { app_id: APP_ID, sub: APP_ID, marker: 'from-firebase-admin' } };
    install(async (token, projectId) => {
      await verifier(token, projectId);
      return sentinel;
    });
    const token = await firebaseToken();
    const result = await appCheck().verifyToken(token);
    expect(result).toBe(sentinel as never);
    expect(calls).toEqual([{ token, projectId: PROJECT_ID, extra: 0 }]);
  });

  it('names the project a cert() credential carries', async () => {
    const { calls, verifier } = stubVerifier();
    install(verifier);
    const service = appCheck({ credential: cert({ project_id: 'demo-cert' }) });
    await rejection(async () => service.verifyToken(await firebaseToken()));
    expect(calls.map((call) => call.projectId)).toEqual(['demo-cert']);
  });

  it('passes firebase-admin errors through unchanged', async () => {
    const failure = Object.assign(new Error(SIGNATURE_MESSAGE), { code: 'app-check/invalid-argument' });
    install(async () => {
      throw failure;
    });
    let caught: unknown;
    try {
      await appCheck().verifyToken(await firebaseToken());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });

  it('says to install firebase-admin when the verifier cannot load it', async () => {
    install(async () => {
      throw Object.assign(new Error("Cannot find package 'firebase-admin' imported from /srv/node_modules/@pyric/cli/dist/register/app-bridge-admin-app-check.js"), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
    });
    expect(await rejection(async () => appCheck().verifyToken(await firebaseToken()))).toEqual({
      code: 'app-check/invalid-argument',
      message: INSTALL_MESSAGE,
    });
  });

  it('passes any other missing module through', async () => {
    const failure = Object.assign(new Error("Cannot find package 'jwks-rsa' imported from /srv/node_modules/firebase-admin/lib/utils/jwt.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    install(async () => {
      throw failure;
    });
    let caught: unknown;
    try {
      await appCheck().verifyToken(await firebaseToken());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });

  it('records consume in the process: false, then true, and never forwards it', async () => {
    const { calls, verifier } = stubVerifier();
    install(verifier);
    const service = appCheck();
    const token = await firebaseToken();
    const first = await service.verifyToken(token, { consume: true });
    const second = await service.verifyToken(token, { consume: true });
    const plain = await service.verifyToken(token);
    expect([first.alreadyConsumed, second.alreadyConsumed]).toEqual([false, true]);
    expect('alreadyConsumed' in plain).toBe(false);
    expect(calls.map((call) => call.extra)).toEqual([0, 0, 0]);
    expect(first.appId).toBe(APP_ID);
  });

  it('never sees a sandbox token, a token with no kid, or a malformed token', async () => {
    const { calls, verifier } = stubVerifier();
    install(verifier);
    const service = appCheck();
    const sandbox = await service.createToken(APP_ID);
    expect((await service.verifyToken(sandbox.token)).appId).toBe(APP_ID);
    const { kid: _kid, ...noKid } = FIREBASE_HEADER;
    expect((await service.verifyToken(await signAppCheckToken(noKid, CLAIMS()))).appId).toBe(APP_ID);
    expect((await rejection(() => service.verifyToken('not-a-jwt')))?.message).toMatch(/^Decoding App Check token failed/);
    expect(calls).toEqual([]);
  });

  it('gives a tampered sandbox token production\'s signature message', async () => {
    const { calls, verifier } = stubVerifier();
    install(verifier);
    const service = appCheck();
    const { token } = await service.createToken(APP_ID);
    const [header, payload, signature] = token.split('.');
    const flipped = `${signature!.slice(0, -2)}${signature!.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await rejection(() => service.verifyToken(`${header}.${payload}.${flipped}`))).toEqual({
      code: 'app-check/invalid-argument',
      message: SIGNATURE_MESSAGE,
    });
    expect(calls).toEqual([]);
  });
});
