/**
 * The account a live record names: the uid and the ID token's claim names,
 * read from the app's own Auth, never the token.
 *
 * In production the Auth SDK holds a signed token from Google's token
 * service; under `connectAuthEmulator` it holds the emulator's unsigned one.
 * The user object, its `uid` and its `accessToken` are the same SDK class
 * either way, so these tests drive the production shape directly: a real
 * Auth with no emulator connected, made current with a user that carries a
 * signed (RS256) token, and plain objects of the same shape. Nothing here
 * reaches a network: `fetch` throws if anything calls it.
 */
import { createRequire } from 'node:module';
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realAuth from 'firebase/auth';
import * as realFirestore from 'firebase/firestore';
import { accountOf, claimNamesOf, liveModuleFor, noteAuth, type LiveCallRecord, type LiveModuleSite } from '../src/index.js';

/** A JWT with `claims`, signed or, as the Auth emulator mints it, not. */
function idToken(claims: Record<string, unknown>, signed: boolean): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = signed ? { alg: 'RS256', kid: 'key-1', typ: 'JWT' } : { alg: 'none', typ: 'JWT' };
  const signature = signed ? Buffer.from('signature-bytes').toString('base64url') : '';
  return `${segment(header)}.${segment(claims)}.${signature}`;
}

/** The claims of a production ID token for an email and password account, with one custom claim. */
const PRODUCTION_CLAIMS = {
  admin: true,
  iss: 'https://securetoken.google.com/prod-project',
  aud: 'prod-project',
  auth_time: 1_700_000_000,
  user_id: 'alice',
  sub: 'alice',
  iat: 1_700_000_000,
  exp: 1_700_003_600,
  email: 'alice@example.com',
  email_verified: true,
  firebase: { identities: { email: ['alice@example.com'] }, sign_in_provider: 'password' },
};
const CLAIM_NAMES = ['admin', 'aud', 'auth_time', 'email', 'email_verified', 'exp', 'firebase', 'iat', 'iss', 'sub', 'user_id'];

describe('claim names', () => {
  test('a signed production token and an unsigned emulator token give the same sorted names', () => {
    expect(claimNamesOf(idToken(PRODUCTION_CLAIMS, true))).toEqual(CLAIM_NAMES);
    expect(claimNamesOf(idToken(PRODUCTION_CLAIMS, false))).toEqual(CLAIM_NAMES);
  });

  test('carry no claim value', () => {
    const names = JSON.stringify(claimNamesOf(idToken(PRODUCTION_CLAIMS, true)));
    expect(names).not.toContain('alice');
    expect(names).not.toContain('prod-project');
  });

  test('a name in another script reads as itself', () => {
    expect(claimNamesOf(idToken({ 'rôle': 'x', sub: 'a' }, true))).toEqual(['rôle', 'sub']);
  });

  test('a host takes at most 64 names of at most 128 characters', () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`c${String(index).padStart(2, '0')}`, 1]));
    expect(claimNamesOf(idToken(many, true))).toHaveLength(64);
    expect(claimNamesOf(idToken({ ['x'.repeat(129)]: 1, sub: 'a' }, true))).toEqual(['sub']);
  });

  for (const [label, token] of [
    ['an opaque string', 'not-a-jwt'],
    ['a payload that is not JSON', 'aGVhZA.bm90IGpzb24.c2ln'],
    ['a payload that is an array', `e30.${Buffer.from('[1]').toString('base64url')}.c2ln`],
    ['a payload that is not base64url', 'e30.***.c2ln'],
    ['a number', 7],
    ['nothing', undefined],
  ] as const) {
    test(`${label} names none`, () => {
      expect(claimNamesOf(token)).toBeUndefined();
    });
  }
});

describe('the account a call runs as, in the shape the production SDK holds', () => {
  const app = { name: 'prod', options: { projectId: 'prod-project' } };
  const user = { uid: 'alice', accessToken: idToken(PRODUCTION_CLAIMS, true) };
  const auth: { app: object; currentUser: object | null } = { app, currentUser: user };
  noteAuth(auth);
  Object.assign(user, { auth });

  test("a reference's, a Firestore instance's, an Auth's, a user's and the app's own call name the app's current user", () => {
    const expected = { uid: 'alice', claimNames: CLAIM_NAMES };
    expect(accountOf({ firestore: { app } })).toEqual(expected);
    expect(accountOf({ app })).toEqual(expected);
    expect(accountOf(auth)).toEqual(expected);
    expect(accountOf(user)).toEqual(expected);
    expect(accountOf(app)).toEqual(expected);
  });

  test('signed out names no account', () => {
    auth.currentUser = null;
    try {
      expect(accountOf({ firestore: { app } })).toBeUndefined();
    } finally {
      auth.currentUser = user;
    }
  });

  test('an app whose Auth live mode never handed out names no account', () => {
    expect(accountOf({ firestore: { app: { options: { projectId: 'other' } } } })).toBeUndefined();
  });

  test('a user whose token is not a JWT names the uid only', () => {
    const other = { name: 'opaque', options: {} };
    noteAuth({ app: other, currentUser: { uid: 'bob', accessToken: 'opaque' } });
    expect(accountOf({ app: other })).toEqual({ uid: 'bob' });
  });

  test('a value that throws on read names no account, and noting it does not throw', () => {
    const throwing = new Proxy({}, { get: () => { throw new Error('read'); }, has: () => { throw new Error('has'); } });
    expect(accountOf(throwing)).toBeUndefined();
    expect(accountOf({ firestore: throwing })).toBeUndefined();
    expect(() => noteAuth(throwing)).not.toThrow();
  });
});

/**
 * The real SDK in production mode: no emulator connected, the user made
 * current from the JSON shape the SDK persists, with a signed token. The
 * user is built by `@firebase/auth`'s own `UserImpl`, the class a production
 * sign-in returns, from the copy `firebase/auth` itself resolves.
 */
describe('the real SDK in production mode', async () => {
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() => {
    throw new Error('a test reached the network');
  }) as unknown as typeof fetch);
  const firebaseAuthFile = createRequire(import.meta.url).resolve('firebase/auth');
  const internalFile = createRequire(firebaseAuthFile).resolve('@firebase/auth/internal');
  const { UserImpl } = await import(internalFile) as { UserImpl: { _fromJSON(auth: unknown, json: object): realAuth.User } };

  const records: LiveCallRecord[] = [];
  const site: LiveModuleSite = { observer: (record) => records.push(record), sdkVersion: realApp.SDK_VERSION, client: 'node' };
  const auth = liveModuleFor('firebase/auth', realAuth, site);
  const firestore = liveModuleFor('firebase/firestore', realFirestore, site);
  const options = { apiKey: 'prod-api-key', projectId: 'prod-project', appId: '1:123456789012:web:0a1b2c3d4e5f6071' };
  const app = realApp.initializeApp(options, 'live-account-production');
  const appAuth = auth.getAuth(app);
  const db = firestore.getFirestore(app);
  await realFirestore.disableNetwork(db);

  afterAll(async () => {
    await realFirestore.terminate(db);
    await realApp.deleteApp(app);
    fetchSpy.mockRestore();
  });

  test('the wrapped getAuth returns the SDK\'s own Auth instance', () => {
    expect(appAuth).toBe(realAuth.getAuth(app));
  });

  test('a call made signed out names no account', async () => {
    records.length = 0;
    await firestore.getDocFromCache(firestore.doc(db, 'rooms/lobby')).catch(() => undefined);
    expect(records.map((record) => record.account)).toEqual([undefined]);
  });

  test('a Firestore call made signed in names the uid and the claim names, never the token', async () => {
    const token = idToken({ ...PRODUCTION_CLAIMS, exp: Math.floor(Date.now() / 1000) + 3600 }, true);
    const user = UserImpl._fromJSON(appAuth, {
      uid: 'alice', email: 'alice@example.com', emailVerified: true, isAnonymous: false,
      providerData: [], createdAt: '1700000000000', lastLoginAt: '1700000000000', apiKey: options.apiKey, appName: app.name,
      stsTokenManager: { refreshToken: 'refresh', accessToken: token, expirationTime: Date.now() + 3_600_000 },
    });
    await realAuth.updateCurrentUser(appAuth, user);
    records.length = 0;
    await firestore.getDocFromCache(firestore.doc(db, 'rooms/lobby')).catch(() => undefined);
    expect(records).toHaveLength(1);
    expect(records[0]!.account).toEqual({ uid: 'alice', claimNames: [...CLAIM_NAMES].sort() });
    expect(JSON.stringify(records)).not.toContain(token.split('.')[1]!);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("the wrapped getAuth lists the SDK's own Auth on the page hub", () => {
    const hub = (globalThis as { [key: symbol]: { auths: object[] } | undefined })[Symbol.for('pyric.live.auths')];
    expect(hub?.auths).toContain(realAuth.getAuth(app));
  });
});

/**
 * The page runtime's seam: each Auth the live row hands the app is listed on
 * the page-wide hub under `Symbol.for('pyric.live.auths')`, where the cli page
 * runtime (`serve/runtime/live-identity.ts`) reads the signed-in user. The hub
 * holds Auth instances only, never a user's profile.
 */
describe('the page hub of noted Auth instances', () => {
  type Hub = { auths: object[]; listeners: Set<(auth: object) => void> };
  const hub = () => (globalThis as { [key: symbol]: Hub | undefined })[Symbol.for('pyric.live.auths')];

  test('a noted Auth is listed once and reaches each hub listener', () => {
    const auth = { app: { name: 'hub-app' }, currentUser: null };
    const heard: object[] = [];
    noteAuth({ app: { name: 'hub-first' }, currentUser: null });
    hub()!.listeners.add((noted) => heard.push(noted));
    noteAuth(auth);
    noteAuth(auth);
    expect(hub()!.auths.filter((noted) => noted === auth)).toHaveLength(1);
    expect(heard).toEqual([auth]);
  });

  test('a value that is not an Auth is not listed', () => {
    const before = hub()?.auths.length ?? 0;
    noteAuth({ app: {} });
    noteAuth(null);
    expect(hub()?.auths.length ?? 0).toBe(before);
  });
});
