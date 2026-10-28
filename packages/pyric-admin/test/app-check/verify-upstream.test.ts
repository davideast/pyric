/**
 * `verifyToken` checks what firebase-admin 13.10.0 checks, in its order and
 * with its messages (lib/app-check/token-verifier.js and lib/utils/jwt.js):
 *
 * 1. the token is a string;
 * 2. content: header `alg` is RS256, `aud` names the project, `iss` is the App
 *    Check issuer, `sub` is a non-empty string;
 * 3. the `kid` names a known key (a missing `kid` is tried against every key);
 * 4. the signature;
 * 5. `nbf` then `exp`, read by jsonwebtoken: absent never applies, a
 *    non-number fails as an invalid signature, a future `nbf` fails as an
 *    invalid signature, and `now >= exp` is expired.
 *
 * The string and options checks throw synchronously, before a promise exists,
 * as upstream's `AppCheck.verifyToken` does.
 *
 * Errors carry firebase-admin's PrefixedFirebaseError shape.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { mintAppCheckToken, signAppCheckToken } from 'pyric/sandbox/internal';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const PROJECT_ID = 'genkit-idx';
const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';
const HEADER = { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const CLAIMS = () => ({
  sub: APP_ID,
  aud: ['projects/123456789012', `projects/${PROJECT_ID}`],
  provider: 'pyric-sandbox',
  iss: 'https://firebaseappcheck.googleapis.com/123456789012',
  iat: nowSeconds(),
  exp: nowSeconds() + 3600,
  jti: `jti-${Math.random()}`,
});

const MESSAGES = {
  notString: 'App check token must be a non-null string.',
  algorithm: (alg: string) => `The provided App Check token has incorrect algorithm. Expected "RS256" but got "${alg}".`,
  noSub: 'The provided App Check token has no "sub" (subject) claim.',
  emptySub: 'The provided App Check token has an empty string "sub" (subject) claim.',
  noMatchingKid:
    'The provided App Check token has "kid" claim which does not correspond to a known public key. Most likely the provided App Check token is expired, so get a fresh token from your client app and try again.',
  signature: 'The provided App Check token has invalid signature.',
  expired: 'The provided App Check token has expired. Get a fresh App Check token from your client app and try again.',
};

let appSeq = 0;
function appCheck() {
  appSeq += 1;
  const config = { sandbox: initializeSandbox(), projectId: PROJECT_ID } as Parameters<typeof initializeApp>[0];
  return getAppCheck(initializeApp(config, `app-check-verify-upstream-${appSeq}`));
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

const invalid = (message: string) => ({ code: 'app-check/invalid-argument', message });

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

/** Calls without awaiting: a synchronous throw is caught here, a rejection is not. */
function syncThrow(operation: () => unknown): { code: string; message: string } | null {
  try {
    const pending = operation() as Promise<unknown> | undefined;
    pending?.catch?.(() => {});
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: String(e.code), message: String(e.message) };
  }
  return null;
}

describe('verifyToken input', () => {
  it('throws synchronously for a token that is not a string, with firebase-admin message', () => {
    const service = appCheck();
    for (const value of [undefined, null, 42, {}]) {
      expect(syncThrow(() => service.verifyToken(value as unknown as string))).toEqual(invalid(MESSAGES.notString));
    }
  });

  it('throws synchronously for options that are not a non-null object', () => {
    const service = appCheck();
    for (const options of [null, 'consume', 1, [true]]) {
      expect(syncThrow(() => service.verifyToken('a.b.c', options as never))).toEqual(
        invalid('VerifyAppCheckTokenOptions must be a non-null object.'),
      );
    }
  });

  it('rejects a segment with characters outside base64url as a decode failure', async () => {
    const token = await signAppCheckToken(HEADER, CLAIMS());
    const [h, p, sig] = token.split('.');
    const decode =
      'Decoding App Check token failed. Make sure you passed the entire string JWT which represents the Firebase App Check token.';
    for (const bad of [`${h}=.${p}.${sig}`, `${h}.${p}+.${sig}`, `${h}.${p}.${sig}/`, ` ${token}`, `${h}..${sig}`]) {
      expect(await rejection(() => appCheck().verifyToken(bad))).toEqual(invalid(decode));
    }
  });
});

describe('verifyToken content', () => {
  it('rejects a missing sub', async () => {
    const { sub: _sub, ...claims } = CLAIMS();
    const token = await signAppCheckToken(HEADER, claims);
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.noSub));
  });

  it('rejects a sub that is not a string', async () => {
    const token = await signAppCheckToken(HEADER, { ...CLAIMS(), sub: 7 });
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.noSub));
  });

  it('rejects an empty sub', async () => {
    const token = await signAppCheckToken(HEADER, { ...CLAIMS(), sub: '' });
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.emptySub));
  });

  it('refuses a token minted for an empty app id', async () => {
    const minted = await mintAppCheckToken({ appId: '', projectId: PROJECT_ID }, 3600);
    expect(await rejection(() => appCheck().verifyToken(minted.token))).toEqual(invalid(MESSAGES.emptySub));
  });

  it('rejects an algorithm other than RS256 before the audience', async () => {
    for (const alg of ['HS256', 'none', 'ES256']) {
      const token = await signAppCheckToken({ ...HEADER, alg }, { ...CLAIMS(), aud: ['projects/elsewhere'] });
      expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.algorithm(alg)));
    }
  });

  it('reports a missing alg as undefined, as firebase-admin does', async () => {
    const { alg: _alg, ...header } = HEADER;
    const token = await signAppCheckToken(header, CLAIMS());
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.algorithm('undefined')));
  });
});

describe('verifyToken key and signature', () => {
  it('rejects a kid that names no known key', async () => {
    const token = await signAppCheckToken({ ...HEADER, kid: 'not-a-key' }, CLAIMS());
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.noMatchingKid));
  });

  it('accepts a sandbox-signed token with no kid, as firebase-admin tries every key', async () => {
    const { kid: _kid, ...header } = HEADER;
    const token = await signAppCheckToken(header, CLAIMS());
    expect((await appCheck().verifyToken(token)).appId).toBe(APP_ID);
  });
});

describe('verifyToken not-before', () => {
  it('fails a future nbf as an invalid signature', async () => {
    const token = await signAppCheckToken(HEADER, { ...CLAIMS(), nbf: nowSeconds() + 3600 });
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.signature));
  });

  it('fails a non-numeric nbf as an invalid signature', async () => {
    const token = await signAppCheckToken(HEADER, { ...CLAIMS(), nbf: 'later' });
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.signature));
  });

  it('checks nbf before exp', async () => {
    const token = await signAppCheckToken(HEADER, { ...CLAIMS(), nbf: nowSeconds() + 3600, exp: nowSeconds() - 1 });
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.signature));
  });

  it('accepts an nbf of now', async () => {
    const token = await signAppCheckToken(HEADER, { ...CLAIMS(), nbf: nowSeconds() });
    expect((await appCheck().verifyToken(token)).appId).toBe(APP_ID);
  });
});

describe('verifyToken expiry', () => {
  it('fails a non-numeric exp as an invalid signature', async () => {
    for (const exp of ['soon', null, [1], { at: 1 }]) {
      const token = await signAppCheckToken(HEADER, { ...CLAIMS(), exp });
      expect(await rejection(() => appCheck().verifyToken(token))).toEqual(invalid(MESSAGES.signature));
    }
  });

  it('never expires a token with no exp', async () => {
    const { exp: _exp, ...claims } = CLAIMS();
    const token = await signAppCheckToken(HEADER, claims);
    expect((await appCheck().verifyToken(token)).appId).toBe(APP_ID);
  });

  it('expires a token whose exp is now', async () => {
    const token = await signAppCheckToken(HEADER, { ...CLAIMS(), exp: nowSeconds() });
    expect(await rejection(() => appCheck().verifyToken(token))).toEqual({
      code: 'app-check/app-check-token-expired',
      message: MESSAGES.expired,
    });
  });
});

describe('App Check error shape', () => {
  it('carries errorInfo, codePrefix, hasCode and toJSON like PrefixedFirebaseError', async () => {
    let caught: unknown;
    try {
      await appCheck().verifyToken('not-a-jwt');
    } catch (error) {
      caught = error;
    }
    const error = caught as Error & {
      code: string;
      errorInfo: { code: string; message: string };
      codePrefix: string;
      hasCode(code: string): boolean;
      toJSON(): unknown;
    };
    const message =
      'Decoding App Check token failed. Make sure you passed the entire string JWT which represents the Firebase App Check token.';
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('app-check/invalid-argument');
    expect(error.message).toBe(message);
    expect(error.errorInfo).toEqual({ code: 'app-check/invalid-argument', message });
    expect(error.codePrefix).toBe('app-check');
    expect(error.hasCode('invalid-argument')).toBe(true);
    expect(error.hasCode('app-check/invalid-argument')).toBe(false);
    expect(error.toJSON()).toEqual({ code: 'app-check/invalid-argument', message });
    expect(Object.keys(error).sort()).toEqual(['codePrefix', 'errorInfo']);
    expect(error.name).toBe('Error');
  });
});

describe('consume', () => {
  it('shares consumed token ids between two copies of the module', async () => {
    const copy = (await import(`../../src/app-check/index.js?copy=${Date.now()}`)) as typeof import('../../src/app-check/index.js');
    expect(copy.getAppCheck).not.toBe(getAppCheck);
    const config = { sandbox: initializeSandbox(), projectId: PROJECT_ID } as Parameters<typeof initializeApp>[0];
    const app = initializeApp(config, 'app-check-consume-copies');
    const { token } = await getAppCheck(app).createToken(APP_ID);
    expect((await getAppCheck(app).verifyToken(token, { consume: true })).alreadyConsumed).toBe(false);
    expect((await copy.getAppCheck(app).verifyToken(token, { consume: true })).alreadyConsumed).toBe(true);
  });
});
