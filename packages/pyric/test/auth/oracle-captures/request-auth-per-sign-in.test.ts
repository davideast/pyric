/**
 * Replays the production captures `auth-request-auth-per-sign-in` and
 * `auth-request-auth-rules-test-api` through the in-page sandbox across RTDB,
 * Firestore, and Storage for all 15 recorded session kinds.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setDatabaseRules } from 'pyric/sandbox/database';
import { get, getDatabase, ref } from 'pyric/database';
import { doc, getDoc, getFirestore } from 'pyric/firestore';
import { getMetadata, getStorageSandbox, ref as storageRef, uploadString } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { evaluateStorageRules, parseStorageRules } from '@pyric/rules/internal/storage';
import { probesFor, type Claims } from '../../../../conformance/src/auth-request-auth-probes.ts';
import {
  sessionSuite,
  SYNTHETIC,
} from '../../../../conformance/src/capture-auth-request-auth-rules-test-api.ts';
import { firestoreRules } from '../../../src/rules/index.js';
import {
  EmailAuthProvider,
  getAuth,
  reauthenticateWithCredential,
  reload,
  sandbox as authSandbox,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  updateProfile,
  type Auth,
  type User,
} from '../../../src/auth/index.js';
import { mintCustomTokenFor } from '../../../src/auth/internal.js';
import { getClock } from '../../../src/sandbox/internal/index.js';
import type { Sandbox } from '../../../src/sandbox/index.js';

function load(stem: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../conformance/observations/auth/${stem}.json`, import.meta.url),
      'utf8',
    ),
  );
}

interface ObservedIdTokenResult {
  authTime: string;
  issuedAtTime: string;
  expirationTime: string;
  signInSecondFactor: string | null;
  keys: string[];
  expMinusIat: number;
  authTimeBeforeIat: boolean;
}

const UTC_DATE_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function classifyTimeString(value: unknown): string {
  if (typeof value !== 'string') {
    return typeof value;
  }
  if (UTC_DATE_RE.test(value)) {
    return 'toUTCString';
  }
  return value;
}

const OBSERVATION = load('auth-request-auth-per-sign-in') as {
  behavior: Record<
    string,
    {
      claims?: Claims | null;
      signInProvider?: string | null;
      idTokenResult?: ObservedIdTokenResult;
      rtdb?: Record<string, string>;
    }
  >;
};

const TEST_API = load('auth-request-auth-rules-test-api') as {
  behavior: Record<string, { firestore: Record<string, string>; storage: Record<string, string> }>;
};

interface Run {
  sandbox: Sandbox;
  auth: Auth;
  user: User | null;
}

const PASSWORD = 'secret-pw';
let storageSeq = 0;

function fresh(): { sandbox: Sandbox; auth: Auth } {
  const sandbox = initializeSandbox();
  return { sandbox, auth: getAuth(sandbox) };
}

async function password(extra: Parameters<typeof authSandbox.createUser>[1] = {}): Promise<Run> {
  const { sandbox, auth } = fresh();
  authSandbox.createUser(auth, { email: 'ada@example.com', password: PASSWORD, ...extra });
  const { user } = await signInWithEmailAndPassword(auth, 'ada@example.com', PASSWORD);
  return { sandbox, auth, user };
}

function requireUser(user: User | null): User {
  if (user === null) {
    throw new Error('Expected signed-in User');
  }
  return user;
}

const KINDS: Record<string, () => Promise<Run>> = {
  signedOut: async () => ({ ...fresh(), user: null }),
  anonymous: async () => {
    const { sandbox, auth } = fresh();
    const cred = await signInAnonymously(auth);
    return { sandbox, auth, user: cred.user };
  },
  passwordUnverified: () => password(),
  passwordVerifiedProfile: () =>
    password({
      emailVerified: true,
      displayName: 'Ada',
      photoUrl: 'https://example.com/ada.png',
      phoneNumber: '+16505550100',
    }),
  customTokenNewUid: async () => {
    const { sandbox, auth } = fresh();
    const token = mintCustomTokenFor(auth, 'hunt-ct', {
      role: 'oracle',
      level: 5,
      ratio: 1.5,
      flag: true,
      nested: { team: 'a' },
      tags: ['x', 'y'],
    });
    const cred = await signInWithCustomToken(auth, token);
    return { sandbox, auth, user: cred.user };
  },
  customTokenExistingEmailAccount: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, {
      email: 'ada@example.com',
      password: PASSWORD,
      emailVerified: true,
      displayName: 'Ada',
      photoUrl: 'https://example.com/ada.png',
      phoneNumber: '+16505550100',
    });
    const cred = await signInWithCustomToken(auth, mintCustomTokenFor(auth, record.uid));
    return { sandbox, auth, user: cred.user };
  },
  setCustomUserClaimsThenRefresh: async () => {
    const run = await password();
    const activeUser = requireUser(run.user);
    authSandbox.updateUser(run.auth, activeUser.uid, {
      customClaims: {
        admin: true,
        tier: 2,
        email: 'custom@example.com',
        email_verified: true,
        user_id: 'custom-user-id',
        phone_number: '+15550000000',
        name: 'custom-name',
      },
    });
    getClock(run.sandbox).advance(2000);
    await activeUser.getIdToken(true);
    return run;
  },
  forcedRefreshLater: async () => {
    const run = await password();
    const activeUser = requireUser(run.user);
    getClock(run.sandbox).advance(3000);
    await activeUser.getIdToken(true);
    return run;
  },
  reloadAfterAdminChanges: async () => {
    const run = await password();
    const activeUser = requireUser(run.user);
    authSandbox.updateUser(run.auth, activeUser.uid, {
      customClaims: { admin: true },
      emailVerified: true,
    });
    await reload(activeUser);
    return run;
  },
  updateProfileThenToken: async () => {
    const run = await password();
    const activeUser = requireUser(run.user);
    await updateProfile(activeUser, {
      displayName: 'Ada renamed',
      photoURL: 'https://example.com/ada.png',
    });
    return run;
  },
  customTokenOverStoredClaims: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, {
      email: 'ada@example.com',
      password: PASSWORD,
      customClaims: { foo: 'api', key1: 'kept', role: 'editor' },
    });
    const token = mintCustomTokenFor(auth, record.uid, {
      foo: 'token',
      key2: 'added',
      admin: true,
    });
    const cred = await signInWithCustomToken(auth, token);
    return { sandbox, auth, user: cred.user };
  },
  passwordAfterCustomToken: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, {
      email: 'ada@example.com',
      password: PASSWORD,
      customClaims: { foo: 'api', key1: 'kept', role: 'editor' },
    });
    await signInWithCustomToken(
      auth,
      mintCustomTokenFor(auth, record.uid, { foo: 'token', key2: 'added', admin: true }),
    );
    await auth.signOut();
    const cred = await signInWithEmailAndPassword(auth, 'ada@example.com', PASSWORD);
    return { sandbox, auth, user: cred.user };
  },
  customTokenReload: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, {
      email: 'ada@example.com',
      password: PASSWORD,
    });
    const { user } = await signInWithCustomToken(auth, mintCustomTokenFor(auth, record.uid));
    await reload(user);
    return { sandbox, auth, user };
  },
  customTokenReauthPassword: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, {
      email: 'ada@example.com',
      password: PASSWORD,
    });
    const { user } = await signInWithCustomToken(auth, mintCustomTokenFor(auth, record.uid));
    getClock(sandbox).advance(1500);
    await reauthenticateWithCredential(
      user,
      EmailAuthProvider.credential('ada@example.com', PASSWORD),
    );
    return { sandbox, auth, user };
  },
  emailLink: async () => {
    const { sandbox, auth } = fresh();
    await sendSignInLinkToEmail(auth, 'ada@example.com', {
      url: 'https://app.example.com/finish',
      handleCodeInApp: true,
    });
    const mail = authSandbox.takeAuthMail(auth);
    if (mail === null) {
      throw new Error('Expected outbound sign-in link mail');
    }
    const { user } = await signInWithEmailLink(auth, 'ada@example.com', mail.link);
    return { sandbox, auth, user };
  },
};

function claimType(v: unknown): string {
  if (v === '<int>' || v === '<float>') {
    return v;
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      return '<int>';
    }
    return '<float>';
  }
  if (Array.isArray(v)) {
    return 'list';
  }
  if (v && typeof v === 'object') {
    return 'map';
  }
  return typeof v;
}

function shapeOf(claims: Claims | null | undefined, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const sourceClaims = claims ?? {};
  for (const [k, v] of Object.entries(sourceClaims)) {
    let key = k;
    if (prefix.length > 0) {
      key = `${prefix}.${k}`;
    }
    out[key] = claimType(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, shapeOf(v as Claims, key));
    }
  }
  return out;
}

async function verdict(read: () => Promise<unknown>): Promise<'ALLOW' | 'DENY'> {
  try {
    await read();
    return 'ALLOW';
  } catch {
    return 'DENY';
  }
}

async function evaluate(run: Run) {
  let claims: Claims | null = null;
  let signInProvider: string | null = null;
  let uid: string | null = null;
  let idTokenResult: Awaited<ReturnType<User['getIdTokenResult']>> | null = null;
  if (run.user !== null) {
    uid = run.user.uid;
    idTokenResult = await run.user.getIdTokenResult();
    claims = idTokenResult.claims as Claims;
    signInProvider = idTokenResult.signInProvider ?? null;
  }
  const probes = probesFor(uid, claims, signInProvider);
  // Production read every probe at least 8 s after the sign-in.
  getClock(run.sandbox).advance(10_000);

  const rtdbProbes = probes
    .map((p, i) => ({ ...p, id: `p${i}` }))
    .filter((p): p is typeof p & { rtdb: string; id: string } => p.rtdb !== null);
  setDatabaseRules(run.sandbox, {
    rules: Object.fromEntries(rtdbProbes.map((p) => [p.id, { '.read': p.rtdb }])),
  });

  const celProbes = probes
    .map((p, i) => ({ ...p, id: `p${i}` }))
    .filter((p): p is typeof p & { cel: string; id: string } => p.cel !== null);
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(run.sandbox.withAuth(null)).setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${celProbes.map((p) => `    match /${p.id}/{doc} { allow get: if ${p.cel}; }`).join('\n')}
  }
}`);

  storageSeq += 1;
  const dbName = `pyric-request-auth-${storageSeq}`;
  const adminStorage = getAdminStorageSandbox(run.sandbox, { dbName });
  for (const p of celProbes) {
    await uploadString(storageRef(adminStorage, `${p.id}/d`), 'ok');
  }
  const userStorage = getStorageSandbox(run.sandbox, {
    dbName,
    rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${celProbes.map((p) => `    match /${p.id}/{doc} { allow get: if ${p.cel}; }`).join('\n')}
  }
}`,
  });

  const db = getDatabase(run.sandbox);
  const fs = getFirestore(run.sandbox);
  const rtdb: Record<string, string> = {};
  for (const p of rtdbProbes) {
    rtdb[p.label] = await verdict(() => get(ref(db, p.id)));
  }
  const firestore: Record<string, string> = {};
  for (const p of celProbes) {
    firestore[p.label] = await verdict(() => getDoc(doc(fs, `${p.id}/d`)));
  }
  const storage: Record<string, string> = {};
  for (const p of celProbes) {
    storage[p.label] = await verdict(() => getMetadata(storageRef(userStorage, `${p.id}/d`)));
  }
  return { claims, rtdb, firestore, storage, signInProvider, idTokenResult };
}

function differences(
  kind: string,
  rtdb: Record<string, string>,
  firestore: Record<string, string>,
  storage: Record<string, string>,
  production: { rtdb?: Record<string, string>; claims?: Claims | null },
  claims: Claims | null,
) {
  const out: Record<string, { pyric: string; production: string }> = {};
  for (const [label, v] of Object.entries(rtdb)) {
    const expected = production.rtdb?.[label] ?? 'ALLOW';
    if (v !== expected) {
      out[`rtdb ${kind} :: ${label}`] = { pyric: v, production: expected };
    }
  }
  for (const [label, v] of Object.entries(firestore)) {
    if (v !== 'ALLOW') {
      out[`firestore ${kind} :: ${label}`] = { pyric: v, production: 'ALLOW' };
    }
  }
  for (const [label, v] of Object.entries(storage)) {
    // Production Storage represents signed-out requests as an absent `request.auth`
    // property (`Property auth is undefined on object.`), whereas every signed-in
    // probe evaluates `ALLOW`.
    let expectedStorage = 'ALLOW';
    if (kind === 'signedOut') {
      expectedStorage = 'DENY';
    }
    if (v !== expectedStorage) {
      out[`storage ${kind} :: ${label}`] = { pyric: v, production: expectedStorage };
    }
  }
  const pyricShape = shapeOf(claims);
  const productionShape = shapeOf(production.claims ?? null);
  for (const key of new Set([...Object.keys(pyricShape), ...Object.keys(productionShape)])) {
    const pyricType = pyricShape[key] ?? 'absent';
    const productionType = productionShape[key] ?? 'absent';
    if (pyricType !== productionType) {
      out[`shape ${kind} :: ${key}`] = { pyric: pyricType, production: productionType };
    }
  }
  return out;
}

describe('request.auth per sign-in kind matches the production capture across RTDB, Firestore, and Storage', () => {
  for (const [kind, setUp] of Object.entries(KINDS)) {
    const production = OBSERVATION.behavior[kind];
    it(`${kind}: RTDB, Firestore, and Storage read pyric's own token as production reads its own`, async () => {
      expect(production).toBeDefined();
      const run = await setUp();
      try {
        const { rtdb, firestore, storage, claims, signInProvider, idTokenResult } = await evaluate(run);
        const found = differences(kind, rtdb, firestore, storage, production, claims);
        const expectedProvider = production.signInProvider ?? null;
        if (signInProvider !== expectedProvider) {
          found[`provider ${kind} :: signInProvider`] = {
            pyric: String(signInProvider),
            production: String(expectedProvider),
          };
        }
        const expectedResult = production.idTokenResult;
        if (expectedResult !== undefined) {
          if (idTokenResult === null) {
            found[`idTokenResult ${kind}`] = { pyric: 'null', production: 'present' };
          } else {
            const actualSummary: ObservedIdTokenResult = {
              authTime: classifyTimeString(idTokenResult.authTime),
              issuedAtTime: classifyTimeString(idTokenResult.issuedAtTime),
              expirationTime: classifyTimeString(idTokenResult.expirationTime),
              signInSecondFactor: idTokenResult.signInSecondFactor ?? null,
              keys: Object.keys(idTokenResult).sort(),
              expMinusIat:
                Number(idTokenResult.claims['exp']) - Number(idTokenResult.claims['iat']),
              authTimeBeforeIat:
                Number(idTokenResult.claims['auth_time']) < Number(idTokenResult.claims['iat']),
            };
            expect(actualSummary).toEqual(expectedResult);
          }
        }
        expect(found).toEqual({});
      } finally {
        run.sandbox.dispose();
      }
    });
  }
});

describe('firestoreRules().simulate and evaluateStorageRules read real token claim sets as production does', () => {
  for (const [kind, production] of Object.entries(TEST_API.behavior)) {
    it(`${kind}: every Firestore and signed-in Storage probe matches the Rules Test API capture`, () => {
      const fsSuite = sessionSuite('firestore', OBSERVATION.behavior[kind] as never);
      let fsAuth: { uid: string; token: Record<string, unknown> } | null = null;
      if (fsSuite.uid !== null) {
        fsAuth = { uid: fsSuite.uid, token: fsSuite.claims ?? {} };
      }
      const fsSummary = firestoreRules(fsSuite.source).simulate(
        fsSuite.labels.map((label, i) => ({
          description: label,
          expectation: 'ALLOW' as const,
          method: 'get' as const,
          path: `p${i}/d`,
          auth: fsAuth,
        })),
      );
      const found: Record<string, { pyric: string; production: string }> = {};
      fsSummary.cases.forEach((c, i) => {
        const label = fsSuite.labels[i] ?? '';
        const expected = production.firestore[label] ?? 'ALLOW';
        if (c.decision !== expected) {
          found[`firestore ${kind} :: ${label}`] = { pyric: c.decision, production: expected };
        }
      });

      if (kind !== 'signedOut') {
        const stSuite = sessionSuite('storage', OBSERVATION.behavior[kind] as never);
        const parsedStorage = parseStorageRules(stSuite.source);
        let stAuth: { uid: string; token: Record<string, unknown> } | null = null;
        if (stSuite.uid !== null) {
          stAuth = { uid: stSuite.uid, token: stSuite.claims ?? {} };
        }
        stSuite.labels.forEach((label, i) => {
          const res = evaluateStorageRules(parsedStorage, {
            request: {
              method: 'get',
              path: `/b/${SYNTHETIC.projectId}.appspot.com/o/p${i}/o`,
              auth: stAuth,
            },
          });
          let stDecision = 'DENY';
          if (res.allowed) {
            stDecision = 'ALLOW';
          }
          const expected = production.storage[label] ?? 'ALLOW';
          if (stDecision !== expected) {
            found[`storage ${kind} :: ${label}`] = { pyric: stDecision, production: expected };
          }
        });
      }

      expect(found).toEqual({});
    });
  }
});
