#!/usr/bin/env bun
/**
 * What `auth` contains in production RTDB rules for each sign-in kind, and how
 * the Admin SDK answers the token and user-management calls pyric-admin
 * mirrors.
 *
 * Each session signs in for real through Identity Toolkit with the Web SDK, on
 * its own client app, and decodes its ID token. One `.read` rule per probe is
 * deployed under a run-scoped key on the dedicated oracle instance, each
 * probe an equality or absence check built from that session's decoded token
 * (`auth.token.email == "<the decoded email>"`, `auth.token.uid == null`, ...;
 * see `auth-request-auth-probes.ts`). The session reads each probe path with
 * its live token: ALLOW means production rules saw that claim with that value.
 * Reads only, so no data is written.
 *
 * The decoded claim shapes recorded here feed the Firestore and Storage leg,
 * `capture-auth-request-auth-rules-test-api.ts`.
 *
 * Every test user is created under the name prefix `pyric-hunt-auth-<run>`
 * (uid and email, or, for kinds whose uid production assigns, a display name
 * set through the Admin SDK right after the probed token was minted), recorded
 * as it is created, deleted at the end, and the deletion proven with a lookup.
 * The RTDB rules are snapshotted before the deploy, restored, and read back;
 * the run key is proven absent from the database root. The observation is
 * written only when all three hold.
 *
 * Inert without PYRIC_ORACLE_FIREBASE_CONFIG (a Web SDK config with
 * `databaseURL`) and an oracle credential: PYRIC_ORACLE_SA_PATH (a service
 * account key outside the checkout), or PYRIC_ORACLE_PROJECT_ID with
 * Application Default Credentials. Under ADC, `createCustomToken` signs
 * through IAM Credentials `signBlob`:
 *
 *   PYRIC_ORACLE_FIREBASE_CONFIG="$(cat <web-config.json>)" \
 *     PYRIC_ORACLE_PROJECT_ID=<oracle project id> \
 *     bun run packages/conformance/src/capture-auth-request-auth.ts
 *
 * PYRIC_AUTH_CAPTURE_UIDS names a file outside the checkout where each created
 * uid is appended as it is created, so a crashed run can still be cleaned up.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RTDB_RULES_SCOPE } from './oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken, oracleAppOptions, oracleCredentialConfigured } from './oracle-credential.ts';
import { resolvedFirebaseVersion } from './package-version.ts';
import { leaves, probesFor, redactor, type Claims, type Probe, type Verdict } from './auth-request-auth-probes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../observations/auth/auth-request-auth-per-sign-in.json');

interface WebConfig { apiKey: string; authDomain?: string; projectId: string; databaseURL?: string }

if (!process.env.PYRIC_ORACLE_FIREBASE_CONFIG || !oracleCredentialConfigured(process.env)) {
  console.log('[oracle:auth-request-auth] inert: set PYRIC_ORACLE_FIREBASE_CONFIG (with databaseURL) and PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID to capture.');
  console.log(`[oracle:auth-request-auth] would write ${OUT}`);
  process.exit(0);
}

const config = JSON.parse(process.env.PYRIC_ORACLE_FIREBASE_CONFIG) as WebConfig;
const sa = loadOracleServiceAccount();
if (!config.databaseURL) throw new Error('the web config has no databaseURL');
if (config.projectId !== sa.project_id) throw new Error('the web config and the service account name different projects');
const DB_URL = config.databaseURL.replace(/\/+$/, '');
const UID_LOG = process.env.PYRIC_AUTH_CAPTURE_UIDS;

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const PREFIX = `pyric-hunt-auth-${RUN}`;
const RUN_KEY = `pyric_hunt_auth_${RUN}`;
const PASSWORD = `Pw-${randomBytes(9).toString('base64url')}`;
const PHONE = `+1555${String(1_000_000 + Math.floor(Math.random() * 8_999_999)).slice(0, 7)}`;
const PHOTO = 'https://example.com/pyric-hunt-auth.png';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { initializeApp, deleteApp } = await import('firebase/app');
const fbAuth = await import('firebase/auth');
const fbDb = await import('firebase/database');
const adminAppMod = await import('firebase-admin/app');
const { getAuth: getAdminAuth } = await import('firebase-admin/auth');

const adminApp = adminAppMod.initializeApp(oracleAppOptions(sa), `hunt-auth-admin-${RUN}`);
const admin = getAdminAuth(adminApp);
const created = new Set<string>();
function record(uid: string) {
  if (created.has(uid)) return;
  created.add(uid);
  if (UID_LOG) appendFileSync(UID_LOG, `${uid}\n`);
}

interface Session {
  kind: string;
  note: string;
  app: ReturnType<typeof initializeApp> | null;
  uid: string | null;
  claims: Claims | null;
  signInProvider: string | null;
  /** The IdTokenResult fields other than claims, as format descriptions. */
  result?: Record<string, unknown>;
  /** Extra facts the session recorded (redacted later). */
  facts?: Record<string, unknown>;
  error?: string;
}
const sessions: Session[] = [];
const secrets = new Map<string, string>([[config.projectId, '<projectId>'], [PREFIX, '<prefix>'], [PHONE, '<phoneNumber>'], [RUN_KEY, '<runKey>']]);
const { redactString, shape } = redactor(secrets);

function timeFormat(s: string | null | undefined): string {
  if (s === null || s === undefined) return String(s);
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(s)) return 'toUTCString';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return 'toISOString';
  return `other: ${s.length} chars`;
}

function newClient(kind: string) {
  const app = initializeApp(config, `hunt-auth-${kind}-${RUN}`);
  return { app, auth: fbAuth.getAuth(app) };
}
async function finish(kind: string, note: string, app: Session['app'], user: import('firebase/auth').User, opts: { forceRefresh?: boolean; facts?: Record<string, unknown> } = {}) {
  const result = await user.getIdTokenResult(opts.forceRefresh ?? false);
  secrets.set(user.uid, '<uid>');
  const claims = result.claims as Claims;
  sessions.push({
    kind, note, app, uid: user.uid, claims, signInProvider: result.signInProvider,
    result: {
      authTime: timeFormat(result.authTime),
      issuedAtTime: timeFormat(result.issuedAtTime),
      expirationTime: timeFormat(result.expirationTime),
      signInSecondFactor: result.signInSecondFactor,
      keys: Object.keys(result).sort(),
      expMinusIat: (claims.exp as number) - (claims.iat as number),
      authTimeBeforeIat: (claims.auth_time as number) < (claims.iat as number),
    },
    ...(opts.facts ? { facts: opts.facts } : {}),
  });
}
async function nameAfterMint(uid: string, kind: string) {
  // Production assigned this uid; give the account its run-prefixed name now
  // that the token the probes use has been minted.
  await admin.updateUser(uid, { displayName: `${PREFIX}-${kind}` });
}
async function attempt(kind: string, note: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`  session: ${kind}`);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    sessions.push({ kind, note, app: null, uid: null, claims: null, signInProvider: null, error: `${err.code ?? ''} ${err.message ?? String(e)}`.trim() });
    console.log(`  session failed: ${kind}: ${err.code ?? err.message}`);
  }
}
async function passwordUser(suffix: string, extra: Record<string, unknown> = {}): Promise<{ uid: string; email: string }> {
  const uid = `${PREFIX}-${suffix}`;
  const email = `${uid}@example.com`;
  await admin.createUser({ uid, email, password: PASSWORD, ...extra });
  record(uid);
  return { uid, email };
}
/** An Admin call's outcome: resolved, or the error's code and message, and whether it threw synchronously. */
async function outcome(run: () => Promise<unknown> | unknown): Promise<Record<string, unknown>> {
  let promise: Promise<unknown> | unknown;
  try {
    promise = run();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { threw: 'synchronously', code: err.code ?? null, message: err.message ?? String(e) };
  }
  try {
    await promise;
    return { resolved: true };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { rejected: true, code: err.code ?? null, message: err.message ?? String(e) };
  }
}

let rulesRestored = false;
let runKeyAbsent = false;
let usersDeleted = false;
const rtdbToken = await oracleAccessToken(sa, RTDB_RULES_SCOPE);
const rulesUrl = `${DB_URL}/.settings/rules.json?access_token=${encodeURIComponent(rtdbToken)}`;
const beforeRulesText = await (async () => {
  const res = await fetch(rulesUrl);
  if (!res.ok) throw new Error(`read rules failed: ${res.status}`);
  return res.text();
})();
const canonical = (text: string) => {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Claims)[k])])) : v;
  return JSON.stringify(sort(JSON.parse(text)));
};
const beforeCanonical = canonical(beforeRulesText);
console.log(`[oracle:auth-request-auth] run ${RUN}; project ${config.projectId}; database ${new URL(DB_URL).host}; rules snapshotted.`);

const behavior: Record<string, unknown> = {};
const adminFacts: Record<string, unknown> = {};
try {
  // ---------------------------------------------------------------- sessions
  sessions.push({ kind: 'signedOut', note: 'no sign-in', app: initializeApp(config, `hunt-auth-signedOut-${RUN}`), uid: null, claims: null, signInProvider: null });

  await attempt('anonymous', 'signInAnonymously', async () => {
    const { app, auth } = newClient('anonymous');
    const { user } = await fbAuth.signInAnonymously(auth);
    record(user.uid);
    await finish('anonymous', 'signInAnonymously', app, user);
    await nameAfterMint(user.uid, 'anonymous');
  });

  await attempt('passwordUnverified', 'Admin createUser with email and password, then signInWithEmailAndPassword', async () => {
    const { email } = await passwordUser('pw');
    const { app, auth } = newClient('passwordUnverified');
    const { user } = await fbAuth.signInWithEmailAndPassword(auth, email, PASSWORD);
    await finish('passwordUnverified', 'signInWithEmailAndPassword, unverified, no profile', app, user);
  });

  await attempt('passwordVerifiedProfile', 'Admin createUser verified, with display name, photo URL and phone number, then signInWithEmailAndPassword', async () => {
    const { email } = await passwordUser('pv', { emailVerified: true, displayName: `${PREFIX}-pv-name`, photoURL: PHOTO, phoneNumber: PHONE });
    const { app, auth } = newClient('passwordVerifiedProfile');
    const { user } = await fbAuth.signInWithEmailAndPassword(auth, email, PASSWORD);
    await finish('passwordVerifiedProfile', 'signInWithEmailAndPassword, verified, profile and phone set through Admin', app, user);
  });

  await attempt('customTokenNewUid', 'Admin createCustomToken for a new uid with developer claims of each JSON type, then signInWithCustomToken', async () => {
    const uid = `${PREFIX}-ct`;
    const token = await admin.createCustomToken(uid, { role: 'oracle', level: 5, ratio: 1.5, flag: true, nested: { team: 'a' }, tags: ['x', 'y'] });
    const { app, auth } = newClient('customTokenNewUid');
    const { user } = await fbAuth.signInWithCustomToken(auth, token);
    record(user.uid);
    await finish('customTokenNewUid', 'signInWithCustomToken, new uid, developer claims of each JSON type', app, user);
  });

  await attempt('customTokenExistingEmailAccount', 'Admin createCustomToken for the verified profile account, then signInWithCustomToken', async () => {
    const token = await admin.createCustomToken(`${PREFIX}-pv`);
    const { app, auth } = newClient('customTokenExistingEmailAccount');
    const { user } = await fbAuth.signInWithCustomToken(auth, token);
    await finish('customTokenExistingEmailAccount', 'signInWithCustomToken for an existing email account', app, user);
  });

  await attempt('setCustomUserClaimsThenRefresh', 'password sign-in, Admin setCustomUserClaims, then getIdToken(true)', async () => {
    const { uid, email } = await passwordUser('sc');
    const { app, auth } = newClient('setCustomUserClaimsThenRefresh');
    const { user } = await fbAuth.signInWithEmailAndPassword(auth, email, PASSWORD);
    await admin.setCustomUserClaims(uid, {
      admin: true, tier: 2,
      // Claims reusing standard names: which value wins on the refreshed token.
      email: 'custom@example.com', email_verified: true, user_id: 'custom-user-id', phone_number: '+15550000000', name: 'custom-name',
    });
    await finish('setCustomUserClaimsThenRefresh', 'custom claims set after sign-in, read after a forced refresh; some reuse standard names', app, user, { forceRefresh: true });
  });

  await attempt('forcedRefreshLater', 'password sign-in, wait 3 s, then getIdToken(true)', async () => {
    const { email } = await passwordUser('fr');
    const { app, auth } = newClient('forcedRefreshLater');
    const { user } = await fbAuth.signInWithEmailAndPassword(auth, email, PASSWORD);
    await sleep(3000);
    await finish('forcedRefreshLater', 'a forced refresh 3 s after sign-in: auth_time keeps the sign-in time', app, user, { forceRefresh: true });
  });

  await attempt('reloadAfterAdminChanges', 'password sign-in, Admin sets a claim and emailVerified, then user.reload() with no token refresh', async () => {
    const { uid, email } = await passwordUser('rl');
    const { app, auth } = newClient('reloadAfterAdminChanges');
    const { user } = await fbAuth.signInWithEmailAndPassword(auth, email, PASSWORD);
    await admin.setCustomUserClaims(uid, { admin: true });
    await admin.updateUser(uid, { emailVerified: true });
    await user.reload();
    await finish('reloadAfterAdminChanges', 'the current token after reload(): Admin changes are not on it', app, user, { facts: { userEmailVerifiedAfterReload: user.emailVerified } });
  });

  await attempt('updateProfileThenToken', 'password sign-in, client updateProfile, then the current token without a forced refresh', async () => {
    const { email } = await passwordUser('up');
    const { app, auth } = newClient('updateProfileThenToken');
    const { user } = await fbAuth.signInWithEmailAndPassword(auth, email, PASSWORD);
    let idTokenChanges = 0;
    const stop = fbAuth.onIdTokenChanged(auth, () => { idTokenChanges += 1; });
    await sleep(200);
    const before = idTokenChanges;
    await fbAuth.updateProfile(user, { displayName: `${PREFIX}-up-renamed`, photoURL: PHOTO });
    await sleep(500);
    stop();
    await finish('updateProfileThenToken', 'token after updateProfile with no forced refresh', app, user, { facts: { onIdTokenChangedFiresOnUpdateProfile: idTokenChanges > before, userDisplayNameUpdated: user.displayName === `${PREFIX}-up-renamed` } });
  });

  await attempt('customTokenOverStoredClaims', 'account with setCustomUserClaims, then signInWithCustomToken whose developer claims overlap and add', async () => {
    const { uid } = await passwordUser('cc');
    await admin.setCustomUserClaims(uid, { foo: 'api', key1: 'kept', role: 'editor' });
    const token = await admin.createCustomToken(uid, { foo: 'token', key2: 'added', admin: true });
    const { app, auth } = newClient('customTokenOverStoredClaims');
    const { user } = await fbAuth.signInWithCustomToken(auth, token);
    const stored = (await admin.getUser(uid)).customClaims ?? null;
    await finish('customTokenOverStoredClaims', 'custom-token developer claims over stored custom claims', app, user, { facts: { storedCustomClaimsAfterCustomTokenSignIn: stored } });
  });

  await attempt('passwordAfterCustomToken', 'the same account signs in with its password after the custom-token sign-in', async () => {
    const { app, auth } = newClient('passwordAfterCustomToken');
    const { user } = await fbAuth.signInWithEmailAndPassword(auth, `${PREFIX}-cc@example.com`, PASSWORD);
    await finish('passwordAfterCustomToken', 'password sign-in after a custom-token sign-in: which claims the token carries', app, user);
  });

  await attempt('customTokenReload', 'custom-token sign-in for an email account, then user.reload()', async () => {
    const { uid } = await passwordUser('cr');
    const token = await admin.createCustomToken(uid);
    const { app, auth } = newClient('customTokenReload');
    const { user } = await fbAuth.signInWithCustomToken(auth, token);
    await user.reload();
    await finish('customTokenReload', 'a custom-token session after reload(): sign_in_provider stays custom', app, user);
  });

  await attempt('customTokenReauthPassword', 'custom-token sign-in for an email account, then reauthenticateWithCredential with its password', async () => {
    const { uid, email } = await passwordUser('ra');
    const token = await admin.createCustomToken(uid);
    const { app, auth } = newClient('customTokenReauthPassword');
    const { user } = await fbAuth.signInWithCustomToken(auth, token);
    await sleep(1500);
    await fbAuth.reauthenticateWithCredential(user, fbAuth.EmailAuthProvider.credential(email, PASSWORD));
    await finish('customTokenReauthPassword', 'the token after reauthenticating a custom-token session with a password credential', app, user);
  });

  await attempt('emailLink', 'Admin generateSignInWithEmailLink for a new email, then signInWithEmailLink', async () => {
    const email = `${PREFIX}-el@example.com`;
    const link = await admin.generateSignInWithEmailLink(email, { url: `https://${config.authDomain ?? `${config.projectId}.firebaseapp.com`}/`, handleCodeInApp: true });
    const { app, auth } = newClient('emailLink');
    const { user } = await fbAuth.signInWithEmailLink(auth, email, link);
    record(user.uid);
    await finish('emailLink', 'signInWithEmailLink, new account', app, user);
    await nameAfterMint(user.uid, 'emailLink');
  });

  for (const s of sessions) if (s.claims) for (const { value } of leaves(s.claims)) {
    if (typeof value === 'string' && value.startsWith(PREFIX) && value.includes('@')) secrets.set(value, '<email>');
  }

  // ---------------------------------------------------------------- Admin SDK answers
  {
    const { uid, email } = await passwordUser('ad');
    const fresh = await admin.getUser(uid);
    adminFacts.freshPasswordUserRecord = {
      creationTime: timeFormat(fresh.metadata.creationTime),
      lastSignInTime: timeFormat(fresh.metadata.lastSignInTime),
      lastRefreshTime: fresh.metadata.lastRefreshTime ?? null,
      providerData: fresh.providerData.map((p) => p.providerId),
      tenantId: fresh.tenantId ?? null,
      customClaims: fresh.customClaims ?? null,
    };
    // Each of these should be refused; one that is not still has its account recorded for deletion.
    const tryCreate = (props: Parameters<typeof admin.createUser>[0]) => outcome(async () => record((await admin.createUser(props)).uid));
    adminFacts.createUserTakenEmail = await tryCreate({ email, password: PASSWORD });
    adminFacts.createUserTakenUid = await tryCreate({ uid, password: PASSWORD });
    adminFacts.createUserShortPassword = await tryCreate({ uid: `${PREFIX}-short`, password: '12345' });
    adminFacts.createUserInvalidEmail = await tryCreate({ uid: `${PREFIX}-bad`, email: 'nope' });
    adminFacts.getUserMissing = await outcome(() => admin.getUser(`${PREFIX}-missing`));
    adminFacts.getUserByEmailMissing = await outcome(() => admin.getUserByEmail(`${PREFIX}-missing@example.com`));
    adminFacts.getUserByEmailOtherCase = await outcome(() => admin.getUserByEmail(email.toUpperCase()));
    adminFacts.deleteUserMissing = await outcome(() => admin.deleteUser(`${PREFIX}-missing`));
    adminFacts.setCustomUserClaimsMissing = await outcome(() => admin.setCustomUserClaims(`${PREFIX}-missing`, { a: 1 }));
    adminFacts.setCustomUserClaims1100 = await outcome(() => admin.setCustomUserClaims(uid, { blob: 'x'.repeat(1100) }));
    adminFacts.setCustomUserClaimsReserved = await outcome(() => admin.setCustomUserClaims(uid, { sub: 'x' }));
    adminFacts.createCustomTokenEmptyUid = await outcome(() => admin.createCustomToken(''));
    adminFacts.createCustomToken129Uid = await outcome(() => admin.createCustomToken('x'.repeat(129)));
    adminFacts.createCustomToken128Uid = await outcome(() => admin.createCustomToken('x'.repeat(128)));
    adminFacts.createCustomTokenReservedAud = await outcome(() => admin.createCustomToken('u', { aud: 'x' }));
    adminFacts.createCustomTokenReservedFirebase = await outcome(() => admin.createCustomToken('u', { firebase: {} }));
    adminFacts.createCustomTokenNullClaims = await outcome(() => admin.createCustomToken('u', null as never));
    adminFacts.verifyIdTokenOfCustomToken = await outcome(async () => admin.verifyIdToken(await admin.createCustomToken('u')));

    // checkRevoked against a disabled, then a deleted, account.
    const { app, auth } = newClient('verify');
    const { user } = await fbAuth.signInWithEmailAndPassword(auth, email, PASSWORD);
    const idToken = await user.getIdToken();
    const decoded = await admin.verifyIdToken(idToken);
    adminFacts.verifyIdTokenDecoded = {
      keys: Object.keys(decoded).sort(),
      firebaseKeys: Object.keys(decoded.firebase).sort(),
      authTimeEqualsToken: decoded.auth_time === (JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()) as Claims).auth_time,
      expMinusIat: decoded.exp - decoded.iat,
      uidEqualsSub: decoded.uid === decoded.sub,
    };
    const afterSignIn = await admin.getUser(uid);
    adminFacts.userRecordAfterSignIn = { lastSignInTime: timeFormat(afterSignIn.metadata.lastSignInTime), lastRefreshTime: timeFormat(afterSignIn.metadata.lastRefreshTime) };
    await admin.updateUser(uid, { disabled: true });
    adminFacts.verifyIdTokenCheckRevokedDisabled = await outcome(() => admin.verifyIdToken(idToken, true));
    adminFacts.verifyIdTokenNoCheckDisabled = await outcome(() => admin.verifyIdToken(idToken));
    await admin.deleteUser(uid);
    adminFacts.verifyIdTokenCheckRevokedDeleted = await outcome(() => admin.verifyIdToken(idToken, true));
    await deleteApp(app);
  }

  // ---------------------------------------------------------------- RTDB probes
  const extraProbes: Record<string, Probe[]> = {
    reloadAfterAdminChanges: [
      { label: 'the claim Admin set after sign-in is not on the token (admin reads null)', rtdb: 'auth.token.admin == null', cel: null },
      { label: 'email_verified is still false after reload', rtdb: 'auth.token.email_verified == false', cel: null },
    ],
    customTokenReload: [{ label: 'sign_in_provider is custom after reload', rtdb: "auth.token.firebase.sign_in_provider == 'custom' && auth.provider == 'custom'", cel: null }],
  };
  const rtdbProbes = new Map<string, { id: string; probe: Probe }[]>();
  const subtree: Record<string, Record<string, { '.read': string }>> = {};
  for (const s of sessions) {
    if (s.error) continue;
    const list = [...probesFor(s.uid, s.claims, s.signInProvider), ...(extraProbes[s.kind] ?? [])]
      .filter((p) => p.rtdb !== null).map((probe, i) => ({ id: `p${i}`, probe }));
    rtdbProbes.set(s.kind, list);
    subtree[s.kind] = Object.fromEntries(list.map(({ id, probe }) => [id, { '.read': probe.rtdb! }]));
  }
  const beforeRules = JSON.parse(beforeRulesText) as { rules: Claims };
  const merged = JSON.stringify({ rules: { ...beforeRules.rules, [RUN_KEY]: subtree } });
  const dry = await fetch(`${rulesUrl}&dryRun=true`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: merged });
  if (!dry.ok) throw new Error(`probe rules rejected by the dry run: ${dry.status} ${redactString(await dry.text())}`);
  const put = await fetch(`${rulesUrl}&print=silent`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: merged });
  if (!put.ok) throw new Error(`probe rules deploy failed: ${put.status}`);
  console.log('[oracle:auth-request-auth] deployed probe rules under the run key; waiting 8s.');
  await sleep(8000);

  const rtdb: Record<string, Record<string, Verdict | string>> = {};
  await Promise.all(sessions.filter((s) => s.app && !s.error).map(async (s) => {
    const db = fbDb.getDatabase(s.app!, DB_URL);
    const out: Record<string, Verdict | string> = {};
    for (const { id, probe } of rtdbProbes.get(s.kind)!) {
      try {
        await fbDb.get(fbDb.ref(db, `${RUN_KEY}/${s.kind}/${id}`));
        out[probe.label] = 'ALLOW';
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        out[probe.label] = /permission/i.test(msg) ? 'DENY' : `ERROR ${redactString(msg)}`;
      }
    }
    rtdb[s.kind] = out;
    fbDb.goOffline(db);
  }));

  for (const s of sessions) {
    behavior[s.kind] = {
      note: s.note,
      ...(s.error ? { signInError: redactString(s.error) } : {
        signInProvider: s.signInProvider,
        claims: s.claims ? shape(s.claims) : null,
        ...(s.result ? { idTokenResult: s.result } : {}),
        ...(s.facts ? { facts: shape(s.facts) } : {}),
        rtdb: rtdb[s.kind],
      }),
    };
  }
  behavior.admin = shape(adminFacts);
} finally {
  try {
    const put = await fetch(`${rulesUrl}&print=silent`, { method: 'PUT', body: beforeRulesText });
    if (!put.ok) throw new Error(`restore failed: ${put.status}`);
    const back = await (await fetch(rulesUrl)).text();
    rulesRestored = canonical(back) === beforeCanonical;
    const root = await (await fetch(`${DB_URL}/.json?shallow=true&access_token=${encodeURIComponent(rtdbToken)}`)).json() as Claims | null;
    runKeyAbsent = root === null || !(RUN_KEY in root);
  } catch (e) {
    console.error(`[oracle:auth-request-auth] restore problem: ${(e as Error).message}. Restore the rules of ${new URL(DB_URL).host} by hand.`);
  }
  for (const s of sessions) if (s.app) await deleteApp(s.app).catch(() => {});
  const remaining: string[] = [];
  for (const uid of created) {
    await admin.deleteUser(uid).catch(() => {});
    try { await admin.getUser(uid); remaining.push(uid); } catch (e) { if ((e as { code?: string }).code !== 'auth/user-not-found') remaining.push(uid); }
  }
  usersDeleted = remaining.length === 0;
  await adminAppMod.deleteApp(adminApp);
  console.log(`[oracle:auth-request-auth] users created ${created.size}, remaining ${remaining.length}${remaining.length ? `: ${remaining.join(', ')}` : ''}`);
  console.log(`[oracle:auth-request-auth] rules restored and read back: ${rulesRestored}; run key absent from the root: ${runKeyAbsent}`);
}

if (!(rulesRestored && runKeyAbsent && usersDeleted)) {
  console.error('[oracle:auth-request-auth] not clean: no observation written.');
  process.exit(1);
}
const observation = {
  name: 'auth-request-auth-per-sign-in',
  matrixRow: 'auth #68c',
  rowIds: ['auth#68c'],
  description: 'What production RTDB rules see as auth for each sign-in kind (signed out, anonymous, email and password unverified, verified with a profile and phone number, custom token for a new uid with developer claims of each JSON type, custom token for an existing email account, custom claims set after sign-in then a forced refresh, a forced refresh seconds after sign-in, reload after Admin changes, the token after updateProfile, custom-token claims over stored claims and a later password sign-in, reload and password reauthentication of a custom-token session, and email link), with the decoded claim shapes and IdTokenResult formats; plus the Admin SDK answers for user management, custom tokens, custom-claims limits and verifyIdToken. Each RTDB probe is an equality or absence check built from the session\'s own decoded token, deployed on a dedicated instance and read with the live token. Values that identify the test accounts are replaced by placeholders; numbers are recorded as <int> or <float>. Every account is removed through the Admin SDK at the end and the removal proven; the instance rules are restored and read back.',
  observedAt: new Date().toISOString(),
  fbSdkVersion: resolvedFirebaseVersion(),
  projectId: config.projectId,
  behavior: { ...behavior, cleanup: { rulesRestored, runKeyAbsent, usersDeleted, usersCreated: created.size } },
};
writeFileSync(OUT, `${JSON.stringify(observation, null, 2)}\n`);
console.log(`[oracle:auth-request-auth] capture complete: rules restored, run key absent, users removed, all read back. Wrote ${OUT}`);
// Client apps and the database connection keep handles open; end the process explicitly.
process.exit(0);
