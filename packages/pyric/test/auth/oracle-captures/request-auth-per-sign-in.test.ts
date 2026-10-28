/**
 * Replays the production capture `auth-request-auth-per-sign-in` through the
 * in-page sandbox: what RTDB `auth` and Firestore `request.auth` contain for
 * each sign-in kind.
 *
 * Production signed in for real, decoded each ID token, and deployed one rule
 * per claim built from that token (`auth.token.<claim> == <decoded value>`,
 * absence checks, `sub == uid`, `exp - iat == 3600`, ...); every probe was
 * ALLOW, so production rules read the decoded token, exact values included.
 * Here each kind signs in through `pyric/auth`, the same probes are built from
 * pyric's own `getIdTokenResult().claims`, and both engines evaluate them in
 * the in-page sandbox. A probe must be ALLOW, as in production, unless a pin
 * names the finding and both answers; the claim shape must match production's
 * key for key, unless a pin names the difference. Fixing a finding turns its
 * pin red, and the fix deletes the pin.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setDatabaseRules } from 'pyric/sandbox/database';
import { get, getDatabase, ref } from 'pyric/database';
import { doc, getDoc, getFirestore } from 'pyric/firestore';
import { probesFor, type Claims } from '../../../../conformance/src/auth-request-auth-probes.ts';
import { sessionSuite } from '../../../../conformance/src/capture-auth-request-auth-rules-test-api.ts';
import { firestoreRules } from '../../../src/rules/index.js';
import {
  EmailAuthProvider,
  getAuth,
  reauthenticateWithCredential,
  reload,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  updateProfile,
  type Auth,
  type User,
} from '../../../src/auth/index.js';
import { getClock } from '../../../src/sandbox/internal/index.js';
import type { Sandbox } from '../../../src/sandbox/index.js';

/** Reads a committed auth capture by stem; the auth completeness gate counts this call as coverage. */
function load(stem: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../../conformance/observations/auth/${stem}.json`, import.meta.url), 'utf8'));
}

const OBSERVATION = load('auth-request-auth-per-sign-in') as {
  behavior: Record<string, { claims?: Claims | null; signInProvider?: string | null; rtdb?: Record<string, string> }>;
};

interface Run { sandbox: Sandbox; auth: Auth; user: User | null }
const PASSWORD = 'secret-pw';

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

/** Each kind as the capture ran it, through pyric's public Auth API. */
const KINDS: Record<string, () => Promise<Run>> = {
  signedOut: async () => ({ ...fresh(), user: null }),
  anonymous: async () => {
    const { sandbox, auth } = fresh();
    return { sandbox, auth, user: (await signInAnonymously(auth)).user };
  },
  passwordUnverified: () => password(),
  passwordVerifiedProfile: () => password({ emailVerified: true, displayName: 'Ada', photoUrl: 'https://example.com/ada.png', phoneNumber: '+16505550100' }),
  customTokenNewUid: async () => {
    const { sandbox, auth } = fresh();
    const token = JSON.stringify({ uid: 'hunt-ct', claims: { role: 'oracle', level: 5, ratio: 1.5, flag: true, nested: { team: 'a' }, tags: ['x', 'y'] } });
    return { sandbox, auth, user: (await signInWithCustomToken(auth, token)).user };
  },
  customTokenExistingEmailAccount: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, { email: 'ada@example.com', password: PASSWORD, emailVerified: true, displayName: 'Ada', photoUrl: 'https://example.com/ada.png', phoneNumber: '+16505550100' });
    return { sandbox, auth, user: (await signInWithCustomToken(auth, JSON.stringify({ uid: record.uid }))).user };
  },
  setCustomUserClaimsThenRefresh: async () => {
    const run = await password();
    authSandbox.updateUser(run.auth, run.user!.uid, {
      customClaims: { admin: true, tier: 2, email: 'custom@example.com', email_verified: true, user_id: 'custom-user-id', phone_number: '+15550000000', name: 'custom-name' },
    });
    await run.user!.getIdToken(true);
    return run;
  },
  forcedRefreshLater: async () => {
    const run = await password();
    getClock(run.sandbox).advance(3000);
    await run.user!.getIdToken(true);
    return run;
  },
  reloadAfterAdminChanges: async () => {
    const run = await password();
    authSandbox.updateUser(run.auth, run.user!.uid, { customClaims: { admin: true }, emailVerified: true });
    await reload(run.user!);
    return run;
  },
  updateProfileThenToken: async () => {
    const run = await password();
    await updateProfile(run.user!, { displayName: 'Ada renamed', photoURL: 'https://example.com/ada.png' });
    return run;
  },
  customTokenOverStoredClaims: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, { email: 'ada@example.com', password: PASSWORD, customClaims: { foo: 'api', key1: 'kept', role: 'editor' } });
    const token = JSON.stringify({ uid: record.uid, claims: { foo: 'token', key2: 'added', admin: true } });
    return { sandbox, auth, user: (await signInWithCustomToken(auth, token)).user };
  },
  passwordAfterCustomToken: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, { email: 'ada@example.com', password: PASSWORD, customClaims: { foo: 'api', key1: 'kept', role: 'editor' } });
    await signInWithCustomToken(auth, JSON.stringify({ uid: record.uid, claims: { foo: 'token', key2: 'added', admin: true } }));
    await auth.signOut();
    return { sandbox, auth, user: (await signInWithEmailAndPassword(auth, 'ada@example.com', PASSWORD)).user };
  },
  customTokenReload: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, { email: 'ada@example.com', password: PASSWORD });
    const { user } = await signInWithCustomToken(auth, JSON.stringify({ uid: record.uid }));
    await reload(user);
    return { sandbox, auth, user };
  },
  customTokenReauthPassword: async () => {
    const { sandbox, auth } = fresh();
    const record = authSandbox.createUser(auth, { email: 'ada@example.com', password: PASSWORD });
    const { user } = await signInWithCustomToken(auth, JSON.stringify({ uid: record.uid }));
    getClock(sandbox).advance(1500);
    await reauthenticateWithCredential(user, EmailAuthProvider.credential('ada@example.com', PASSWORD));
    return { sandbox, auth, user };
  },
};

/**
 * Known disagreements, keyed `<plane> <kind> :: <probe label or claim>`, where
 * the plane is `rtdb`, `firestore`, `shape` (the claim's JSON type, or
 * `absent`) or `provider`. Each holds pyric's answer, production's, and the
 * finding.
 */
const SIGNED_IN = Object.keys(KINDS).filter((kind) => kind !== 'signedOut');

interface PinGroup { finding: string; plane: string; kinds: string[]; labels: string[]; pyric: string; production: string }
const PIN_GROUPS: PinGroup[] = [
  {
    finding: '#1341: the rules token for a signed-in session drops sub, aud, iss, iat, exp and auth_time',
    plane: 'firestore', kinds: SIGNED_IN, pyric: 'DENY', production: 'ALLOW',
    labels: [
      'token.sub equals uid', 'token.sub equals the decoded value', 'token.sub is string',
      'token.aud equals the decoded value', 'token.iss equals the decoded value', 'token.iss is securetoken plus token.aud',
      'token.iat equals the decoded value', 'token.iat is int', 'token.exp equals the decoded value', 'token.exp is int',
      'token.exp minus token.iat is 3600', 'token.auth_time equals the decoded value', 'token.auth_time is int',
      'token.auth_time is at or before token.iat',
    ],
  },
  {
    finding: 'auth-claims RA-1: RTDB auth.token.iat, exp and auth_time are filled from the evaluation time, not taken from the minted token',
    plane: 'rtdb', kinds: SIGNED_IN, pyric: 'DENY', production: 'ALLOW',
    labels: [
      'token.iat equals the decoded value', 'token.exp equals the decoded value', 'token.auth_time equals the decoded value',
      'token.auth_time is more than 5 s before evaluation',
    ],
  },
  {
    finding: 'auth-claims RA-2: the minted token names aud pyric-sandbox and iss https://sandbox.pyric.dev, not the project and securetoken',
    plane: 'rtdb', kinds: SIGNED_IN, pyric: 'DENY', production: 'ALLOW',
    labels: ['token.iss is securetoken plus token.aud'],
  },
  {
    finding: 'auth-claims CO-1: a float custom claim does not read as float in Firestore rules',
    plane: 'firestore', kinds: ['customTokenNewUid'], pyric: 'DENY', production: 'ALLOW',
    labels: ['token.ratio is float'],
  },
  {
    finding: 'auth-claims CO-3: reauthenticating a custom-token session with a password credential keeps sign_in_provider custom',
    plane: 'provider', kinds: ['customTokenReauthPassword'], pyric: 'custom', production: 'password',
    labels: ['signInProvider'],
  },
  {
    finding: 'auth-claims AU-2: custom-token claims replace the stored custom claims instead of merging over them',
    plane: 'shape', kinds: ['customTokenOverStoredClaims', 'passwordAfterCustomToken'], pyric: 'absent', production: 'string',
    labels: ['key1', 'role'],
  },
  {
    finding: 'auth-claims AU-2: custom-token claims are written to the account and reach a later password sign-in',
    plane: 'shape', kinds: ['passwordAfterCustomToken'], pyric: 'boolean', production: 'absent',
    labels: ['admin'],
  },
  {
    finding: 'auth-claims AU-2: custom-token claims are written to the account and reach a later password sign-in',
    plane: 'shape', kinds: ['passwordAfterCustomToken'], pyric: 'string', production: 'absent',
    labels: ['key2'],
  },
];

const PINS: Record<string, { pyric: string; production: string; finding: string }> = Object.fromEntries(
  PIN_GROUPS.flatMap((group) => group.kinds.flatMap((kind) => group.labels.map((label) => [
    `${group.plane} ${kind} :: ${label}`,
    { pyric: group.pyric, production: group.production, finding: group.finding },
  ]))),
);

function claimType(v: unknown): string {
  // The observation records numbers as `<int>` or `<float>`.
  if (v === '<int>' || v === '<float>') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? '<int>' : '<float>';
  if (Array.isArray(v)) return 'list';
  if (v && typeof v === 'object') return 'map';
  return typeof v;
}
function shapeOf(claims: Claims | null | undefined, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(claims ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    out[key] = claimType(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, shapeOf(v as Claims, key));
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
  const result = run.user ? await run.user.getIdTokenResult() : null;
  const claims = (result?.claims ?? null) as Claims | null;
  const probes = probesFor(run.user?.uid ?? null, claims, result?.signInProvider ?? null);
  // Production read every probe at least 8 s after the sign-in.
  getClock(run.sandbox).advance(10_000);
  const rtdbProbes = probes.map((p, i) => ({ ...p, id: `p${i}` })).filter((p) => p.rtdb !== null);
  setDatabaseRules(run.sandbox, { rules: Object.fromEntries(rtdbProbes.map((p) => [p.id, { '.read': p.rtdb! }])) });
  const celProbes = probes.map((p, i) => ({ ...p, id: `p${i}` })).filter((p) => p.cel !== null);
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(run.sandbox.withAuth(null)).setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${celProbes.map((p) => `    match /${p.id}/{doc} { allow get: if ${p.cel}; }`).join('\n')}
  }
}`);
  const db = getDatabase(run.sandbox);
  const fs = getFirestore(run.sandbox);
  const rtdb: Record<string, string> = {};
  for (const p of rtdbProbes) rtdb[p.label] = await verdict(() => get(ref(db, p.id)));
  const firestore: Record<string, string> = {};
  for (const p of celProbes) firestore[p.label] = await verdict(() => getDoc(doc(fs, `${p.id}/d`)));
  return { claims, rtdb, firestore, signInProvider: result?.signInProvider ?? null };
}

/** Every place pyric's answer differs from production's for one kind. */
function differences(kind: string, rtdb: Record<string, string>, firestore: Record<string, string>, production: { rtdb?: Record<string, string>; claims?: Claims | null }, claims: Claims | null) {
  const out: Record<string, { pyric: string; production: string }> = {};
  for (const [label, v] of Object.entries(rtdb)) {
    const expected = production.rtdb?.[label] ?? 'ALLOW';
    if (v !== expected) out[`rtdb ${kind} :: ${label}`] = { pyric: v, production: expected };
  }
  // Production's evaluator allows every Firestore probe on a real token
  // (auth-request-auth-rules-test-api).
  for (const [label, v] of Object.entries(firestore)) {
    if (v !== 'ALLOW') out[`firestore ${kind} :: ${label}`] = { pyric: v, production: 'ALLOW' };
  }
  const pyricShape = shapeOf(claims);
  const productionShape = shapeOf(production.claims ?? null);
  for (const key of new Set([...Object.keys(pyricShape), ...Object.keys(productionShape)])) {
    const pair = { pyric: pyricShape[key] ?? 'absent', production: productionShape[key] ?? 'absent' };
    if (pair.pyric !== pair.production) out[`shape ${kind} :: ${key}`] = pair;
  }
  return out;
}

describe('request.auth per sign-in kind matches the production capture', () => {
  for (const [kind, setUp] of Object.entries(KINDS)) {
    const production = OBSERVATION.behavior[kind];
    it(`${kind}: RTDB and Firestore read pyric's own token as production reads its own`, async () => {
      expect(production).toBeDefined();
      const run = await setUp();
      const { rtdb, firestore, claims, signInProvider } = await evaluate(run);
      const found = differences(kind, rtdb, firestore, production, claims);
      if (signInProvider !== (production.signInProvider ?? null)) {
        found[`provider ${kind} :: signInProvider`] = { pyric: String(signInProvider), production: String(production.signInProvider ?? null) };
      }
      const pinned = Object.fromEntries(Object.entries(PINS)
        .filter(([key]) => key.split(' ')[1] === kind)
        .map(([key, pin]) => [key, { pyric: pin.pyric, production: pin.production }]));
      expect(found).toEqual(pinned);
    });
  }
});

const TEST_API = load('auth-request-auth-rules-test-api') as {
  behavior: Record<string, { firestore: Record<string, string> }>;
};

/** Simulator answers that differ from production's on the same token, keyed `<kind> :: <probe label>`. */
const SIMULATE_PINS: Record<string, { pyric: string; production: string; finding: string }> = {
  'customTokenNewUid :: token.ratio is float': { pyric: 'DENY', production: 'ALLOW', finding: 'auth-claims CO-1: a float custom claim does not read as float in Firestore rules' },
};

describe('firestoreRules().simulate reads a real token claim set as production does', () => {
  for (const [kind, production] of Object.entries(TEST_API.behavior)) {
    it(`${kind}: every probe matches the Rules Test API capture`, () => {
      const { source, labels, claims, uid } = sessionSuite('firestore', OBSERVATION.behavior[kind] as never);
      const summary = firestoreRules(source).simulate(labels.map((label, i) => ({
        description: label, expectation: 'ALLOW' as const, method: 'get' as const, path: `p${i}/d`, auth: uid === null ? null : { uid, token: claims ?? {} },
      })));
      const found: Record<string, { pyric: string; production: string }> = {};
      summary.cases.forEach((c, i) => {
        const expected = production.firestore[labels[i]];
        if (c.decision !== expected) found[`${kind} :: ${labels[i]}`] = { pyric: c.decision, production: expected };
      });
      const pinned = Object.fromEntries(Object.entries(SIMULATE_PINS)
        .filter(([key]) => key.startsWith(`${kind} :: `))
        .map(([key, pin]) => [key, { pyric: pin.pyric, production: pin.production }]));
      expect(found).toEqual(pinned);
    });
  }
});
