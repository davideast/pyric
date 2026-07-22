#!/usr/bin/env bun
/**
 * Empirical oracle harness for the conformance test suite.
 *
 * Runs probes against bare **upstream** `firebase/auth` +
 * `firebase/firestore` (no `@pyric/*` shim) against a **real
 * Firebase project**. Each probe captures observable production
 * behavior into `observations/<surface>/<name>.json` (grouped by
 * owning surface — auth, firestore, rtdb, rtdb-modular, storage) so the
 * matrices can cite "observed empirically against firebase-js-sdk
 * <version> on <date>" rather than guessing.
 *
 * Why not the emulator: the Firestore emulator has known
 * divergences from cloud Firestore and the gap widens over time.
 * For an oracle that needs to be true, only the real service
 * counts.
 *
 * Auth path: a service-account JSON file (default
 * `ignored/service-account.json`, override with
 * `PYRIC_ORACLE_SA_PATH`). The harness mints a short-lived OAuth
 * token, calls the Firebase Management API to fetch the project's
 * Web SDK config (apiKey, authDomain, …), then initializes the
 * Web SDK normally. Manual config via
 * `PYRIC_ORACLE_FIREBASE_CONFIG` is honored if you'd rather not
 * use the SA path.
 *
 * Cleanup: each probe writes under a unique sub-collection
 * (`oracle-<ts>-<rand>-<probe>`) and deletes its docs on the way
 * out. Anonymous users are deleted after each probe that signs
 * in, with one exception: the `auth-signout-idempotent` probe
 * ends signed out, so its anonymous user can't be deleted from
 * the client SDK. See `packages/conformance/docs/oracle-project-setup.md` for that and
 * the one-time project setup.
 */
import { createSign } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import * as fbAuthNs from 'firebase/auth';
import {
  ActionCodeOperation,
  ActionCodeURL,
  applyActionCode,
  AuthErrorCodes,
  checkActionCode,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  fetchSignInMethodsForEmail,
  getAdditionalUserInfo,
  getAuth,
  isSignInWithEmailLink,
  linkWithCredential,
  onAuthStateChanged,
  onIdTokenChanged,
  OperationType,
  parseActionCodeURL,
  ProviderId,
  reauthenticateWithCredential,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  SignInMethod,
  signOut,
  unlink,
  validatePassword,
  verifyBeforeUpdateEmail,
  verifyPasswordResetCode,
  type ActionCodeSettings,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  addDoc,
  and,
  arrayRemove,
  arrayUnion,
  Bytes,
  collection,
  collectionGroup,
  deleteDoc,
  deleteField,
  doc,
  documentId,
  endAt,
  endBefore,
  GeoPoint,
  getCountFromServer,
  getDoc,
  getDocs,
  getFirestore,
  increment,
  limit,
  limitToLast,
  onSnapshot,
  or,
  orderBy,
  query,
  queryEqual,
  querySnapshotFromJSON,
  runTransaction,
  serverTimestamp,
  setDoc,
  snapshotEqual,
  startAfter,
  startAt,
  Timestamp,
  updateDoc,
  vector,
  where,
  writeBatch,
  type FirestoreDataConverter,
  type Firestore,
} from 'firebase/firestore';
import {
  deleteObject,
  getBytes,
  getDownloadURL,
  getMetadata,
  getStorage,
  listAll,
  ref as storageRef,
  updateMetadata,
  uploadBytes,
  uploadString,
  type FirebaseStorage,
} from 'firebase/storage';
import {
  getDatabase,
  ref as rtdbRef,
  get as rtdbGet,
  set as rtdbSet,
  remove as rtdbRemove,
  push as rtdbPush,
  onValue as rtdbOnValue,
  onChildAdded as rtdbOnChildAdded,
  onChildChanged as rtdbOnChildChanged,
  onChildRemoved as rtdbOnChildRemoved,
  onChildMoved as rtdbOnChildMoved,
  off as rtdbOff,
  update as rtdbUpdate,
  query as rtdbQuery,
  orderByChild as rtdbOrderByChild,
  orderByKey as rtdbOrderByKey,
  orderByValue as rtdbOrderByValue,
  limitToFirst as rtdbLimitToFirst,
  limitToLast as rtdbLimitToLast,
  equalTo as rtdbEqualTo,
  startAt as rtdbStartAt,
  startAfter as rtdbStartAfter,
  endAt as rtdbEndAt,
  endBefore as rtdbEndBefore,
  runTransaction as rtdbRunTransaction,
  increment as rtdbIncrement,
  serverTimestamp as rtdbServerTimestamp,
  type Database,
} from 'firebase/database';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceDescriptors } from '../surfaces/load.ts';
import { soleLongestPrefixOwner } from './observation-surface.ts';
import {
  cert as adminCert,
  initializeApp as adminInitializeApp,
  deleteApp as adminDeleteApp,
  type App as AdminApp,
} from 'firebase-admin/app';
import { getDatabaseWithUrl as getAdminDatabase } from 'firebase-admin/database';
import {
  compileRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
  type SimulationInput,
} from 'pyric/rules/internal/rtdb';

// ─── Setup ────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const OBS_DIR = join(HERE, '..', 'observations');

interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  /** Realtime Database URL — present when the project has an RTDB
   *  instance and the Web App config includes it. The harness probes
   *  RTDB only when this is set; otherwise RTDB probes report a
   *  `skipped` observation. */
  databaseURL?: string;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';
const RULES_API = 'https://firebaserules.googleapis.com/v1';
const RTDB_API = 'https://firebasedatabase.googleapis.com/v1beta';

const ORACLE_RULE_MARKER = '@pyric/oracle';
const ORACLE_RULE_SNIPPET = `      // @pyric/oracle - read/write under pyric_oracle/* for the conformance oracle harness
      match /pyric_oracle/{run}/{anything=**} {
        allow read, write: if request.auth != null;
      }`;
const ORACLE_FRESH_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${ORACLE_RULE_SNIPPET}
  }
}
`;

// RTDB rules counterpart. RTDB rules are JSON (not the
// `service cloud.firestore { ... }` grammar), and the API endpoint is
// the database's own `<databaseUrl>/.settings/rules.json`. We marker
// off the oracle namespace by checking for `pyric_oracle` as a
// top-level key in the parsed rules JSON — much simpler than parsing
// the Storage / Firestore rules grammar.
const ORACLE_RTDB_NAMESPACE_KEY = 'pyric_oracle';
// The rules-JSON that grants the oracle harness read+write on
// `/pyric_oracle/*` while leaving the rest of the database
// default-deny. Includes `.indexOn` declarations at the leaf list
// level (`$probe/list`) so the query probes (orderByChild, equalTo)
// can run without per-probe rule modifications — RTDB rejects
// queries on un-indexed fields with `Index not defined`. The set of
// indexed fields is the union of what every modular-SDK query probe
// uses (`pos`, `group`).
const ORACLE_RTDB_RULES_BODY = {
  rules: {
    '.read': false,
    '.write': false,
    [ORACLE_RTDB_NAMESPACE_KEY]: {
      '.read': 'auth != null',
      '.write': 'auth != null',
      // Allow nested queries on common shapes. RTDB applies $-vars
      // top-down; this matches `pyric_oracle/<run>/<probe>/list` and
      // indexes that level's children on `pos` + `group`.
      $run: {
        $probe: {
          list: {
            '.indexOn': ['pos', 'group'],
          },
        },
      },
    },
  },
};

// Storage rules counterpart. Mirrors the Firestore namespacing but
// targets `service firebase.storage` + the `/b/{bucket}/o/...` path
// pattern that's universal for Firebase Storage.
const ORACLE_STORAGE_RULE_MARKER = '@pyric/oracle/storage';
const ORACLE_STORAGE_FRESH_RULES = `rules_version = '2';
service firebase.storage {
  // ${ORACLE_STORAGE_RULE_MARKER} - read/write under pyric_oracle/* for the conformance oracle harness
  match /b/{bucket}/o {
    match /pyric_oracle/{run}/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}
`;

/**
 * Mint an OAuth access token from a service account JSON, using
 * only node:crypto + fetch. Mirrors the pattern in
 * `ignored/check-sa-perms.ts`.
 */
async function mintToken(sa: ServiceAccount, scope: string): Promise<string> {
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: sa.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600 }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(sa.private_key).toString('base64url');
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Auto-create a Web App in the project. Polls the long-running
 * operation to completion. Used when the project has no Web App
 * registered yet.
 */
async function createWebApp(token: string, projectId: string): Promise<string> {
  const url = `${FIREBASE_API}/projects/${encodeURIComponent(projectId)}/webApps`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Pyric Oracle' }),
  });
  if (!resp.ok) throw new Error(`createWebApp failed: ${resp.status} ${await resp.text()}`);
  const op = (await resp.json()) as { name: string; done?: boolean; response?: { appId: string } };
  if (op.done && op.response) return op.response.appId;

  const opUrl = `https://firebase.googleapis.com/v1beta1/${op.name}`;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const polled = await fetch(opUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!polled.ok) throw new Error(`operation poll failed: ${polled.status} ${await polled.text()}`);
    const status = (await polled.json()) as { done?: boolean; response?: { appId: string }; error?: { message: string } };
    if (status.error) throw new Error(`createWebApp operation failed: ${status.error.message}`);
    if (status.done && status.response) return status.response.appId;
  }
  throw new Error(`createWebApp operation did not complete within 30s`);
}

/**
 * Fetch the Web SDK config for a project. Auto-creates a Web App if
 * none exist (one-time setup; subsequent runs reuse the same app).
 */
async function fetchWebConfig(token: string, projectId: string): Promise<FirebaseWebConfig> {
  const listUrl = `${FIREBASE_API}/projects/${encodeURIComponent(projectId)}/webApps`;
  const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!listResp.ok) {
    throw new Error(`listWebApps failed: ${listResp.status} ${await listResp.text()}`);
  }
  const list = (await listResp.json()) as { apps?: Array<{ appId: string; name: string }> };
  const apps = list.apps ?? [];
  let appId: string;
  if (apps.length === 0) {
    console.log(`[oracle] no Web App registered for ${projectId} — creating one (one-time)`);
    appId = await createWebApp(token, projectId);
    console.log(`[oracle] created Web App ${appId}`);
  } else {
    appId = apps[0].appId;
  }
  const cfgUrl = `${FIREBASE_API}/projects/${encodeURIComponent(projectId)}/webApps/${encodeURIComponent(appId)}/config`;
  const cfgResp = await fetch(cfgUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!cfgResp.ok) {
    throw new Error(`fetchWebConfig failed: ${cfgResp.status} ${await cfgResp.text()}`);
  }
  return (await cfgResp.json()) as FirebaseWebConfig;
}

/**
 * Idempotent rule installer: ensure the oracle-* namespace rule
 * exists alongside whatever else the project already deploys. Three
 * branches:
 *   - No release yet → deploy a fresh rules file containing only
 *     the oracle rule.
 *   - Existing rules already contain the marker → no-op.
 *   - Existing rules don't have it → inject the snippet at the top
 *     of the `documents { … }` block and redeploy.
 */
async function ensureOracleRules(token: string, projectId: string): Promise<'fresh' | 'merged' | 'already-configured'> {
  const releaseUrl = `${RULES_API}/projects/${encodeURIComponent(projectId)}/releases/cloud.firestore`;
  const releaseRes = await fetch(releaseUrl, { headers: { Authorization: `Bearer ${token}` } });
  let current: string | null = null;
  if (releaseRes.status === 404) {
    current = null;
  } else if (releaseRes.ok) {
    const release = (await releaseRes.json()) as { rulesetName: string };
    const rulesetRes = await fetch(`${RULES_API}/${release.rulesetName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rulesetRes.ok) throw new Error(`fetch ruleset failed: ${rulesetRes.status} ${await rulesetRes.text()}`);
    const ruleset = (await rulesetRes.json()) as { source: { files: { name: string; content: string }[] } };
    const file = ruleset.source.files.find((f) => f.name.endsWith('.rules')) ?? ruleset.source.files[0];
    if (!file) throw new Error('existing ruleset has no source files');
    current = file.content;
  } else {
    throw new Error(`read release failed: ${releaseRes.status} ${await releaseRes.text()}`);
  }

  let next: string;
  let outcome: 'fresh' | 'merged' | 'already-configured';
  if (current === null) {
    next = ORACLE_FRESH_RULES;
    outcome = 'fresh';
  } else if (current.includes(ORACLE_RULE_MARKER)) {
    return 'already-configured';
  } else {
    const matchRe = /(match\s+\/databases\/\{database\}\/documents\s*\{)/;
    const m = matchRe.exec(current);
    if (!m) throw new Error('cannot locate `match /databases/{database}/documents` block in current rules');
    const insertAt = m.index + m[0].length;
    next = current.slice(0, insertAt) + '\n' + ORACLE_RULE_SNIPPET + '\n' + current.slice(insertAt);
    outcome = 'merged';
  }

  // Two-step deploy: create ruleset, patch release to point at it.
  const reqBody = JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: next }] } });
  const createRes = await fetch(
    `${RULES_API}/projects/${encodeURIComponent(projectId)}/rulesets`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: reqBody,
    },
  );
  if (!createRes.ok) throw new Error(`create ruleset failed: ${createRes.status} ${await createRes.text()}`);
  const created = (await createRes.json()) as { name: string };

  const releaseName = `projects/${projectId}/releases/cloud.firestore`;
  const patchRes = await fetch(`${RULES_API}/${releaseName}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ release: { name: releaseName, rulesetName: created.name } }),
  });
  if (!patchRes.ok) throw new Error(`patch release failed: ${patchRes.status} ${await patchRes.text()}`);
  return outcome;
}

/**
 * Storage-rules counterpart of `ensureOracleRules`. Firebase Storage
 * rules live on a **per-bucket** release name —
 * `projects/{p}/releases/firebase.storage/{bucketId}` — and use the
 * `service firebase.storage` grammar. Same three-branch logic as the
 * Firestore version:
 *
 *   - No release for this bucket → deploy a fresh rules file
 *     containing only the oracle Storage rule.
 *   - Existing rules contain the storage marker → no-op.
 *   - Existing rules don't have it → inject the
 *     `match /pyric_oracle/{run}/{allPaths=**}` block at the top of
 *     the `match /b/{bucket}/o { … }` block and redeploy.
 *
 * Returns `'skipped'` when the project has no Storage bucket
 * configured (Storage not enabled in the Firebase console). The
 * harness then runs Storage probes in skip-mode, recording
 * `skipped: true` observations instead of actual behaviors.
 */
async function ensureOracleStorageRules(
  token: string,
  projectId: string,
  bucketId: string | undefined,
): Promise<'fresh' | 'merged' | 'already-configured' | 'skipped'> {
  if (!bucketId) return 'skipped';
  // Storage release names embed slashes inside the path segment after
  // the trailing `/releases/`. Per the Firebase Rules API,
  // `firebase.storage/{bucketId}` is one release name and the bucket
  // id can be percent-encoded as a single segment — but the modern
  // Firebase console encodes the slash literally. We follow suit so
  // the URL matches the project's existing rules path.
  const releaseSuffix = `firebase.storage/${bucketId}`;
  const releaseUrl =
    `${RULES_API}/projects/${encodeURIComponent(projectId)}/releases/${releaseSuffix}`;
  const releaseRes = await fetch(releaseUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let current: string | null = null;
  if (releaseRes.status === 404) {
    current = null;
  } else if (releaseRes.ok) {
    const release = (await releaseRes.json()) as { rulesetName: string };
    const rulesetRes = await fetch(`${RULES_API}/${release.rulesetName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rulesetRes.ok) {
      throw new Error(`fetch storage ruleset failed: ${rulesetRes.status} ${await rulesetRes.text()}`);
    }
    const ruleset = (await rulesetRes.json()) as { source: { files: { name: string; content: string }[] } };
    const file = ruleset.source.files.find((f) => f.name.endsWith('.rules')) ?? ruleset.source.files[0];
    if (!file) throw new Error('existing storage ruleset has no source files');
    current = file.content;
  } else {
    throw new Error(`read storage release failed: ${releaseRes.status} ${await releaseRes.text()}`);
  }

  let next: string;
  let outcome: 'fresh' | 'merged' | 'already-configured';
  if (current === null) {
    next = ORACLE_STORAGE_FRESH_RULES;
    outcome = 'fresh';
  } else if (current.includes(ORACLE_STORAGE_RULE_MARKER)) {
    return 'already-configured';
  } else {
    // Insert the oracle namespace block at the top of the bucket
    // match block. Pattern targets `match /b/{bucket}/o {` which is
    // the canonical Storage rules shape; if a project uses a custom
    // shape we'd need a richer merge — log + bail.
    const matchRe = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;
    const m = matchRe.exec(current);
    if (!m) {
      throw new Error(
        'cannot locate `match /b/{bucket}/o` block in current storage rules — ' +
        'use a non-default Storage rules shape? Deploy oracle rules manually ' +
        'or extend ensureOracleStorageRules to handle this layout.',
      );
    }
    const insertAt = m.index + m[0].length;
    const inject = `\n    // ${ORACLE_STORAGE_RULE_MARKER} - read/write under pyric_oracle/* for the conformance oracle harness\n    match /pyric_oracle/{run}/{allPaths=**} {\n      allow read, write: if request.auth != null;\n    }\n`;
    next = current.slice(0, insertAt) + inject + current.slice(insertAt);
    outcome = 'merged';
  }

  // Two-step deploy: create ruleset, PATCH release. The release for
  // a brand-new bucket may not exist yet, in which case PATCH 404s
  // and we fall back to POST /releases.
  const reqBody = JSON.stringify({
    source: { files: [{ name: 'storage.rules', content: next }] },
  });
  const createRes = await fetch(
    `${RULES_API}/projects/${encodeURIComponent(projectId)}/rulesets`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: reqBody,
    },
  );
  if (!createRes.ok) {
    throw new Error(`create storage ruleset failed: ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { name: string };

  const releaseName = `projects/${projectId}/releases/${releaseSuffix}`;
  const patchRes = await fetch(`${RULES_API}/${releaseName}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ release: { name: releaseName, rulesetName: created.name } }),
  });
  if (patchRes.ok) return outcome;

  if (patchRes.status === 404) {
    // First-time release — POST `releases.create`.
    const createRelease = await fetch(
      `${RULES_API}/projects/${encodeURIComponent(projectId)}/releases`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: releaseName, rulesetName: created.name }),
      },
    );
    if (!createRelease.ok) {
      throw new Error(`create storage release failed: ${createRelease.status} ${await createRelease.text()}`);
    }
    return outcome;
  }

  throw new Error(`patch storage release failed: ${patchRes.status} ${await patchRes.text()}`);
}

/**
 * Discover the project's default RTDB instance via the Firebase
 * Database Management API. Returns the databaseUrl or null when:
 *   - the project has no RTDB instances (404 / empty list)
 *   - the Firebase RTDB API isn't enabled on the project (403)
 *   - any other error (logged, treated as "no RTDB" so probes skip)
 *
 * The Web App config sometimes embeds `databaseURL` already (when the
 * RTDB existed at app-creation time). When it doesn't, we fall back
 * to discovery so re-running against a project that gained an RTDB
 * after the app was created just works.
 *
 * To provision an RTDB if missing: Firebase Console → Realtime Database
 * → Create Database, or via the Management API:
 *
 *   POST https://firebasedatabase.googleapis.com/v1beta/projects/<projectId>/locations/<region>/instances?databaseId=<projectId>-default-rtdb
 *
 * with body `{ "type": "DEFAULT_DATABASE" }`.
 */
async function discoverRtdbInstance(
  token: string,
  projectId: string,
): Promise<string | null> {
  const url = `${RTDB_API}/projects/${encodeURIComponent(projectId)}/locations/-/instances`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    if (resp.status === 403 || resp.status === 404) return null;
    console.log(`[oracle] discoverRtdbInstance: ${resp.status} ${await resp.text()}`);
    return null;
  }
  const body = (await resp.json()) as {
    instances?: Array<{
      name: string;
      databaseUrl?: string;
      state?: string;
      type?: string;
    }>;
  };
  const instances = body.instances ?? [];
  if (instances.length === 0) return null;
  const active = instances.filter((i) => i.state === 'ACTIVE');
  const pool = active.length > 0 ? active : instances;
  const def = pool.find((i) => i.type === 'DEFAULT_DATABASE') ?? pool[0];
  return def.databaseUrl ?? null;
}

/**
 * RTDB-rules counterpart of `ensureOracleRules` / `ensureOracleStorageRules`.
 * RTDB rules are deployed as JSON via the database's own REST endpoint:
 *
 *   GET   <databaseUrl>/.settings/rules.json?access_token=…
 *   PUT   <databaseUrl>/.settings/rules.json?access_token=…
 *
 * (`PATCH` is not supported — RTDB takes a full rules-JSON replacement.
 * The "PATCH" mention in some Firebase docs refers to the
 * `firebasedatabase.googleapis.com` management API, not the per-DB rules
 * endpoint.)
 *
 * Marker-based idempotency: read the current rules; if they already
 * contain a top-level `pyric_oracle` key, no-op. Otherwise inject our
 * oracle namespace into the existing `rules` object (preserving any
 * other top-level keys the project's rules already carry) and PUT the
 * merged JSON.
 *
 * Returns:
 *   - 'fresh' — no rules existed, deployed our minimal namespace.
 *   - 'merged' — existing rules merged with our namespace.
 *   - 'already-configured' — `pyric_oracle` already a top-level key, no-op.
 *   - 'skipped' — no RTDB instance on the project (`databaseUrl` null).
 *   - `error: …` — failure surfaced as a string so the caller can log
 *     and continue. RTDB probes then run against whatever rules the
 *     project currently has (likely capturing PERMISSION_DENIED for
 *     happy-path writes).
 */
async function ensureOracleRtdbRules(
  token: string,
  databaseUrl: string | undefined,
): Promise<'fresh' | 'merged' | 'already-configured' | 'skipped' | string> {
  if (!databaseUrl) return 'skipped';
  const rulesUrl = `${databaseUrl}/.settings/rules.json?access_token=${encodeURIComponent(token)}`;
  // 1. Read current rules. RTDB returns the full JSON document; if the
  //    database is brand-new it may return `{"rules":{".read":false,".write":false}}`
  //    or similar default.
  const readResp = await fetch(rulesUrl);
  if (!readResp.ok) {
    return `error: read rules failed: ${readResp.status} ${await readResp.text()}`;
  }
  let currentBody: unknown;
  try {
    currentBody = await readResp.json();
  } catch (e) {
    return `error: parse rules failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  const current = (currentBody ?? {}) as Record<string, unknown>;
  const currentRules = (current.rules ?? {}) as Record<string, unknown>;
  // 2. Marker check: namespace already present AND the embedded
  //    `$run/$probe/list/.indexOn` shape matches. We compare against
  //    the live ORACLE_RTDB_RULES_BODY so adding a new indexed field
  //    here triggers a re-deploy automatically (rather than silently
  //    using a stale older index set).
  const existing = currentRules[ORACLE_RTDB_NAMESPACE_KEY] as Record<string, unknown> | undefined;
  if (existing) {
    const desired = ORACLE_RTDB_RULES_BODY.rules[ORACLE_RTDB_NAMESPACE_KEY];
    if (JSON.stringify(existing) === JSON.stringify(desired)) {
      return 'already-configured';
    }
    // Marker present but shape drifted — fall through to merge so
    // we update to the desired shape.
  }
  // 3. Decide outcome. If the rules object was empty / missing, we
  //    deploy our minimal "fresh" body (deny-all + permissive oracle
  //    namespace). Otherwise we MERGE — preserve every existing
  //    top-level key and overwrite (or insert) `pyric_oracle` with the
  //    desired shape.
  let nextBody: { rules: Record<string, unknown> };
  let outcome: 'fresh' | 'merged';
  const existingKeyCount = Object.keys(currentRules).length;
  if (existingKeyCount === 0) {
    nextBody = ORACLE_RTDB_RULES_BODY;
    outcome = 'fresh';
  } else {
    nextBody = {
      rules: {
        ...currentRules,
        [ORACLE_RTDB_NAMESPACE_KEY]: ORACLE_RTDB_RULES_BODY.rules[ORACLE_RTDB_NAMESPACE_KEY],
      },
    };
    outcome = 'merged';
  }
  // 4. Deploy. RTDB takes a full PUT of the rules JSON; `print=silent`
  //    suppresses the (verbose) echo response body.
  const putUrl = `${databaseUrl}/.settings/rules.json?access_token=${encodeURIComponent(token)}&print=silent`;
  const putResp = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nextBody),
  });
  if (!putResp.ok) {
    return `error: deploy rules failed: ${putResp.status} ${await putResp.text()}`;
  }
  return outcome;
}

// Module-level handles to the service account + RTDB admin token, set
// after `loadConfig()` runs. Probes that need to PUT to the
// `/.settings/rules.json` endpoint (rules round-trip, propagation
// timing) read these. `null` when the harness ran via
// `PYRIC_ORACLE_FIREBASE_CONFIG` (no SA available) or when the project
// has no RTDB instance.
let serviceAccount: ServiceAccount | null = null;
let rtdbAdminToken: string | null = null;

async function loadConfig(): Promise<FirebaseWebConfig> {
  // Manual override path (no SA needed) — paste the Web config JSON.
  const manual = process.env.PYRIC_ORACLE_FIREBASE_CONFIG;
  if (manual) {
    try {
      return JSON.parse(manual) as FirebaseWebConfig;
    } catch (e) {
      throw new Error(`PYRIC_ORACLE_FIREBASE_CONFIG is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Service-account path — default to the repo's local SA file.
  const saPath = process.env.PYRIC_ORACLE_SA_PATH
    ?? join(REPO_ROOT, 'ignored', 'service-account.json');
  if (!existsSync(saPath)) {
    throw new Error(
      `service account not found at ${saPath}. Set PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_FIREBASE_CONFIG. See packages/conformance/docs/oracle-project-setup.md.`,
    );
  }
  const sa = JSON.parse(readFileSync(saPath, 'utf8')) as ServiceAccount;
  serviceAccount = sa;
  console.log(`[oracle] service account: ${sa.client_email}`);
  console.log(`[oracle] project: ${sa.project_id}`);
  const token = await mintToken(sa, 'https://www.googleapis.com/auth/firebase');
  const cfg = await fetchWebConfig(token, sa.project_id);
  const ruleOutcome = await ensureOracleRules(token, sa.project_id);
  console.log(`[oracle] oracle rules: ${ruleOutcome}`);
  // Storage rules deployment is best-effort. If the project has
  // Storage enabled but the SA lacks the rules-deploy permission, or
  // the rules layout doesn't match our merge regex, the harness logs
  // the failure and proceeds — Storage probes will then observe the
  // existing rules' behavior (likely `storage/unauthorized`).
  let storageRuleOutcome: string = 'skipped';
  try {
    storageRuleOutcome = await ensureOracleStorageRules(token, sa.project_id, cfg.storageBucket);
  } catch (e) {
    storageRuleOutcome = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(`[oracle] storage rules: ${storageRuleOutcome}`);
  // Newly-deployed rules take a few seconds to propagate before
  // the next setDoc sees them. Existing-configured: no wait.
  const ruleChanged = ruleOutcome !== 'already-configured';
  const storageRuleChanged =
    storageRuleOutcome !== 'already-configured' &&
    storageRuleOutcome !== 'skipped' &&
    !storageRuleOutcome.startsWith('error');
  if (ruleChanged || storageRuleChanged) {
    console.log('[oracle] waiting 10s for new rules to propagate');
    await new Promise((r) => setTimeout(r, 10_000));
  }
  // Pick up the RTDB instance URL if the Web App config didn't carry
  // one. The Web App config only embeds `databaseURL` when an RTDB
  // existed at app-creation time, so we fall back to discovery via
  // the Database Management API.
  if (!cfg.databaseURL) {
    const rtdbUrl = await discoverRtdbInstance(token, sa.project_id);
    if (rtdbUrl) {
      cfg.databaseURL = rtdbUrl;
      console.log(`[oracle] discovered rtdb instance: ${rtdbUrl}`);
    } else {
      console.log(`[oracle] no rtdb instance found on ${sa.project_id} — rtdb probes will be skipped`);
    }
  }
  // RTDB rules — best-effort, mirrors the Firestore + Storage pattern.
  // The per-database `/.settings/rules.json` endpoint requires the
  // `firebase.database` OAuth scope (the broader `firebase` scope used
  // by the Firestore + Storage + Management APIs is NOT accepted here).
  // We mint a separate token scoped to `firebase.database` +
  // `userinfo.email` (the email scope is required by the RTDB REST API
  // for SA auth). If the SA lacks the necessary IAM role
  // (e.g. `roles/firebasedatabase.admin`), the deploy returns 401/403
  // and we log the error string but proceed; RTDB probes will then
  // observe whatever rules the project currently has.
  let rtdbRuleOutcome: string = 'skipped';
  if (cfg.databaseURL) {
    try {
      const rtdbToken = await mintToken(
        sa,
        'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
      );
      rtdbAdminToken = rtdbToken;
      rtdbRuleOutcome = await ensureOracleRtdbRules(rtdbToken, cfg.databaseURL);
    } catch (e) {
      rtdbRuleOutcome = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    console.log(`[oracle] rtdb rules: ${rtdbRuleOutcome}`);
    const rtdbRuleChanged =
      rtdbRuleOutcome !== 'already-configured' &&
      rtdbRuleOutcome !== 'skipped' &&
      !rtdbRuleOutcome.startsWith('error');
    if (rtdbRuleChanged) {
      console.log('[oracle] waiting 5s for rtdb rules to propagate');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  return cfg;
}

const config = await loadConfig();
// Resolve the firebase package via Node's resolver so we don't care
// where it's hoisted in the workspace.
const fbPkgPath = await import.meta.resolve('firebase/package.json');
const fbPkg = JSON.parse(readFileSync(fileURLToPath(fbPkgPath), 'utf8')) as { version: string };
const FB_SDK_VERSION = fbPkg.version;

const appName = `pyric-oracle-${Date.now()}`;
const app = initializeApp(config, appName);
const db: Firestore = getFirestore(app);
const auth: Auth = getAuth(app);

// Storage handle is lazy: if the project doesn't have a `storageBucket`
// in its Web SDK config, Storage isn't enabled and `getStorage(app)`
// won't have a default bucket to bind to. Storage probes guard on this
// and skip-with-explanation rather than failing the whole run.
const STORAGE_BUCKET = config.storageBucket;
const storage: FirebaseStorage | null = STORAGE_BUCKET
  ? getStorage(app)
  : null;

// RTDB handle is lazy: same as storage. The Web SDK config carries
// `databaseURL` only when RTDB existed at app-creation time; we fall
// back to discovery via the Management API in loadConfig. Probes guard
// on `rtdb !== null` and skip with `{ skipped: true }` otherwise.
const rtdb: Database | null = config.databaseURL ? getDatabase(app) : null;

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// All probe data lives under pyric_oracle/<RUN_ID>/<probe>/* — keeps
// each run isolated and lets the rule match the whole subtree.
const RUN_DOC = (probe: string) => `pyric_oracle/${RUN_ID}/${probe}`;
// Storage objects live under pyric_oracle/<RUN_ID>/<probe>/<filename>
// so the namespace mirrors Firestore's. Storage rules need to be
// deployed separately (see packages/conformance/docs/oracle-project-setup.md); if the project's
// Storage rules deny writes to this namespace, the probes record the
// observation and surface the failure as a `storage/unauthorized`
// observation rather than a probe-runtime error.
const RUN_STORAGE_PATH = (probe: string, filename: string) =>
  `pyric_oracle/${RUN_ID}/${probe}/${filename}`;
// RTDB probe scope. RTDB paths are absolute and slash-separated; we
// nest under `/pyric_oracle/<RUN_ID>/<probe>` so each run is isolated
// and the `pyric_oracle/*` rules namespace covers the whole subtree.
// Leading slash matters: the modular SDK accepts both `'foo'` and
// `'/foo'`, but having an explicit leading slash makes the namespace
// boundary unambiguous in any URL constructed from the path (e.g. when
// crossing into a denied-namespace probe).
const RTDB_RUN_PATH = (probe: string) =>
  `/pyric_oracle/${RUN_ID}/${probe}`;

// ─── Observation type ─────────────────────────────────────────────────

interface Observation {
  name: string;
  /** Display prose only ("firestore #39") — machines read rowIds. */
  matrixRow: string;
  /** Structured registry links, e.g. ['firestore#39']. */
  rowIds: string[];
  description: string;
  observedAt: string;
  fbSdkVersion: string;
  projectId: string;
  behavior: Record<string, unknown>;
}

interface Probe {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observe(): Promise<Record<string, unknown>>;
}

const SURFACE_OWNERS = surfaceDescriptors.map((d) => ({ id: d.surface, observationPrefixes: d.observationPrefixes }));

/** This rig (oracle-run) spans five surfaces (auth, firestore, rtdb,
 *  rtdb-modular, storage) — every observation it writes must land in ITS
 *  surface subdirectory, resolved by the same longest-prefix rule
 *  validated surfaces/*.json observationPrefixes define everywhere else. */
function writeObservation(obs: Observation): void {
  const surface = soleLongestPrefixOwner(obs.name, SURFACE_OWNERS);
  if (!surface) throw new Error(`observation '${obs.name}' does not match a known surface observation prefix`);
  const dir = join(OBS_DIR, surface);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${obs.name}.json`);
  writeFileSync(file, JSON.stringify(obs, null, 2) + '\n');
}

async function purge(probeId: string): Promise<void> {
  try {
    const c = collection(db, RUN_DOC(probeId));
    const snap = await getDocs(c);
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  } catch {
    // Best-effort. If we never signed in (or rules deny anonymous reads
    // here), the leftover docs get cleaned up by the next run's purge
    // or the user's own console cleanup.
  }
}

async function dropCurrentUser(): Promise<void> {
  const u: User | null = auth.currentUser;
  if (u && u.isAnonymous) {
    try { await u.delete(); } catch { /* ignored */ }
  }
}

/**
 * Read the `.type` discriminant off one of `firebase/auth`'s persistence
 * tokens by name, through the namespace import. Returns
 * `'absent-in-node-build'` for the browser-only tokens
 * (`indexedDBLocalPersistence`, `browserCookiePersistence`), which this
 * Node-resolved harness cannot see — the census resolves the browser
 * condition and DOES see them, so the mirror still owes those exports.
 */
function persistenceType(name: string): string {
  const token = (fbAuthNs as Record<string, unknown>)[name] as { type?: string } | undefined;
  if (token === undefined) return 'absent-in-node-build';
  return token.type ?? 'no-type-field';
}

/**
 * Run a step and report the FirebaseError code it raised, or `null` if it
 * resolved. Every step of a probe body — setup included — should go through
 * this: an unguarded throw inside `observe()` aborts the whole run, so one
 * operation this project happens to gate at the project level (Identity
 * Platform's `auth/operation-not-allowed`) would otherwise take the
 * remaining probes down with it. Recording the code IS the observation.
 */
async function attemptCode(step: () => Promise<unknown>): Promise<string | null> {
  try {
    await step();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e));
  }
}

// ─── Probes ───────────────────────────────────────────────────────────

const probes: Probe[] = [
  {
    name: 'firestore-deletedoc-missing',
    matrixRow: 'firestore #39',
    rowIds: ['firestore#39'],
    description: 'deleteDoc against a non-existent doc — locks whether prod throws or no-ops.',
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('deletedoc-missing'), 'never-written');
      let threw = false;
      let error: string | undefined;
      let code: string | undefined;
      try {
        await deleteDoc(ref);
      } catch (e) {
        threw = true;
        error = e instanceof Error ? e.message : String(e);
        code = (e as { code?: string }).code;
      }
      await dropCurrentUser();
      return { threw, error: error ?? null, code: code ?? null };
    },
  },
  {
    name: 'firestore-queryequal-structural',
    matrixRow: 'firestore #116',
    rowIds: ['firestore#116'],
    description: 'queryEqual semantics — does prod compare structurally or by identity?',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('queryequal'));
      const aRef = doc(c, 'a');
      const bRef = doc(c, 'b');
      const localRef = doc(db, 'query-equality/ref');
      const timestampValue = Timestamp.fromMillis(1_234);
      const bytesInput = new Uint8Array([1, 2]);
      const bytesValue = Bytes.fromUint8Array(bytesInput);
      const geoPointValue = new GeoPoint(10, 20);
      const vectorInput = [1, 2];
      const vectorValue = vector(vectorInput);
      await setDoc(aRef, {
        value: { score: 1 },
        rank: 1,
        timestampValue,
        bytesValue,
        geoPointValue,
        referenceValue: localRef,
        vectorValue,
      });
      await setDoc(bRef, { value: { score: 2 }, rank: 2 });
      const q1 = query(c, where('x', '==', 1));
      const q2 = query(c, where('x', '==', 1));
      const q3 = query(c, where('x', '==', 2));
      const q4 = query(c, where('x', '==', { a: 1 }));
      const q5 = query(c, where('x', '==', { a: 1 }));
      const q6 = query(c, where('x', '==', { a: 2 }));
      const otherCollection = collection(db, RUN_DOC('queryequal-other'));
      const collectionGroupA = collectionGroup(db, 'queryequal-group');
      const collectionGroupB = collectionGroup(db, 'queryequal-group');
      const collectionGroupChanged = collectionGroup(db, 'queryequal-other-group');
      const orderedA = query(c, orderBy('rank'), orderBy(documentId()));
      const orderedB = query(c, orderBy('rank'), orderBy(documentId()));
      const orderedDescending = query(c, orderBy('rank', 'desc'), orderBy(documentId()));
      const orderedReversed = query(c, orderBy(documentId()), orderBy('rank'));
      const limitedA = query(c, orderBy('rank'), limit(1));
      const limitedB = query(c, orderBy('rank'), limit(1));
      const limitedChanged = query(c, orderBy('rank'), limit(2));
      const limitedLast = query(c, orderBy('rank'), limitToLast(1));
      const compositeA = query(c, and(where('x', '==', 1), where('y', '==', 2)));
      const compositeB = query(c, and(where('x', '==', 1), where('y', '==', 2)));
      const compositeValueChanged = query(c, and(where('x', '==', 1), where('y', '==', 3)));
      const compositeShapeChanged = query(c, or(where('x', '==', 1), where('y', '==', 2)));
      const startAtA = query(orderedA, startAt(1, aRef.id));
      const startAtB = query(orderedA, startAt(1, aRef.id));
      const startAtChanged = query(orderedA, startAt(2, bRef.id));
      const startAfterSame = query(orderedA, startAfter(1, aRef.id));
      const endAtA = query(orderedA, endAt(1, aRef.id));
      const endAtB = query(orderedA, endAt(1, aRef.id));
      const endAtChanged = query(orderedA, endAt(2, bRef.id));
      const endBeforeSame = query(orderedA, endBefore(1, aRef.id));
      const structuredA = query(c, where('x', '==', ['x', { enabled: true }]));
      const structuredB = query(c, where('x', '==', ['x', { enabled: true }]));
      const structuredChanged = query(c, where('x', '==', ['x', { enabled: false }]));
      const timestampA = query(c, where('x', '==', timestampValue));
      const timestampB = query(c, where('x', '==', Timestamp.fromMillis(1_234)));
      const timestampChanged = query(c, where('x', '==', Timestamp.fromMillis(1_235)));
      const bytesA = query(c, where('x', '==', bytesValue));
      const bytesB = query(c, where('x', '==', Bytes.fromUint8Array(new Uint8Array([1, 2]))));
      const bytesChanged = query(c, where('x', '==', Bytes.fromUint8Array(new Uint8Array([1, 3]))));
      const geoA = query(c, where('x', '==', geoPointValue));
      const geoB = query(c, where('x', '==', new GeoPoint(10, 20)));
      const geoChanged = query(c, where('x', '==', new GeoPoint(10, 21)));
      const refA = query(c, where('x', '==', localRef));
      const refB = query(c, where('x', '==', doc(db, 'query-equality/ref')));
      const refChanged = query(c, where('x', '==', doc(db, 'query-equality/other')));
      const otherApp = initializeApp(
        { ...config, projectId: `${config.projectId}-other` },
        `${appName}-query-equality-other`,
      );
      const otherDb = getFirestore(otherApp);
      let referenceOtherDatabaseRejected = false;
      let referenceOtherDatabaseErrorCode: string | null = null;
      try {
        query(c, where('x', '==', doc(otherDb, 'query-equality/ref')));
      } catch (error) {
        referenceOtherDatabaseRejected = true;
        referenceOtherDatabaseErrorCode = typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : null;
      }
      const vectorA = query(c, where('x', '==', vectorValue));
      const vectorB = query(c, where('x', '==', vector([1, 2])));
      const vectorChanged = query(c, where('x', '==', vector([1, 3])));
      const dateValue = query(c, where('x', '==', new Date(1_234)));
      const negativeZero = query(c, where('x', '==', -0));
      const positiveZero = query(c, where('x', '==', 0));
      const converterA: FirestoreDataConverter<Record<string, unknown>> = {
        toFirestore: (value) => value,
        fromFirestore: (snapshot) => snapshot.data(),
      };
      const converterB = { ...converterA };
      const convertedA1 = c.withConverter(converterA);
      const convertedA2 = c.withConverter(converterA);
      const convertedB = c.withConverter(converterB);
      const constructionError = (value: unknown): { threw: boolean; code: string | null } => {
        try {
          query(c, where('x', '==', value));
          return { threw: false, code: null };
        } catch (error) {
          return {
            threw: true,
            code: typeof (error as { code?: unknown })?.code === 'string'
              ? (error as { code: string }).code
              : null,
          };
        }
      };
      const foreignRef = doc(otherDb, 'query-equality/ref');
      const nestedForeignReference = constructionError({ ref: foreignRef });
      const arrayForeignReference = constructionError([foreignRef]);
      const convertedForeignReference = constructionError(foreignRef.withConverter(converterA));
      const rawReferenceQuery = query(c, where('x', '==', localRef));
      const convertedReferenceQuery = query(c, where('x', '==', localRef.withConverter(converterA)));
      const mutableOperand = { score: 1 };
      const independentOperand = { score: 1 };
      const frozenExecutionQuery = query(c, where('value', '==', mutableOperand));
      const independentExecutionQuery = query(c, where('value', '==', independentOperand));
      mutableOperand.score = 2;
      const frozenExecutionIds = (await getDocs(frozenExecutionQuery)).docs.map((snap) => snap.id);
      const independentExecutionIds = (await getDocs(independentExecutionQuery)).docs.map((snap) => snap.id);
      const execute = async (field: string, value: unknown) => {
        try {
          return {
            ids: (await getDocs(query(c, where(field, '==', value)))).docs.map((snap) => snap.id),
            code: null,
          };
        } catch (error) {
          return {
            ids: [],
            code: typeof (error as { code?: unknown })?.code === 'string'
              ? (error as { code: string }).code
              : null,
          };
        }
      };
      const timestampExecution = await execute('timestampValue', timestampValue);
      const bytesExecution = await execute('bytesValue', bytesValue);
      const geoPointExecution = await execute('geoPointValue', geoPointValue);
      const referenceExecution = await execute('referenceValue', localRef);
      const vectorExecution = await execute('vectorValue', vectorValue);
      const frozenBytesQuery = query(c, where('bytesValue', '==', bytesValue));
      const frozenVectorQuery = query(c, where('vectorValue', '==', vectorValue));
      bytesInput[0] = 9;
      vectorInput[0] = 9;
      const bytesExecutionAfterInputMutation = await execute('bytesValue', bytesValue);
      const vectorExecutionAfterInputMutation = await execute('vectorValue', vectorValue);
      const frozenBytesExecutionAfterInputMutation = await getDocs(frozenBytesQuery)
        .then((snapshot) => ({ ids: snapshot.docs.map((docSnapshot) => docSnapshot.id), code: null }))
        .catch((error: unknown) => ({
          ids: [] as string[],
          code: typeof (error as { code?: unknown })?.code === 'string'
            ? (error as { code: string }).code
            : null,
        }));
      const frozenVectorExecutionAfterInputMutation = await getDocs(frozenVectorQuery)
        .then((snapshot) => ({ ids: snapshot.docs.map((docSnapshot) => docSnapshot.id), code: null }))
        .catch((error: unknown) => ({
          ids: [] as string[],
          code: typeof (error as { code?: unknown })?.code === 'string'
            ? (error as { code: string }).code
            : null,
        }));
      const cursorSnapshot = await getDoc(aRef);
      const cursorBase = query(c, orderBy('rank'), orderBy(documentId()));
      const snapshotCursor = query(cursorBase, startAt(cursorSnapshot));
      const explicitCursor = query(cursorBase, startAt(1, aRef.id));
      let snapshotCursorConverterCalls = 0;
      const statefulCursorConverter: FirestoreDataConverter<Record<string, unknown>> = {
        toFirestore: (value) => value,
        fromFirestore: () => {
          snapshotCursorConverterCalls += 1;
          return { rank: 999 };
        },
      };
      const convertedCursorSnapshot = await getDoc(aRef.withConverter(statefulCursorConverter));
      const snapshotCursorConverterCallsAfterFetch = snapshotCursorConverterCalls;
      const statefulSnapshotCursor = query(cursorBase, startAt(convertedCursorSnapshot));
      const snapshotCursorConverterCallsAfterConstruction = snapshotCursorConverterCalls;
      const statefulSnapshotCursorEqualToExplicit = queryEqual(
        statefulSnapshotCursor,
        explicitCursor,
      );
      const snapshotCursorConverterCallsAfterEquality = snapshotCursorConverterCalls;
      const statefulSnapshotCursorFirstExecutionIds = (await getDocs(statefulSnapshotCursor))
        .docs.map((snap) => snap.id);
      const snapshotCursorConverterCallsAfterFirstExecution = snapshotCursorConverterCalls;
      const statefulSnapshotCursorSecondExecutionIds = (await getDocs(statefulSnapshotCursor))
        .docs.map((snap) => snap.id);
      const snapshotCursorConverterCallsAfterSecondExecution = snapshotCursorConverterCalls;
      const rawAddedRef = await addDoc(c, { kind: 'raw-added-reference' });
      const convertedAddedRef = await addDoc(
        c.withConverter(converterA),
        { kind: 'converted-added-reference' },
      );
      await setDoc(aRef, {
        rawAddedReference: rawAddedRef,
        convertedAddedReference: convertedAddedRef,
      }, { merge: true });
      const rawAddedReferenceQuery = query(c, where('rawAddedReference', '==', rawAddedRef));
      const rebuiltRawAddedReferenceQuery = query(
        c,
        where('rawAddedReference', '==', doc(db, rawAddedRef.path)),
      );
      const convertedAddedReferenceQuery = query(
        c,
        where('convertedAddedReference', '==', convertedAddedRef),
      );
      const rebuiltConvertedAddedReferenceQuery = query(
        c,
        where('convertedAddedReference', '==', doc(db, convertedAddedRef.path)),
      );
      let getterCalls = 0;
      const getterOperand = Object.defineProperty({}, 'value', {
        enumerable: true,
        get() { getterCalls += 1; return 1; },
      });
      const getterA = query(c, where('x', '==', getterOperand));
      const getterB = query(c, where('x', '==', getterOperand));
      const getterCallsAfterConstruction = getterCalls;
      const getterQueriesEqual = queryEqual(getterA, getterB);
      const getterCallsAfterEquality = getterCalls;
      const undefinedValue = constructionError(undefined);
      const bigintValue = constructionError(BigInt(1));
      const result = {
        sameQueryBuiltTwice: queryEqual(q1, q2),
        differentValue: queryEqual(q1, q3),
        objectValueBuiltTwice: queryEqual(q4, q5),
        objectValueChanged: queryEqual(q4, q6),
        sameCollectionScope: queryEqual(q1, query(c, where('x', '==', 1))),
        differentCollectionScope: queryEqual(q1, query(otherCollection, where('x', '==', 1))),
        sameCollectionGroupScope: queryEqual(collectionGroupA, collectionGroupB),
        differentCollectionGroupScope: queryEqual(collectionGroupA, collectionGroupChanged),
        collectionAndCollectionGroupDiffer: queryEqual(c, collectionGroupA),
        sameOrderSequence: queryEqual(orderedA, orderedB),
        differentOrderDirection: queryEqual(orderedA, orderedDescending),
        differentOrderSequence: queryEqual(orderedA, orderedReversed),
        sameLimit: queryEqual(limitedA, limitedB),
        differentLimit: queryEqual(limitedA, limitedChanged),
        limitAndLimitToLastDiffer: queryEqual(limitedA, limitedLast),
        sameCompositeFilter: queryEqual(compositeA, compositeB),
        differentCompositeFilterValue: queryEqual(compositeA, compositeValueChanged),
        differentCompositeFilterShape: queryEqual(compositeA, compositeShapeChanged),
        sameStartCursor: queryEqual(startAtA, startAtB),
        differentStartCursorValue: queryEqual(startAtA, startAtChanged),
        startAtAndStartAfterDiffer: queryEqual(startAtA, startAfterSame),
        sameEndCursor: queryEqual(endAtA, endAtB),
        differentEndCursorValue: queryEqual(endAtA, endAtChanged),
        endAtAndEndBeforeDiffer: queryEqual(endAtA, endBeforeSame),
        structuredValueBuiltTwice: queryEqual(structuredA, structuredB),
        structuredValueChanged: queryEqual(structuredA, structuredChanged),
        timestampValueBuiltTwice: queryEqual(timestampA, timestampB),
        timestampValueChanged: queryEqual(timestampA, timestampChanged),
        bytesValueBuiltTwice: queryEqual(bytesA, bytesB),
        bytesValueChanged: queryEqual(bytesA, bytesChanged),
        geoPointValueBuiltTwice: queryEqual(geoA, geoB),
        geoPointValueChanged: queryEqual(geoA, geoChanged),
        referenceValueBuiltTwice: queryEqual(refA, refB),
        referenceValueChanged: queryEqual(refA, refChanged),
        referenceOtherDatabaseRejected,
        referenceOtherDatabaseErrorCode,
        nestedReferenceOtherDatabaseRejected: nestedForeignReference.threw,
        nestedReferenceOtherDatabaseErrorCode: nestedForeignReference.code,
        arrayReferenceOtherDatabaseRejected: arrayForeignReference.threw,
        arrayReferenceOtherDatabaseErrorCode: arrayForeignReference.code,
        convertedReferenceOtherDatabaseRejected: convertedForeignReference.threw,
        convertedReferenceOtherDatabaseErrorCode: convertedForeignReference.code,
        rawAndConvertedReferenceOperandsEqual: queryEqual(rawReferenceQuery, convertedReferenceQuery),
        constructedQueriesRemainEqualAfterOperandMutation: queryEqual(
          frozenExecutionQuery,
          independentExecutionQuery,
        ),
        frozenExecutionIds,
        independentExecutionIds,
        timestampExecution,
        bytesExecution,
        geoPointExecution,
        referenceExecution,
        vectorExecution,
        bytesExecutionAfterInputMutation,
        vectorExecutionAfterInputMutation,
        frozenBytesExecutionAfterInputMutation,
        frozenVectorExecutionAfterInputMutation,
        snapshotAndExplicitCursorEqual: queryEqual(snapshotCursor, explicitCursor),
        snapshotCursorConverterCallsAfterFetch,
        snapshotCursorConverterCallsAfterConstruction,
        statefulSnapshotCursorEqualToExplicit,
        snapshotCursorConverterCallsAfterEquality,
        statefulSnapshotCursorFirstExecutionIds,
        snapshotCursorConverterCallsAfterFirstExecution,
        statefulSnapshotCursorSecondExecutionIds,
        snapshotCursorConverterCallsAfterSecondExecution,
        rawAddDocReferenceEqualToRebuilt: queryEqual(
          rawAddedReferenceQuery,
          rebuiltRawAddedReferenceQuery,
        ),
        convertedAddDocReferenceEqualToRebuilt: queryEqual(
          convertedAddedReferenceQuery,
          rebuiltConvertedAddedReferenceQuery,
        ),
        rawAddDocReferenceExecutionIds: (await getDocs(rawAddedReferenceQuery))
          .docs.map((snap) => snap.id),
        convertedAddDocReferenceExecutionIds: (await getDocs(convertedAddedReferenceQuery))
          .docs.map((snap) => snap.id),
        vectorValueBuiltTwice: queryEqual(vectorA, vectorB),
        vectorValueChanged: queryEqual(vectorA, vectorChanged),
        dateEqualsEquivalentTimestamp: queryEqual(dateValue, timestampA),
        negativeZeroEqualsPositiveZero: queryEqual(negativeZero, positiveZero),
        sameConverterIdentity: queryEqual(convertedA1, convertedA2),
        differentConverterIdentity: queryEqual(convertedA1, convertedB),
        getterQueriesEqual,
        getterCallsAfterConstruction,
        getterCallsAfterEquality,
        undefinedRejected: undefinedValue.threw,
        undefinedErrorCode: undefinedValue.code,
        bigintRejected: bigintValue.threw,
        bigintErrorCode: bigintValue.code,
        identity: queryEqual(q1, q1),
      };
      await Promise.all([
        deleteDoc(aRef),
        deleteDoc(bRef),
        deleteDoc(rawAddedRef),
        deleteDoc(convertedAddedRef),
      ]);
      await deleteApp(otherApp);
      await dropCurrentUser();
      return result;
    },
  },
  {
    name: 'firestore-snapshotequal-structural',
    matrixRow: 'firestore #117',
    rowIds: ['firestore#117'],
    description: 'snapshotEqual semantics — does prod compare structurally or by identity across two fetches of the same query?',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('snapshotequal'));
      await setDoc(doc(c, 'a'), { v: 1 });
      const q = query(c, where('v', '==', 1));
      const snap1 = await getDocs(q);
      const snap2 = await getDocs(q);
      const snap3 = await getDocs(q);
      const equivalentQueryRead = await getDocs(query(c, where('v', '==', 1)));
      const differentQueryRead = await getDocs(query(c, orderBy('v')));
      const aRef = doc(c, 'a');
      const bRef = doc(c, 'b');
      const summarize = (snapshot: typeof snap1, includeMetadataChanges = false) => ({
        ids: snapshot.docs.map((docSnapshot) => docSnapshot.id),
        data: snapshot.docs.map((docSnapshot) => docSnapshot.data()),
        changes: snapshot.docChanges(
          includeMetadataChanges ? { includeMetadataChanges: true } : undefined,
        ).map((change) => ({
          type: change.type,
          id: change.doc.id,
          oldIndex: change.oldIndex,
          newIndex: change.newIndex,
        })),
        metadata: {
          fromCache: snapshot.metadata.fromCache,
          hasPendingWrites: snapshot.metadata.hasPendingWrites,
        },
      });
      const firstListenerSnapshot = (source = q) => new Promise<typeof snap1>((resolve, reject) => {
        let unsubscribe = () => {};
        unsubscribe = onSnapshot(source, (snapshot) => {
          unsubscribe();
          resolve(snapshot);
        }, reject);
      });
      const [listenerSnap1, listenerSnap2, differentQuerySnapshot] = await Promise.all([
        firstListenerSnapshot(),
        firstListenerSnapshot(),
        firstListenerSnapshot(query(c, orderBy('v'))),
      ]);
      const [beforeDocumentChange, afterDocumentChange] = await new Promise<[
        typeof snap1,
        typeof snap1,
      ]>((resolve, reject) => {
        let first: typeof snap1 | undefined;
        let writeCompletion: Promise<void> | undefined;
        let unsubscribe = () => {};
        unsubscribe = onSnapshot(q, (snapshot) => {
          if (first === undefined) {
            first = snapshot;
            writeCompletion = setDoc(bRef, { v: 1 });
            void writeCompletion.catch(reject);
            return;
          }
          unsubscribe();
          void writeCompletion?.then(() => resolve([first!, snapshot]), reject);
        }, reject);
      });
      const changedRead1 = await getDocs(q);
      const changedRead2 = await getDocs(q);
      const changedRead3 = await getDocs(q);

      const historyCollection = collection(db, RUN_DOC('snapshotequal-history'));
      const historyRef = doc(historyCollection, 'a');
      await setDoc(historyRef, { v: 1 });
      const [historyInitial, historyChanged, historyRestored] = await new Promise<[
        typeof snap1,
        typeof snap1,
        typeof snap1,
      ]>((resolve, reject) => {
        const snapshots: Array<typeof snap1> = [];
        let unsubscribe = () => {};
        unsubscribe = onSnapshot(historyCollection, (snapshot) => {
          snapshots.push(snapshot);
          if (snapshots.length === 1) {
            void setDoc(historyRef, { v: 2 }).catch(reject);
          } else if (snapshots.length === 2) {
            void setDoc(historyRef, { v: 1 }).catch(reject);
          } else {
            unsubscribe();
            resolve([snapshots[0]!, snapshots[1]!, snapshots[2]!]);
          }
        }, reject);
      });

      const metadataCollection = collection(db, RUN_DOC('snapshotequal-metadata'));
      const metadataRef = doc(metadataCollection, 'a');
      await setDoc(metadataRef, { v: 1 });
      const [metadataPending, metadataSettled] = await new Promise<[
        typeof snap1,
        typeof snap1,
      ]>((resolve, reject) => {
        let wrote = false;
        let pending: typeof snap1 | undefined;
        let unsubscribe = () => {};
        unsubscribe = onSnapshot(
          metadataCollection,
          { includeMetadataChanges: true },
          (snapshot) => {
            if (!wrote) {
              wrote = true;
              void setDoc(metadataRef, { v: 1 }).catch(reject);
              return;
            }
            if (snapshot.metadata.hasPendingWrites) {
              pending = snapshot;
              return;
            }
            if (pending !== undefined) {
              unsubscribe();
              resolve([pending, snapshot]);
            }
          },
          reject,
        );
      });

      const document1 = await getDoc(aRef);
      const document2 = await getDoc(aRef);
      const documentOtherRef = await getDoc(bRef);
      const queryChild = snap1.docs[0]!;
      const missingRef = doc(c, 'missing');
      const missing1 = await getDoc(missingRef);
      const missing2 = await getDoc(missingRef);
      const converterA: FirestoreDataConverter<Record<string, unknown>> = {
        toFirestore: (value) => value,
        fromFirestore: (snapshot) => snapshot.data(),
      };
      const converterB = { ...converterA };
      const convertedA1 = await getDoc(aRef.withConverter(converterA));
      const convertedA2 = await getDoc(aRef.withConverter(converterA));
      const convertedB = await getDoc(aRef.withConverter(converterB));
      await setDoc(aRef, { v: 2 });
      const documentChanged = await getDoc(aRef);
      const json = snap1.toJSON();
      const fromJson1 = querySnapshotFromJSON(db, json);
      const fromJson2 = querySnapshotFromJSON(db, json);
      const repeatedFetchState = [snap1, snap2, snap3, equivalentQueryRead].map((snapshot) =>
        summarize(snapshot));
      const differentReadQueryState = [summarize(snap3), summarize(differentQueryRead)];
      const differentListenerQueryState = [
        summarize(listenerSnap1),
        summarize(differentQuerySnapshot),
      ];
      const simultaneousListenerState = [summarize(listenerSnap1), summarize(listenerSnap2)];
      const differentDocumentState = [
        summarize(beforeDocumentChange),
        summarize(afterDocumentChange),
      ];
      const restoredChangeState = [summarize(historyInitial), summarize(historyRestored)];
      const metadataOnlyState = [summarize(metadataPending), summarize(metadataSettled)];
      const sameJson = (left: unknown, right: unknown) =>
        JSON.stringify(left) === JSON.stringify(right);
      const result = {
        identity: snapshotEqual(snap1, snap1),
        twoFetchesSameData: snapshotEqual(snap1, snap2),
        repeatedFetchEquality: [
          snapshotEqual(snap1, snap2),
          snapshotEqual(snap2, snap3),
          snapshotEqual(snap3, equivalentQueryRead),
        ],
        repeatedFetchState,
        repeatedFetchVisibleStateSame: repeatedFetchState.slice(1).every((state) =>
          sameJson(state, repeatedFetchState[0])),
        differentReadQuerySameDocumentsEqual: snapshotEqual(snap3, differentQueryRead),
        differentReadQueryDocumentsSame: sameJson(
          differentReadQueryState[0]!.data,
          differentReadQueryState[1]!.data,
        ),
        changedReadEquality: [
          snapshotEqual(snap3, changedRead1),
          snapshotEqual(changedRead1, changedRead2),
          snapshotEqual(changedRead2, changedRead3),
        ],
        changedReadState: [snap3, changedRead1, changedRead2, changedRead3].map((snapshot) =>
          summarize(snapshot)),
        deserializedSnapshotsDistinct: fromJson1 !== fromJson2,
        sameJsonSnapshotsEqual: snapshotEqual(fromJson1, fromJson2),
        listenerSnapshotsDistinct: listenerSnap1 !== listenerSnap2,
        simultaneousListenerSnapshotsEqual: snapshotEqual(listenerSnap1, listenerSnap2),
        listenerSameState: summarize(listenerSnap1),
        simultaneousListenerStateSame: sameJson(
          simultaneousListenerState[0],
          simultaneousListenerState[1],
        ),
        differentQuerySameDocumentsEqual: snapshotEqual(listenerSnap1, differentQuerySnapshot),
        differentQuerySameDocuments: differentListenerQueryState,
        differentListenerQueryDocumentsSame: sameJson(
          differentListenerQueryState[0]!.data,
          differentListenerQueryState[1]!.data,
        ),
        differentDocumentsEqual: snapshotEqual(beforeDocumentChange, afterDocumentChange),
        differentDocuments: differentDocumentState,
        differentDocumentsChanged: !sameJson(
          differentDocumentState[0]!.data,
          differentDocumentState[1]!.data,
        ),
        restoredDocumentsDifferentChangesEqual: snapshotEqual(historyInitial, historyRestored),
        restoredDocumentsDifferentChanges: restoredChangeState,
        restoredDocumentsStateSame: sameJson(
          restoredChangeState[0]!.data,
          restoredChangeState[1]!.data,
        ),
        restoredChangesDiffer: !sameJson(
          restoredChangeState[0]!.changes,
          restoredChangeState[1]!.changes,
        ),
        metadataOnlySnapshotsEqual: snapshotEqual(metadataPending, metadataSettled),
        metadataOnlySnapshots: metadataOnlyState,
        metadataOnlyDocumentsSame: sameJson(
          metadataOnlyState[0]!.data,
          metadataOnlyState[1]!.data,
        ),
        metadataOnlyChangesSame: sameJson(
          metadataOnlyState[0]!.changes,
          metadataOnlyState[1]!.changes,
        ),
        metadataOnlyMetadataDiffer: !sameJson(
          metadataOnlyState[0]!.metadata,
          metadataOnlyState[1]!.metadata,
        ),
        documentIdentity: snapshotEqual(document1, document1),
        documentSameRefTwoFetches: snapshotEqual(document1, document2),
        documentDifferentRefSameData: snapshotEqual(document1, documentOtherRef),
        documentChangedData: snapshotEqual(document1, documentChanged),
        documentMissingSameRef: snapshotEqual(missing1, missing2),
        documentExistingAndMissingDiffer: snapshotEqual(document1, missing1),
        documentQueryChildMatchesGet: snapshotEqual(queryChild, document1),
        documentSameConverterIdentity: snapshotEqual(convertedA1, convertedA2),
        documentDifferentConverterIdentity: snapshotEqual(convertedA1, convertedB),
        listenerMetadata: [listenerSnap1, listenerSnap2].map((snapshot) => ({
          fromCache: snapshot.metadata.fromCache,
          hasPendingWrites: snapshot.metadata.hasPendingWrites,
        })),
        size: snap1.size,
      };
      await Promise.all([
        deleteDoc(aRef),
        deleteDoc(bRef),
        deleteDoc(historyRef),
        deleteDoc(metadataRef),
      ]);
      await dropCurrentUser();
      return result;
    },
  },
  {
    name: 'auth-signout-idempotent',
    matrixRow: 'auth #27',
    rowIds: ['auth#27'],
    description: 'signOut on already-signed-out auth — does prod throw, no-op, and does it fire onAuthStateChanged?',
    async observe() {
      const fires: Array<string | null> = [];
      const unsub = onAuthStateChanged(auth, (u) => fires.push(u ? u.uid : null));
      await signInAnonymously(auth);
      const minted = auth.currentUser;
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 100));
      const baselineFires = fires.length;
      let threw = false;
      let error: string | undefined;
      let code: string | undefined;
      try {
        await signOut(auth);
      } catch (e) {
        threw = true;
        error = e instanceof Error ? e.message : String(e);
        code = (e as { code?: string }).code;
      }
      await new Promise((r) => setTimeout(r, 100));
      const afterRedundantSignOut = fires.length;
      unsub();
      return {
        threw,
        error: error ?? null,
        code: code ?? null,
        baselineFires,
        afterRedundantSignOut,
        redundantSignOutFiredListener: afterRedundantSignOut > baselineFires,
        leakedAnonymousUid: minted?.uid ?? null,
      };
    },
  },
  {
    name: 'firestore-adddoc-autoid-format',
    matrixRow: 'firestore #45',
    rowIds: ['firestore#45'],
    description: 'addDoc auto-id format — observes the length and character set prod mints for auto-ids.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('adddoc-autoid'));
      const ref = await addDoc(c, {});
      const id = ref.id;
      const len = id.length;
      // Firestore docs describe auto-ids as 20-char base64-ish. Capture
      // the actual length + character classification so the matrix row
      // is locked to whatever prod actually mints.
      const isAllAlphanumeric = /^[A-Za-z0-9]+$/.test(id);
      const hasUpper = /[A-Z]/.test(id);
      const hasLower = /[a-z]/.test(id);
      const hasDigit = /[0-9]/.test(id);
      const hasOther = /[^A-Za-z0-9]/.test(id);
      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        sampleId: id,
        length: len,
        isAllAlphanumeric,
        hasUpper,
        hasLower,
        hasDigit,
        hasOther,
      };
    },
  },
  {
    name: 'firestore-count-aggregate-shape',
    matrixRow: 'firestore #79',
    rowIds: ['firestore#79'],
    description: 'getCountFromServer on empty vs non-empty query — observes the .data().count shape.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('count-aggregate'));

      // Empty collection
      const emptyAgg = await getCountFromServer(c);
      const emptyData = emptyAgg.data();
      const emptyCount = emptyData.count;
      const emptyCountType = typeof emptyCount;
      const emptyKeys = Object.keys(emptyData);

      // Seed 3 docs and re-aggregate
      await Promise.all([
        setDoc(doc(c, 'a'), { v: 1 }),
        setDoc(doc(c, 'b'), { v: 2 }),
        setDoc(doc(c, 'c'), { v: 1 }),
      ]);
      const fullAgg = await getCountFromServer(c);
      const fullData = fullAgg.data();
      const fullCount = fullData.count;
      const fullCountType = typeof fullCount;

      // A filtered query — count should drop to 2 docs with v===1
      const fq = query(c, where('v', '==', 1));
      const filteredAgg = await getCountFromServer(fq);
      const filteredCount = filteredAgg.data().count;

      await Promise.all([
        deleteDoc(doc(c, 'a')),
        deleteDoc(doc(c, 'b')),
        deleteDoc(doc(c, 'c')),
      ]);
      await dropCurrentUser();
      return {
        emptyCount,
        emptyCountType,
        emptyDataKeys: emptyKeys,
        fullCount,
        fullCountType,
        filteredCount,
      };
    },
  },
  {
    name: 'firestore-rules-denied-error',
    matrixRow: 'firestore #21',
    rowIds: ['firestore#21'],
    description: 'Rules-denied write — observes the error class, code, and message prod returns. Writes deliberately outside pyric_oracle/* so the rules deny it.',
    async observe() {
      await signInAnonymously(auth);
      // Deliberately OUTSIDE the pyric_oracle/* namespace so the
      // permissive rule does NOT match — prod returns whatever its
      // default-deny path produces.
      const ref = doc(db, 'pyric_oracle_denied_namespace', `denied-${RUN_ID}`);
      let threw = false;
      let code: string | undefined;
      let message: string | undefined;
      let name: string | undefined;
      let constructorName: string | undefined;
      let isFirebaseError = false;
      let isErrorInstance = false;
      try {
        await setDoc(ref, { x: 1 });
      } catch (e) {
        threw = true;
        const err = e as {
          code?: string;
          message?: string;
          name?: string;
          constructor?: { name?: string };
        };
        code = err.code;
        message = err.message;
        name = err.name;
        constructorName = err.constructor?.name;
        isErrorInstance = e instanceof Error;
        // FirebaseError is the prod class — duck-type it via .name.
        isFirebaseError = err.name === 'FirebaseError';
      }
      await dropCurrentUser();
      return {
        threw,
        code: code ?? null,
        message: message ?? null,
        errorName: name ?? null,
        constructorName: constructorName ?? null,
        isFirebaseError,
        isErrorInstance,
      };
    },
  },
  {
    name: 'firestore-read-denied-error-code',
    matrixRow: 'firestore #20',
    rowIds: ['firestore#20'],
    description: 'Rules-denied read — observes the error class, code, and message prod returns when getDoc targets a path outside pyric_oracle/* that the rules deny.',
    async observe() {
      await signInAnonymously(auth);
      // Deliberately OUTSIDE pyric_oracle/* — the permissive rule does
      // NOT match here, so the project's default-deny path kicks in.
      const ref = doc(db, 'pyric_oracle_denied_read', `denied-${RUN_ID}`);
      let threw = false;
      let code: string | undefined;
      let message: string | undefined;
      let name: string | undefined;
      let constructorName: string | undefined;
      let isFirebaseError = false;
      let isErrorInstance = false;
      try {
        await getDoc(ref);
      } catch (e) {
        threw = true;
        const err = e as {
          code?: string;
          message?: string;
          name?: string;
          constructor?: { name?: string };
        };
        code = err.code;
        message = err.message;
        name = err.name;
        constructorName = err.constructor?.name;
        isErrorInstance = e instanceof Error;
        isFirebaseError = err.name === 'FirebaseError';
      }
      await dropCurrentUser();
      return {
        threw,
        code: code ?? null,
        message: message ?? null,
        errorName: name ?? null,
        constructorName: constructorName ?? null,
        isFirebaseError,
        isErrorInstance,
      };
    },
  },
  {
    name: 'firestore-write-denied-error-code',
    matrixRow: 'firestore #32',
    rowIds: ['firestore#32'],
    description: 'Rules-denied write — pins the error class/code/message setDoc returns when the target is outside pyric_oracle/*. Companion to firestore-rules-denied-error but namespaced to #32 (setDoc).',
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, 'pyric_oracle_denied_write', `denied-${RUN_ID}`);
      let threw = false;
      let code: string | undefined;
      let message: string | undefined;
      let name: string | undefined;
      let constructorName: string | undefined;
      let isFirebaseError = false;
      let isErrorInstance = false;
      try {
        await setDoc(ref, { x: 1 });
      } catch (e) {
        threw = true;
        const err = e as {
          code?: string;
          message?: string;
          name?: string;
          constructor?: { name?: string };
        };
        code = err.code;
        message = err.message;
        name = err.name;
        constructorName = err.constructor?.name;
        isErrorInstance = e instanceof Error;
        isFirebaseError = err.name === 'FirebaseError';
      }
      await dropCurrentUser();
      return {
        threw,
        code: code ?? null,
        message: message ?? null,
        errorName: name ?? null,
        constructorName: constructorName ?? null,
        isFirebaseError,
        isErrorInstance,
      };
    },
  },
  {
    name: 'firestore-delete-denied-error-code',
    matrixRow: 'firestore #40',
    rowIds: ['firestore#40'],
    description: 'Rules-denied delete — observes the error class/code/message deleteDoc returns when the target is outside pyric_oracle/*. The doc need not exist; prod evaluates the rule before touching storage, so a deleteDoc on a denied path throws permission-denied regardless of whether the doc is present.',
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, 'pyric_oracle_denied_delete', `denied-${RUN_ID}`);
      let threw = false;
      let code: string | undefined;
      let message: string | undefined;
      let name: string | undefined;
      let constructorName: string | undefined;
      let isFirebaseError = false;
      let isErrorInstance = false;
      try {
        await deleteDoc(ref);
      } catch (e) {
        threw = true;
        const err = e as {
          code?: string;
          message?: string;
          name?: string;
          constructor?: { name?: string };
        };
        code = err.code;
        message = err.message;
        name = err.name;
        constructorName = err.constructor?.name;
        isErrorInstance = e instanceof Error;
        isFirebaseError = err.name === 'FirebaseError';
      }
      await dropCurrentUser();
      return {
        threw,
        code: code ?? null,
        message: message ?? null,
        errorName: name ?? null,
        constructorName: constructorName ?? null,
        isFirebaseError,
        isErrorInstance,
      };
    },
  },
  {
    name: 'firestore-include-metadata-changes',
    matrixRow: 'firestore #85',
    rowIds: ['firestore#85'],
    description: 'onSnapshot with includeMetadataChanges:true vs default — observes how many fires prod produces for one write.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('include-metadata'));
      const refA = doc(c, 'a');
      const refB = doc(c, 'b');

      // Default listener — no metadata changes.
      const fires: Array<{
        kind: 'default';
        fromCache: boolean;
        hasPendingWrites: boolean;
        size: number;
      }> = [];
      const firesMeta: Array<{
        kind: 'meta';
        fromCache: boolean;
        hasPendingWrites: boolean;
        size: number;
      }> = [];

      const unsubDefault = onSnapshot(c, (snap) => {
        fires.push({
          kind: 'default',
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
          size: snap.size,
        });
      });
      const unsubMeta = onSnapshot(c, { includeMetadataChanges: true }, (snap) => {
        firesMeta.push({
          kind: 'meta',
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
          size: snap.size,
        });
      });

      // Wait for initial fires.
      await new Promise((r) => setTimeout(r, 800));
      const initialDefault = fires.length;
      const initialMeta = firesMeta.length;

      // Single write — server-confirmed; default sees 1 fire; meta sees
      // 2 (local optimistic + server-confirmed) per prod docs.
      await setDoc(refA, { v: 1 });
      await new Promise((r) => setTimeout(r, 1500));
      const afterWriteDefault = fires.length;
      const afterWriteMeta = firesMeta.length;

      unsubDefault();
      unsubMeta();
      await Promise.all([deleteDoc(refA), deleteDoc(refB).catch(() => {})]);
      await dropCurrentUser();
      return {
        initialDefault,
        initialMeta,
        afterWriteDefault,
        afterWriteMeta,
        firesDefault: fires,
        firesMeta,
      };
    },
  },
  {
    name: 'auth-getidtoken-force-refresh',
    matrixRow: 'auth #55',
    rowIds: ['auth#55'],
    description: 'getIdToken(forceRefresh=true) — observes whether prod actually returns a different token string.',
    async observe() {
      await signInAnonymously(auth);
      const u = auth.currentUser!;
      const t0 = await u.getIdToken();
      // Spec says force refresh should mint a new token; if Firebase
      // dedupes within a small window we want to see that too. Wait a
      // moment so the timestamp claims differ.
      await new Promise((r) => setTimeout(r, 1100));
      const t1 = await u.getIdToken(true);
      const t2 = await u.getIdToken(false);
      await dropCurrentUser();
      return {
        token0Length: t0.length,
        token1Length: t1.length,
        token2Length: t2.length,
        token0EqualsToken1: t0 === t1,
        token1EqualsToken2: t1 === t2,
        forceRefreshReturnedDifferentString: t0 !== t1,
      };
    },
  },
  {
    name: 'auth-onidtokenchanged-force-refresh',
    matrixRow: 'auth #39',
    rowIds: ['auth#39'],
    description: 'onIdTokenChanged on getIdToken(true) — observes whether prod fires the listener on a forced refresh.',
    async observe() {
      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsub = onIdTokenChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 300));
      const firesAfterSignIn = fires.length;
      const u = auth.currentUser!;
      await new Promise((r) => setTimeout(r, 1100));
      await u.getIdToken(true);
      // Token-change events propagate asynchronously after the refresh
      // resolves. Give the SDK a beat to dispatch.
      await new Promise((r) => setTimeout(r, 1000));
      const firesAfterRefresh = fires.length;
      unsub();
      await dropCurrentUser();
      return {
        firesAfterSignIn,
        firesAfterRefresh,
        refreshFiredListener: firesAfterRefresh > firesAfterSignIn,
        fires,
      };
    },
  },
  {
    name: 'auth-anonymous-credential-providerid',
    matrixRow: 'auth #6',
    rowIds: ['auth#6'],
    description: 'UserCredential.providerId for anonymous sign-in — locks whether prod returns "anonymous" or null.',
    async observe() {
      const cred = await signInAnonymously(auth);
      const result = {
        providerId: cred.providerId,
        operationType: cred.operationType,
        userIsAnonymous: cred.user.isAnonymous,
        userEmail: cred.user.email,
        userDisplayName: cred.user.displayName,
      };
      await dropCurrentUser();
      return result;
    },
  },
  {
    name: 'auth-wrong-password-error-code',
    matrixRow: 'auth #15',
    rowIds: ['auth#15'],
    description: 'signInWithEmailAndPassword with wrong password — locks the FirebaseError code prod actually emits (older "auth/wrong-password" vs newer "auth/invalid-credential").',
    async observe() {
      // Create a throwaway user so we can attempt sign-in against it.
      const email = `oracle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      const password = 'correct-password-123';
      await createUserWithEmailAndPassword(auth, email, password);
      const created = auth.currentUser;
      await signOut(auth);

      let code: string | null = null;
      let message: string | null = null;
      try {
        await signInWithEmailAndPassword(auth, email, 'wrong-password-456');
      } catch (e) {
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }

      // Clean up: re-sign-in as the user we created so we can delete it.
      try {
        await signInWithEmailAndPassword(auth, email, password);
        if (auth.currentUser) await deleteUser(auth.currentUser);
      } catch {
        // Best-effort cleanup. If we can't sign back in, the throwaway
        // user leaks — recorded in result.
      }

      return {
        code,
        messageContains: {
          wrongPassword: message?.includes('wrong-password') ?? false,
          invalidCredential: message?.includes('invalid-credential') ?? false,
        },
        createdUid: created?.uid ?? null,
      };
    },
  },
  {
    name: 'auth-user-not-found-error-code',
    matrixRow: 'auth #14',
    rowIds: ['auth#14'],
    description: 'signInWithEmailAndPassword with an email that was never registered — locks the FirebaseError code prod actually emits (older "auth/user-not-found" vs newer "auth/invalid-credential").',
    async observe() {
      // Build a uniquely-randomized email that has not been seeded /
      // created in the project. The probe asserts on the error code
      // returned by the SDK when signing in with such an email.
      const email = `oracle-never-registered-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      let code: string | null = null;
      let message: string | null = null;
      let threw = false;
      try {
        await signInWithEmailAndPassword(auth, email, 'any-password-here-123');
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      // No user was ever signed in, so nothing to drop. If the call
      // unexpectedly succeeded (it shouldn't), clean up so we don't
      // leak.
      await dropCurrentUser();
      return {
        threw,
        code,
        messageContains: {
          userNotFound: message?.includes('user-not-found') ?? false,
          invalidCredential: message?.includes('invalid-credential') ?? false,
          invalidLoginCredentials: message?.includes('invalid-login-credentials') ?? false,
        },
        attemptedEmail: email,
      };
    },
  },
  {
    name: 'auth-createUser-operationType',
    matrixRow: 'auth #21',
    rowIds: ['auth#21', 'auth#13'],
    description: 'createUserWithEmailAndPassword returns UserCredential with operationType: "signIn" (NOT "register") per matrix claim — empirically lock the value prod actually emits.',
    async observe() {
      const email = `oracle-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      const password = 'oracle-pw-123';
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const result = {
        operationType: cred.operationType,
        providerId: cred.providerId,
        userIsAnonymous: cred.user.isAnonymous,
        userEmail: cred.user.email,
        createdUid: cred.user.uid,
      };
      // Clean up the freshly-created user so we don't leak.
      let cleanupLeaked = false;
      try {
        if (auth.currentUser) await deleteUser(auth.currentUser);
      } catch {
        cleanupLeaked = true;
      }
      await dropCurrentUser();
      return { ...result, cleanupLeaked };
    },
  },
  {
    name: 'auth-email-already-in-use-error-code',
    matrixRow: 'auth #22',
    rowIds: ['auth#22'],
    description: 'createUserWithEmailAndPassword called twice with the same email — locks the FirebaseError code prod emits for the duplicate-registration path.',
    async observe() {
      const email = `oracle-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      const password = 'oracle-pw-123';
      // First create succeeds — gives us a user we can clean up later.
      await createUserWithEmailAndPassword(auth, email, password);
      // Sign out so the second attempt isn't a no-op against an
      // already-signed-in account (createUserWithEmailAndPassword
      // doesn't care, but keeps the state clean).
      await signOut(auth);

      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      try {
        await createUserWithEmailAndPassword(auth, email, password);
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }

      // Re-sign-in as the user we created so we can delete them.
      let cleanupLeaked = false;
      try {
        await signInWithEmailAndPassword(auth, email, password);
        if (auth.currentUser) await deleteUser(auth.currentUser);
      } catch {
        cleanupLeaked = true;
      }
      await dropCurrentUser();

      return {
        threw,
        code,
        messageContains: {
          emailAlreadyInUse: message?.includes('email-already-in-use') ?? false,
        },
        attemptedEmail: email,
        cleanupLeaked,
      };
    },
  },
  {
    name: 'auth-row-18-invalid-email-error-code',
    matrixRow: 'auth #18',
    rowIds: ['auth#18'],
    description: 'createUserWithEmailAndPassword with a malformed email (no `@`, no domain) — locks the FirebaseError code prod actually emits for the format-validation path. Matrix language says `auth/invalid-email`; this probe verifies that empirically.',
    async observe() {
      const malformedEmail = 'not-an-email';
      const password = 'somepass123';
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let errorName: string | null = null;
      let createdUid: string | null = null;
      try {
        const cred = await createUserWithEmailAndPassword(auth, malformedEmail, password);
        // Should not happen — but if prod accepts it for some reason,
        // capture the uid so cleanup can delete the leaked user.
        createdUid = cred.user.uid;
      } catch (e) {
        threw = true;
        const err = e as { code?: string; message?: string; name?: string };
        code = err.code ?? null;
        message = err.message ?? (e instanceof Error ? e.message : String(e));
        errorName = err.name ?? null;
      }
      // If the call unexpectedly succeeded, delete the user so we don't
      // leak. Otherwise nothing to clean — no user was minted.
      let cleanupLeaked = false;
      if (createdUid && auth.currentUser) {
        try {
          await deleteUser(auth.currentUser);
        } catch {
          cleanupLeaked = true;
        }
      }
      await dropCurrentUser();
      return {
        threw,
        code,
        errorName,
        message,
        attemptedEmail: malformedEmail,
        createdUid,
        cleanupLeaked,
      };
    },
  },
  {
    name: 'auth-row-19-weak-password-error-code',
    matrixRow: 'auth #19',
    rowIds: ['auth#19'],
    description: 'createUserWithEmailAndPassword with a short password (5 chars or fewer) — locks the FirebaseError code prod actually emits for the strength-validation path. Matrix language says "≥6 chars per prod default"; verify the specific code empirically (could be auth/weak-password, auth/missing-password, etc.).',
    async observe() {
      const email = `oracle-weak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      const shortPassword = '123';
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let errorName: string | null = null;
      let createdUid: string | null = null;
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, shortPassword);
        // Unexpected success — record the uid so we can clean up.
        createdUid = cred.user.uid;
      } catch (e) {
        threw = true;
        const err = e as { code?: string; message?: string; name?: string };
        code = err.code ?? null;
        message = err.message ?? (e instanceof Error ? e.message : String(e));
        errorName = err.name ?? null;
      }
      let cleanupLeaked = false;
      if (createdUid && auth.currentUser) {
        try {
          await deleteUser(auth.currentUser);
        } catch {
          cleanupLeaked = true;
        }
      }
      await dropCurrentUser();
      return {
        threw,
        code,
        errorName,
        message,
        attemptedEmail: email,
        attemptedPasswordLength: shortPassword.length,
        createdUid,
        cleanupLeaked,
      };
    },
  },
  {
    name: 'firestore-updatedoc-missing-error',
    matrixRow: 'firestore #34',
    rowIds: ['firestore#34'],
    description: 'updateDoc on a non-existent doc — locks the FirebaseError code/class prod returns when the precondition fails. Writes inside pyric_oracle/* so rules permit; only the missing-doc precondition should fire.',
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('updatedoc-missing'), 'never-written');
      let threw = false;
      let code: string | undefined;
      let message: string | undefined;
      let name: string | undefined;
      let constructorName: string | undefined;
      let isFirebaseError = false;
      let isErrorInstance = false;
      try {
        await updateDoc(ref, { x: 1 });
      } catch (e) {
        threw = true;
        const err = e as {
          code?: string;
          message?: string;
          name?: string;
          constructor?: { name?: string };
        };
        code = err.code;
        message = err.message;
        name = err.name;
        constructorName = err.constructor?.name;
        isErrorInstance = e instanceof Error;
        isFirebaseError = err.name === 'FirebaseError';
      }
      await dropCurrentUser();
      return {
        threw,
        code: code ?? null,
        message: message ?? null,
        errorName: name ?? null,
        constructorName: constructorName ?? null,
        isFirebaseError,
        isErrorInstance,
      };
    },
  },
  {
    name: 'firestore-transaction-rules-denied-error',
    matrixRow: 'firestore #94',
    rowIds: ['firestore#94'],
    description: 'runTransaction with an inner write that violates rules — locks the FirebaseError code prod actually returns. Matrix says "aborted / similar"; this observation pins the specific code (permission-denied vs aborted vs other).',
    async observe() {
      await signInAnonymously(auth);
      // Deliberately write OUTSIDE pyric_oracle/* so the permissive
      // rule does NOT match. The transaction should commit-fail when
      // the server applies the writes and rules reject.
      const deniedRef = doc(db, 'pyric_oracle_denied_namespace', `tx-denied-${RUN_ID}`);
      let threw = false;
      let code: string | undefined;
      let message: string | undefined;
      let name: string | undefined;
      let constructorName: string | undefined;
      let isFirebaseError = false;
      let isErrorInstance = false;
      let innerRan = 0;
      try {
        await runTransaction(db, async (tx) => {
          innerRan += 1;
          tx.set(deniedRef, { x: 1 });
        });
      } catch (e) {
        threw = true;
        const err = e as {
          code?: string;
          message?: string;
          name?: string;
          constructor?: { name?: string };
        };
        code = err.code;
        message = err.message;
        name = err.name;
        constructorName = err.constructor?.name;
        isErrorInstance = e instanceof Error;
        isFirebaseError = err.name === 'FirebaseError';
      }
      await dropCurrentUser();
      return {
        threw,
        code: code ?? null,
        message: message ?? null,
        errorName: name ?? null,
        constructorName: constructorName ?? null,
        isFirebaseError,
        isErrorInstance,
        innerRan,
      };
    },
  },
  {
    name: 'auth-bare-getauth-no-default-app',
    matrixRow: 'auth #4',
    rowIds: ['auth#4'],
    description: 'getAuth() with no argument and no default Firebase App initialized — locks the FirebaseError code prod throws. The harness uses a NAMED app (not the default), so a bare getAuth() call has no app to fall back to.',
    async observe() {
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let errorName: string | null = null;
      try {
        // Call WITHOUT any app argument. No default app is registered
        // (harness uses initializeApp(config, namedAppName)), so the
        // internal getApp() should throw app/no-app.
        getAuth();
      } catch (e) {
        threw = true;
        const err = e as { code?: string; message?: string; name?: string };
        code = err.code ?? null;
        message = err.message ?? (e instanceof Error ? e.message : String(e));
        errorName = err.name ?? null;
      }
      return { threw, code, errorName, message };
    },
  },
  {
    name: 'firestore-bare-getfirestore-no-default-app',
    matrixRow: 'firestore #4',
    rowIds: ['firestore#4'],
    description: 'getFirestore() with no argument and no default Firebase App initialized — locks the FirebaseError code prod throws.',
    async observe() {
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let errorName: string | null = null;
      try {
        getFirestore();
      } catch (e) {
        threw = true;
        const err = e as { code?: string; message?: string; name?: string };
        code = err.code ?? null;
        message = err.message ?? (e instanceof Error ? e.message : String(e));
        errorName = err.name ?? null;
      }
      return { threw, code, errorName, message };
    },
  },
  {
    name: 'firestore-row-80-onsnapshot-fires-initial',
    matrixRow: 'firestore #80',
    rowIds: ['firestore#80'],
    description: 'onSnapshot(docRef, cb) fires the initial snapshot microtask-deferred — not synchronously. Probes whether the first fire arrives during the registering call (synchronous), in the next microtask (queueMicrotask boundary), or after a macrotask (setTimeout(0) boundary).',
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-80-onsnapshot-fires-initial'), 'seed');
      await setDoc(ref, { v: 1 });

      // Now register a fresh listener. The "initial fire" semantics
      // we care about are about the FIRST invocation of the callback
      // relative to control flow at the registration site.
      const events: Array<{ at: string; existsResult: boolean; v: unknown }> = [];
      let registerReturned = false;
      let microtaskRan = false;
      let timeoutRan = false;

      await new Promise<void>((resolve) => {
        let fired = 0;
        const unsub = onSnapshot(ref, (snap) => {
          fired += 1;
          events.push({
            at: !registerReturned
              ? 'sync'
              : !microtaskRan
                ? 'before-microtask'
                : !timeoutRan
                  ? 'after-microtask-before-timeout'
                  : 'after-timeout',
            existsResult: snap.exists(),
            v: snap.data()?.v ?? null,
          });
          if (fired >= 1) {
            // Defer resolve so we also see whether a second/duplicate
            // fire arrives.
            queueMicrotask(() => {
              unsub();
              resolve();
            });
          }
        });
        registerReturned = true;
        queueMicrotask(() => {
          microtaskRan = true;
        });
        setTimeout(() => {
          timeoutRan = true;
        }, 0);
      });

      // Wait a tick to make sure the unsubscribe + any late fires settle.
      await new Promise((r) => setTimeout(r, 200));

      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        fireCount: events.length,
        events,
        firstFireAt: events[0]?.at ?? null,
        firstFireSyncDuringRegister: events[0]?.at === 'sync',
      };
    },
  },
  {
    name: 'firestore-row-82-onsnapshot-missing-initial',
    matrixRow: 'firestore #82',
    rowIds: ['firestore#82'],
    description: 'Initial fire for a missing doc has exists() === false and data() === undefined. Probes onSnapshot on a doc that does not exist and inspects the first snapshot.',
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-82-onsnapshot-missing-initial'), 'never-written');

      const events: Array<{
        exists: boolean;
        dataIsUndefined: boolean;
        dataValue: unknown;
        hasPendingWrites: boolean;
        fromCache: boolean;
      }> = [];

      await new Promise<void>((resolve) => {
        const unsub = onSnapshot(ref, (snap) => {
          const d = snap.data();
          events.push({
            exists: snap.exists(),
            dataIsUndefined: d === undefined,
            dataValue: d ?? null,
            hasPendingWrites: snap.metadata.hasPendingWrites,
            fromCache: snap.metadata.fromCache,
          });
          queueMicrotask(() => {
            unsub();
            resolve();
          });
        });
      });

      // Wait for any straggler fires.
      await new Promise((r) => setTimeout(r, 200));

      await dropCurrentUser();
      return {
        fireCount: events.length,
        firstExists: events[0]?.exists ?? null,
        firstDataIsUndefined: events[0]?.dataIsUndefined ?? null,
        events,
      };
    },
  },
  {
    name: 'firestore-row-42-adddoc-returned-ref-usable',
    matrixRow: 'firestore #42',
    rowIds: ['firestore#42'],
    description: 'addDoc returns a DocumentReference that is immediately usable in subsequent ops — getDoc round-trips the data, setDoc overwrites it, and onSnapshot registers on it and fires. Probes addDoc({v:1}), getDoc(ref) → {v:1}, setDoc(ref, {v:2}), onSnapshot(ref, cb) with first fire having v:2.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('row-42-adddoc-returned-ref-usable'));
      const ref = await addDoc(c, { v: 1 });
      const addedId = ref.id;
      const addedPath = ref.path;

      // getDoc round-trip via the returned ref.
      const snap1 = await getDoc(ref);
      const getDocExists = snap1.exists();
      const getDocV = snap1.data()?.v ?? null;

      // setDoc on the returned ref — overwrites the body.
      let setDocThrew = false;
      let setDocError: string | null = null;
      try {
        await setDoc(ref, { v: 2 });
      } catch (e) {
        setDocThrew = true;
        setDocError = e instanceof Error ? e.message : String(e);
      }
      const snap2 = await getDoc(ref);
      const afterSetDocV = snap2.data()?.v ?? null;

      // onSnapshot on the returned ref — capture first fire.
      const fires: Array<{ exists: boolean; v: unknown }> = [];
      const unsub = onSnapshot(ref, (s) => {
        fires.push({ exists: s.exists(), v: s.data()?.v ?? null });
      });
      // Give listener time to fire.
      await new Promise((r) => setTimeout(r, 1500));
      unsub();
      const firstFire = fires[0] ?? null;

      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        addedId,
        addedPath,
        getDocExists,
        getDocV,
        setDocThrew,
        setDocError,
        afterSetDocV,
        onSnapshotFireCount: fires.length,
        firstFire,
        allOpsSucceeded:
          getDocExists === true &&
          getDocV === 1 &&
          !setDocThrew &&
          afterSetDocV === 2 &&
          fires.length >= 1 &&
          firstFire?.exists === true &&
          firstFire?.v === 2,
      };
    },
  },
  {
    name: 'firestore-row-81-onsnapshot-query-fires-on-write',
    matrixRow: 'firestore #81',
    rowIds: ['firestore#81'],
    description: 'onSnapshot(query, cb) fires on writes to the underlying collection. Probes: register a listener on a collection-level query, then perform writes (add a doc, modify, delete) and confirm each write produces a fire reflecting the new state.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('row-81-onsnapshot-query-fires-on-write'));
      const q = query(c);

      const fires: Array<{ size: number; ids: string[] }> = [];
      const unsub = onSnapshot(q, (snap) => {
        fires.push({
          size: snap.size,
          ids: snap.docs.map((d) => d.id).sort(),
        });
      });
      // Allow the initial empty fire.
      await new Promise((r) => setTimeout(r, 1000));
      const initialFireCount = fires.length;
      const initialSize = fires[fires.length - 1]?.size ?? null;

      // Write 1: addDoc to the collection.
      const ref1 = await addDoc(c, { v: 1 });
      await new Promise((r) => setTimeout(r, 1200));
      const afterAddFireCount = fires.length;
      const afterAddSize = fires[fires.length - 1]?.size ?? null;

      // Write 2: setDoc on a known id within the collection.
      const ref2 = doc(c, 'known-id');
      await setDoc(ref2, { v: 99 });
      await new Promise((r) => setTimeout(r, 1200));
      const afterSetFireCount = fires.length;
      const afterSetSize = fires[fires.length - 1]?.size ?? null;

      // Write 3: delete one doc.
      await deleteDoc(ref1);
      await new Promise((r) => setTimeout(r, 1200));
      const afterDeleteFireCount = fires.length;
      const afterDeleteSize = fires[fires.length - 1]?.size ?? null;

      unsub();
      await deleteDoc(ref2).catch(() => {});
      await dropCurrentUser();
      return {
        initialFireCount,
        initialSize,
        afterAddFireCount,
        afterAddSize,
        afterSetFireCount,
        afterSetSize,
        afterDeleteFireCount,
        afterDeleteSize,
        addFired: afterAddFireCount > initialFireCount,
        setFired: afterSetFireCount > afterAddFireCount,
        deleteFired: afterDeleteFireCount > afterSetFireCount,
        fires,
      };
    },
  },
  {
    name: 'firestore-row-83-unsubscribe-stops-fires',
    matrixRow: 'firestore #83',
    rowIds: ['firestore#83'],
    description: 'Unsubscribe returned by onSnapshot stops further fires. Probes: register listener, do a write (verify fire), call unsub(), do another write, verify no further fires arrive.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('row-83-unsubscribe-stops-fires'));
      const ref = doc(c, 'tracked');
      // Seed the doc first so the listener has a stable initial fire.
      await setDoc(ref, { v: 0 });

      const fires: Array<{ v: unknown; phase: string }> = [];
      let phase = 'pre-unsub';
      const unsub = onSnapshot(ref, (snap) => {
        fires.push({ v: snap.data()?.v ?? null, phase });
      });
      // Allow initial fire.
      await new Promise((r) => setTimeout(r, 1200));
      const afterInitialFires = fires.length;

      // Write 1 — should fire.
      await setDoc(ref, { v: 1 });
      await new Promise((r) => setTimeout(r, 1200));
      const afterFirstWriteFires = fires.length;

      // Unsubscribe.
      unsub();
      phase = 'post-unsub';

      // Write 2 — should NOT fire.
      await setDoc(ref, { v: 2 });
      await new Promise((r) => setTimeout(r, 1500));
      const afterSecondWriteFires = fires.length;

      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        afterInitialFires,
        afterFirstWriteFires,
        afterSecondWriteFires,
        firstWriteFired: afterFirstWriteFires > afterInitialFires,
        unsubStoppedFires: afterSecondWriteFires === afterFirstWriteFires,
        postUnsubFireCount: fires.filter((f) => f.phase === 'post-unsub').length,
        fires,
      };
    },
  },
  {
    name: 'firestore-row-84-observer-object-form',
    matrixRow: 'firestore #84',
    rowIds: ['firestore#84'],
    description: 'Observer object form `{next, error, complete}` works alongside the function form. Probes: register one listener as a function and another as `{next}` on the same doc, do a write, verify both fire with the same snapshot data.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('row-84-observer-object-form'));
      const ref = doc(c, 'tracked');
      await setDoc(ref, { v: 0 });

      const fnFires: Array<{ v: unknown }> = [];
      const obsFires: Array<{ v: unknown }> = [];
      const errorFires: unknown[] = [];
      let completeCalled = false;

      const unsubFn = onSnapshot(ref, (snap) => {
        fnFires.push({ v: snap.data()?.v ?? null });
      });
      const unsubObs = onSnapshot(ref, {
        next: (snap) => {
          obsFires.push({ v: snap.data()?.v ?? null });
        },
        error: (e) => {
          errorFires.push(e);
        },
        complete: () => {
          completeCalled = true;
        },
      });

      // Allow initial fires.
      await new Promise((r) => setTimeout(r, 1500));
      const initialFn = fnFires.length;
      const initialObs = obsFires.length;

      // Trigger a write.
      await setDoc(ref, { v: 1 });
      await new Promise((r) => setTimeout(r, 1500));
      const afterWriteFn = fnFires.length;
      const afterWriteObs = obsFires.length;

      unsubFn();
      unsubObs();
      // Give complete() a chance if prod surfaces it.
      await new Promise((r) => setTimeout(r, 100));

      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        initialFn,
        initialObs,
        afterWriteFn,
        afterWriteObs,
        fnFiredOnWrite: afterWriteFn > initialFn,
        obsFiredOnWrite: afterWriteObs > initialObs,
        bothInitialFired: initialFn >= 1 && initialObs >= 1,
        errorFireCount: errorFires.length,
        completeCalled,
        fnFires,
        obsFires,
      };
    },
  },
  {
    name: 'firestore-row-89-snapshot-ref-usable',
    matrixRow: 'firestore #89',
    rowIds: ['firestore#89'],
    description: 'Snapshot `.ref` (docRef listener) and `.docs[i].ref` (query listener) are usable in follow-up ops. Probes: register both kinds of listeners; capture refs from the first fire; use them in getDoc + setDoc; verify the ref points back at the same data.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('row-89-snapshot-ref-usable'));
      const docPath = 'tracked';
      const ref = doc(c, docPath);
      await setDoc(ref, { v: 1, marker: 'seed' });

      // docRef listener — capture snap.ref on first fire.
      let docRefFromSnap: unknown = null;
      let docRefPath: string | null = null;
      await new Promise<void>((resolve) => {
        const unsub = onSnapshot(ref, (snap) => {
          docRefFromSnap = snap.ref;
          docRefPath = snap.ref.path;
          queueMicrotask(() => {
            unsub();
            resolve();
          });
        });
      });
      await new Promise((r) => setTimeout(r, 100));

      // Use snap.ref in getDoc + setDoc.
      let docRefGetOK = false;
      let docRefGetV: unknown = null;
      let docRefGetThrew = false;
      try {
        const s = await getDoc(docRefFromSnap as ReturnType<typeof doc>);
        docRefGetOK = s.exists();
        docRefGetV = s.data()?.v ?? null;
      } catch (e) {
        docRefGetThrew = true;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _msg = e instanceof Error ? e.message : String(e);
      }

      let docRefSetThrew = false;
      try {
        await setDoc(docRefFromSnap as ReturnType<typeof doc>, {
          v: 2,
          marker: 'updated-via-snap-ref',
        });
      } catch (e) {
        docRefSetThrew = true;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _msg = e instanceof Error ? e.message : String(e);
      }
      const afterDocRefSet = await getDoc(ref);
      const docRefSetV = afterDocRefSet.data()?.v ?? null;
      const docRefSetMarker = afterDocRefSet.data()?.marker ?? null;

      // query listener — capture snap.docs[0].ref on first non-empty fire.
      const q = query(c);
      let queryDocRef: unknown = null;
      let queryDocPath: string | null = null;
      await new Promise<void>((resolve) => {
        const unsub = onSnapshot(q, (snap) => {
          if (snap.size > 0) {
            queryDocRef = snap.docs[0].ref;
            queryDocPath = snap.docs[0].ref.path;
            queueMicrotask(() => {
              unsub();
              resolve();
            });
          }
        });
      });
      await new Promise((r) => setTimeout(r, 100));

      let queryDocRefGetOK = false;
      let queryDocRefGetV: unknown = null;
      try {
        const s = await getDoc(queryDocRef as ReturnType<typeof doc>);
        queryDocRefGetOK = s.exists();
        queryDocRefGetV = s.data()?.v ?? null;
      } catch {
        // ignored
      }

      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        docRefPath,
        docRefGetOK,
        docRefGetV,
        docRefGetThrew,
        docRefSetThrew,
        docRefSetV,
        docRefSetMarker,
        queryDocPath,
        queryDocRefGetOK,
        queryDocRefGetV,
        docRefRoundTrips:
          docRefPath === ref.path &&
          docRefGetOK &&
          !docRefSetThrew &&
          docRefSetV === 2 &&
          docRefSetMarker === 'updated-via-snap-ref',
        queryDocRefRoundTrips:
          queryDocPath === ref.path &&
          queryDocRefGetOK &&
          queryDocRefGetV === 2,
      };
    },
  },
  {
    name: 'firestore-row-30-sentinels-in-setdoc',
    matrixRow: 'firestore #30',
    rowIds: ['firestore#30'],
    description: 'Sentinels (serverTimestamp, increment, arrayUnion, arrayRemove, deleteField) resolve in the same setDoc call. Probes setDoc({createdAt: serverTimestamp(), count: 5, tags: [\"a\"]}) then getDoc and checks the resolved shape — createdAt is a Timestamp instance, count === 5, tags === [\"a\"].',
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-30-sentinels-in-setdoc'), 'd');
      await setDoc(ref, {
        createdAt: serverTimestamp(),
        count: 5,
        tags: ['a'],
      });
      const snap = await getDoc(ref);
      const data = snap.data() ?? {};
      const createdAt = (data as { createdAt?: unknown }).createdAt;
      const result = {
        exists: snap.exists(),
        keys: Object.keys(data).sort(),
        createdAtIsTimestamp: createdAt instanceof Timestamp,
        createdAtCtorName: (createdAt as { constructor?: { name?: string } } | null | undefined)?.constructor?.name ?? null,
        createdAtHasSeconds: !!createdAt && typeof (createdAt as { seconds?: unknown }).seconds === 'number',
        createdAtHasNanoseconds:
          !!createdAt && typeof (createdAt as { nanoseconds?: unknown }).nanoseconds === 'number',
        count: (data as { count?: unknown }).count ?? null,
        countType: typeof (data as { count?: unknown }).count,
        tags: (data as { tags?: unknown }).tags ?? null,
      };
      await deleteDoc(ref);
      await dropCurrentUser();
      return result;
    },
  },
  {
    name: 'firestore-row-36-sentinels-in-updatedoc',
    matrixRow: 'firestore #36',
    rowIds: ['firestore#36'],
    description: 'Sentinels resolve mid-update. Probes setDoc({count:5, tags:[\"a\"], oldField:\"keep-then-remove\"}), then updateDoc({count: increment(3), tags: arrayUnion(\"b\"), oldField: deleteField()}), then getDoc — verifies increment, arrayUnion, and deleteField all applied.',
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-36-sentinels-in-updatedoc'), 'd');
      await setDoc(ref, { count: 5, tags: ['a'], oldField: 'keep-then-remove' });
      await updateDoc(ref, {
        count: increment(3),
        tags: arrayUnion('b'),
        oldField: deleteField(),
      });
      const snap = await getDoc(ref);
      const data = snap.data() ?? {};
      const result = {
        exists: snap.exists(),
        keys: Object.keys(data).sort(),
        count: (data as { count?: unknown }).count ?? null,
        tags: (data as { tags?: unknown }).tags ?? null,
        oldFieldPresent: Object.prototype.hasOwnProperty.call(data, 'oldField'),
        oldFieldValue: (data as { oldField?: unknown }).oldField ?? null,
      };
      await deleteDoc(ref);
      await dropCurrentUser();
      return result;
    },
  },
  {
    name: 'firestore-row-101-arrayunion-dedupes',
    matrixRow: 'firestore #101',
    rowIds: ['firestore#101'],
    description: 'arrayUnion(...values) de-dupes against existing members. Probes setDoc({tags:[\"a\",\"b\"]}) then updateDoc({tags: arrayUnion(\"b\",\"c\")}) then getDoc — verifies tags is [\"a\",\"b\",\"c\"] not [\"a\",\"b\",\"b\",\"c\"]. Also probes inline dedup of duplicate args (arrayUnion(\"d\",\"d\")) in a follow-up update.',
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-101-arrayunion-dedupes'), 'd');
      await setDoc(ref, { tags: ['a', 'b'] });
      await updateDoc(ref, { tags: arrayUnion('b', 'c') });
      const afterDedupAcrossExisting = (await getDoc(ref)).data()?.tags ?? null;

      // Second pass: inline duplicate args.
      await updateDoc(ref, { tags: arrayUnion('d', 'd', 'a') });
      const afterDedupInlineArgs = (await getDoc(ref)).data()?.tags ?? null;

      // Third pass: arrayRemove for parity / cross-check that the union
      // path didn't accidentally upgrade behaviors.
      await updateDoc(ref, { tags: arrayRemove('b') });
      const afterArrayRemove = (await getDoc(ref)).data()?.tags ?? null;

      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        afterDedupAcrossExisting,
        afterDedupInlineArgs,
        afterArrayRemove,
        dedupedAcrossExisting:
          Array.isArray(afterDedupAcrossExisting) &&
          JSON.stringify(afterDedupAcrossExisting) === JSON.stringify(['a', 'b', 'c']),
        dedupedInlineArgs:
          Array.isArray(afterDedupInlineArgs) &&
          JSON.stringify(afterDedupInlineArgs) === JSON.stringify(['a', 'b', 'c', 'd']),
      };
    },
  },
  {
    name: 'firestore-row-96-batch-commit-atomic',
    matrixRow: 'firestore #96',
    rowIds: ['firestore#96'],
    description:
      'batch.commit() applies all queued writes atomically. Success path: queue 3 writes to 3 different docs (one set on a fresh doc, one update on a previously-set doc, one delete) and verify all 3 changes are present after a single commit. Failure path: a batch where one write targets a path OUTSIDE pyric_oracle/* — verify the whole batch rejects (no partial application: the previously-set doc still has its original value, the would-be-new doc never lands).',
    async observe() {
      await signInAnonymously(auth);
      const base = RUN_DOC('row-96-batch-commit-atomic');
      const refSet = doc(db, base, 'will-set');
      const refUpdate = doc(db, base, 'will-update');
      const refDelete = doc(db, base, 'will-delete');

      // Seed the doc we'll update and the doc we'll delete.
      await setDoc(refUpdate, { v: 1, label: 'before-batch' });
      await setDoc(refDelete, { v: 1, label: 'will-be-deleted' });

      // Success path: all three writes inside pyric_oracle/*.
      const batchOk = writeBatch(db);
      batchOk.set(refSet, { v: 1, label: 'from-set' });
      batchOk.update(refUpdate, { v: 2, label: 'after-batch' });
      batchOk.delete(refDelete);
      let okThrew = false;
      let okError: string | null = null;
      let okCode: string | null = null;
      try {
        await batchOk.commit();
      } catch (e) {
        okThrew = true;
        okError = e instanceof Error ? e.message : String(e);
        okCode = (e as { code?: string }).code ?? null;
      }

      const snapSet = await getDoc(refSet);
      const snapUpdate = await getDoc(refUpdate);
      const snapDelete = await getDoc(refDelete);
      const successAllApplied =
        snapSet.exists() &&
        (snapSet.data() as { v?: unknown; label?: unknown }).v === 1 &&
        (snapSet.data() as { label?: unknown }).label === 'from-set' &&
        snapUpdate.exists() &&
        (snapUpdate.data() as { v?: unknown }).v === 2 &&
        (snapUpdate.data() as { label?: unknown }).label === 'after-batch' &&
        !snapDelete.exists();

      // Reset for the failure path: re-seed the target we'd update.
      await setDoc(refUpdate, { v: 1, label: 'before-batch-2' });
      // The other "good" doc we'll attempt to set in the failure batch.
      const refSet2 = doc(db, base, 'would-have-set-2');

      // Failure path: a batch with one write OUTSIDE pyric_oracle/*.
      const refDenied = doc(db, 'pyric_oracle_denied_batch', `denied-${RUN_ID}`);
      const batchBad = writeBatch(db);
      batchBad.set(refSet2, { v: 1, label: 'should-not-land' });
      batchBad.update(refUpdate, { v: 99, label: 'should-not-update' });
      batchBad.set(refDenied, { v: 1, label: 'rules-deny-this' });

      let badThrew = false;
      let badError: string | null = null;
      let badCode: string | null = null;
      try {
        await batchBad.commit();
      } catch (e) {
        badThrew = true;
        badError = e instanceof Error ? e.message : String(e);
        badCode = (e as { code?: string }).code ?? null;
      }

      const snapSet2After = await getDoc(refSet2);
      const snapUpdateAfter = await getDoc(refUpdate);
      const failureNoPartialApply =
        badThrew &&
        !snapSet2After.exists() &&
        snapUpdateAfter.exists() &&
        (snapUpdateAfter.data() as { v?: unknown }).v === 1 &&
        (snapUpdateAfter.data() as { label?: unknown }).label === 'before-batch-2';

      // Cleanup.
      try { await deleteDoc(refSet); } catch { /* ignored */ }
      try { await deleteDoc(refUpdate); } catch { /* ignored */ }
      try { await deleteDoc(refSet2); } catch { /* ignored */ }
      await dropCurrentUser();

      return {
        successCase: {
          threw: okThrew,
          error: okError,
          code: okCode,
          setExists: snapSet.exists(),
          setData: snapSet.data() ?? null,
          updateExists: snapUpdate.exists(),
          updateData: snapUpdate.data() ?? null,
          deleteExists: snapDelete.exists(),
          allApplied: successAllApplied,
        },
        failureCase: {
          threw: badThrew,
          error: badError,
          code: badCode,
          set2Exists: snapSet2After.exists(),
          set2Data: snapSet2After.data() ?? null,
          updateExists: snapUpdateAfter.exists(),
          updateData: snapUpdateAfter.data() ?? null,
          noPartialApply: failureNoPartialApply,
        },
      };
    },
  },
  {
    name: 'firestore-row-99-servertimestamp-resolves-to-timestamp',
    matrixRow: 'firestore #99',
    rowIds: ['firestore#99'],
    description:
      "serverTimestamp() resolves to a Timestamp after the write commits. Probes setDoc({at: serverTimestamp()}) then getDoc — verifies `at` is a Timestamp instance (constructor.name === 'Timestamp', .seconds + .nanoseconds present, instanceof Timestamp).",
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-99-servertimestamp-resolves'), 'd');
      await setDoc(ref, { at: serverTimestamp() });
      const snap = await getDoc(ref);
      const data = snap.data() ?? {};
      const at = (data as { at?: unknown }).at;
      const atObj = at as
        | { seconds?: unknown; nanoseconds?: unknown; constructor?: { name?: string } }
        | null
        | undefined;
      const result = {
        exists: snap.exists(),
        keys: Object.keys(data).sort(),
        atIsTimestamp: at instanceof Timestamp,
        atCtorName: atObj?.constructor?.name ?? null,
        atHasSeconds: !!atObj && typeof atObj.seconds === 'number',
        atHasNanoseconds: !!atObj && typeof atObj.nanoseconds === 'number',
        atSeconds: atObj && typeof atObj.seconds === 'number' ? atObj.seconds : null,
        atNanoseconds: atObj && typeof atObj.nanoseconds === 'number' ? atObj.nanoseconds : null,
      };
      await deleteDoc(ref);
      await dropCurrentUser();
      return result;
    },
  },
  {
    name: 'firestore-row-100-increment-bumps-numeric',
    matrixRow: 'firestore #100',
    rowIds: ['firestore#100'],
    description:
      "increment(n) atomically bumps a numeric field. Matrix claim: null/missing field starts from 0. Probe: setDoc with no `count` field, then updateDoc with {count: increment(5)} → expect 5. Then increment(3) → expect 8. Then increment(-2) → expect 6.",
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-100-increment-bumps-numeric'), 'd');
      // Initial write has NO `count` field — increment must start from 0.
      await setDoc(ref, { other: 'untouched' });
      const initialSnap = await getDoc(ref);
      const initialKeys = Object.keys(initialSnap.data() ?? {}).sort();
      const countMissingInitially = !Object.prototype.hasOwnProperty.call(
        initialSnap.data() ?? {},
        'count',
      );

      await updateDoc(ref, { count: increment(5) });
      const afterFirst = (await getDoc(ref)).data()?.count ?? null;

      await updateDoc(ref, { count: increment(3) });
      const afterSecond = (await getDoc(ref)).data()?.count ?? null;

      await updateDoc(ref, { count: increment(-2) });
      const afterThird = (await getDoc(ref)).data()?.count ?? null;

      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        initialKeys,
        countMissingInitially,
        afterFirst,
        afterSecond,
        afterThird,
        startsFromZero: afterFirst === 5,
        secondIncrementApplied: afterSecond === 8,
        negativeIncrementApplied: afterThird === 6,
      };
    },
  },
  {
    name: 'firestore-row-102-arrayremove-strips',
    matrixRow: 'firestore #102',
    rowIds: ['firestore#102'],
    description:
      "arrayRemove(...values) strips matching members. Probe: setDoc({tags:['a','b','c']}), then updateDoc({tags: arrayRemove('b','d')}) where 'd' isn't in the array — verify tags === ['a','c'] ('b' removed, 'd' silent no-op).",
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-102-arrayremove-strips'), 'd');
      await setDoc(ref, { tags: ['a', 'b', 'c'] });
      await updateDoc(ref, { tags: arrayRemove('b', 'd') });
      const after = (await getDoc(ref)).data()?.tags ?? null;
      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        after,
        matchesExpected:
          Array.isArray(after) && JSON.stringify(after) === JSON.stringify(['a', 'c']),
        removedExisting: Array.isArray(after) && !after.includes('b'),
        missingValueWasNoop: Array.isArray(after) && !after.includes('d'),
        preservedOthers:
          Array.isArray(after) && after.includes('a') && after.includes('c'),
      };
    },
  },
  {
    name: 'firestore-row-103-deletefield-removes-field',
    matrixRow: 'firestore #103',
    rowIds: ['firestore#103'],
    description:
      "deleteField() removes a field on update. Probe: setDoc({keep:1, remove:2}), then updateDoc({remove: deleteField()}), then getDoc — verify keep===1 AND remove is absent from the returned data (not just undefined-valued, actually not present).",
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-103-deletefield-removes-field'), 'd');
      await setDoc(ref, { keep: 1, remove: 2 });
      const beforeSnap = await getDoc(ref);
      const beforeKeys = Object.keys(beforeSnap.data() ?? {}).sort();
      await updateDoc(ref, { remove: deleteField() });
      const afterSnap = await getDoc(ref);
      const afterData = afterSnap.data() ?? {};
      const afterKeys = Object.keys(afterData).sort();
      const keepValue = (afterData as { keep?: unknown }).keep;
      const removePresent = Object.prototype.hasOwnProperty.call(afterData, 'remove');
      const removeValue = (afterData as { remove?: unknown }).remove;
      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        beforeKeys,
        afterKeys,
        keepValue: keepValue ?? null,
        removePresent,
        removeValue: removeValue ?? null,
        keepPreserved: keepValue === 1,
        removeStripped: !removePresent && removeValue === undefined,
      };
    },
  },
  {
    name: 'firestore-row-109-bytes-roundtrip',
    matrixRow: 'firestore #109',
    rowIds: ['firestore#109'],
    description:
      "Bytes round-trip through setDoc / getDoc. Probe: write { payload: Bytes.fromUint8Array([1,2,3,4]) }, then read back — verify the field is an instance of Bytes with the same toBase64() and the same byte sequence (no destructuring to a plain object).",
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-109-bytes-roundtrip'), 'd');
      const original = Bytes.fromUint8Array(new Uint8Array([1, 2, 3, 4]));
      const originalBase64 = original.toBase64();
      await setDoc(ref, { payload: original });
      const snap = await getDoc(ref);
      const data = snap.data() ?? {};
      const payload = (data as { payload?: unknown }).payload;
      const payloadObj = payload as
        | { toBase64?: () => string; toUint8Array?: () => Uint8Array; constructor?: { name?: string } }
        | null
        | undefined;
      const payloadIsBytes = payload instanceof Bytes;
      const payloadCtorName = payloadObj?.constructor?.name ?? null;
      const roundTrippedBase64 =
        typeof payloadObj?.toBase64 === 'function' ? payloadObj.toBase64() : null;
      const roundTrippedBytes =
        typeof payloadObj?.toUint8Array === 'function'
          ? Array.from(payloadObj.toUint8Array())
          : null;
      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        exists: snap.exists(),
        keys: Object.keys(data).sort(),
        originalBase64,
        roundTrippedBase64,
        roundTrippedBytes,
        payloadIsBytes,
        payloadCtorName,
        base64Matches: roundTrippedBase64 === originalBase64,
        bytesMatch:
          Array.isArray(roundTrippedBytes) &&
          JSON.stringify(roundTrippedBytes) === JSON.stringify([1, 2, 3, 4]),
      };
    },
  },
  {
    name: 'firestore-row-110-geopoint-roundtrip',
    matrixRow: 'firestore #110',
    rowIds: ['firestore#110'],
    description:
      "GeoPoint round-trip through setDoc / getDoc. Probe: write { loc: new GeoPoint(37.7749, -122.4194) }, then read back — verify the field is an instance of GeoPoint with the same latitude / longitude (no destructuring to a plain object).",
    async observe() {
      await signInAnonymously(auth);
      const ref = doc(db, RUN_DOC('row-110-geopoint-roundtrip'), 'd');
      const lat = 37.7749;
      const lng = -122.4194;
      const original = new GeoPoint(lat, lng);
      await setDoc(ref, { loc: original });
      const snap = await getDoc(ref);
      const data = snap.data() ?? {};
      const loc = (data as { loc?: unknown }).loc;
      const locObj = loc as
        | { latitude?: number; longitude?: number; constructor?: { name?: string } }
        | null
        | undefined;
      const locIsGeoPoint = loc instanceof GeoPoint;
      const locCtorName = locObj?.constructor?.name ?? null;
      const roundTrippedLat = locObj?.latitude ?? null;
      const roundTrippedLng = locObj?.longitude ?? null;
      await deleteDoc(ref);
      await dropCurrentUser();
      return {
        exists: snap.exists(),
        keys: Object.keys(data).sort(),
        originalLat: lat,
        originalLng: lng,
        roundTrippedLat,
        roundTrippedLng,
        locIsGeoPoint,
        locCtorName,
        latMatches: roundTrippedLat === lat,
        lngMatches: roundTrippedLng === lng,
      };
    },
  },
  {
    name: 'firestore-or-composite',
    matrixRow: 'firestore #56',
    rowIds: ['firestore#56'],
    description: 'or(...) composite — at least one sub-filter matches. Seeds 3 docs (x=1/y=9, x=2/y=2, x=3/y=3) and queries with or(where(x,==,1), where(y,==,2)); observed match set should be the union of each sub-filter\'s matches.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('or-composite'));
      await Promise.all([
        setDoc(doc(c, 'match-x'), { x: 1, y: 9 }),
        setDoc(doc(c, 'match-y'), { x: 7, y: 2 }),
        setDoc(doc(c, 'match-both'), { x: 1, y: 2 }),
        setDoc(doc(c, 'match-neither'), { x: 7, y: 9 }),
      ]);
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let matched = -1;
      let matchedIds: string[] = [];
      try {
        const q = query(c, or(where('x', '==', 1), where('y', '==', 2)));
        const snap = await getDocs(q);
        matched = snap.size;
        matchedIds = snap.docs.map((d) => d.id).sort();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await Promise.all([
        deleteDoc(doc(c, 'match-x')),
        deleteDoc(doc(c, 'match-y')),
        deleteDoc(doc(c, 'match-both')),
        deleteDoc(doc(c, 'match-neither')),
      ]);
      await dropCurrentUser();
      return {
        seeded: 4,
        matched,
        matchedIds,
        threw,
        code,
        errorMessage: message,
        expectedIds: ['match-both', 'match-x', 'match-y'],
      };
    },
  },
  {
    name: 'firestore-and-composite',
    matrixRow: 'firestore #57',
    rowIds: ['firestore#57'],
    description: 'and(...) composite — every sub-filter must match. Seeds 4 docs with overlapping conditions and queries with and(where(x,==,1), where(y,==,2)); only the doc matching ALL sub-filters should come back.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('and-composite'));
      await Promise.all([
        setDoc(doc(c, 'match-x-only'), { x: 1, y: 9 }),
        setDoc(doc(c, 'match-y-only'), { x: 7, y: 2 }),
        setDoc(doc(c, 'match-both'), { x: 1, y: 2 }),
        setDoc(doc(c, 'match-neither'), { x: 7, y: 9 }),
      ]);
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let matched = -1;
      let matchedIds: string[] = [];
      try {
        const q = query(c, and(where('x', '==', 1), where('y', '==', 2)));
        const snap = await getDocs(q);
        matched = snap.size;
        matchedIds = snap.docs.map((d) => d.id).sort();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await Promise.all([
        deleteDoc(doc(c, 'match-x-only')),
        deleteDoc(doc(c, 'match-y-only')),
        deleteDoc(doc(c, 'match-both')),
        deleteDoc(doc(c, 'match-neither')),
      ]);
      await dropCurrentUser();
      return {
        seeded: 4,
        matched,
        matchedIds,
        threw,
        code,
        errorMessage: message,
        expectedIds: ['match-both'],
      };
    },
  },
  {
    name: 'firestore-nested-or-and-composite',
    matrixRow: 'firestore #58',
    rowIds: ['firestore#58'],
    description: 'Nested or/and — the canonical composite pattern. Query: or(and(where(x,==,1), where(y,==,2)), where(z,==,3)). Result should be the boolean union of "x==1 AND y==2" with "z==3".',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('nested-or-and'));
      await Promise.all([
        setDoc(doc(c, 'inner-and-match'), { x: 1, y: 2, z: 9 }),
        setDoc(doc(c, 'outer-z-match'), { x: 7, y: 8, z: 3 }),
        setDoc(doc(c, 'both-branches'), { x: 1, y: 2, z: 3 }),
        setDoc(doc(c, 'partial-x'), { x: 1, y: 8, z: 9 }),
        setDoc(doc(c, 'partial-y'), { x: 7, y: 2, z: 9 }),
        setDoc(doc(c, 'none'), { x: 7, y: 8, z: 9 }),
      ]);
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let matched = -1;
      let matchedIds: string[] = [];
      try {
        const q = query(
          c,
          or(and(where('x', '==', 1), where('y', '==', 2)), where('z', '==', 3)),
        );
        const snap = await getDocs(q);
        matched = snap.size;
        matchedIds = snap.docs.map((d) => d.id).sort();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await Promise.all([
        deleteDoc(doc(c, 'inner-and-match')),
        deleteDoc(doc(c, 'outer-z-match')),
        deleteDoc(doc(c, 'both-branches')),
        deleteDoc(doc(c, 'partial-x')),
        deleteDoc(doc(c, 'partial-y')),
        deleteDoc(doc(c, 'none')),
      ]);
      await dropCurrentUser();
      return {
        seeded: 6,
        matched,
        matchedIds,
        threw,
        code,
        errorMessage: message,
        expectedIds: ['both-branches', 'inner-and-match', 'outer-z-match'],
      };
    },
  },
  {
    name: 'firestore-cursor-startat-inclusive',
    matrixRow: 'firestore #67',
    rowIds: ['firestore#67'],
    description: 'startAt(...values) — inclusive value cursor. Seeds 5 docs with field pos=[1,2,3,4,5], queries orderBy(pos), startAt(3); the doc at pos=3 should be INCLUDED. Pins the one-off-by-one boundary.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('cursor-startat'));
      const seededIds = ['pos-1', 'pos-2', 'pos-3', 'pos-4', 'pos-5'];
      await Promise.all([
        setDoc(doc(c, 'pos-1'), { pos: 1 }),
        setDoc(doc(c, 'pos-2'), { pos: 2 }),
        setDoc(doc(c, 'pos-3'), { pos: 3 }),
        setDoc(doc(c, 'pos-4'), { pos: 4 }),
        setDoc(doc(c, 'pos-5'), { pos: 5 }),
      ]);
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let matched = -1;
      let matchedIds: string[] = [];
      try {
        const q = query(c, orderBy('pos'), startAt(3));
        const snap = await getDocs(q);
        matched = snap.size;
        matchedIds = snap.docs.map((d) => d.id);
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await Promise.all(seededIds.map((id) => deleteDoc(doc(c, id))));
      await dropCurrentUser();
      return {
        seeded: 5,
        seededIds,
        matched,
        matchedIds,
        threw,
        code,
        errorMessage: message,
        expectedIds: ['pos-3', 'pos-4', 'pos-5'],
      };
    },
  },
  {
    name: 'firestore-cursor-startafter-exclusive',
    matrixRow: 'firestore #68',
    rowIds: ['firestore#68'],
    description: 'startAfter(...values) — exclusive value cursor. Seeds 5 docs with field pos=[1,2,3,4,5], queries orderBy(pos), startAfter(3); the doc at pos=3 should be EXCLUDED.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('cursor-startafter'));
      const seededIds = ['pos-1', 'pos-2', 'pos-3', 'pos-4', 'pos-5'];
      await Promise.all([
        setDoc(doc(c, 'pos-1'), { pos: 1 }),
        setDoc(doc(c, 'pos-2'), { pos: 2 }),
        setDoc(doc(c, 'pos-3'), { pos: 3 }),
        setDoc(doc(c, 'pos-4'), { pos: 4 }),
        setDoc(doc(c, 'pos-5'), { pos: 5 }),
      ]);
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let matched = -1;
      let matchedIds: string[] = [];
      try {
        const q = query(c, orderBy('pos'), startAfter(3));
        const snap = await getDocs(q);
        matched = snap.size;
        matchedIds = snap.docs.map((d) => d.id);
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await Promise.all(seededIds.map((id) => deleteDoc(doc(c, id))));
      await dropCurrentUser();
      return {
        seeded: 5,
        seededIds,
        matched,
        matchedIds,
        threw,
        code,
        errorMessage: message,
        expectedIds: ['pos-4', 'pos-5'],
      };
    },
  },
  {
    name: 'firestore-cursor-endat-inclusive',
    matrixRow: 'firestore #69',
    rowIds: ['firestore#69'],
    description: 'endAt(...values) — inclusive end cursor. Seeds 5 docs with field pos=[1,2,3,4,5], queries orderBy(pos), endAt(3); the doc at pos=3 should be INCLUDED.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('cursor-endat'));
      const seededIds = ['pos-1', 'pos-2', 'pos-3', 'pos-4', 'pos-5'];
      await Promise.all([
        setDoc(doc(c, 'pos-1'), { pos: 1 }),
        setDoc(doc(c, 'pos-2'), { pos: 2 }),
        setDoc(doc(c, 'pos-3'), { pos: 3 }),
        setDoc(doc(c, 'pos-4'), { pos: 4 }),
        setDoc(doc(c, 'pos-5'), { pos: 5 }),
      ]);
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let matched = -1;
      let matchedIds: string[] = [];
      try {
        const q = query(c, orderBy('pos'), endAt(3));
        const snap = await getDocs(q);
        matched = snap.size;
        matchedIds = snap.docs.map((d) => d.id);
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await Promise.all(seededIds.map((id) => deleteDoc(doc(c, id))));
      await dropCurrentUser();
      return {
        seeded: 5,
        seededIds,
        matched,
        matchedIds,
        threw,
        code,
        errorMessage: message,
        expectedIds: ['pos-1', 'pos-2', 'pos-3'],
      };
    },
  },
  {
    name: 'firestore-cursor-endbefore-exclusive',
    matrixRow: 'firestore #70',
    rowIds: ['firestore#70'],
    description: 'endBefore(...values) — exclusive end cursor. Seeds 5 docs with field pos=[1,2,3,4,5], queries orderBy(pos), endBefore(3); the doc at pos=3 should be EXCLUDED.',
    async observe() {
      await signInAnonymously(auth);
      const c = collection(db, RUN_DOC('cursor-endbefore'));
      const seededIds = ['pos-1', 'pos-2', 'pos-3', 'pos-4', 'pos-5'];
      await Promise.all([
        setDoc(doc(c, 'pos-1'), { pos: 1 }),
        setDoc(doc(c, 'pos-2'), { pos: 2 }),
        setDoc(doc(c, 'pos-3'), { pos: 3 }),
        setDoc(doc(c, 'pos-4'), { pos: 4 }),
        setDoc(doc(c, 'pos-5'), { pos: 5 }),
      ]);
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let matched = -1;
      let matchedIds: string[] = [];
      try {
        const q = query(c, orderBy('pos'), endBefore(3));
        const snap = await getDocs(q);
        matched = snap.size;
        matchedIds = snap.docs.map((d) => d.id);
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await Promise.all(seededIds.map((id) => deleteDoc(doc(c, id))));
      await dropCurrentUser();
      return {
        seeded: 5,
        seededIds,
        matched,
        matchedIds,
        threw,
        code,
        errorMessage: message,
        expectedIds: ['pos-1', 'pos-2'],
      };
    },
  },
  {
    name: 'auth-row-25-signout-currentuser-null-sync',
    matrixRow: 'auth #25',
    rowIds: ['auth#25'],
    description: 'signOut sets currentUser to null synchronously after the returned promise resolves — read auth.currentUser BEFORE any await/microtask runs after `await signOut(auth)`.',
    async observe() {
      await signInAnonymously(auth);
      const userBefore = auth.currentUser;
      const uidBefore = userBefore ? userBefore.uid : null;
      await signOut(auth);
      // Critical: do NOT await, queueMicrotask, or setTimeout between
      // signOut resolution and this read. This captures whether
      // currentUser is already null at the *synchronous continuation*
      // immediately after the awaited promise resolved.
      const currentUserImmediatelyAfter = auth.currentUser;
      const uidImmediatelyAfter = currentUserImmediatelyAfter
        ? currentUserImmediatelyAfter.uid
        : null;
      // Fence #2: after a microtask flush.
      await Promise.resolve();
      const uidAfterMicrotask = auth.currentUser ? auth.currentUser.uid : null;
      // Fence #3: after a macrotask.
      await new Promise((r) => setTimeout(r, 0));
      const uidAfterMacrotask = auth.currentUser ? auth.currentUser.uid : null;
      return {
        uidBefore,
        uidImmediatelyAfter,
        uidAfterMicrotask,
        uidAfterMacrotask,
        currentUserIsNullSync: currentUserImmediatelyAfter === null,
      };
    },
  },
  {
    name: 'auth-row-29-onauthstatechanged-initial-fire-timing',
    matrixRow: 'auth #29',
    rowIds: ['auth#29'],
    description: 'onAuthStateChanged initial-fire timing — does the first fire arrive synchronously on subscribe, after a microtask, or after a macrotask? Fences capture each tier.',
    async observe() {
      await signInAnonymously(auth);
      const signedInUid = auth.currentUser ? auth.currentUser.uid : null;
      // Subscribe with a fresh listener; capture firing order with
      // three fences: synchronous, microtask, macrotask.
      const fires: Array<{ uid: string | null; fence: string }> = [];
      let phase: 'sync' | 'microtask' | 'macrotask' | 'post' = 'sync';
      const unsub = onAuthStateChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, fence: phase });
      });
      const firedSynchronously = fires.length;
      phase = 'microtask';
      await Promise.resolve();
      const firedAfterMicrotask = fires.length;
      phase = 'macrotask';
      await new Promise((r) => setTimeout(r, 0));
      const firedAfterMacrotask = fires.length;
      phase = 'post';
      // Give the SDK a generous tail to make sure no extra fires leak in.
      await new Promise((r) => setTimeout(r, 200));
      const firedAfterLongDelay = fires.length;
      unsub();
      await dropCurrentUser();
      return {
        signedInUid,
        firedSynchronously,
        firedAfterMicrotask,
        firedAfterMacrotask,
        firedAfterLongDelay,
        fires,
      };
    },
  },
  {
    name: 'auth-row-31-onauthstatechanged-no-dup-on-sync-transition',
    matrixRow: 'auth #31',
    rowIds: ['auth#31'],
    description: 'onAuthStateChanged dedup — subscribe then immediately (same tick) trigger a sign-in; matrix claims 1 fire (new value), not 2 (initial-null replay + new). Probe counts fires after enough time for both to settle.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);
      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      // Subscribe + synchronously kick off sign-in (no await between
      // them). Both effects are scheduled in the same tick; the SDK's
      // dedup window decides whether the initial-null and the new-user
      // both fire, or just the new-user.
      const unsub = onAuthStateChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      const signInPromise = signInAnonymously(auth);
      await signInPromise;
      // Give listeners a tail to flush.
      await new Promise((r) => setTimeout(r, 500));
      unsub();
      const newUid = auth.currentUser ? auth.currentUser.uid : null;
      await dropCurrentUser();
      const sawInitialNull = fires.some((f) => f.uid === null);
      const sawNewUser = fires.some((f) => f.uid !== null);
      return {
        totalFires: fires.length,
        sawInitialNull,
        sawNewUser,
        newUid,
        fires,
      };
    },
  },
  {
    name: 'auth-row-35-throwing-observer-doesnt-block-others',
    matrixRow: 'auth #35',
    rowIds: ['auth#35'],
    description: 'A throwing observer registered on onAuthStateChanged does NOT block subsequent observers. Register two; the first throws; trigger a state change; verify the second fires.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);
      let firstFireCount = 0;
      let secondFireCount = 0;
      let firstThrewObserved = 0;
      // First observer throws on every call.
      const unsub1 = onAuthStateChanged(auth, () => {
        firstFireCount += 1;
        firstThrewObserved += 1;
        throw new Error('intentional throw from oracle probe observer #1');
      });
      // Second observer increments — must still fire after observer #1 throws.
      const unsub2 = onAuthStateChanged(auth, () => {
        secondFireCount += 1;
      });
      // Initial fire flush.
      await new Promise((r) => setTimeout(r, 100));
      const afterInitial = { firstFireCount, secondFireCount };
      // Trigger a state transition.
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignIn = { firstFireCount, secondFireCount };
      unsub1();
      unsub2();
      await dropCurrentUser();
      return {
        afterInitial,
        afterSignIn,
        firstThrewObserved,
        secondObserverContinuedFiring: secondFireCount > afterInitial.secondFireCount,
      };
    },
  },
  {
    name: 'auth-row-37-same-user-no-double-fire',
    matrixRow: 'auth #37',
    rowIds: ['auth#37'],
    description: 'signInAnonymously twice in a row — does the second call (which prod treats as "already signed in anonymously, return same user") fire onAuthStateChanged again? Matrix claims no double-fire for same-user.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);
      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsub = onAuthStateChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Wait for initial fire (null).
      await new Promise((r) => setTimeout(r, 200));
      const initialFires = fires.length;
      // First sign-in mints a user, must fire.
      const cred1 = await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterFirstSignIn = fires.length;
      const uidAfterFirst = auth.currentUser ? auth.currentUser.uid : null;
      // Second call — same anonymous user (per fix #399 / prod behavior).
      const cred2 = await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSecondSignIn = fires.length;
      const uidAfterSecond = auth.currentUser ? auth.currentUser.uid : null;
      unsub();
      await dropCurrentUser();
      return {
        initialFires,
        afterFirstSignIn,
        afterSecondSignIn,
        firstSignInProducedFire: afterFirstSignIn > initialFires,
        secondSignInProducedFire: afterSecondSignIn > afterFirstSignIn,
        uidAfterFirst,
        uidAfterSecond,
        sameUserAcrossCalls: cred1.user.uid === cred2.user.uid,
        fires,
      };
    },
  },
  {
    name: 'auth-row-38-onidtokenchanged-fires-on-user-change',
    matrixRow: 'auth #38',
    rowIds: ['auth#38'],
    description: 'onIdTokenChanged fires on user change. Probe: signInAnonymously → signOut → signInAnonymously, count + shape the fires.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);
      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsub = onIdTokenChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Initial fire flush.
      await new Promise((r) => setTimeout(r, 300));
      const initialFires = fires.length;
      // signIn #1
      const cred1 = await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 300));
      const afterSignIn1 = fires.length;
      // signOut
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 300));
      const afterSignOut = fires.length;
      // signIn #2 — new anonymous user, fresh uid
      const cred2 = await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 300));
      const afterSignIn2 = fires.length;
      unsub();
      await dropCurrentUser();
      return {
        initialFires,
        afterSignIn1,
        afterSignOut,
        afterSignIn2,
        firstSignInFired: afterSignIn1 > initialFires,
        signOutFired: afterSignOut > afterSignIn1,
        secondSignInFired: afterSignIn2 > afterSignOut,
        uid1: cred1.user.uid,
        uid2: cred2.user.uid,
        differentUids: cred1.user.uid !== cred2.user.uid,
        fires,
      };
    },
  },
  {
    name: 'auth-row-40-onidtokenchanged-matches-onauthstatechanged-initial-fire',
    matrixRow: 'auth #40',
    rowIds: ['auth#40'],
    description: 'Subscribe onIdTokenChanged and onAuthStateChanged simultaneously; capture count + timing of their initial fires. Matrix claims same initial-fire semantics.',
    async observe() {
      // Ensure starting state is signed out so the initial fire is null.
      if (auth.currentUser) await signOut(auth);
      const authFires: Array<{ uid: string | null; ts: number }> = [];
      const idTokenFires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      // Subscribe both back-to-back in the same tick.
      const unsubAuth = onAuthStateChanged(auth, (u) => {
        authFires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      const unsubIdToken = onIdTokenChanged(auth, (u) => {
        idTokenFires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      const syncAuth = authFires.length;
      const syncIdToken = idTokenFires.length;
      await Promise.resolve();
      const microAuth = authFires.length;
      const microIdToken = idTokenFires.length;
      await new Promise((r) => setTimeout(r, 0));
      const macroAuth = authFires.length;
      const macroIdToken = idTokenFires.length;
      // Give a longer tail to make sure no late fires sneak in.
      await new Promise((r) => setTimeout(r, 300));
      const finalAuth = authFires.length;
      const finalIdToken = idTokenFires.length;
      unsubAuth();
      unsubIdToken();
      return {
        sync: { auth: syncAuth, idToken: syncIdToken },
        microtask: { auth: microAuth, idToken: microIdToken },
        macrotask: { auth: macroAuth, idToken: macroIdToken },
        final: { auth: finalAuth, idToken: finalIdToken },
        authFires,
        idTokenFires,
        sameInitialCount: finalAuth === finalIdToken,
      };
    },
  },
  {
    name: 'auth-row-10-onauthstatechanged-one-per-transition',
    matrixRow: 'auth #10',
    rowIds: ['auth#10'],
    description:
      'onAuthStateChanged fires exactly once per state transition (no same-value double-fire). Subscribe, then signInAnonymously → signOut → signInAnonymously; count fires per transition. Matrix claim: each of the 3 transitions produces 1 fire.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);
      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsub = onAuthStateChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Wait for initial fire (null) to land.
      await new Promise((r) => setTimeout(r, 300));
      const initialFires = fires.length;

      // Transition 1: signed-out → signed-in (anon user A).
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignIn1 = fires.length;
      const firesForTransition1 = afterSignIn1 - initialFires;

      // Transition 2: signed-in → signed-out.
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignOut = fires.length;
      const firesForTransition2 = afterSignOut - afterSignIn1;

      // Transition 3: signed-out → signed-in (fresh anon user B).
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignIn2 = fires.length;
      const firesForTransition3 = afterSignIn2 - afterSignOut;

      unsub();
      await dropCurrentUser();
      return {
        initialFires,
        afterSignIn1,
        afterSignOut,
        afterSignIn2,
        firesForTransition1,
        firesForTransition2,
        firesForTransition3,
        eachTransitionFiredExactlyOnce:
          firesForTransition1 === 1 &&
          firesForTransition2 === 1 &&
          firesForTransition3 === 1,
        fires,
      };
    },
  },
  {
    name: 'auth-row-17-signin-email-password-fires-once',
    matrixRow: 'auth #17',
    rowIds: ['auth#17'],
    description:
      'signInWithEmailAndPassword fires onAuthStateChanged with the new user exactly once. Probe: createUser → signOut → subscribe → signInWithEmailAndPassword; count fires for the signIn transition.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);
      const email = `oracle-row17-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      const password = 'oracle-pw-row17';
      await createUserWithEmailAndPassword(auth, email, password);
      const createdUid = auth.currentUser?.uid ?? null;
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 200));

      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsub = onAuthStateChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Wait for initial fire (null).
      await new Promise((r) => setTimeout(r, 300));
      const initialFires = fires.length;

      // Sign in via email/password — one fire expected with the new user.
      const cred = await signInWithEmailAndPassword(auth, email, password);
      await new Promise((r) => setTimeout(r, 600));
      const afterSignIn = fires.length;
      const firesForSignIn = afterSignIn - initialFires;
      const lastFire = fires[fires.length - 1];

      unsub();

      // Cleanup: delete the throwaway user so it doesn't leak.
      let cleanupLeaked = false;
      try {
        if (auth.currentUser) await deleteUser(auth.currentUser);
      } catch {
        cleanupLeaked = true;
      }
      await dropCurrentUser();
      return {
        initialFires,
        afterSignIn,
        firesForSignIn,
        signInFiredExactlyOnce: firesForSignIn === 1,
        lastFireUidMatches: lastFire?.uid === cred.user.uid,
        createdUid,
        signedInUid: cred.user.uid,
        cleanupLeaked,
        fires,
      };
    },
  },
  {
    name: 'auth-row-24-createuser-fires-once',
    matrixRow: 'auth #24',
    rowIds: ['auth#24'],
    description:
      'createUserWithEmailAndPassword fires onAuthStateChanged with the new user exactly once. Subscribe, createUser, count fires for the create transition.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);

      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsub = onAuthStateChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Wait for initial fire (null).
      await new Promise((r) => setTimeout(r, 300));
      const initialFires = fires.length;

      const email = `oracle-row24-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      const password = 'oracle-pw-row24';
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await new Promise((r) => setTimeout(r, 600));
      const afterCreate = fires.length;
      const firesForCreate = afterCreate - initialFires;
      const lastFire = fires[fires.length - 1];

      unsub();

      // Cleanup: delete the freshly-created user.
      let cleanupLeaked = false;
      try {
        if (auth.currentUser) await deleteUser(auth.currentUser);
      } catch {
        cleanupLeaked = true;
      }
      await dropCurrentUser();
      return {
        initialFires,
        afterCreate,
        firesForCreate,
        createFiredExactlyOnce: firesForCreate === 1,
        lastFireUidMatches: lastFire?.uid === cred.user.uid,
        createdUid: cred.user.uid,
        cleanupLeaked,
        fires,
      };
    },
  },
  {
    name: 'auth-row-26-signout-fires-null-once',
    matrixRow: 'auth #26',
    rowIds: ['auth#26'],
    description:
      'signOut fires onAuthStateChanged with null exactly once. Subscribe, signInAnonymously, then signOut; count fires for the signOut transition and verify the fire delivers null.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);

      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsub = onAuthStateChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Wait for initial fire (null).
      await new Promise((r) => setTimeout(r, 300));
      const initialFires = fires.length;

      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignIn = fires.length;

      await signOut(auth);
      await new Promise((r) => setTimeout(r, 500));
      const afterSignOut = fires.length;
      const firesForSignOut = afterSignOut - afterSignIn;
      const lastFire = fires[fires.length - 1];

      unsub();
      await dropCurrentUser();
      return {
        initialFires,
        afterSignIn,
        afterSignOut,
        firesForSignOut,
        signOutFiredExactlyOnce: firesForSignOut === 1,
        lastFireUidWasNull: lastFire?.uid === null,
        fires,
      };
    },
  },
  {
    name: 'auth-row-30-onauthstatechanged-fires-on-every-transition',
    matrixRow: 'auth #30',
    rowIds: ['auth#30'],
    description:
      'onAuthStateChanged fires on every subsequent identity change. Subscribe, then run signIn → signOut → signIn → signOut; verify the listener receives a fire for each of the 4 transitions.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);

      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsub = onAuthStateChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Wait for initial (null) fire.
      await new Promise((r) => setTimeout(r, 300));
      const initialFires = fires.length;

      // Transition 1: signIn
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const t1 = fires.length;

      // Transition 2: signOut
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 400));
      const t2 = fires.length;

      // Transition 3: signIn (fresh anonymous user)
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const t3 = fires.length;

      // Transition 4: signOut
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 400));
      const t4 = fires.length;

      unsub();
      await dropCurrentUser();
      const fire1 = t1 - initialFires;
      const fire2 = t2 - t1;
      const fire3 = t3 - t2;
      const fire4 = t4 - t3;
      return {
        initialFires,
        firesForT1SignIn: fire1,
        firesForT2SignOut: fire2,
        firesForT3SignIn: fire3,
        firesForT4SignOut: fire4,
        allFourTransitionsFired:
          fire1 >= 1 && fire2 >= 1 && fire3 >= 1 && fire4 >= 1,
        eachTransitionFiredExactlyOnce:
          fire1 === 1 && fire2 === 1 && fire3 === 1 && fire4 === 1,
        fires,
      };
    },
  },
  {
    name: 'auth-row-32-unsubscribe-stops-fires',
    matrixRow: 'auth #32',
    rowIds: ['auth#32'],
    description:
      'Returned Unsubscribe removes the observer; subsequent state changes do NOT fire it. Subscribe, do one transition (to confirm the listener is wired), unsubscribe, then do further transitions and verify no further fires.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);

      const fires: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsub = onAuthStateChanged(auth, (u) => {
        fires.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Wait for initial (null) fire.
      await new Promise((r) => setTimeout(r, 300));
      const initialFires = fires.length;

      // One transition while subscribed — should fire.
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignIn = fires.length;

      // Unsubscribe.
      unsub();
      const firesAtUnsubscribe = fires.length;

      // Multiple post-unsubscribe transitions — should NOT fire.
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterPostUnsubSignOut = fires.length;
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterPostUnsubSignIn = fires.length;
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterPostUnsubSecondSignOut = fires.length;

      await dropCurrentUser();
      const postUnsubFires = afterPostUnsubSecondSignOut - firesAtUnsubscribe;
      return {
        initialFires,
        afterSignIn,
        firesAtUnsubscribe,
        afterPostUnsubSignOut,
        afterPostUnsubSignIn,
        afterPostUnsubSecondSignOut,
        postUnsubFires,
        unsubscribeStoppedFires: postUnsubFires === 0,
        fires,
      };
    },
  },
  {
    name: 'auth-row-33-multiple-subscribers-all-fire',
    matrixRow: 'auth #33',
    rowIds: ['auth#33'],
    description:
      'Multiple subscribers all fire on each state change. Register two onAuthStateChanged subscribers, do a signIn transition, verify both fire.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);

      const firesA: Array<{ uid: string | null; ts: number }> = [];
      const firesB: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      const unsubA = onAuthStateChanged(auth, (u) => {
        firesA.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      const unsubB = onAuthStateChanged(auth, (u) => {
        firesB.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Wait for initial fires.
      await new Promise((r) => setTimeout(r, 300));
      const initialA = firesA.length;
      const initialB = firesB.length;

      // Trigger a state transition.
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignInA = firesA.length;
      const afterSignInB = firesB.length;

      // Trigger a second transition just to be thorough.
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignOutA = firesA.length;
      const afterSignOutB = firesB.length;

      unsubA();
      unsubB();
      await dropCurrentUser();

      const aSignInFires = afterSignInA - initialA;
      const bSignInFires = afterSignInB - initialB;
      const aSignOutFires = afterSignOutA - afterSignInA;
      const bSignOutFires = afterSignOutB - afterSignInB;
      return {
        initialA,
        initialB,
        afterSignInA,
        afterSignInB,
        afterSignOutA,
        afterSignOutB,
        aSignInFires,
        bSignInFires,
        aSignOutFires,
        bSignOutFires,
        bothFiredOnSignIn: aSignInFires >= 1 && bSignInFires >= 1,
        bothFiredOnSignOut: aSignOutFires >= 1 && bSignOutFires >= 1,
        firesA,
        firesB,
      };
    },
  },
  {
    name: 'auth-row-36-observer-object-form-works',
    matrixRow: 'auth #36',
    rowIds: ['auth#36'],
    description:
      'Observer object form ({next, error, complete}) works alongside the function form. Register one observer as a NextFn and another as {next}; trigger a transition; verify both fire.',
    async observe() {
      // Ensure starting state is signed out.
      if (auth.currentUser) await signOut(auth);

      const firesFn: Array<{ uid: string | null; ts: number }> = [];
      const firesObs: Array<{ uid: string | null; ts: number }> = [];
      const start = Date.now();
      // Function form.
      const unsubFn = onAuthStateChanged(auth, (u) => {
        firesFn.push({ uid: u ? u.uid : null, ts: Date.now() - start });
      });
      // Observer object form. Cast through `as never` to satisfy the
      // overload picker; the runtime accepts a {next, error, complete}
      // shape per the Observer<T> contract from @firebase/util.
      const unsubObs = onAuthStateChanged(
        auth,
        {
          next: (u: User | null) => {
            firesObs.push({ uid: u ? u.uid : null, ts: Date.now() - start });
          },
          error: () => {},
          complete: () => {},
        } as never,
      );

      // Wait for initial fires.
      await new Promise((r) => setTimeout(r, 300));
      const initialFn = firesFn.length;
      const initialObs = firesObs.length;

      // Trigger a transition.
      await signInAnonymously(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignInFn = firesFn.length;
      const afterSignInObs = firesObs.length;

      // And a second transition for good measure.
      await signOut(auth);
      await new Promise((r) => setTimeout(r, 400));
      const afterSignOutFn = firesFn.length;
      const afterSignOutObs = firesObs.length;

      unsubFn();
      unsubObs();
      await dropCurrentUser();

      const fnSignInFires = afterSignInFn - initialFn;
      const obsSignInFires = afterSignInObs - initialObs;
      const fnSignOutFires = afterSignOutFn - afterSignInFn;
      const obsSignOutFires = afterSignOutObs - afterSignInObs;
      return {
        initialFn,
        initialObs,
        afterSignInFn,
        afterSignInObs,
        afterSignOutFn,
        afterSignOutObs,
        fnSignInFires,
        obsSignInFires,
        fnSignOutFires,
        obsSignOutFires,
        bothFormsFiredOnSignIn: fnSignInFires >= 1 && obsSignInFires >= 1,
        bothFormsFiredOnSignOut: fnSignOutFires >= 1 && obsSignOutFires >= 1,
        firesFn,
        firesObs,
      };
    },
  },

  // ─── Storage probes ────────────────────────────────────────────────
  //
  // All storage probes require:
  //   1. `config.storageBucket` set (i.e. Storage is enabled on the
  //      project's Web SDK config — without it, `getStorage(app)`
  //      has no default bucket and every operation throws).
  //   2. Storage rules that permit writes under `pyric_oracle/**` for
  //      authenticated users. The Firestore-rules installer at the
  //      top of this file does NOT touch Storage rules — they live on
  //      a different release name (`firebase.storage/{bucketId}`) and
  //      the methodology pivot is to keep them deployed manually
  //      until a follow-up wires `packages/storage/src/admin/api.ts`'s
  //      `deployStorageRules` into the harness.
  //
  // Each probe checks `storage` early and records a structured
  // skip-observation if Storage isn't available, so the harness still
  // succeeds and the matrix can cite the skipped state. Cleanup uses
  // `deleteObject` on the same ref the probe wrote.
  {
    name: 'storage-upload-bytes-roundtrip',
    matrixRow: 'storage #36',
    rowIds: ['storage#36'],
    description:
      'uploadBytes a small ArrayBuffer, getDownloadURL + fetch, verify byte-for-byte equality with what was uploaded.',
    async observe() {
      if (!storage) {
        return {
          skipped: true,
          reason: 'Storage not enabled on this project (no storageBucket in Web SDK config). Enable Storage in the Firebase console and re-run.',
        };
      }
      await signInAnonymously(auth);
      const path = RUN_STORAGE_PATH('upload-bytes', 'payload.bin');
      const ref = storageRef(storage, path);
      const payload = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63, 0x21]); // "pyric!"
      let uploadOk = false;
      let downloadOk = false;
      let bytesMatch = false;
      let url: string | null = null;
      let bodyLen = 0;
      let error: string | null = null;
      let code: string | null = null;
      try {
        await uploadBytes(ref, payload);
        uploadOk = true;
        url = await getDownloadURL(ref);
        const resp = await fetch(url);
        downloadOk = resp.ok;
        const buf = new Uint8Array(await resp.arrayBuffer());
        bodyLen = buf.byteLength;
        bytesMatch = buf.length === payload.length &&
          buf.every((b, i) => b === payload[i]);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        code = (e as { code?: string }).code ?? null;
      } finally {
        try { await deleteObject(ref); } catch { /* ignored */ }
        await dropCurrentUser();
      }
      return {
        uploadOk,
        downloadOk,
        bytesMatch,
        urlIsHttps: url !== null && url.startsWith('https://'),
        bodyLen,
        payloadLen: payload.length,
        error,
        code,
      };
    },
  },
  {
    name: 'storage-upload-then-getmetadata',
    matrixRow: 'storage #89',
    rowIds: ['storage#89', 'storage#37', 'storage#91'],
    description:
      'uploadBytes with contentType: application/octet-stream, then getMetadata — verify contentType and size round-trip exactly.',
    async observe() {
      if (!storage) {
        return {
          skipped: true,
          reason: 'Storage not enabled on this project (no storageBucket in Web SDK config).',
        };
      }
      await signInAnonymously(auth);
      const path = RUN_STORAGE_PATH('upload-getmd', 'octet.bin');
      const ref = storageRef(storage, path);
      const payload = new Uint8Array(128).fill(0x42);
      let uploadOk = false;
      let metadataContentType: string | null = null;
      let metadataSize: number | null = null;
      let metadataFullPath: string | null = null;
      let metadataBucket: string | null = null;
      let metadataGeneration: string | null = null;
      let metadataMetageneration: string | null = null;
      let hasMd5Hash = false;
      let error: string | null = null;
      let code: string | null = null;
      try {
        await uploadBytes(ref, payload, {
          contentType: 'application/octet-stream',
        });
        uploadOk = true;
        const md = await getMetadata(ref);
        metadataContentType = md.contentType ?? null;
        metadataSize = md.size;
        metadataFullPath = md.fullPath;
        metadataBucket = md.bucket;
        metadataGeneration = md.generation;
        metadataMetageneration = md.metageneration;
        hasMd5Hash = typeof (md as { md5Hash?: unknown }).md5Hash === 'string';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        code = (e as { code?: string }).code ?? null;
      } finally {
        try { await deleteObject(ref); } catch { /* ignored */ }
        await dropCurrentUser();
      }
      return {
        uploadOk,
        metadataContentType,
        metadataSize,
        metadataFullPath,
        metadataBucket,
        metadataGeneration,
        metadataMetageneration,
        contentTypeMatches: metadataContentType === 'application/octet-stream',
        sizeMatches: metadataSize === payload.length,
        fullPathMatches: metadataFullPath === path,
        hasMd5Hash,
        error,
        code,
      };
    },
  },
  {
    name: 'storage-uploadstring-base64-roundtrip',
    matrixRow: 'storage #46',
    rowIds: ['storage#46'],
    description:
      'uploadString with format: base64 — payload "hello" base64-encoded as "aGVsbG8=" — fetch and verify decoded bytes match.',
    async observe() {
      if (!storage) {
        return {
          skipped: true,
          reason: 'Storage not enabled on this project (no storageBucket in Web SDK config).',
        };
      }
      await signInAnonymously(auth);
      const path = RUN_STORAGE_PATH('uploadstring-b64', 'hello.txt');
      const ref = storageRef(storage, path);
      const b64 = 'aGVsbG8='; // "hello"
      const expected = 'hello';
      let uploadOk = false;
      let downloadText: string | null = null;
      let textMatches = false;
      let error: string | null = null;
      let code: string | null = null;
      try {
        await uploadString(ref, b64, 'base64');
        uploadOk = true;
        const url = await getDownloadURL(ref);
        const resp = await fetch(url);
        downloadText = await resp.text();
        textMatches = downloadText === expected;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        code = (e as { code?: string }).code ?? null;
      } finally {
        try { await deleteObject(ref); } catch { /* ignored */ }
        await dropCurrentUser();
      }
      return {
        uploadOk,
        downloadText,
        textMatches,
        error,
        code,
      };
    },
  },
  {
    name: 'storage-delete-then-get-throws',
    matrixRow: 'storage #66',
    rowIds: ['storage#66', 'storage#54'],
    description:
      'Upload, deleteObject, then getDownloadURL on the deleted ref — observe the error code (expected: storage/object-not-found).',
    async observe() {
      if (!storage) {
        return {
          skipped: true,
          reason: 'Storage not enabled on this project (no storageBucket in Web SDK config).',
        };
      }
      await signInAnonymously(auth);
      const path = RUN_STORAGE_PATH('delete-then-get', 'soon-gone.bin');
      const ref = storageRef(storage, path);
      let uploadOk = false;
      let deleteOk = false;
      let getUrlThrew = false;
      let code: string | null = null;
      let message: string | null = null;
      let errorName: string | null = null;
      let isFirebaseError = false;
      let setupError: string | null = null;
      let setupCode: string | null = null;
      try {
        try {
          await uploadBytes(ref, new Uint8Array([1, 2, 3]));
          uploadOk = true;
          await deleteObject(ref);
          deleteOk = true;
        } catch (e) {
          // Upload or delete failed (most often: rules-denied). Record
          // the failure and bail; the post-delete getDownloadURL claim
          // can't be observed here.
          setupError = e instanceof Error ? e.message : String(e);
          setupCode = (e as { code?: string }).code ?? null;
        }
        if (uploadOk && deleteOk) {
          try {
            await getDownloadURL(ref);
          } catch (e) {
            getUrlThrew = true;
            const err = e as { code?: string; message?: string; name?: string };
            code = err.code ?? null;
            message = err.message ?? null;
            errorName = err.name ?? null;
            isFirebaseError = err.name === 'FirebaseError';
          }
        }
      } finally {
        try { await deleteObject(ref); } catch { /* ignored */ }
        await dropCurrentUser();
      }
      return {
        uploadOk,
        deleteOk,
        getUrlThrew,
        code,
        message,
        errorName,
        isFirebaseError,
        setupError,
        setupCode,
      };
    },
  },
  {
    name: 'storage-delete-missing-throws',
    matrixRow: 'storage #64',
    rowIds: ['storage#64'],
    description:
      'deleteObject on a path that was never uploaded — observe the error code (expected: storage/object-not-found). Sandbox is no-op; this oracle locks prod\'s shape.',
    async observe() {
      if (!storage) {
        return {
          skipped: true,
          reason: 'Storage not enabled on this project (no storageBucket in Web SDK config).',
        };
      }
      await signInAnonymously(auth);
      const path = RUN_STORAGE_PATH('delete-missing', 'never-existed.bin');
      const ref = storageRef(storage, path);
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let errorName: string | null = null;
      let isFirebaseError = false;
      try {
        await deleteObject(ref);
      } catch (e) {
        threw = true;
        const err = e as { code?: string; message?: string; name?: string };
        code = err.code ?? null;
        message = err.message ?? null;
        errorName = err.name ?? null;
        isFirebaseError = err.name === 'FirebaseError';
      } finally {
        await dropCurrentUser();
      }
      return {
        threw,
        code,
        message,
        errorName,
        isFirebaseError,
      };
    },
  },
  {
    name: 'storage-listall-shape',
    matrixRow: 'storage #77',
    rowIds: ['storage#77'],
    description:
      'Upload 3 objects under a directory ref + one in a sub-folder; listAll returns items + prefixes in the documented shape.',
    async observe() {
      if (!storage) {
        return {
          skipped: true,
          reason: 'Storage not enabled on this project (no storageBucket in Web SDK config).',
        };
      }
      await signInAnonymously(auth);
      const dir = RUN_STORAGE_PATH('listall', '');
      // Trailing slash → strip — we use the parent ref.
      const dirRef = storageRef(storage, dir.replace(/\/$/, ''));

      const childPaths = [
        `${dir}a.bin`,
        `${dir}b.bin`,
        `${dir}c.bin`,
        `${dir}sub/x.bin`,
      ];
      const childRefs = childPaths.map((p) => storageRef(storage, p));

      let uploadedAll = false;
      let itemPaths: string[] = [];
      let prefixPaths: string[] = [];
      let error: string | null = null;
      let code: string | null = null;
      try {
        for (let i = 0; i < childRefs.length; i++) {
          await uploadBytes(childRefs[i], new Uint8Array([i]));
        }
        uploadedAll = true;
        const result = await listAll(dirRef);
        itemPaths = result.items.map((it) => it.fullPath).sort();
        prefixPaths = result.prefixes.map((p) => p.fullPath).sort();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        code = (e as { code?: string }).code ?? null;
      } finally {
        for (const r of childRefs) {
          try { await deleteObject(r); } catch { /* ignored */ }
        }
        await dropCurrentUser();
      }
      return {
        uploadedAll,
        itemPaths,
        prefixPaths,
        itemCount: itemPaths.length,
        prefixCount: prefixPaths.length,
        threeDirectChildren: itemPaths.length === 3,
        oneSubPrefix: prefixPaths.length === 1,
        error,
        code,
      };
    },
  },
  {
    name: 'storage-update-metadata-roundtrip',
    matrixRow: 'storage #90',
    rowIds: ['storage#90'],
    description:
      'uploadBytes, then updateMetadata({customMetadata: {k: "v"}}), then getMetadata — verify the customMetadata survived and metageneration bumped.',
    async observe() {
      if (!storage) {
        return {
          skipped: true,
          reason: 'Storage not enabled on this project (no storageBucket in Web SDK config).',
        };
      }
      await signInAnonymously(auth);
      const path = RUN_STORAGE_PATH('update-md', 'has-md.bin');
      const ref = storageRef(storage, path);
      let uploadOk = false;
      let updateOk = false;
      let beforeCustom: Record<string, string> | null = null;
      let afterCustom: Record<string, string> | null = null;
      let metagenerationBefore: string | null = null;
      let metagenerationAfter: string | null = null;
      let error: string | null = null;
      let code: string | null = null;
      try {
        await uploadBytes(ref, new Uint8Array([7, 7, 7]), {
          contentType: 'application/octet-stream',
        });
        uploadOk = true;
        const mdBefore = await getMetadata(ref);
        beforeCustom = mdBefore.customMetadata ?? null;
        metagenerationBefore = mdBefore.metageneration;
        await updateMetadata(ref, {
          customMetadata: { conformance: 'storage-row-90', run: RUN_ID },
        });
        updateOk = true;
        const mdAfter = await getMetadata(ref);
        afterCustom = mdAfter.customMetadata ?? null;
        metagenerationAfter = mdAfter.metageneration;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        code = (e as { code?: string }).code ?? null;
      } finally {
        try { await deleteObject(ref); } catch { /* ignored */ }
        await dropCurrentUser();
      }
      return {
        uploadOk,
        updateOk,
        beforeCustom,
        afterCustom,
        customSurvived:
          afterCustom?.conformance === 'storage-row-90' &&
          afterCustom?.run === RUN_ID,
        metagenerationBefore,
        metagenerationAfter,
        metagenerationBumped:
          metagenerationBefore !== null &&
          metagenerationAfter !== null &&
          Number(metagenerationAfter) > Number(metagenerationBefore),
        error,
        code,
      };
    },
  },
  {
    name: 'storage-rules-denied-error-code',
    matrixRow: 'storage #105',
    rowIds: ['storage#105'],
    description:
      'Attempt to upload to a path the rules deny (deliberately outside pyric_oracle/* if the bucket rules scope writes to that namespace, or any path if rules default-deny). Capture error code + class.',
    async observe() {
      if (!storage) {
        return {
          skipped: true,
          reason: 'Storage not enabled on this project (no storageBucket in Web SDK config).',
        };
      }
      await signInAnonymously(auth);
      // Path outside pyric_oracle/* so the namespaced rule does NOT
      // grant access. Whether this is denied depends on the bucket's
      // current rules; if they default-allow, this observation
      // records the open-bucket reality.
      const path = `pyric_oracle_denied_storage/${RUN_ID}/forbidden.bin`;
      const ref = storageRef(storage, path);
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let errorName: string | null = null;
      let isFirebaseError = false;
      try {
        await uploadBytes(ref, new Uint8Array([0xff]));
      } catch (e) {
        threw = true;
        const err = e as { code?: string; message?: string; name?: string };
        code = err.code ?? null;
        message = err.message ?? null;
        errorName = err.name ?? null;
        isFirebaseError = err.name === 'FirebaseError';
      } finally {
        // Cleanup only if the upload somehow succeeded (rules open).
        if (!threw) {
          try { await deleteObject(ref); } catch { /* ignored */ }
        }
        await dropCurrentUser();
      }
      return {
        threw,
        code,
        message,
        errorName,
        isFirebaseError,
      };
    },
  },
  {
    name: 'rtdb-set-then-get-roundtrip',
    matrixRow: 'rtdb #16/#10',
    rowIds: ['rtdb#16', 'rtdb#10', 'rtdb-modular#M10', 'rtdb-modular#109', 'rtdb-modular#114'],
    description: 'Write a JSON value with set(), read back with get(), verify the round-trip. Locks the basic admin/user-mode write + read contract against the live service.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('roundtrip')}/value`;
      const payload = { hello: 'world', count: 42, ok: true };
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let readBack: unknown = undefined;
      try {
        await rtdbSet(rtdbRef(rtdb, path), payload);
        const snap = await rtdbGet(rtdbRef(rtdb, path));
        readBack = snap.val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        readBack,
        roundTripEqual: JSON.stringify(readBack) === JSON.stringify(payload),
      };
    },
  },
  {
    name: 'rtdb-onvalue-fires-on-set',
    matrixRow: 'rtdb #(listener behavior — oracle locks the upstream SDK shape)',
    rowIds: ['rtdb-modular#130'],
    description: 'Register an onValue listener at a path, perform a set(), observe the fire count. Locks the upstream firebase/database onValue semantics with real behavior evidence.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('onvalue')}/data`;
      const fires: Array<{ val: unknown; ts: number }> = [];
      const start = Date.now();
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let initialFires = 0;
      let firesAfterFirstSet = 0;
      let firesAfterSecondSet = 0;
      try {
        const unsub = rtdbOnValue(rtdbRef(rtdb, path), (snap) => {
          fires.push({ val: snap.val(), ts: Date.now() - start });
        });
        await new Promise((r) => setTimeout(r, 500));
        initialFires = fires.length;
        await rtdbSet(rtdbRef(rtdb, path), { v: 1 });
        await new Promise((r) => setTimeout(r, 500));
        firesAfterFirstSet = fires.length;
        await rtdbSet(rtdbRef(rtdb, path), { v: 2 });
        await new Promise((r) => setTimeout(r, 500));
        firesAfterSecondSet = fires.length;
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        initialFires,
        firesAfterFirstSet,
        firesAfterSecondSet,
        firstSetFires: firesAfterFirstSet - initialFires,
        secondSetFires: firesAfterSecondSet - firesAfterFirstSet,
        fires,
      };
    },
  },
  {
    name: 'rtdb-remove-vs-set-null',
    matrixRow: 'rtdb #18/#31',
    rowIds: ['rtdb#18', 'rtdb#31', 'rtdb-modular#M11', 'rtdb-modular#M12', 'rtdb-modular#121', 'rtdb-modular#123'],
    description: 'Confirm remove(ref) and set(ref, null) produce the same end state: a subsequent get() returns null in both cases. Locks the documented RTDB invariant that null-write and remove are equivalent.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const baseA = `${RTDB_RUN_PATH('null-vs-remove')}/a`;
      const baseB = `${RTDB_RUN_PATH('null-vs-remove')}/b`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let afterRemove: unknown = 'unset';
      let afterSetNull: unknown = 'unset';
      try {
        // Path A: set then remove
        await rtdbSet(rtdbRef(rtdb, baseA), { v: 1 });
        await rtdbRemove(rtdbRef(rtdb, baseA));
        afterRemove = (await rtdbGet(rtdbRef(rtdb, baseA))).val();
        // Path B: set then set-null
        await rtdbSet(rtdbRef(rtdb, baseB), { v: 1 });
        await rtdbSet(rtdbRef(rtdb, baseB), null);
        afterSetNull = (await rtdbGet(rtdbRef(rtdb, baseB))).val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        afterRemove,
        afterSetNull,
        bothNull: afterRemove === null && afterSetNull === null,
        equivalent: afterRemove === afterSetNull,
      };
    },
  },
  {
    name: 'rtdb-push-autoid-format',
    matrixRow: 'rtdb #27/#28',
    rowIds: ['rtdb#27', 'rtdb#28', 'rtdb-modular#M17', 'rtdb-modular#M70', 'rtdb-modular#124', 'rtdb-modular#125'],
    description: 'Call push(ref).key three times and capture the auto-id format: length, leading char, monotonicity. RTDB push IDs are documented as 20-char, dash-prefixed, timestamp-encoding, lexicographically sortable.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const listPath = `${RTDB_RUN_PATH('pushid')}`;
      const keys: string[] = [];
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      try {
        for (let i = 0; i < 3; i++) {
          const r = rtdbPush(rtdbRef(rtdb, listPath), { i });
          if (r.key) keys.push(r.key);
          // Tiny gap so the timestamp prefix can differ if it's per-ms.
          await new Promise((res) => setTimeout(res, 5));
        }
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, listPath)); } catch { /* best effort */ }
      await dropCurrentUser();
      const lengths = keys.map((k) => k.length);
      const startsWithDash = keys.map((k) => k.startsWith('-'));
      const sorted = [...keys].sort();
      return {
        threw,
        code,
        message,
        sampleKeys: keys,
        lengths,
        allLength20: lengths.every((l) => l === 20),
        allStartWithDash: startsWithDash.every(Boolean),
        monotonicallySorted: JSON.stringify(keys) === JSON.stringify(sorted),
      };
    },
  },
  {
    name: 'rtdb-servertimestamp-resolves',
    matrixRow: 'rtdb #(sentinel behavior — oracle locks the upstream SDK shape)',
    rowIds: ['rtdb-modular#M21', 'rtdb-modular#153', 'rtdb-modular#154'],
    description: 'Write a value containing serverTimestamp() as a field, read back, observe that the field resolved to a numeric millisecond timestamp (not the {".sv":"timestamp"} sentinel placeholder).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('servertimestamp')}/entry`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let readBack: unknown = undefined;
      try {
        await rtdbSet(rtdbRef(rtdb, path), { createdAt: rtdbServerTimestamp(), label: 'hello' });
        const snap = await rtdbGet(rtdbRef(rtdb, path));
        readBack = snap.val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      const createdAt = (readBack as { createdAt?: unknown } | null)?.createdAt;
      return {
        threw,
        code,
        message,
        readBack,
        createdAtType: typeof createdAt,
        createdAtIsNumber: typeof createdAt === 'number',
        createdAtSentinelShape:
          typeof createdAt === 'object' && createdAt !== null && '.sv' in (createdAt as object),
      };
    },
  },
  {
    name: 'rtdb-rules-denied-error-code',
    matrixRow: 'rtdb #15/#20',
    rowIds: ['rtdb#15', 'rtdb#20', 'rtdb#14', 'rtdb-modular#M23', 'rtdb-modular#M24', 'rtdb-modular#110', 'rtdb-modular#115'],
    description: 'Attempt a write to a path that RTDB rules deny (outside /pyric_oracle/*). Locks the FirebaseError code + message text the upstream firebase/database SDK emits for permission denial.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      // Deliberately outside the permissive namespace. Whatever the
      // project's default rules say will reject this; we capture the
      // error shape so the matrix row can cite it.
      const path = `/pyric_oracle_denied_namespace/denied-${RUN_ID}`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let errorName: string | null = null;
      let constructorName: string | null = null;
      let isErrorInstance = false;
      try {
        await rtdbSet(rtdbRef(rtdb, path), { x: 1 });
      } catch (e) {
        threw = true;
        const err = e as {
          code?: string;
          message?: string;
          name?: string;
          constructor?: { name?: string };
        };
        code = err.code ?? null;
        message = err.message ?? null;
        errorName = err.name ?? null;
        constructorName = err.constructor?.name ?? null;
        isErrorInstance = e instanceof Error;
      }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        errorName,
        constructorName,
        isErrorInstance,
      };
    },
  },
  // ─── Modular SDK probes (Phase 1 — lock prod behavior so the
  //     Phase 3 sandbox is correct by construction). Names use the
  //     `rtdb-modular-` prefix to keep them separable from the
  //     existing 6 RTDB probes which target the agent-tool surface.
  {
    name: 'rtdb-modular-get-snapshot-shape',
    matrixRow: 'rtdb-modular #106',
    rowIds: ['rtdb-modular#106', 'rtdb-modular#M71'],
    description: 'Lock the DataSnapshot shape returned by get(): val/exists/key/ref/size/hasChildren/hasChild/forEach all present. Modular SDK uses `size` getter (NOT `numChildren()` method — that was the legacy namespaced API).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-snap-shape')}/parent`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let shape: Record<string, unknown> = {};
      try {
        await rtdbSet(rtdbRef(rtdb, path), { a: 1, b: 2, c: 3 });
        const snap = await rtdbGet(rtdbRef(rtdb, path));
        const forEachKeys: string[] = [];
        snap.forEach((child) => {
          forEachKeys.push(child.key);
          return false; // continue
        });
        const s = snap as unknown as { numChildren?: () => number };
        shape = {
          hasVal: typeof snap.val === 'function',
          hasExists: typeof snap.exists === 'function',
          hasKey: 'key' in snap,
          hasRef: snap.ref !== undefined,
          hasSize: typeof snap.size === 'number',
          hasHasChildren: typeof snap.hasChildren === 'function',
          hasHasChild: typeof snap.hasChild === 'function',
          hasForEach: typeof snap.forEach === 'function',
          // numChildren() existed on the legacy namespaced API. Check it
          // here to lock whether the modular SDK exposes it for back-compat.
          hasNumChildren: typeof s.numChildren === 'function',
          size: snap.size,
          hasChildrenResult: snap.hasChildren(),
          existsResult: snap.exists(),
          val: snap.val(),
          forEachKeys,
          key: snap.key,
        };
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return { threw, code, message, ...shape };
    },
  },
  {
    name: 'rtdb-modular-get-missing-path',
    matrixRow: 'rtdb-modular #107/#108',
    rowIds: ['rtdb-modular#107', 'rtdb-modular#108'],
    description: 'get() on a nonexistent path — RTDB returns a snapshot with val()===null and exists()===false (NOT a thrown error, diverging from intuition that maps `getDoc` errors onto RTDB).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-missing')}/never-written`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let val: unknown = undefined;
      let exists: boolean | null = null;
      try {
        const snap = await rtdbGet(rtdbRef(rtdb, path));
        val = snap.val();
        exists = snap.exists();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await dropCurrentUser();
      return { threw, code, message, val, exists, valIsNull: val === null };
    },
  },
  {
    name: 'rtdb-modular-set-null-equals-remove',
    matrixRow: 'rtdb-modular #112',
    rowIds: ['rtdb-modular#112'],
    description: 'set(ref, null) — confirm the end state is identical to remove(ref): subsequent get() returns null. Companion to rtdb-remove-vs-set-null but scoped to the modular SDK set-null behavior alone.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-setnull')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let beforeExists: boolean | null = null;
      let afterExists: boolean | null = null;
      let afterVal: unknown = undefined;
      try {
        await rtdbSet(rtdbRef(rtdb, path), { a: 1 });
        beforeExists = (await rtdbGet(rtdbRef(rtdb, path))).exists();
        await rtdbSet(rtdbRef(rtdb, path), null);
        const snap = await rtdbGet(rtdbRef(rtdb, path));
        afterExists = snap.exists();
        afterVal = snap.val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        beforeExists,
        afterExists,
        afterVal,
        nullRemovesPath: beforeExists === true && afterExists === false && afterVal === null,
      };
    },
  },
  {
    name: 'rtdb-modular-set-replaces-not-merges',
    matrixRow: 'rtdb-modular #113',
    rowIds: ['rtdb-modular#113'],
    description: 'set(ref, {a:1}) after set(ref, {a:1, b:2}) — verify the second set REPLACES (final state is {a:1}, NOT a merge of {a:1, b:2}).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-replace')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let final: unknown = undefined;
      try {
        await rtdbSet(rtdbRef(rtdb, path), { a: 1, b: 2 });
        await rtdbSet(rtdbRef(rtdb, path), { a: 1 });
        final = (await rtdbGet(rtdbRef(rtdb, path))).val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      const finalKeys = final && typeof final === 'object' ? Object.keys(final as object) : [];
      return {
        threw,
        code,
        message,
        final,
        finalKeys,
        bIsAbsent: !finalKeys.includes('b'),
      };
    },
  },
  {
    name: 'rtdb-modular-update-merges-keys',
    matrixRow: 'rtdb-modular #116',
    rowIds: ['rtdb-modular#116'],
    description: 'update(ref, {a:10}) — verify partial merge: existing key `b` is preserved alongside the updated `a`.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-update-merge')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let final: unknown = undefined;
      try {
        await rtdbSet(rtdbRef(rtdb, path), { a: 1, b: 2 });
        await rtdbUpdate(rtdbRef(rtdb, path), { a: 10 });
        final = (await rtdbGet(rtdbRef(rtdb, path))).val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      const f = (final ?? {}) as Record<string, unknown>;
      return {
        threw,
        code,
        message,
        final,
        aUpdated: f.a === 10,
        bPreserved: f.b === 2,
      };
    },
  },
  {
    name: 'rtdb-modular-update-multipath-atomic',
    matrixRow: 'rtdb-modular #117',
    rowIds: ['rtdb-modular#117', 'rtdb#23'],
    description: 'Multi-path update — update(parentRef, {"a/x":1, "b/y":2}) — verify both subtrees land in a single call. The "fan-out" pattern is RTDB\'s most distinctive feature.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const parent = `${RTDB_RUN_PATH('mod-update-fanout')}`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let aX: unknown = undefined;
      let bY: unknown = undefined;
      try {
        await rtdbUpdate(rtdbRef(rtdb, parent), {
          'a/x': 1,
          'b/y': 2,
        });
        aX = (await rtdbGet(rtdbRef(rtdb, `${parent}/a/x`))).val();
        bY = (await rtdbGet(rtdbRef(rtdb, `${parent}/b/y`))).val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, parent)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        aX,
        bY,
        bothLanded: aX === 1 && bY === 2,
      };
    },
  },
  {
    name: 'rtdb-modular-update-multipath-rules-denial',
    matrixRow: 'rtdb-modular #118',
    rowIds: ['rtdb-modular#118'],
    description: 'Multi-path update where one path is denied by rules — confirm the WHOLE update rejects and neither path is written (atomicity contract).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const okPath = `${RTDB_RUN_PATH('mod-fanout-denied')}/ok`;
      // Deliberately outside pyric_oracle/* so the rules deny it.
      const deniedPath = `/pyric_oracle_denied_namespace/fanout-${RUN_ID}/denied`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      try {
        // The update fn takes a single root-or-parent ref; root makes
        // the absolute paths inside the values object unambiguous.
        await rtdbUpdate(rtdbRef(rtdb), {
          [okPath]: 1,
          [deniedPath]: 2,
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      // Check that the OK path is also unwritten (atomic rollback).
      let okExists: boolean | null = null;
      try {
        okExists = (await rtdbGet(rtdbRef(rtdb, okPath))).exists();
      } catch { /* if even the read fails, fall through with null */ }
      try { await rtdbRemove(rtdbRef(rtdb, okPath)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        okPathWrittenDespiteDenial: okExists,
        atomicRollback: okExists === false,
      };
    },
  },
  {
    name: 'rtdb-modular-update-null-removes-key',
    matrixRow: 'rtdb-modular #119',
    rowIds: ['rtdb-modular#119'],
    description: 'update(ref, {a: null}) removes key a — same null-equivalence as set(ref, null) but scoped to a single key inside a multi-key update.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-update-null')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let final: unknown = undefined;
      try {
        await rtdbSet(rtdbRef(rtdb, path), { a: 1, b: 2 });
        await rtdbUpdate(rtdbRef(rtdb, path), { a: null });
        final = (await rtdbGet(rtdbRef(rtdb, path))).val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      const finalKeys = final && typeof final === 'object' ? Object.keys(final as object) : [];
      return {
        threw,
        code,
        message,
        final,
        finalKeys,
        aRemoved: !finalKeys.includes('a'),
        bPreserved: finalKeys.includes('b'),
      };
    },
  },
  {
    name: 'rtdb-modular-remove-idempotent',
    matrixRow: 'rtdb-modular #122',
    rowIds: ['rtdb-modular#122', 'rtdb#32'],
    description: 'remove(ref) on an absent path — confirm it resolves successfully without throwing (idempotent).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-remove-absent')}/never-written`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let afterExists: boolean | null = null;
      try {
        // Don't set anything first — the path is already absent.
        await rtdbRemove(rtdbRef(rtdb, path));
        afterExists = (await rtdbGet(rtdbRef(rtdb, path))).exists();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        afterExists,
        idempotent: !threw && afterExists === false,
      };
    },
  },
  {
    name: 'rtdb-modular-push-with-value',
    matrixRow: 'rtdb-modular #126/#127',
    rowIds: ['rtdb-modular#126', 'rtdb-modular#127'],
    description: 'push(parent, value) — verify (a) the value is written under the new auto-id, (b) the returned ref is usable in follow-up ops.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const listPath = `${RTDB_RUN_PATH('mod-push-value')}`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let pushedKey: string | null = null;
      let readBackInitial: unknown = undefined;
      let readBackAfterSet: unknown = undefined;
      let readBackAfterRemove: unknown = undefined;
      try {
        const r = await rtdbPush(rtdbRef(rtdb, listPath), { hello: 'world' });
        pushedKey = r.key;
        readBackInitial = (await rtdbGet(r)).val();
        // Use the returned ref directly for a set
        await rtdbSet(r, { hello: 'again' });
        readBackAfterSet = (await rtdbGet(r)).val();
        // And a remove
        await rtdbRemove(r);
        readBackAfterRemove = (await rtdbGet(r)).val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, listPath)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        pushedKey,
        pushedKeyLength: pushedKey?.length ?? null,
        readBackInitial,
        readBackAfterSet,
        readBackAfterRemove,
        refIsUsableForFollowupOps:
          JSON.stringify(readBackInitial) === JSON.stringify({ hello: 'world' }) &&
          JSON.stringify(readBackAfterSet) === JSON.stringify({ hello: 'again' }) &&
          readBackAfterRemove === null,
      };
    },
  },
  {
    name: 'rtdb-modular-onvalue-initial-with-data',
    matrixRow: 'rtdb-modular #128',
    rowIds: ['rtdb-modular#128'],
    description: 'onValue on a path with existing data — observe the initial fire snapshot value.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onvalue-initial')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const fires: Array<{ val: unknown; ts: number }> = [];
      let initialFires = 0;
      try {
        await rtdbSet(rtdbRef(rtdb, path), { seeded: true });
        const start = Date.now();
        const unsub = rtdbOnValue(rtdbRef(rtdb, path), (snap) => {
          fires.push({ val: snap.val(), ts: Date.now() - start });
        });
        await new Promise((r) => setTimeout(r, 600));
        initialFires = fires.length;
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        initialFires,
        firstFire: fires[0] ?? null,
        firedExactlyOnceOnSubscribe: initialFires === 1,
      };
    },
  },
  {
    name: 'rtdb-modular-onvalue-initial-no-data',
    matrixRow: 'rtdb-modular #129',
    rowIds: ['rtdb-modular#129'],
    description: 'onValue on a NONEXISTENT path — does it fire at all? Locks the RTDB-vs-Firestore divergence: Firestore fires with exists=false; RTDB fires with val=null (or might not fire at all).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onvalue-empty')}/never-written`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const fires: Array<{ val: unknown; exists: boolean; ts: number }> = [];
      let initialFires = 0;
      try {
        const start = Date.now();
        const unsub = rtdbOnValue(rtdbRef(rtdb, path), (snap) => {
          fires.push({ val: snap.val(), exists: snap.exists(), ts: Date.now() - start });
        });
        await new Promise((r) => setTimeout(r, 600));
        initialFires = fires.length;
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        initialFires,
        firstFire: fires[0] ?? null,
        firedOnEmptyPath: initialFires >= 1,
        firstFireVal: fires[0]?.val ?? null,
        firstFireExists: fires[0]?.exists ?? null,
      };
    },
  },
  {
    name: 'rtdb-modular-onvalue-unsubscribe',
    matrixRow: 'rtdb-modular #131',
    rowIds: ['rtdb-modular#131'],
    description: 'Returned unsubscribe from onValue stops further fires — after unsub(), subsequent set() produces 0 additional fires.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onvalue-unsub')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const fires: number[] = [];
      let preUnsubFires = 0;
      let postUnsubFires = 0;
      try {
        const unsub = rtdbOnValue(rtdbRef(rtdb, path), () => { fires.push(Date.now()); });
        await new Promise((r) => setTimeout(r, 300));
        await rtdbSet(rtdbRef(rtdb, path), { v: 1 });
        await new Promise((r) => setTimeout(r, 300));
        preUnsubFires = fires.length;
        unsub();
        await rtdbSet(rtdbRef(rtdb, path), { v: 2 });
        await new Promise((r) => setTimeout(r, 500));
        postUnsubFires = fires.length;
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        preUnsubFires,
        postUnsubFires,
        unsubStopsFires: preUnsubFires === postUnsubFires,
      };
    },
  },
  {
    name: 'rtdb-modular-onchildadded-initial-replay',
    matrixRow: 'rtdb-modular #133',
    rowIds: ['rtdb-modular#133', 'rtdb-modular#M41'],
    description: 'onChildAdded replays existing children on subscribe — register listener AFTER seeding 3 children, observe 3 initial fires (one per existing key).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onchildadded')}/parent`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const firedKeys: string[] = [];
      let initialFires = 0;
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), { k1: { v: 1 }, k2: { v: 2 }, k3: { v: 3 } });
        const unsub = rtdbOnChildAdded(rtdbRef(rtdb, path), (snap) => {
          if (snap.key) firedKeys.push(snap.key);
        });
        await new Promise((r) => setTimeout(r, 700));
        initialFires = firedKeys.length;
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        initialFires,
        firedKeys,
        replayedExistingChildren: initialFires === 3,
      };
    },
  },
  {
    name: 'rtdb-modular-onchildadded-post-subscribe',
    matrixRow: 'rtdb-modular #134',
    rowIds: ['rtdb-modular#134', 'rtdb-modular#M42'],
    description: 'After subscribe, adding a NEW child fires onChildAdded exactly once for that key — seed 2 children, subscribe, then write a 3rd child via set(child, …).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onchildadded-post')}/parent`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const firedKeys: string[] = [];
      const firedVals: Array<{ key: string | null; val: unknown }> = [];
      let initialFires = 0;
      let postSubscribeFires = 0;
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), { k1: { v: 1 }, k2: { v: 2 } });
        const unsub = rtdbOnChildAdded(rtdbRef(rtdb, path), (snap) => {
          firedKeys.push(snap.key ?? '');
          firedVals.push({ key: snap.key, val: snap.val() });
        });
        await new Promise((r) => setTimeout(r, 500));
        initialFires = firedKeys.length;
        await rtdbSet(rtdbRef(rtdb, `${path}/k3`), { v: 3 });
        await new Promise((r) => setTimeout(r, 500));
        postSubscribeFires = firedKeys.length - initialFires;
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        initialFires,
        postSubscribeFires,
        firedKeys,
        lastFire: firedVals[firedVals.length - 1] ?? null,
        firesOncePerNewChild: postSubscribeFires === 1,
      };
    },
  },
  {
    name: 'rtdb-modular-onchildchanged-fires-on-update',
    matrixRow: 'rtdb-modular #135',
    rowIds: ['rtdb-modular#135', 'rtdb-modular#M43'],
    description: 'onChildChanged fires when an existing child is updated — write a child, subscribe, update the child, observe the fire (key + new val).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onchildchanged')}/parent`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const fires: Array<{ key: string | null; val: unknown }> = [];
      let firedOnInitial = 0;
      let firedOnUpdate = 0;
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), { k1: { v: 1 } });
        const unsub = rtdbOnChildChanged(rtdbRef(rtdb, path), (snap) => {
          fires.push({ key: snap.key, val: snap.val() });
        });
        await new Promise((r) => setTimeout(r, 400));
        firedOnInitial = fires.length;
        await rtdbSet(rtdbRef(rtdb, `${path}/k1`), { v: 2 });
        await new Promise((r) => setTimeout(r, 500));
        firedOnUpdate = fires.length - firedOnInitial;
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        firedOnInitial,
        firedOnUpdate,
        lastFire: fires[fires.length - 1] ?? null,
        noInitialReplay: firedOnInitial === 0,
        firesOnceOnUpdate: firedOnUpdate === 1,
      };
    },
  },
  {
    name: 'rtdb-modular-onchildremoved-fires-on-delete',
    matrixRow: 'rtdb-modular #136',
    rowIds: ['rtdb-modular#136', 'rtdb-modular#M45'],
    description: 'onChildRemoved fires when a child is deleted — seed 2 children, subscribe, remove one, observe the fire (key + the now-removed value).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onchildremoved')}/parent`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const fires: Array<{ key: string | null; val: unknown }> = [];
      let firedOnInitial = 0;
      let firedOnDelete = 0;
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), { k1: { v: 1 }, k2: { v: 2 } });
        const unsub = rtdbOnChildRemoved(rtdbRef(rtdb, path), (snap) => {
          fires.push({ key: snap.key, val: snap.val() });
        });
        await new Promise((r) => setTimeout(r, 400));
        firedOnInitial = fires.length;
        await rtdbRemove(rtdbRef(rtdb, `${path}/k1`));
        await new Promise((r) => setTimeout(r, 500));
        firedOnDelete = fires.length - firedOnInitial;
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        firedOnInitial,
        firedOnDelete,
        lastFire: fires[fires.length - 1] ?? null,
        noInitialReplay: firedOnInitial === 0,
        firesOnceOnDelete: firedOnDelete === 1,
        removedSnapCarriesPriorValue:
          (fires[fires.length - 1]?.val as { v?: number } | null)?.v === 1,
      };
    },
  },
  {
    name: 'rtdb-modular-onchildmoved-with-orderby',
    matrixRow: 'rtdb-modular #137',
    rowIds: ['rtdb-modular#137', 'rtdb-modular#M46'],
    description: 'onChildMoved fires when a child\'s ordering value changes — only emits under an ordered query. Seed 3 children with priorities, subscribe via query(ref, orderByChild("priority")), update one\'s priority so its sort position changes, observe the fire (or its absence).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onchildmoved')}/parent`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const fires: Array<{ key: string | null; val: unknown }> = [];
      let firedOnInitial = 0;
      let firedOnMove = 0;
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          k1: { priority: 1 },
          k2: { priority: 2 },
          k3: { priority: 3 },
        });
        const q = rtdbQuery(rtdbRef(rtdb, path), rtdbOrderByChild('priority'));
        const unsub = rtdbOnChildMoved(q, (snap) => {
          fires.push({ key: snap.key, val: snap.val() });
        });
        await new Promise((r) => setTimeout(r, 500));
        firedOnInitial = fires.length;
        // Bump k1's priority above k3 so it moves to the end.
        await rtdbSet(rtdbRef(rtdb, `${path}/k1/priority`), 10);
        await new Promise((r) => setTimeout(r, 700));
        firedOnMove = fires.length - firedOnInitial;
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        firedOnInitial,
        firedOnMove,
        lastFire: fires[fires.length - 1] ?? null,
        noInitialReplay: firedOnInitial === 0,
        firesOnReorder: firedOnMove >= 1,
      };
    },
  },
  {
    name: 'rtdb-modular-onchildmoved-previouschildname-sequencing',
    matrixRow: 'rtdb-modular #137',
    rowIds: ['rtdb-modular#137'],
    description: 'onChildMoved previousChildName (2nd callback arg) sequencing under query(ref, orderByChild("priority")). Seeds k1/k2/k3 (priority 1/2/3, sorted k1,k2,k3), then reorders k1 to the END, then the MIDDLE, then the FRONT — capturing previousChildName for each move (end → follows k3; middle → follows k2; front → null). Lifts the held previousChildName unknown from docs/reviews/deep-divergence-review.md item 2. rowIds are [] pending the registry-admission ticket, which lands the rows.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onchildmoved-prevname')}/parent`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const moves: Array<{ key: string | null; previousChildName: string | null }> = [];
      let firedOnInitial = 0;
      let moveToEnd: { key: string | null; previousChildName: string | null } | null = null;
      let moveToMiddle: { key: string | null; previousChildName: string | null } | null = null;
      let moveToFront: { key: string | null; previousChildName: string | null } | null = null;
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          k1: { priority: 1 },
          k2: { priority: 2 },
          k3: { priority: 3 },
        });
        const q = rtdbQuery(rtdbRef(rtdb, path), rtdbOrderByChild('priority'));
        const unsub = rtdbOnChildMoved(q, (snap, previousChildName) => {
          moves.push({ key: snap.key, previousChildName: previousChildName ?? null });
        });
        await new Promise((r) => setTimeout(r, 500));
        firedOnInitial = moves.length;
        // Pattern 1 — move k1 to the END (priority above k3). New order:
        // k2, k3, k1 → k1 now follows k3, so previousChildName should be 'k3'.
        await rtdbSet(rtdbRef(rtdb, `${path}/k1/priority`), 10);
        await new Promise((r) => setTimeout(r, 600));
        moveToEnd = moves[moves.length - 1] ?? null;
        // Pattern 2 — move k1 to the MIDDLE (between k2 and k3). New order:
        // k2, k1, k3 → k1 now follows k2, so previousChildName should be 'k2'.
        await rtdbSet(rtdbRef(rtdb, `${path}/k1/priority`), 2.5);
        await new Promise((r) => setTimeout(r, 600));
        moveToMiddle = moves[moves.length - 1] ?? null;
        // Pattern 3 — move k1 to the FRONT (priority below k2). New order:
        // k1, k2, k3 → k1 is first, so previousChildName should be null.
        await rtdbSet(rtdbRef(rtdb, `${path}/k1/priority`), 0);
        await new Promise((r) => setTimeout(r, 600));
        moveToFront = moves[moves.length - 1] ?? null;
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        firedOnInitial,
        noInitialReplay: firedOnInitial === 0,
        moveToEnd,
        moveToMiddle,
        moveToFront,
        totalMoves: moves.length - firedOnInitial,
        // Environment-independent shape facts: the ordered sequence of
        // previousChildName values and moved keys across the 3 reorders.
        prevNameSequence: moves.slice(firedOnInitial).map((m) => m.previousChildName),
        movedKeySequence: moves.slice(firedOnInitial).map((m) => m.key),
        endMovePrevIsK3: moveToEnd?.previousChildName === 'k3',
        middleMovePrevIsK2: moveToMiddle?.previousChildName === 'k2',
        frontMovePrevIsNull: moveToFront != null && moveToFront.previousChildName === null,
      };
    },
  },
  {
    name: 'rtdb-modular-childchanged-cofire-with-childmoved',
    matrixRow: 'rtdb-modular #137',
    rowIds: ['rtdb-modular#137'],
    description: 'Whether onChildChanged co-fires with onChildMoved on a reorder. Under query(ref, orderByChild("score")) with children a/b/c (score 10/20/30), subscribe BOTH listeners and record which fire for three mutation kinds: (1) a change to the ordered field that moves sort position (value-change-that-reorders: b.score 20→40), (2) a change to a NON-ordered sibling field (pure value change, no reorder: a.label), (3) a change to the ordered field that does NOT change rank (value/priority change without a move: c.score 30→35). Answers co-fire and how a reordering value change differs from a priority-only / non-reordering change. See docs/reviews/deep-divergence-review.md item 2. rowIds are [] pending the registry-admission ticket, which lands the rows.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-childchanged-cofire')}/parent`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const changed: Array<{ key: string | null; val: unknown }> = [];
      const moved: Array<{ key: string | null; previousChildName: string | null }> = [];
      let reorderChanged = 0;
      let reorderMoved = 0;
      let nonOrderChanged = 0;
      let nonOrderMoved = 0;
      let sameRankChanged = 0;
      let sameRankMoved = 0;
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          a: { score: 10, label: 'a0' },
          b: { score: 20, label: 'b0' },
          c: { score: 30, label: 'c0' },
        });
        const q = rtdbQuery(rtdbRef(rtdb, path), rtdbOrderByChild('score'));
        const unsubChanged = rtdbOnChildChanged(q, (snap) => {
          changed.push({ key: snap.key, val: snap.val() });
        });
        const unsubMoved = rtdbOnChildMoved(q, (snap, previousChildName) => {
          moved.push({ key: snap.key, previousChildName: previousChildName ?? null });
        });
        await new Promise((r) => setTimeout(r, 500));
        let c0 = changed.length;
        let m0 = moved.length;
        // (1) Reordering value change: b.score 20 → 40. Order a,b,c → a,c,b.
        await rtdbSet(rtdbRef(rtdb, `${path}/b/score`), 40);
        await new Promise((r) => setTimeout(r, 600));
        reorderChanged = changed.length - c0;
        reorderMoved = moved.length - m0;
        c0 = changed.length;
        m0 = moved.length;
        // (2) Non-ordered field change: a.label → 'a1'. a.score stays 10
        // (front), so no reorder — isolates whether child_changed alone fires.
        await rtdbSet(rtdbRef(rtdb, `${path}/a/label`), 'a1');
        await new Promise((r) => setTimeout(r, 600));
        nonOrderChanged = changed.length - c0;
        nonOrderMoved = moved.length - m0;
        c0 = changed.length;
        m0 = moved.length;
        // (3) Ordered field change WITHOUT a rank change: c.score 30 → 35.
        // Current order is a(10), c(30), b(40); c→35 keeps c in the middle.
        await rtdbSet(rtdbRef(rtdb, `${path}/c/score`), 35);
        await new Promise((r) => setTimeout(r, 600));
        sameRankChanged = changed.length - c0;
        sameRankMoved = moved.length - m0;
        unsubChanged();
        unsubMoved();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        reorderChanged,
        reorderMoved,
        nonOrderChanged,
        nonOrderMoved,
        sameRankChanged,
        sameRankMoved,
        // Shape facts answering the review's two questions:
        childChangedCoFiresWithChildMoved: reorderChanged >= 1 && reorderMoved >= 1,
        reorderFiresChildMoved: reorderMoved >= 1,
        nonOrderFieldFiresChildMovedZero: nonOrderMoved === 0,
        nonOrderFieldFiresChildChanged: nonOrderChanged >= 1,
        sameRankFiresChildMovedZero: sameRankMoved === 0,
        sameRankFiresChildChanged: sameRankChanged >= 1,
        lastChanged: changed[changed.length - 1] ?? null,
        lastMoved: moved[moved.length - 1] ?? null,
      };
    },
  },
  {
    name: 'rtdb-modular-off-stops-child-fires',
    matrixRow: 'rtdb-modular #138/#139',
    rowIds: ['rtdb-modular#138', 'rtdb-modular#139', 'rtdb-modular#M47'],
    description: 'off(ref) (no eventType) removes ALL listeners at the ref — register onChildAdded, call off(ref), then write a NEW child; verify zero additional fires.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-off-child')}/parent`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const firedKeys: string[] = [];
      let preOffFires = 0;
      let postOffFires = 0;
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), { k1: { v: 1 } });
        rtdbOnChildAdded(rtdbRef(rtdb, path), (snap) => {
          if (snap.key) firedKeys.push(snap.key);
        });
        await new Promise((r) => setTimeout(r, 400));
        preOffFires = firedKeys.length;
        // off(ref) with no eventType — removes ALL listeners.
        rtdbOff(rtdbRef(rtdb, path));
        await rtdbSet(rtdbRef(rtdb, `${path}/k2`), { v: 2 });
        await new Promise((r) => setTimeout(r, 500));
        postOffFires = firedKeys.length - preOffFires;
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        preOffFires,
        postOffFires,
        firedKeys,
        offStopsFires: postOffFires === 0,
      };
    },
  },
  {
    name: 'rtdb-modular-query-orderbychild-limit',
    matrixRow: 'rtdb-modular #142/#150',
    rowIds: ['rtdb-modular#142', 'rtdb-modular#150'],
    description: 'query(ref, orderByChild("pos"), limitToFirst(2)) — verify the result window respects both ordering and limit.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-query-orderby-limit')}/list`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const orderedKeys: Array<{ key: string; pos: number }> = [];
      try {
        // Seed 4 children with positions 1..4 in random insertion order.
        await rtdbUpdate(rtdbRef(rtdb, path), {
          c: { pos: 3 },
          a: { pos: 1 },
          d: { pos: 4 },
          b: { pos: 2 },
        });
        const q = rtdbQuery(rtdbRef(rtdb, path), rtdbOrderByChild('pos'), rtdbLimitToFirst(2));
        const snap = await rtdbGet(q);
        snap.forEach((child) => {
          const v = child.val() as { pos: number } | null;
          orderedKeys.push({ key: child.key ?? '', pos: v?.pos ?? -1 });
          return false;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      const positions = orderedKeys.map((k) => k.pos);
      return {
        threw,
        code,
        message,
        orderedKeys,
        positions,
        twoResults: orderedKeys.length === 2,
        firstTwoInOrder: JSON.stringify(positions) === JSON.stringify([1, 2]),
      };
    },
  },
  {
    name: 'rtdb-modular-query-equalto',
    matrixRow: 'rtdb-modular #145',
    rowIds: ['rtdb-modular#145'],
    description: 'query(ref, orderByChild("group"), equalTo("blue")) — verify equalTo filters to matching children only.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-query-equalto')}/list`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const matchedKeys: string[] = [];
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          k1: { group: 'red' },
          k2: { group: 'blue' },
          k3: { group: 'blue' },
          k4: { group: 'green' },
        });
        const q = rtdbQuery(rtdbRef(rtdb, path), rtdbOrderByChild('group'), rtdbEqualTo('blue'));
        const snap = await rtdbGet(q);
        snap.forEach((child) => {
          if (child.key) matchedKeys.push(child.key);
          return false;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        matchedKeys: matchedKeys.sort(),
        onlyBlueMatched:
          matchedKeys.length === 2 &&
          matchedKeys.includes('k2') &&
          matchedKeys.includes('k3'),
      };
    },
  },
  {
    name: 'rtdb-modular-query-startat-inclusive',
    matrixRow: 'rtdb-modular #146',
    rowIds: ['rtdb-modular#146'],
    description: 'query(ref, orderByChild("pos"), startAt(2)) — verify the cursor is INCLUSIVE (child with pos===2 is in the result).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-query-startat')}/list`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const matched: number[] = [];
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          a: { pos: 1 },
          b: { pos: 2 },
          c: { pos: 3 },
          d: { pos: 4 },
        });
        const q = rtdbQuery(rtdbRef(rtdb, path), rtdbOrderByChild('pos'), rtdbStartAt(2));
        const snap = await rtdbGet(q);
        snap.forEach((child) => {
          const v = child.val() as { pos: number } | null;
          if (v) matched.push(v.pos);
          return false;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        matched,
        cursorInclusive: JSON.stringify(matched) === JSON.stringify([2, 3, 4]),
      };
    },
  },
  {
    name: 'rtdb-modular-orderbychild-window',
    matrixRow: 'rtdb-modular #142/#146/#147',
    rowIds: ['rtdb-modular#142', 'rtdb-modular#146', 'rtdb-modular#147', 'rtdb-modular#M49'],
    description: 'query(ref, orderByChild("pos"), startAt(2), endAt(4)) — seed 5 children with pos 1..5; observe windowed matched keys + ordered positions.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-orderbychild-window')}/list`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const matchedKeys: string[] = [];
      const positions: number[] = [];
      try {
        // Seed with shuffled insertion order so we observe ordering not insertion.
        await rtdbUpdate(rtdbRef(rtdb, path), {
          c: { pos: 3 },
          a: { pos: 1 },
          e: { pos: 5 },
          b: { pos: 2 },
          d: { pos: 4 },
        });
        const q = rtdbQuery(
          rtdbRef(rtdb, path),
          rtdbOrderByChild('pos'),
          rtdbStartAt(2),
          rtdbEndAt(4),
        );
        const snap = await rtdbGet(q);
        snap.forEach((child) => {
          if (child.key) matchedKeys.push(child.key);
          const v = child.val() as { pos: number } | null;
          if (v) positions.push(v.pos);
          return false;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        matchedKeys,
        positions,
        bothEndsInclusive: JSON.stringify(positions) === JSON.stringify([2, 3, 4]),
      };
    },
  },
  {
    name: 'rtdb-modular-orderbykey-window',
    matrixRow: 'rtdb-modular #143/#146/#147',
    rowIds: ['rtdb-modular#143', 'rtdb-modular#146', 'rtdb-modular#147'],
    description: 'query(ref, orderByKey(), startAt("b"), endAt("d")) — seed children with keys a..e; observe windowed matched keys in key order.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-orderbykey-window')}/list`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const matchedKeys: string[] = [];
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          c: 3,
          a: 1,
          e: 5,
          b: 2,
          d: 4,
        });
        const q = rtdbQuery(
          rtdbRef(rtdb, path),
          rtdbOrderByKey(),
          rtdbStartAt('b'),
          rtdbEndAt('d'),
        );
        const snap = await rtdbGet(q);
        snap.forEach((child) => {
          if (child.key) matchedKeys.push(child.key);
          return false;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        matchedKeys,
        windowInKeyOrder: JSON.stringify(matchedKeys) === JSON.stringify(['b', 'c', 'd']),
      };
    },
  },
  {
    name: 'rtdb-modular-orderbyvalue-numeric',
    matrixRow: 'rtdb-modular #144/#150',
    rowIds: ['rtdb-modular#144', 'rtdb-modular#150', 'rtdb-modular#M51'],
    description: 'query(ref, orderByValue(), limitToFirst(3)) over primitive numeric children — observe first 3 by ascending value.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-orderbyvalue')}/scores`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const matchedKeys: string[] = [];
      const values: number[] = [];
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          alice: 30,
          bob: 10,
          carol: 50,
          dave: 20,
          eve: 40,
        });
        const q = rtdbQuery(
          rtdbRef(rtdb, path),
          rtdbOrderByValue(),
          rtdbLimitToFirst(3),
        );
        const snap = await rtdbGet(q);
        snap.forEach((child) => {
          if (child.key) matchedKeys.push(child.key);
          const v = child.val();
          if (typeof v === 'number') values.push(v);
          return false;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        matchedKeys,
        values,
        ascendingFirstThree: JSON.stringify(values) === JSON.stringify([10, 20, 30]),
      };
    },
  },
  {
    name: 'rtdb-modular-equalTo-filter',
    matrixRow: 'rtdb-modular #145',
    rowIds: ['rtdb-modular#145', 'rtdb-modular#M52'],
    description: 'query(ref, orderByChild("group"), equalTo("b")) — seed children with group "a"|"b"|"c"; verify only "b" children come back.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-equalto-filter')}/list`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const matchedKeys: string[] = [];
      const groups: string[] = [];
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          k1: { group: 'a' },
          k2: { group: 'b' },
          k3: { group: 'c' },
          k4: { group: 'b' },
          k5: { group: 'a' },
        });
        const q = rtdbQuery(
          rtdbRef(rtdb, path),
          rtdbOrderByChild('group'),
          rtdbEqualTo('b'),
        );
        const snap = await rtdbGet(q);
        snap.forEach((child) => {
          if (child.key) matchedKeys.push(child.key);
          const v = child.val() as { group: string } | null;
          if (v) groups.push(v.group);
          return false;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        matchedKeys: matchedKeys.sort(),
        groups,
        onlyBMatched:
          matchedKeys.length === 2 &&
          matchedKeys.includes('k2') &&
          matchedKeys.includes('k4'),
      };
    },
  },
  {
    name: 'rtdb-modular-limittofirst-vs-limittolast',
    matrixRow: 'rtdb-modular #150/#151',
    rowIds: ['rtdb-modular#150', 'rtdb-modular#151', 'rtdb-modular#M54', 'rtdb-modular#M55'],
    description: 'Compare limitToFirst(2) vs limitToLast(2) on the same orderByChild query — observe which children land in each window.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-limit-first-vs-last')}/list`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const firstKeys: string[] = [];
      const firstPositions: number[] = [];
      const lastKeys: string[] = [];
      const lastPositions: number[] = [];
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          c: { pos: 3 },
          a: { pos: 1 },
          e: { pos: 5 },
          b: { pos: 2 },
          d: { pos: 4 },
        });
        const qFirst = rtdbQuery(rtdbRef(rtdb, path), rtdbOrderByChild('pos'), rtdbLimitToFirst(2));
        const qLast = rtdbQuery(rtdbRef(rtdb, path), rtdbOrderByChild('pos'), rtdbLimitToLast(2));
        const sFirst = await rtdbGet(qFirst);
        sFirst.forEach((child) => {
          if (child.key) firstKeys.push(child.key);
          const v = child.val() as { pos: number } | null;
          if (v) firstPositions.push(v.pos);
          return false;
        });
        const sLast = await rtdbGet(qLast);
        sLast.forEach((child) => {
          if (child.key) lastKeys.push(child.key);
          const v = child.val() as { pos: number } | null;
          if (v) lastPositions.push(v.pos);
          return false;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        firstKeys,
        firstPositions,
        lastKeys,
        lastPositions,
        firstTakesLowest: JSON.stringify(firstPositions) === JSON.stringify([1, 2]),
        lastTakesHighest: JSON.stringify(lastPositions) === JSON.stringify([4, 5]),
      };
    },
  },
  {
    name: 'rtdb-modular-startafter-endbefore-exclusive',
    matrixRow: 'rtdb-modular #148/#149',
    rowIds: ['rtdb-modular#148', 'rtdb-modular#149', 'rtdb-modular#M57'],
    description: 'query(ref, orderByChild("pos"), startAfter(2), endBefore(5)) — verify startAfter + endBefore are EXCLUSIVE (the cursor positions are dropped).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-startafter-endbefore')}/list`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const matchedKeys: string[] = [];
      const positions: number[] = [];
      try {
        await rtdbUpdate(rtdbRef(rtdb, path), {
          a: { pos: 1 },
          b: { pos: 2 },
          c: { pos: 3 },
          d: { pos: 4 },
          e: { pos: 5 },
        });
        const q = rtdbQuery(
          rtdbRef(rtdb, path),
          rtdbOrderByChild('pos'),
          rtdbStartAfter(2),
          rtdbEndBefore(5),
        );
        const snap = await rtdbGet(q);
        snap.forEach((child) => {
          if (child.key) matchedKeys.push(child.key);
          const v = child.val() as { pos: number } | null;
          if (v) positions.push(v.pos);
          return false;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        matchedKeys,
        positions,
        bothExclusive: JSON.stringify(positions) === JSON.stringify([3, 4]),
      };
    },
  },
  {
    name: 'rtdb-modular-onvalue-with-query',
    matrixRow: 'rtdb-modular #152',
    rowIds: ['rtdb-modular#152', 'rtdb-modular#M58'],
    description: 'onValue(query(ref, orderByChild("pos"), limitToFirst(2))) — does the listener fire only when the windowed result changes, or on every parent write?',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-onvalue-with-query')}/list`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const fires: Array<{ keys: string[]; positions: number[] }> = [];
      try {
        // Seed with 3 children; window will be the first 2 by pos.
        await rtdbUpdate(rtdbRef(rtdb, path), {
          a: { pos: 1 },
          b: { pos: 2 },
          c: { pos: 3 },
        });
        const q = rtdbQuery(
          rtdbRef(rtdb, path),
          rtdbOrderByChild('pos'),
          rtdbLimitToFirst(2),
        );
        let resolveAll: () => void = () => {};
        const done = new Promise<void>((r) => { resolveAll = r; });
        const unsub = rtdbOnValue(q, (snap) => {
          const ks: string[] = [];
          const ps: number[] = [];
          snap.forEach((c) => {
            if (c.key) ks.push(c.key);
            const v = c.val() as { pos: number } | null;
            if (v) ps.push(v.pos);
            return false;
          });
          fires.push({ keys: ks, positions: ps });
          if (fires.length >= 4) resolveAll();
        });
        // Initial fire is one. Now:
        //   1) Write to child 'c' (pos=3) — OUTSIDE the window. Should NOT fire again.
        //   2) Write to child 'a' (pos=1) — INSIDE the window, changed. Should fire.
        //   3) Push a new child with pos=0 — enters the window, displacing 'b'. Should fire.
        await rtdbSet(rtdbRef(rtdb, `${path}/c/extra`), 1);
        await rtdbSet(rtdbRef(rtdb, `${path}/a`), { pos: 1, label: 'A!' });
        await rtdbSet(rtdbRef(rtdb, `${path}/z`), { pos: 0 });
        // Race vs the 'done' promise so we don't hang if fewer fires happen.
        await Promise.race([
          done,
          new Promise<void>((r) => setTimeout(r, 1500)),
        ]);
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        fireCount: fires.length,
        fires,
      };
    },
  },
  {
    name: 'rtdb-modular-increment-from-missing',
    matrixRow: 'rtdb-modular #155/#156',
    rowIds: ['rtdb-modular#155', 'rtdb-modular#156'],
    description: 'increment(n) against a missing field starts at 0; subsequent increments accumulate (positive then negative deltas).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-increment')}/counter`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let afterFirst: unknown = undefined;
      let afterSecond: unknown = undefined;
      let afterNegative: unknown = undefined;
      try {
        // Field doesn't exist yet — increment(5) should land as 5.
        await rtdbUpdate(rtdbRef(rtdb, path), { count: rtdbIncrement(5) });
        afterFirst = (await rtdbGet(rtdbRef(rtdb, `${path}/count`))).val();
        await rtdbUpdate(rtdbRef(rtdb, path), { count: rtdbIncrement(3) });
        afterSecond = (await rtdbGet(rtdbRef(rtdb, `${path}/count`))).val();
        await rtdbUpdate(rtdbRef(rtdb, path), { count: rtdbIncrement(-2) });
        afterNegative = (await rtdbGet(rtdbRef(rtdb, `${path}/count`))).val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        afterFirst,
        afterSecond,
        afterNegative,
        startsFromZero: afterFirst === 5,
        accumulates: afterFirst === 5 && afterSecond === 8 && afterNegative === 6,
      };
    },
  },
  {
    name: 'rtdb-modular-runtransaction-success',
    matrixRow: 'rtdb-modular #158/#160/#162',
    rowIds: ['rtdb-modular#158', 'rtdb-modular#160', 'rtdb-modular#162', 'rtdb-modular#M37'],
    description: 'Basic runTransaction success — current value is null on first call, fn returns the new value, result.committed === true, result.snapshot.val() is the committed value.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-tx-success')}/counter`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const seenCurrentValues: Array<unknown> = [];
      let committed: boolean | null = null;
      let snapVal: unknown = undefined;
      try {
        const result = await rtdbRunTransaction(rtdbRef(rtdb, path), (current) => {
          seenCurrentValues.push(current);
          return (typeof current === 'number' ? current : 0) + 1;
        });
        committed = result.committed;
        snapVal = result.snapshot.val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        seenCurrentValues,
        committed,
        snapVal,
        firstCurrentWasNull: seenCurrentValues[0] === null,
        committedNewValue: committed === true && snapVal === 1,
      };
    },
  },
  {
    name: 'rtdb-modular-runtransaction-abort-undefined',
    matrixRow: 'rtdb-modular #159',
    rowIds: ['rtdb-modular#159', 'rtdb-modular#M37a'],
    description: 'runTransaction abort by returning undefined — RTDB-specific: returning `undefined` from the update fn aborts. result.committed === false, no write performed.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-tx-abort')}/counter`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let committed: boolean | null = null;
      let snapVal: unknown = undefined;
      let afterValOnServer: unknown = undefined;
      try {
        // Seed an existing value so we can tell if the abort wrote.
        await rtdbSet(rtdbRef(rtdb, path), 100);
        const result = await rtdbRunTransaction(rtdbRef(rtdb, path), () => {
          return undefined; // abort
        });
        committed = result.committed;
        snapVal = result.snapshot.val();
        afterValOnServer = (await rtdbGet(rtdbRef(rtdb, path))).val();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        committed,
        snapVal,
        afterValOnServer,
        abortedAndPreservedValue:
          committed === false && afterValOnServer === 100,
      };
    },
  },
  {
    name: 'rtdb-modular-runtransaction-current-value-arg',
    matrixRow: 'rtdb-modular #160',
    rowIds: ['rtdb-modular#160', 'rtdb-modular#M37b'],
    description: 'runTransaction update fn — what shape does `current` arrive as when the path does not exist? Locks the null-vs-undefined question for empty paths AND records the existing-value shape for a seeded path so the sandbox round-trips the right type.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const missingPath = `${RTDB_RUN_PATH('mod-tx-curr-missing')}/v`;
      const seededPath = `${RTDB_RUN_PATH('mod-tx-curr-seeded')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      // Capture each `current` arg + a JS-typeof so we can tell `null`
      // from `undefined` from `0` etc. unambiguously even after JSON-
      // round-tripping the observation.
      const missingArgs: Array<{ raw: unknown; type: string; isNull: boolean; isUndefined: boolean }> = [];
      const seededArgs: Array<{ raw: unknown; type: string; isNull: boolean; isUndefined: boolean }> = [];
      try {
        // Missing path — current should be null (RTDB's "absent" shape).
        await rtdbRunTransaction(rtdbRef(rtdb, missingPath), (current) => {
          missingArgs.push({
            raw: current,
            type: typeof current,
            isNull: current === null,
            isUndefined: current === undefined,
          });
          return 1;
        });
        // Seeded path — current should arrive as the seeded value.
        await rtdbSet(rtdbRef(rtdb, seededPath), { name: 'alice', count: 7 });
        await rtdbRunTransaction(rtdbRef(rtdb, seededPath), (current) => {
          seededArgs.push({
            raw: current,
            type: typeof current,
            isNull: current === null,
            isUndefined: current === undefined,
          });
          // No abort — bump count so the call commits and we exercise the
          // happy path alongside the arg-shape capture.
          if (current && typeof current === 'object' && !Array.isArray(current)) {
            const c = current as { name: string; count: number };
            return { ...c, count: c.count + 1 };
          }
          return current;
        });
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, missingPath)); } catch { /* best effort */ }
      try { await rtdbRemove(rtdbRef(rtdb, seededPath)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        missingArgs,
        seededArgs,
        // First invocation on a missing path: prod's documented
        // behavior says `null`. The harness pins it empirically.
        missingFirstWasNull: missingArgs[0]?.isNull === true,
        missingFirstWasUndefined: missingArgs[0]?.isUndefined === true,
        // First invocation on a seeded path: prod typically delivers
        // the existing value directly (no speculative null call first).
        seededFirstShape: seededArgs[0]?.type ?? null,
      };
    },
  },
  {
    name: 'rtdb-modular-runtransaction-warm-client-speculation',
    matrixRow: 'rtdb-modular #160',
    rowIds: ['rtdb-modular#160', 'rtdb-modular#M37'],
    description: 'Warm-client runTransaction speculation. Seeds a path, then WARMS the client cache — attaches an onValue listener and awaits its initial fire, plus a direct get() — BEFORE running runTransaction on that same warmed path. Captures every `current` arg (type + isNull + whether it carries the seeded keys) to answer whether a warmed client still speculatively invokes the update fn with `null` first (the cold-cache double-call) or invokes exactly once with the cached value. Directly probes the uncaptured warm-client case flagged in docs/reviews/deep-divergence-review.md item 4 (is the cold-cache double-invoke a stable contract or an artifact?). rowIds are [] pending the registry-admission ticket, which lands the rows.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-tx-warm')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      // Each `current` arg reduced to shape facts (never raw env values).
      const warmArgs: Array<{ type: string; isNull: boolean; isUndefined: boolean; hasSeededKeys: boolean }> = [];
      let initialFires = 0;
      try {
        await rtdbSet(rtdbRef(rtdb, path), { count: 7, name: 'alice' });
        // Warm the client cache: subscribe and wait for the initial fire so
        // the client holds the current value locally before the transaction.
        const unsub = rtdbOnValue(rtdbRef(rtdb, path), () => {
          initialFires++;
        });
        await new Promise((r) => setTimeout(r, 500));
        // Force a direct read into the cache as well.
        await rtdbGet(rtdbRef(rtdb, path));
        await new Promise((r) => setTimeout(r, 200));
        // Transact on the now-warmed path; record the shape of each invocation.
        await rtdbRunTransaction(rtdbRef(rtdb, path), (current) => {
          warmArgs.push({
            type: typeof current,
            isNull: current === null,
            isUndefined: current === undefined,
            hasSeededKeys:
              !!current &&
              typeof current === 'object' &&
              !Array.isArray(current) &&
              'count' in (current as Record<string, unknown>),
          });
          if (current && typeof current === 'object' && !Array.isArray(current)) {
            const c = current as { name: string; count: number };
            return { ...c, count: c.count + 1 };
          }
          return current;
        });
        unsub();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        initialFires,
        warmClientWasListening: initialFires >= 1,
        invocationCount: warmArgs.length,
        firstArgType: warmArgs[0]?.type ?? null,
        firstArgWasNull: warmArgs[0]?.isNull ?? null,
        // The two competing hypotheses from review item 4, as shape facts:
        speculativeNullFirstEvenWhenWarm: warmArgs.length > 1 && warmArgs[0]?.isNull === true,
        singleInvocationWithCachedValue: warmArgs.length === 1 && warmArgs[0]?.hasSeededKeys === true,
        warmArgs,
      };
    },
  },
  {
    name: 'rtdb-modular-runtransaction-returns-committed-snapshot',
    matrixRow: 'rtdb-modular #162',
    rowIds: ['rtdb-modular#162'],
    description: 'runTransaction success — the resolved value is `{ committed: boolean, snapshot: DataSnapshot }`. Lock the resolved snapshot.val() against the actual committed value (not the seed value, not the update-fn return value). Pin the shape (`committed` is a boolean primitive, `snapshot` is an object that responds to .val()/.exists()/.key).',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('mod-tx-result-snap')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let resultKeys: string[] = [];
      let committed: boolean | null = null;
      let committedType: string | null = null;
      let snapVal: unknown = undefined;
      let snapExists: boolean | null = null;
      let snapKey: string | null = null;
      let hasSnapshotProp = false;
      let snapshotValIsFn = false;
      try {
        // Seed an initial value so we can verify the result reflects
        // the committed (new) value rather than the pre-existing one.
        await rtdbSet(rtdbRef(rtdb, path), { count: 41 });
        const result = await rtdbRunTransaction(rtdbRef(rtdb, path), (current) => {
          if (current && typeof current === 'object' && !Array.isArray(current)) {
            const c = current as { count: number };
            return { count: c.count + 1 };
          }
          return { count: 1 };
        });
        resultKeys = Object.keys(result as object).sort();
        committed = result.committed;
        committedType = typeof result.committed;
        hasSnapshotProp = 'snapshot' in (result as object);
        snapshotValIsFn = typeof result.snapshot?.val === 'function';
        snapVal = result.snapshot.val();
        snapExists = result.snapshot.exists();
        snapKey = result.snapshot.key;
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        resultKeys,
        committed,
        committedType,
        hasSnapshotProp,
        snapshotValIsFn,
        snapVal,
        snapExists,
        snapKey,
        // The committed value should be the update-fn return (42),
        // not the seed (41). The key is the last path segment (`v`).
        committedReflectsNewValue:
          committed === true &&
          (snapVal as { count: number } | null)?.count === 42 &&
          snapExists === true &&
          snapKey === 'v',
      };
    },
  },
  {
    name: 'rtdb-modular-runtransaction-options-applylocally',
    matrixRow: 'rtdb-modular #158/#160 (options.applyLocally)',
    rowIds: ['rtdb-modular#158', 'rtdb-modular#160', 'rtdb-modular#M37d'],
    description: 'runTransaction with options.applyLocally — RTDB optionally suppresses optimistic local writes. With applyLocally:false the in-flight value should NOT be visible to onValue listeners until the commit lands. Probe both branches against an onValue listener registered on the ref before the transaction starts.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const pathTrue = `${RTDB_RUN_PATH('mod-tx-apply-true')}/v`;
      const pathFalse = `${RTDB_RUN_PATH('mod-tx-apply-false')}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      const trueFires: Array<{ val: unknown; ts: number }> = [];
      const falseFires: Array<{ val: unknown; ts: number }> = [];
      let trueCommitted: boolean | null = null;
      let falseCommitted: boolean | null = null;
      let trueFinalVal: unknown = undefined;
      let falseFinalVal: unknown = undefined;
      try {
        // ── applyLocally: true (default) ──
        await rtdbSet(rtdbRef(rtdb, pathTrue), 1);
        // Wait so the initial-fire is already in the bucket BEFORE the
        // transaction kicks off (avoids races where the listener hasn't
        // attached yet).
        const startT = Date.now();
        const unsubT = rtdbOnValue(rtdbRef(rtdb, pathTrue), (snap) => {
          trueFires.push({ val: snap.val(), ts: Date.now() - startT });
        });
        await new Promise((r) => setTimeout(r, 400));
        const resultT = await rtdbRunTransaction(
          rtdbRef(rtdb, pathTrue),
          (current) => (typeof current === 'number' ? current : 0) + 10,
          { applyLocally: true },
        );
        await new Promise((r) => setTimeout(r, 400));
        trueCommitted = resultT.committed;
        trueFinalVal = resultT.snapshot.val();
        unsubT();
        // ── applyLocally: false ──
        await rtdbSet(rtdbRef(rtdb, pathFalse), 1);
        const startF = Date.now();
        const unsubF = rtdbOnValue(rtdbRef(rtdb, pathFalse), (snap) => {
          falseFires.push({ val: snap.val(), ts: Date.now() - startF });
        });
        await new Promise((r) => setTimeout(r, 400));
        const resultF = await rtdbRunTransaction(
          rtdbRef(rtdb, pathFalse),
          (current) => (typeof current === 'number' ? current : 0) + 10,
          { applyLocally: false },
        );
        await new Promise((r) => setTimeout(r, 400));
        falseCommitted = resultF.committed;
        falseFinalVal = resultF.snapshot.val();
        unsubF();
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
      }
      try { await rtdbRemove(rtdbRef(rtdb, pathTrue)); } catch { /* best effort */ }
      try { await rtdbRemove(rtdbRef(rtdb, pathFalse)); } catch { /* best effort */ }
      await dropCurrentUser();
      // Listener fires we expect for both:
      //   1. initial fire (val: 1)
      //   2. commit fire (val: 11)
      // With applyLocally:true some clients deliver an extra local-
      // optimistic fire BEFORE the commit lands; with applyLocally:false
      // that intermediate fire is suppressed. We record the full
      // sequence so the matrix can pin the exact contract observed.
      return {
        threw,
        code,
        message,
        trueCommitted,
        falseCommitted,
        trueFinalVal,
        falseFinalVal,
        trueFireCount: trueFires.length,
        falseFireCount: falseFires.length,
        trueFireVals: trueFires.map((f) => f.val),
        falseFireVals: falseFires.map((f) => f.val),
        bothCommitted: trueCommitted === true && falseCommitted === true,
        bothEndedAt11: trueFinalVal === 11 && falseFinalVal === 11,
      };
    },
  },
  {
    name: 'rtdb-modular-runtransaction-on-rules-denied-path',
    matrixRow: 'rtdb-modular #158 (denial)',
    rowIds: ['rtdb-modular#158', 'rtdb#14', 'rtdb-modular#M37e'],
    description: 'runTransaction against a path the rules deny — confirm the promise rejects, capture the error shape (FirebaseError vs plain Error, .code, .message). Locks the denial contract so the sandbox throws an equivalent shape.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      // Deliberately outside `pyric_oracle/*` so the deny-all default
      // rules at the root reject this op.
      const deniedPath = `/pyric_oracle_denied_namespace/tx-${RUN_ID}/v`;
      let threw = false;
      let code: string | null = null;
      let message: string | null = null;
      let errorName: string | null = null;
      let constructorName: string | null = null;
      let isErrorInstance: boolean | null = null;
      let updateFnCallCount = 0;
      let committed: boolean | null = null;
      try {
        const result = await rtdbRunTransaction(rtdbRef(rtdb, deniedPath), (current) => {
          updateFnCallCount++;
          return (typeof current === 'number' ? current : 0) + 1;
        });
        committed = result.committed;
      } catch (e) {
        threw = true;
        code = (e as { code?: string }).code ?? null;
        message = e instanceof Error ? e.message : String(e);
        errorName = e instanceof Error ? e.name : null;
        constructorName = (e as object)?.constructor?.name ?? null;
        isErrorInstance = e instanceof Error;
      }
      // Best-effort cleanup; will likely also be denied but we try.
      try { await rtdbRemove(rtdbRef(rtdb, deniedPath)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        threw,
        code,
        message,
        errorName,
        constructorName,
        isErrorInstance,
        updateFnCallCount,
        committed,
        // Was the rejection a true rejection (not a `{ committed: false }`
        // resolve)? RTDB's contract: denied paths reject; aborts resolve.
        rejectedNotAborted: threw === true && committed === null,
      };
    },
  },
  // ─── A1: REST-shape probes ────────────────────────────────────────
  //
  // Locks the contract the RTDB REST endpoint exposes (`.json` suffix,
  // rules-JSON round-trip, deploy propagation timing, shallow response
  // shape). These claims are implicit assumptions of every RTDB
  // handler that calls `fetchDatabase`; the matrix had them as `?`
  // until now.
  {
    name: 'rtdb-rest-json-suffix-contract',
    matrixRow: 'rtdb #5',
    rowIds: ['rtdb#5'],
    description: '`.json`-suffix REST contract — fetching `<databaseUrl>/<path>.json` returns the JSON value at that path, while omitting `.json` returns HTML (the Firebase console redirector). Locks the contract every handler that calls `fetchDatabase` depends on.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      if (!config.databaseURL || !rtdbAdminToken) {
        return { skipped: true, reason: 'no rtdb databaseURL or admin token (manual config?)' };
      }
      // Write a known value under the oracle namespace first so we can
      // verify the `.json`-suffix returns it.
      await signInAnonymously(auth);
      const probePath = `${RTDB_RUN_PATH('rest-suffix')}/value`;
      const payload = { hello: 'world', n: 42 };
      let setThrew = false;
      let setError: string | null = null;
      try {
        await rtdbSet(rtdbRef(rtdb, probePath), payload);
      } catch (e) {
        setThrew = true;
        setError = e instanceof Error ? e.message : String(e);
      }
      const base = config.databaseURL!.replace(/\/+$/, '');
      const auth_qs = `access_token=${encodeURIComponent(rtdbAdminToken)}`;
      // 1) With `.json` suffix — should be JSON.
      const withJsonUrl = `${base}${probePath}.json?${auth_qs}`;
      const withJsonRes = await fetch(withJsonUrl);
      const withJsonCT = withJsonRes.headers.get('content-type') ?? '';
      const withJsonBody = await withJsonRes.text();
      let withJsonParsed: unknown = null;
      let withJsonParseOk = false;
      try {
        withJsonParsed = JSON.parse(withJsonBody);
        withJsonParseOk = true;
      } catch { /* leave parsed null */ }
      // 2) Without `.json` suffix — observe what the endpoint returns.
      const withoutJsonUrl = `${base}${probePath}?${auth_qs}`;
      const withoutJsonRes = await fetch(withoutJsonUrl);
      const withoutJsonCT = withoutJsonRes.headers.get('content-type') ?? '';
      const withoutJsonBody = await withoutJsonRes.text();
      let withoutJsonParseOk = false;
      try { JSON.parse(withoutJsonBody); withoutJsonParseOk = true; } catch { /* not JSON */ }
      // Cleanup
      try { await rtdbRemove(rtdbRef(rtdb, probePath)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        setThrew,
        setError,
        // Suffix-on response
        withJsonStatus: withJsonRes.status,
        withJsonContentType: withJsonCT,
        withJsonParseOk,
        withJsonRoundTripsPayload:
          withJsonParseOk &&
          JSON.stringify(withJsonParsed) === JSON.stringify(payload),
        withJsonValue: withJsonParsed,
        // Suffix-off response
        withoutJsonStatus: withoutJsonRes.status,
        withoutJsonContentType: withoutJsonCT,
        withoutJsonParseOk,
        withoutJsonIsHtml:
          withoutJsonCT.includes('html') ||
          /^<!DOCTYPE/i.test(withoutJsonBody.trim().slice(0, 60)) ||
          /^<html/i.test(withoutJsonBody.trim().slice(0, 60)),
        withoutJsonSnippet: withoutJsonBody.slice(0, 200),
      };
    },
  },
  {
    name: 'rtdb-rules-json-roundtrip',
    matrixRow: 'rtdb #39',
    rowIds: ['rtdb#39'],
    description: 'Rules-JSON round-trip — PUT a rules JSON containing path-variable segments (`$userId`), `.indexOn` arrays, and `.read`/`.write`/`.validate` keys, GET it back, verify the structure is preserved. Locks the REST `/.settings/rules.json` accept/return contract.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      if (!config.databaseURL || !rtdbAdminToken) {
        return { skipped: true, reason: 'no rtdb databaseURL or admin token (manual config?)' };
      }
      // Read the CURRENT rules so we can restore them afterward. The
      // RTDB rules endpoint is global per-database, so writing test
      // rules here would clobber the harness's `ensureOracleRtdbRules`
      // configuration. We snapshot first, deploy, fetch-back, then
      // restore — all under one admin token.
      const rulesUrl = `${config.databaseURL!}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}`;
      const before = await fetch(rulesUrl);
      if (!before.ok) {
        return { skipped: true, reason: `cannot read current rules: ${before.status}` };
      }
      const beforeBody = (await before.json()) as Record<string, unknown>;
      const beforeRules = (beforeBody.rules ?? {}) as Record<string, unknown>;
      // Test rule with the round-trip shapes we care about.
      // - Path-variable segment `$userId` referenced in an expression.
      // - `.indexOn` array.
      // - All three rule kinds (`.read`, `.write`, `.validate`).
      // We layer this UNDER a `pyric_oracle_roundtrip_<RUN_ID>` key
      // so it can't fight with the live `pyric_oracle/*` namespace.
      const probeKey = `pyric_oracle_roundtrip_${RUN_ID.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      const desiredSubtree = {
        '.read': false,
        '.write': false,
        users: {
          $userId: {
            '.read': '$userId === auth.uid',
            '.write': '$userId === auth.uid',
            '.indexOn': ['createdAt', 'name'],
            posts: {
              '.validate': 'newData.hasChildren([\'title\', \'body\'])',
              $postId: {
                '.read': 'auth != null',
              },
            },
          },
        },
      };
      const nextBody = {
        rules: {
          ...beforeRules,
          [probeKey]: desiredSubtree,
        },
      };
      const putUrl = `${config.databaseURL!}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}&print=silent`;
      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextBody),
      });
      let putStatus = putRes.status;
      let putOk = putRes.ok;
      let putText: string | null = null;
      if (!putRes.ok) putText = await putRes.text();
      // Fetch back.
      let fetchedSubtree: unknown = null;
      let fetchedAt: number | null = null;
      let getStatus: number | null = null;
      if (putOk) {
        // Small wait for the deploy to settle (RTDB rules are eventually
        // consistent; the same propagation row #46 measures the bound).
        await new Promise((r) => setTimeout(r, 2000));
        const getRes = await fetch(rulesUrl);
        getStatus = getRes.status;
        if (getRes.ok) {
          const got = (await getRes.json()) as Record<string, unknown>;
          fetchedSubtree = (got.rules as Record<string, unknown>)?.[probeKey] ?? null;
          fetchedAt = Date.now();
        }
      }
      // Restore the original rules — flush our probe key out.
      const restoreRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: beforeRules }),
      });
      const restoreOk = restoreRes.ok;
      const desiredJson = JSON.stringify(desiredSubtree);
      const fetchedJson = JSON.stringify(fetchedSubtree);
      // Compare structurally: path-variable segments, `.indexOn` array,
      // and rule expression text should all survive the round-trip.
      const fs = fetchedSubtree as Record<string, unknown> | null;
      const usersDollarUserId = (fs?.users as Record<string, unknown> | undefined)?.$userId as
        | Record<string, unknown>
        | undefined;
      const indexOn = usersDollarUserId?.['.indexOn'];
      const readExpr = usersDollarUserId?.['.read'];
      const writeExpr = usersDollarUserId?.['.write'];
      const validateExpr = (usersDollarUserId?.posts as Record<string, unknown> | undefined)?.['.validate'];
      return {
        putStatus,
        putOk,
        putError: putText,
        getStatus,
        restoreOk,
        restoreStatus: restoreRes.status,
        // Structural assertions:
        pathVariableSegmentPreserved:
          fs !== null && (fs.users as Record<string, unknown> | undefined)?.$userId !== undefined,
        indexOnPreserved:
          Array.isArray(indexOn) &&
          indexOn.length === 2 &&
          (indexOn as string[]).includes('createdAt') &&
          (indexOn as string[]).includes('name'),
        readRulePreserved: readExpr === '$userId === auth.uid',
        writeRulePreserved: writeExpr === '$userId === auth.uid',
        validateRulePreserved:
          validateExpr === "newData.hasChildren(['title', 'body'])",
        exactRoundTrip: desiredJson === fetchedJson,
        fetchedAt,
        // Capture the fetched subtree so the observation file shows
        // the exact return shape if any field diverged.
        fetchedSubtree,
      };
    },
  },
  {
    name: 'rtdb-rules-deploy-propagation-timing',
    matrixRow: 'rtdb #46',
    rowIds: ['rtdb#46'],
    description: 'Rules-deploy propagation timing — write a permissive rule for a fresh path, then poll a write-under-that-rule to measure how long until the new rules take effect. Locks the empirical upper bound the harness needs to wait between rule deploys and dependent writes.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      if (!config.databaseURL || !rtdbAdminToken) {
        return { skipped: true, reason: 'no rtdb databaseURL or admin token (manual config?)' };
      }
      // Read the current rules so we can restore them afterward.
      const rulesUrl = `${config.databaseURL!}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}`;
      const before = await fetch(rulesUrl);
      if (!before.ok) {
        return { skipped: true, reason: `cannot read current rules: ${before.status}` };
      }
      const beforeBody = (await before.json()) as Record<string, unknown>;
      const beforeRules = (beforeBody.rules ?? {}) as Record<string, unknown>;
      // Pick a fresh path that's NOT under `pyric_oracle/*` (so the
      // baseline rule is deny-all). The probe deploys a permissive
      // rule there and measures how long until a write succeeds.
      const propKey = `pyric_oracle_proptiming_${RUN_ID.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      const probePath = `/${propKey}/value`;
      const putUrl = `${config.databaseURL!}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}&print=silent`;
      // First, sign in so the rules can use `auth != null`.
      await signInAnonymously(auth);
      // Confirm the baseline: write to this path should currently be
      // denied (the path is outside `pyric_oracle/*`).
      let baselineDenied = false;
      let baselineCode: string | null = null;
      try {
        await rtdbSet(rtdbRef(rtdb, probePath), { v: 'baseline' });
      } catch (e) {
        baselineDenied = true;
        baselineCode = (e as { code?: string }).code ?? null;
      }
      // Deploy the new rules — add a permissive block for our key.
      const permissiveRules = {
        rules: {
          ...beforeRules,
          [propKey]: {
            '.read': 'auth != null',
            '.write': 'auth != null',
          },
        },
      };
      const deployStart = Date.now();
      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(permissiveRules),
      });
      const putOk = putRes.ok;
      const putStatus = putRes.status;
      let putError: string | null = null;
      if (!putOk) putError = await putRes.text();
      // Poll the write at short intervals; record the first time it
      // succeeds.
      const pollIntervalMs = 200;
      const maxWaitMs = 30_000;
      let firstSuccessElapsed: number | null = null;
      let totalAttempts = 0;
      let lastCode: string | null = null;
      let lastMessage: string | null = null;
      const attempts: Array<{ elapsedMs: number; ok: boolean; code: string | null }> = [];
      if (putOk) {
        const deadline = deployStart + maxWaitMs;
        while (Date.now() < deadline) {
          totalAttempts++;
          const t = Date.now();
          let attemptOk = false;
          let attemptCode: string | null = null;
          try {
            await rtdbSet(rtdbRef(rtdb, probePath), { v: t });
            attemptOk = true;
            firstSuccessElapsed = t - deployStart;
            attempts.push({ elapsedMs: t - deployStart, ok: true, code: null });
            break;
          } catch (e) {
            attemptCode = (e as { code?: string }).code ?? null;
            lastCode = attemptCode;
            lastMessage = e instanceof Error ? e.message : String(e);
            attempts.push({ elapsedMs: t - deployStart, ok: false, code: attemptCode });
          }
          if (!attemptOk) {
            await new Promise((r) => setTimeout(r, pollIntervalMs));
          }
        }
      }
      // Restore the original rules, then clean up the test path.
      const restoreRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: beforeRules }),
      });
      const restoreOk = restoreRes.ok;
      // Best-effort delete via admin SDK so the cleanup isn't blocked
      // by the post-restore deny rule.
      // (Skipped — the path is under a non-`pyric_oracle/*` namespace
      // that the restored rules deny; the data will be invisible to the
      // production app and orphaned. Harmless.)
      await dropCurrentUser();
      return {
        baselineDenied,
        baselineCode,
        putOk,
        putStatus,
        putError,
        firstSuccessElapsedMs: firstSuccessElapsed,
        totalAttempts,
        lastCode,
        lastMessage,
        attempts,
        restoreOk,
        restoreStatus: restoreRes.status,
        // The harness currently waits 5s after a rules deploy — is that enough?
        within5s: firstSuccessElapsed !== null && firstSuccessElapsed <= 5_000,
        within10s: firstSuccessElapsed !== null && firstSuccessElapsed <= 10_000,
      };
    },
  },
  {
    name: 'rtdb-shallow-rest-response-shape',
    matrixRow: 'rtdb #58',
    rowIds: ['rtdb#58'],
    description: '`?shallow=true` REST response shape — write a tree with objects, leaf primitives, and a missing path, then GET each with `?shallow=true`. Locks the response shape the crawl handler depends on: object children → `{key: true, ...}`, leaf primitive → the primitive itself, missing path → `null`.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      if (!config.databaseURL || !rtdbAdminToken) {
        return { skipped: true, reason: 'no rtdb databaseURL or admin token (manual config?)' };
      }
      await signInAnonymously(auth);
      // Seed a tree:
      //   /pyric_oracle/<run>/shallow-shape/
      //     obj/    -> { a: 1, b: 2, c: {x: true} }
      //     leaf    -> 'hello' (primitive)
      //     leafNum -> 42 (primitive number)
      //     leafBool -> true (primitive boolean)
      //   (missing -> never written)
      const base = `${RTDB_RUN_PATH('shallow-shape')}`;
      const tree = {
        obj: { a: 1, b: 2, c: { x: true } },
        leaf: 'hello',
        leafNum: 42,
        leafBool: true,
      };
      let seedThrew = false;
      let seedError: string | null = null;
      try {
        await rtdbSet(rtdbRef(rtdb, base), tree);
      } catch (e) {
        seedThrew = true;
        seedError = e instanceof Error ? e.message : String(e);
      }
      const dbBase = config.databaseURL!.replace(/\/+$/, '');
      const tok = encodeURIComponent(rtdbAdminToken);
      async function fetchShallow(path: string): Promise<{ status: number; ct: string; body: unknown; parsed: boolean }> {
        const url = `${dbBase}${path}.json?shallow=true&access_token=${tok}`;
        const res = await fetch(url);
        const ct = res.headers.get('content-type') ?? '';
        const text = await res.text();
        let parsed: unknown = null;
        let ok = false;
        try { parsed = JSON.parse(text); ok = true; } catch { parsed = text; }
        return { status: res.status, ct, body: parsed, parsed: ok };
      }
      const objAtBase = await fetchShallow(`${base}/obj`);
      const leafString = await fetchShallow(`${base}/leaf`);
      const leafNum = await fetchShallow(`${base}/leafNum`);
      const leafBool = await fetchShallow(`${base}/leafBool`);
      const missing = await fetchShallow(`${base}/nonexistent-key-${Date.now()}`);
      // Also fetch the base (collection / object).
      const baseShallow = await fetchShallow(base);
      try { await rtdbRemove(rtdbRef(rtdb, base)); } catch { /* best effort */ }
      await dropCurrentUser();
      // Object-children shape: { key: true, ...}
      const objBody = objAtBase.body as Record<string, unknown> | null;
      const objShapeIsKeysTrue =
        objBody !== null &&
        typeof objBody === 'object' &&
        Object.keys(objBody).length > 0 &&
        Object.values(objBody).every((v) => v === true);
      return {
        seedThrew,
        seedError,
        // Object node — keys mapped to true
        objStatus: objAtBase.status,
        objBody: objAtBase.body,
        objShapeIsKeysTrue,
        // Leaf primitives — the value itself
        leafStringBody: leafString.body,
        leafStringIsPrimitive: typeof leafString.body === 'string' && leafString.body === 'hello',
        leafNumBody: leafNum.body,
        leafNumIsPrimitive: typeof leafNum.body === 'number' && leafNum.body === 42,
        leafBoolBody: leafBool.body,
        leafBoolIsPrimitive: typeof leafBool.body === 'boolean' && leafBool.body === true,
        // Missing path — null
        missingStatus: missing.status,
        missingBody: missing.body,
        missingIsNull: missing.body === null,
        // Base (the parent object)
        baseBody: baseShallow.body,
      };
    },
  },
  // ─── A2: Handler return-shape + listener-precision probes ──────────
  //
  // Row #10/#11: empirically lock that the DataHandler returns
  // `{ success: true, data: <value> }` for both admin and user modes.
  // Row #139: `off(ref, 'value')` removes only `value` listeners.
  // Row #141: the returned unsub from `onValue(ref, cb)` is equivalent
  // to `off(ref, 'value', cb)`.
  {
    name: 'rtdb-handler-admin-vs-user-returnshape',
    matrixRow: 'rtdb #10/#11',
    rowIds: ['rtdb#10', 'rtdb#11'],
    description: 'DataHandler return shape — invoke handler.execute() against a real RTDB in admin mode (no auth) and user mode (anonymous auth) and verify both return `{ success: true, data: <value> }` with the same value. Locks the admin/user-mode return-shape contract end-to-end against the live service.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      if (!serviceAccount || !config.databaseURL) {
        return { skipped: true, reason: 'no service account / databaseURL (manual config?)' };
      }
      // Seed a value at a known path under the oracle namespace using
      // the modular SDK (signed in as an anonymous user).
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('handler-shape')}/value`;
      const payload = { hello: 'handler', n: 7 };
      let seedThrew = false;
      try {
        await rtdbSet(rtdbRef(rtdb, path), payload);
      } catch (e) {
        seedThrew = true;
        return { seedThrew, seedError: e instanceof Error ? e.message : String(e) };
      }
      // Build a real admin app from the service account.
      const adminAppName = `oracle-handler-${RUN_ID}`;
      let adminApp: AdminApp | null = null;
      let adminResult: unknown = null;
      let userResult: unknown = null;
      let adminError: string | null = null;
      let userError: string | null = null;
      try {
        adminApp = adminInitializeApp(
          {
            credential: adminCert({
              projectId: serviceAccount.project_id,
              clientEmail: serviceAccount.client_email,
              privateKey: serviceAccount.private_key,
            }),
            databaseURL: config.databaseURL,
          },
          adminAppName,
        );
        // ── Admin mode: mirror DataHandler's executeAsAdmin shape.
        const adminDb = getAdminDatabase(config.databaseURL, adminApp);
        const adminSnap = await adminDb.ref(path).get();
        adminResult = { success: true, data: adminSnap.val() };
      } catch (e) {
        adminError = e instanceof Error ? e.message : String(e);
      }
      // ── User mode: mirror DataHandler's executeAsUser shape.
      try {
        const userSnap = await rtdbGet(rtdbRef(rtdb, path));
        userResult = { success: true, data: userSnap.val() };
      } catch (e) {
        userError = e instanceof Error ? e.message : String(e);
      }
      // Cleanup
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      if (adminApp) {
        try { await adminDeleteApp(adminApp); } catch { /* best effort */ }
      }
      await dropCurrentUser();
      const adminShape = adminResult as { success?: boolean; data?: unknown } | null;
      const userShape = userResult as { success?: boolean; data?: unknown } | null;
      return {
        seedThrew,
        adminError,
        userError,
        adminSuccess: adminShape?.success === true,
        userSuccess: userShape?.success === true,
        adminData: adminShape?.data ?? null,
        userData: userShape?.data ?? null,
        adminDataMatchesPayload:
          JSON.stringify(adminShape?.data) === JSON.stringify(payload),
        userDataMatchesPayload:
          JSON.stringify(userShape?.data) === JSON.stringify(payload),
        // The matrix claim: same shape on both paths.
        shapesAgree:
          adminShape?.success === userShape?.success &&
          JSON.stringify(adminShape?.data) === JSON.stringify(userShape?.data),
      };
    },
  },
  {
    name: 'rtdb-off-eventtype-precision',
    matrixRow: 'rtdb #139',
    rowIds: ['rtdb-modular#139'],
    description: '`off(ref, eventType)` precision — register a `value` listener and a `child_added` listener at the same ref, call `off(ref, \'value\')`, verify a subsequent set fires only the child listener. Also verify `off(ref, \'value\')` with no callback clears ALL value listeners at the ref.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const listPath = `${RTDB_RUN_PATH('off-precision')}/list`;
      const ref = rtdbRef(rtdb, listPath);
      // Seed an initial child so onChildAdded has something to replay.
      try {
        await rtdbSet(ref, { k0: { v: 0 } });
      } catch (e) {
        await dropCurrentUser();
        return { seedThrew: true, seedError: e instanceof Error ? e.message : String(e) };
      }
      // Counters for the two listener types.
      let valueFires1 = 0;
      let valueFires2 = 0;
      let childFires = 0;
      const valueCb1 = () => { valueFires1++; };
      const valueCb2 = () => { valueFires2++; };
      const childCb = () => { childFires++; };
      // Register TWO value listeners and one child listener.
      rtdbOnValue(ref, valueCb1);
      rtdbOnValue(ref, valueCb2);
      rtdbOnChildAdded(ref, childCb);
      // Let initial fires settle.
      await new Promise((r) => setTimeout(r, 500));
      const initial = { v1: valueFires1, v2: valueFires2, c: childFires };
      // Phase 1: write a NEW child while all listeners are active.
      try { await rtdbSet(rtdbRef(rtdb, `${listPath}/k1`), { v: 1 }); } catch { /* ignored */ }
      await new Promise((r) => setTimeout(r, 500));
      const afterFirstWrite = { v1: valueFires1, v2: valueFires2, c: childFires };
      // Phase 2: call `off(ref, 'value')` with NO callback. Per the
      // contract, this should remove BOTH value listeners but leave
      // the child listener alone.
      rtdbOff(ref, 'value');
      // Phase 3: write another child — value listeners should be
      // silent, child listener should fire.
      try { await rtdbSet(rtdbRef(rtdb, `${listPath}/k2`), { v: 2 }); } catch { /* ignored */ }
      await new Promise((r) => setTimeout(r, 500));
      const afterOffValue = { v1: valueFires1, v2: valueFires2, c: childFires };
      // Phase 4: clean up the remaining child listener.
      rtdbOff(ref, 'child_added', childCb);
      try { await rtdbSet(rtdbRef(rtdb, `${listPath}/k3`), { v: 3 }); } catch { /* ignored */ }
      await new Promise((r) => setTimeout(r, 500));
      const afterOffChild = { v1: valueFires1, v2: valueFires2, c: childFires };
      try { await rtdbRemove(rtdbRef(rtdb, listPath)); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        initial,
        afterFirstWrite,
        afterOffValue,
        afterOffChild,
        // Both writes after first should NOT have fired value listeners.
        valueListenersStopped:
          afterOffValue.v1 === afterFirstWrite.v1 &&
          afterOffValue.v2 === afterFirstWrite.v2,
        // The child listener should keep firing until off'd.
        childListenerStillFiringAfterOffValue:
          afterOffValue.c > afterFirstWrite.c,
        // After off-child, the child listener should stop firing too.
        childListenerStoppedAfterOffChild:
          afterOffChild.c === afterOffValue.c,
        // Verify `off(ref, 'value')` (no callback) cleared BOTH value
        // listeners — not just the first.
        offValueClearsAllValueListeners:
          afterOffValue.v1 === afterFirstWrite.v1 &&
          afterOffValue.v2 === afterFirstWrite.v2,
      };
    },
  },
  {
    name: 'rtdb-onvalue-unsub-equivalence',
    matrixRow: 'rtdb #141',
    rowIds: ['rtdb-modular#141'],
    description: 'onValue unsubscribe equivalence — register an `onValue(ref, cb)` and capture its return value. Then call BOTH `unsub()` AND `off(ref, \'value\', cb)` against fresh registrations; verify each form stops the listener on its own.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      await signInAnonymously(auth);
      const path = `${RTDB_RUN_PATH('onvalue-unsub')}/value`;
      const ref = rtdbRef(rtdb, path);
      try { await rtdbSet(ref, { v: 0 }); } catch { /* ignored */ }
      // ── Case 1: stop via the returned unsubscribe function.
      let firesA = 0;
      const cbA = () => { firesA++; };
      const unsubA = rtdbOnValue(ref, cbA);
      await new Promise((r) => setTimeout(r, 300));
      const initialA = firesA;
      try { await rtdbSet(ref, { v: 1 }); } catch { /* ignored */ }
      await new Promise((r) => setTimeout(r, 300));
      const afterFireA = firesA;
      unsubA(); // <-- the returned function
      try { await rtdbSet(ref, { v: 2 }); } catch { /* ignored */ }
      await new Promise((r) => setTimeout(r, 300));
      const afterUnsubA = firesA;
      // ── Case 2: stop via `off(ref, 'value', cb)` directly.
      let firesB = 0;
      const cbB = () => { firesB++; };
      rtdbOnValue(ref, cbB);
      await new Promise((r) => setTimeout(r, 300));
      const initialB = firesB;
      try { await rtdbSet(ref, { v: 3 }); } catch { /* ignored */ }
      await new Promise((r) => setTimeout(r, 300));
      const afterFireB = firesB;
      rtdbOff(ref, 'value', cbB); // <-- explicit off-with-cb
      try { await rtdbSet(ref, { v: 4 }); } catch { /* ignored */ }
      await new Promise((r) => setTimeout(r, 300));
      const afterOffB = firesB;
      // ── Case 3: confirm the typeof returned-value really IS a function.
      const probeRef = rtdbRef(rtdb, `${path}-probe`);
      const noopCb = () => undefined;
      const ret = rtdbOnValue(probeRef, noopCb);
      const retType = typeof ret;
      const retIsFunction = typeof ret === 'function';
      try { ret(); } catch { /* harmless */ }
      try { await rtdbRemove(rtdbRef(rtdb, path)); } catch { /* best effort */ }
      try { await rtdbRemove(probeRef); } catch { /* best effort */ }
      await dropCurrentUser();
      return {
        // Case 1 — unsub() stops the listener.
        initialFiresA: initialA,
        afterWriteFiresA: afterFireA,
        afterUnsubFiresA: afterUnsubA,
        unsubReturnedFnStopsListener: afterUnsubA === afterFireA && afterFireA > initialA,
        // Case 2 — off(ref, 'value', cb) stops the listener.
        initialFiresB: initialB,
        afterWriteFiresB: afterFireB,
        afterOffFiresB: afterOffB,
        offRefValueCbStopsListener: afterOffB === afterFireB && afterFireB > initialB,
        // Case 3 — the returned value is a function.
        unsubReturnType: retType,
        unsubIsFunction: retIsFunction,
        // The contract: both forms are equivalent.
        bothFormsEquivalent:
          afterUnsubA === afterFireA &&
          afterOffB === afterFireB &&
          retIsFunction,
      };
    },
  },
  // ─── A3: Simulator-vs-prod allow/deny agreement audit ──────────────
  //
  // The package's central oracle claim (row #71): the in-process
  // The in-process engine's allow/deny decision matches the live RTDB rules
  // engine for the same `{ rules, mockData, auth, operation, path,
  // newData }` tuple.
  //
  // Methodology: deploy each test rule to a unique sub-namespace,
  // run M ops against the live service (capturing allow/deny), then
  // run the SAME ops through the in-process engine with mockData=null/{} and
  // compare. Disagreements get listed in the observation file and
  // surfaced into a new section of COMPAT.md.
  //
  // Aim for breadth — 50+ (rule, op) tuples — so any simulator bug
  // surfaces in this run.
  {
    name: 'rtdb-simulator-vs-prod-agreement',
    matrixRow: 'rtdb #71',
    rowIds: ['rtdb#71'],
    description: 'Simulator-vs-prod allow/deny agreement audit — deploy N rules to live RTDB, run M ops per rule against prod and through the in-process engine, report per-op agreement / disagreement. Lists every divergence so the matrix can call them out.',
    async observe() {
      if (!rtdb) return { skipped: true, reason: 'no rtdb instance on project' };
      if (!config.databaseURL || !rtdbAdminToken || !serviceAccount) {
        return { skipped: true, reason: 'no rtdb databaseURL / admin token / SA (manual config?)' };
      }
      // Snapshot current rules so we can restore them afterward.
      const rulesUrl = `${config.databaseURL!}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}`;
      const before = await fetch(rulesUrl);
      if (!before.ok) {
        return { skipped: true, reason: `cannot read current rules: ${before.status}` };
      }
      const beforeBody = (await before.json()) as Record<string, unknown>;
      const beforeRules = (beforeBody.rules ?? {}) as Record<string, unknown>;
      const putUrl = `${config.databaseURL!}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}&print=silent`;
      // The audit namespace — sub-keys per rule so we don't fight
      // `ensureOracleRtdbRules`'s `pyric_oracle` namespace.
      const auditKey = `pyric_oracle_simaudit_${RUN_ID.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      // Sign in once for the whole audit.
      await signInAnonymously(auth);
      const currentUid = auth.currentUser?.uid ?? null;
      if (!currentUid) {
        await dropCurrentUser();
        return { skipped: true, reason: 'failed to sign in anonymously for audit' };
      }
      // The test rules. Each is a small RTDB rules subtree we'll
      // deploy under `<auditKey>/<ruleId>`. The ops list per-rule
      // describes the operations to run against both prod and the
      // simulator.
      //
      // Path/newData fields may contain the literal token `<UID>`,
      // which gets substituted at op-run time with the CURRENT
      // signed-in user's uid (anonymous re-sign-ins mint fresh uids,
      // so capturing one at audit start doesn't work). Same token for
      // simulator input — the simulator sees the substituted path
      // and the same auth.uid, so a `$uid === auth.uid` rule is
      // exercised symmetrically.
      //
      // Rules chosen to cover the common patterns:
      //   r1: auth-only ─ deny anon, allow authed
      //   r2: own-uid path-variable ─ allow if $uid === auth.uid
      //   r3: data.exists() in expression
      //   r4: validate on a structure constraint
      //   r5: cascading ancestor grant (root-grant via .read=true)
      //   r6: deny everything (baseline)
      //   r7: $any path variable, expression references the binding
      //   r8: combined check (auth.uid AND value type)
      //
      // The harness rule simulator only sees the rule subtree we pass
      // in; we don't have to mirror the rest of the tree to it.
      const UID_TOKEN = '<UID>';
      function substituteUid<T>(v: T, uid: string): T {
        if (typeof v === 'string') {
          return v.replace(UID_TOKEN, uid) as unknown as T;
        }
        if (v === null || v === undefined) return v;
        if (Array.isArray(v)) {
          return v.map((item) => substituteUid(item, uid)) as unknown as T;
        }
        if (typeof v === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            out[k] = substituteUid(val, uid);
          }
          return out as unknown as T;
        }
        return v;
      }
      const testRules: Array<{
        id: string;
        subtree: Record<string, unknown>;
        // The rules JSON form that compileRtdbRules accepts. We build it
        // by wrapping the subtree under `{ '.read': false, '.write': false, ... }`
        // so a deny-all root forces the simulator to descend into the
        // rule we want to test.
        ops: Array<{
          opPath: string;
          operation: 'read' | 'write';
          authPresent: boolean;
          authUid?: string;
          newData?: unknown;
          mockData?: unknown;
          label: string;
        }>;
      }> = [
        {
          id: 'r1-auth-only',
          subtree: {
            '.read': 'auth != null',
            '.write': 'auth != null',
          },
          ops: [
            { opPath: '/value', operation: 'read', authPresent: true, authUid: currentUid, label: 'authed read allowed' },
            { opPath: '/value', operation: 'write', authPresent: true, authUid: currentUid, newData: { hi: 1 }, label: 'authed write allowed' },
            { opPath: '/value', operation: 'read', authPresent: false, label: 'anon read denied' },
            { opPath: '/value', operation: 'write', authPresent: false, newData: { hi: 1 }, label: 'anon write denied' },
          ],
        },
        {
          id: 'r2-own-uid',
          subtree: {
            $uid: {
              '.read': '$uid === auth.uid',
              '.write': '$uid === auth.uid',
            },
          },
          ops: [
            { opPath: `/${UID_TOKEN}/value`, operation: 'read', authPresent: true, label: 'matching uid read allowed' },
            { opPath: `/${UID_TOKEN}/value`, operation: 'write', authPresent: true, newData: { x: 1 }, label: 'matching uid write allowed' },
            { opPath: `/some-other-uid/value`, operation: 'read', authPresent: true, label: 'foreign uid read denied' },
            { opPath: `/some-other-uid/value`, operation: 'write', authPresent: true, newData: { x: 1 }, label: 'foreign uid write denied' },
            { opPath: `/${UID_TOKEN}/value`, operation: 'read', authPresent: false, label: 'anon read denied (no auth.uid)' },
          ],
        },
        {
          id: 'r3-data-exists',
          subtree: {
            '.read': 'auth != null',
            '.write': 'auth != null',
            value: {
              // Write only if the value at this path doesn't already exist.
              '.write': '!data.exists()',
            },
          },
          ops: [
            // For prod, we'll seed before each op as needed via the
            // probe runner. For the simulator, mockData governs.
            { opPath: '/value', operation: 'write', authPresent: true, newData: { v: 1 }, mockData: null, label: 'write to empty path allowed (!data.exists)' },
            { opPath: '/value', operation: 'write', authPresent: true, newData: { v: 2 }, mockData: { v: 'preexisting' }, label: 'write to populated path denied (data.exists)' },
            { opPath: '/value', operation: 'read', authPresent: true, label: 'read inherits ancestor (auth != null)' },
          ],
        },
        {
          id: 'r4-validate-structure',
          subtree: {
            '.read': 'auth != null',
            '.write': 'auth != null',
            entry: {
              '.validate': "newData.hasChildren(['title', 'body'])",
            },
          },
          ops: [
            { opPath: '/entry', operation: 'write', authPresent: true, newData: { title: 't', body: 'b' }, label: 'valid structure allowed' },
            { opPath: '/entry', operation: 'write', authPresent: true, newData: { title: 't' }, label: 'missing body denied (validate fails)' },
          ],
        },
        {
          id: 'r5-cascade-root-grant',
          subtree: {
            // Root-grant: .read=true at this subtree's root grants all
            // descendants. The simulator should agree.
            '.read': true,
            // Writes need auth.
            '.write': 'auth != null',
            // Deeper override (always-deny on writes) — but the read
            // grant at the root should still cascade.
            inner: {
              '.write': false,
            },
          },
          ops: [
            { opPath: '/inner/deep', operation: 'read', authPresent: true, label: 'cascade allows deep read' },
            { opPath: '/inner/deep', operation: 'read', authPresent: false, label: 'cascade allows anon deep read (true)' },
            { opPath: '/inner/deep', operation: 'write', authPresent: true, newData: { v: 1 }, label: 'deeper false override write denied (BUT cascade from auth grant?)' },
            { opPath: '/top', operation: 'write', authPresent: true, newData: { v: 1 }, label: 'top-level write allowed (auth)' },
          ],
        },
        {
          id: 'r6-deny-everything',
          subtree: {
            '.read': false,
            '.write': false,
          },
          ops: [
            { opPath: '/anything', operation: 'read', authPresent: true, label: 'authed read denied' },
            { opPath: '/anything', operation: 'write', authPresent: true, newData: { v: 1 }, label: 'authed write denied' },
            { opPath: '/anything', operation: 'read', authPresent: false, label: 'anon read denied' },
          ],
        },
        {
          id: 'r7-pathvar-binding',
          subtree: {
            sessions: {
              $sessionId: {
                // Allow read/write if the session id matches the auth uid.
                '.read': 'auth != null && $sessionId === auth.uid',
                '.write': 'auth != null && $sessionId === auth.uid',
              },
            },
          },
          ops: [
            { opPath: `/sessions/${UID_TOKEN}`, operation: 'read', authPresent: true, label: 'matching pathvar allows' },
            { opPath: `/sessions/${UID_TOKEN}`, operation: 'write', authPresent: true, newData: { v: 1 }, label: 'matching pathvar allows write' },
            { opPath: `/sessions/other-uid`, operation: 'read', authPresent: true, label: 'mismatching pathvar denies read' },
            { opPath: `/sessions/${UID_TOKEN}`, operation: 'read', authPresent: false, label: 'anon denied (no auth.uid)' },
          ],
        },
        {
          id: 'r8-combined-check',
          subtree: {
            '.write': "auth != null && newData.hasChildren(['owner']) && newData.child('owner').val() === auth.uid",
            '.read': 'auth != null',
          },
          ops: [
            { opPath: '/item', operation: 'write', authPresent: true, newData: { owner: UID_TOKEN, v: 1 }, label: 'matching owner field allowed' },
            { opPath: '/item', operation: 'write', authPresent: true, newData: { owner: 'somebody-else', v: 1 }, label: 'wrong owner denied' },
            { opPath: '/item', operation: 'write', authPresent: true, newData: { v: 1 }, label: 'missing owner field denied' },
            { opPath: '/item', operation: 'read', authPresent: true, label: 'auth-only read allowed' },
          ],
        },
      ];
      // Build the consolidated rules-JSON we'll deploy. We mount each
      // testRule under `<auditKey>/<ruleId>`, and add a permissive
      // top-level entry for the auditKey so RTDB doesn't reject the
      // deploy on missing root rule.
      const auditRulesSubtree: Record<string, unknown> = {};
      for (const r of testRules) {
        auditRulesSubtree[r.id] = r.subtree;
      }
      const nextRules: Record<string, unknown> = {
        ...beforeRules,
        [auditKey]: auditRulesSubtree,
      };
      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: nextRules }),
      });
      if (!putRes.ok) {
        await dropCurrentUser();
        const txt = await putRes.text();
        return { skipped: true, reason: `deploy audit rules failed: ${putRes.status} ${txt}` };
      }
      // Wait for the rules to propagate. We'll measure this loosely
      // by waiting 8s (above the 5s the harness uses for general
      // propagation) so we're not racing the rules-update.
      await new Promise((r) => setTimeout(r, 8_000));
      // For each (rule, op), execute the op against prod RTDB,
      // capture allow/deny. Then compile the same rules for the
      // SAME rule subtree (wrapped in a deny-all root for safety),
      // and run the same op through the simulator with the same
      // auth context.
      type DivergenceRow = {
        ruleId: string;
        opLabel: string;
        opPath: string;
        operation: 'read' | 'write';
        authPresent: boolean;
        prodAllowed: boolean | null;
        prodCode: string | null;
        simAllowed: boolean | null;
        simReason: string | null;
        simErrorCode: string | null;
        agree: boolean;
      };
      const allResults: DivergenceRow[] = [];
      const divergences: DivergenceRow[] = [];
      // Need to be signed-in anonymously for the authed cases. For
      // anon cases, the simplest path: sign out, run the op, sign
      // back in. (Each rule's op set groups authed and anon ops
      // separately, but the test rules interleave them.)
      // Strategy: run authed ops first while signed in, then sign
      // out and run anon ops, then sign back in.
      // ── Build a compiled tree per rule for the simulator. Mount the rule at
      // a top-level key (mirroring how it'll be evaluated at the
      // probe path). The compiler needs a `{ rules: { …
      // root … } }` shape. We deny-all at root so the simulator
      // descends into our test rule.
      const compiledRules = new Map<string, CompiledRtdbRules>();
      for (const r of testRules) {
        // The simulator descends from root. Build a rules JSON where
        // the root has deny-all and ALL rule subtrees are mounted by
        // id at the top level. (This avoids `NO_MATCHING_RULE`
        // surprises if the root lacks any rule for the operation.)
        const simRulesJson = {
          rules: {
            '.read': false,
            '.write': false,
            // Mount THIS test rule's subtree directly at the top of
            // the simulator's view — the simulator's path is e.g.
            // `<r.id>/value`, and the simulator binds path
            // variables top-down so `$uid` etc. work.
            [r.id]: r.subtree,
          },
        };
        try {
          compiledRules.set(r.id, compileRtdbRules(simRulesJson));
        } catch (e) {
          // Skip this rule's simulator evaluation; mark its ops as
          // un-comparable.
          // Continue — we'll capture the build error in the prod-only
          // path.
          console.log(`[oracle] simulator rules compile failed for ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // ── Execute ops. For each (rule, op):
      //   - prod path: write/read against `${auditKey}/<r.id>${opPath}`
      //     under the appropriate auth context.
      //   - sim path: run simulateRtdbRules(compiled, { operation, path: /<r.id><opPath>, auth, mockData, newData })
      for (const r of testRules) {
        const compiled = compiledRules.get(r.id);
        for (const op of r.ops) {
          // Switch auth context if needed. Capture the LIVE uid after
          // re-signing in so paths/newData with `<UID>` substitute
          // correctly (anonymous re-sign-ins mint fresh uids).
          if (op.authPresent && !auth.currentUser) {
            await signInAnonymously(auth);
          } else if (!op.authPresent && auth.currentUser) {
            await signOut(auth);
          }
          const liveUid = auth.currentUser?.uid ?? '';
          const opPathSubst = substituteUid(op.opPath, liveUid);
          const newDataSubst =
            op.newData !== undefined ? substituteUid(op.newData, liveUid) : undefined;
          const mockDataSubst =
            op.mockData !== undefined ? substituteUid(op.mockData, liveUid) : undefined;
          const authUidSubst = op.authPresent ? liveUid : '';
          const fullProdPath = `/${auditKey}/${r.id}${opPathSubst}`;
          let prodAllowed: boolean | null = null;
          let prodCode: string | null = null;
          try {
            if (op.operation === 'read') {
              // For r3 (data.exists), pre-seed if mockData has a value
              // and the path is supposed to be populated. Use the
              // admin SDK if needed — but since the simulator's
              // mockData is per-op, just rely on whatever the live
              // path holds (empty for fresh runs).
              await rtdbGet(rtdbRef(rtdb, fullProdPath));
            } else {
              // For r3 (data.exists) "write to populated path
              // denied" — first seed the path so prod sees it
              // already exists. We seed via the ADMIN admin app so
              // the seed isn't blocked by the rule under test.
              if (mockDataSubst !== undefined && mockDataSubst !== null) {
                try {
                  const seedApp = adminInitializeApp(
                    {
                      credential: adminCert({
                        projectId: serviceAccount!.project_id,
                        clientEmail: serviceAccount!.client_email,
                        privateKey: serviceAccount!.private_key,
                      }),
                      databaseURL: config.databaseURL,
                    },
                    `oracle-sim-seed-${RUN_ID}-${r.id}-${op.label.replace(/\s+/g, '_')}`,
                  );
                  try {
                    const seedDb = getAdminDatabase(config.databaseURL!, seedApp);
                    await seedDb.ref(fullProdPath).set(mockDataSubst);
                  } finally {
                    try { await adminDeleteApp(seedApp); } catch { /* ignored */ }
                  }
                } catch { /* seed best-effort */ }
              }
              await rtdbSet(rtdbRef(rtdb, fullProdPath), newDataSubst ?? null);
            }
            prodAllowed = true;
          } catch (e) {
            prodAllowed = false;
            prodCode = (e as { code?: string }).code ?? null;
          }
          // ── Simulator
          let simAllowed: boolean | null = null;
          let simReason: string | null = null;
          let simErrorCode: string | null = null;
          if (compiled) {
            const simPath = `/${r.id}${opPathSubst}`;
            // The simulator's mockData is a root-relative snapshot.
            // For `data.exists()` at `/<r.id><opPath>` to be true,
            // the mockData must encode the value at the FULL simPath.
            // We build a nested record matching the path segments.
            //
            //   opPath '/value', mockData = { v: 'pre' } →
            //   simMock = { '<r.id>': { value: { v: 'pre' } } }
            //
            // If mockData is undefined/null, we pass `{}` (empty
            // root) — the simulator sees no value at the simPath.
            function buildSimMock(): Record<string, unknown> {
              if (mockDataSubst === undefined || mockDataSubst === null) return {};
              const segs = simPath.split('/').filter(Boolean);
              const root: Record<string, unknown> = {};
              let cursor = root;
              for (let i = 0; i < segs.length - 1; i++) {
                const child: Record<string, unknown> = {};
                cursor[segs[i]] = child;
                cursor = child;
              }
              cursor[segs[segs.length - 1]] = mockDataSubst;
              return root;
            }
            const coercedMock = buildSimMock();
            const simInput: SimulationInput = {
              operation: op.operation === 'read' ? 'read' : 'write',
              path: simPath,
              auth: op.authPresent
                ? {
                    uid: authUidSubst,
                    token: { firebase: { sign_in_provider: 'anonymous' }, provider_id: 'anonymous' },
                  }
                : null,
              mockData: coercedMock,
              newData: newDataSubst,
            };
            const simRes = simulateRtdbRules(compiled, simInput);
            if (simRes.success) {
              simAllowed = simRes.data.allowed;
              simReason = simRes.data.reason ?? null;
            } else {
              simErrorCode = simRes.error.code;
              // Treat NO_MATCHING_RULE / RULES_NOT_COMPILED as "deny
              // by default" for comparison purposes — but capture
              // the actual code so we can see it in the observation.
              simAllowed = false;
            }
          }
          const row: DivergenceRow = {
            ruleId: r.id,
            opLabel: op.label,
            opPath: opPathSubst,
            operation: op.operation,
            authPresent: op.authPresent,
            prodAllowed,
            prodCode,
            simAllowed,
            simReason,
            simErrorCode,
            agree: prodAllowed !== null && simAllowed !== null && prodAllowed === simAllowed,
          };
          allResults.push(row);
          if (!row.agree) divergences.push(row);
        }
      }
      // Restore rules + cleanup.
      const restoreRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: beforeRules }),
      });
      const restoreOk = restoreRes.ok;
      // Sign back in just to satisfy the cleanup invariant.
      if (!auth.currentUser) {
        try { await signInAnonymously(auth); } catch { /* ignored */ }
      }
      await dropCurrentUser();
      return {
        totalOps: allResults.length,
        agreements: allResults.filter((r) => r.agree).length,
        disagreements: divergences.length,
        agreementRate: allResults.length > 0
          ? allResults.filter((r) => r.agree).length / allResults.length
          : null,
        ruleIds: testRules.map((r) => r.id),
        divergences,
        allResults,
        restoreOk,
        restoreStatus: restoreRes.status,
      };
    },
  },
  // ─── Auth climb: email-link / action-code, linking, reauth ──────────
  //
  // Emails are addressed at the reserved, non-deliverable `oracle.test`
  // TLD (same convention the existing email/password probes use), so a
  // probe that successfully triggers an outbound send reaches no real
  // inbox. No probe below completes an email ROUND TRIP — nothing here
  // reads a mailbox. What they capture is what production does
  // OBSERVABLY on the client side of these APIs: the accept/reject
  // shape, the error code for an invalid/malformed input, the pure
  // client-side parse contract, and the conflict codes for linking and
  // reauth (which need no mail at all, because email/password
  // credentials carry their own secret).
  {
    name: 'auth-actioncodeurl-parse',
    matrixRow: 'auth #150',
    rowIds: ['auth#150'],
    description: 'ActionCodeURL.parseLink / parseActionCodeURL — the PURE CLIENT-SIDE parse contract for an out-of-band action link. No network, no mailbox: fully capturable. Locks which query params become which fields, and what a link that is missing mode/oobCode parses to.',
    async observe() {
      const wellFormed =
        'https://example.com/finish?mode=resetPassword&oobCode=CODE_123&apiKey=API_KEY_1&continueUrl=https%3A%2F%2Fapp.example.com%2Fnext&lang=fr';
      const parsed = ActionCodeURL.parseLink(wellFormed);
      const viaFn = parseActionCodeURL(wellFormed);
      const signInLink =
        'https://example.com/finish?mode=signIn&oobCode=CODE_SIGNIN&apiKey=API_KEY_1';
      const signInParsed = parseActionCodeURL(signInLink);
      // A link with no `mode` / no `oobCode` — the two params the parse
      // requires. Locks whether prod returns null or throws.
      const noMode = parseActionCodeURL('https://example.com/finish?oobCode=X&apiKey=K');
      const noCode = parseActionCodeURL('https://example.com/finish?mode=signIn&apiKey=K');
      const notAUrl = parseActionCodeURL('definitely not a url');
      return {
        wellFormed: parsed
          ? {
            operation: parsed.operation,
            code: parsed.code,
            apiKey: parsed.apiKey,
            continueUrl: parsed.continueUrl,
            languageCode: parsed.languageCode,
            tenantId: parsed.tenantId,
          }
          : null,
        parseActionCodeURLAgrees: JSON.stringify(viaFn) === JSON.stringify(parsed),
        signInOperation: signInParsed ? signInParsed.operation : null,
        signInContinueUrl: signInParsed ? signInParsed.continueUrl : null,
        noModeIsNull: noMode === null,
        noCodeIsNull: noCode === null,
        notAUrlIsNull: notAUrl === null,
        // The ActionCodeOperation constant map — the operation strings the
        // parse above yields.
        actionCodeOperation: { ...ActionCodeOperation },
      };
    },
  },
  {
    name: 'auth-issigninwithemaillink-predicate',
    matrixRow: 'auth #151',
    rowIds: ['auth#151'],
    description: 'isSignInWithEmailLink — pure client-side predicate over a link. Locks exactly which links prod accepts as an email-link sign-in link (mode=signIn + oobCode) and which it rejects.',
    async observe() {
      const signIn = 'https://example.com/x?mode=signIn&oobCode=C1&apiKey=K';
      const reset = 'https://example.com/x?mode=resetPassword&oobCode=C1&apiKey=K';
      const noCode = 'https://example.com/x?mode=signIn&apiKey=K';
      return {
        signInLink: isSignInWithEmailLink(auth, signIn),
        resetPasswordLink: isSignInWithEmailLink(auth, reset),
        signInModeNoOobCode: isSignInWithEmailLink(auth, noCode),
        garbage: isSignInWithEmailLink(auth, 'not-a-link'),
        empty: isSignInWithEmailLink(auth, ''),
      };
    },
  },
  {
    name: 'auth-action-code-invalid',
    matrixRow: 'auth #152',
    rowIds: ['auth#152'],
    description: 'The four out-of-band code CONSUMERS against a code production never issued. This is the reject shape an email round trip is not needed to observe: applyActionCode / checkActionCode / verifyPasswordResetCode / confirmPasswordReset each hit the real Identity Platform endpoint with a bogus oobCode. Locks auth/invalid-action-code across all four.',
    async observe() {
      const bogus = 'pyric-oracle-not-a-real-oob-code';
      async function codeOf(p: Promise<unknown>): Promise<string | null> {
        try {
          await p;
          return null; // resolved — no error code
        } catch (e) {
          return (e as { code?: string }).code ?? null;
        }
      }
      return {
        applyActionCode: await codeOf(applyActionCode(auth, bogus)),
        checkActionCode: await codeOf(checkActionCode(auth, bogus)),
        verifyPasswordResetCode: await codeOf(verifyPasswordResetCode(auth, bogus)),
        confirmPasswordReset: await codeOf(confirmPasswordReset(auth, bogus, 'newpassword123')),
        // Empty-string code — locks whether the SDK validates client-side
        // (argument-error) or lets the server decide (invalid-action-code).
        applyActionCodeEmpty: await codeOf(applyActionCode(auth, '')),
      };
    },
  },
  {
    name: 'auth-sendsigninlinktoemail-settings-validation',
    matrixRow: 'auth #153',
    rowIds: ['auth#153'],
    description: 'sendSignInLinkToEmail ActionCodeSettings validation — the accept/reject shape for the continue-URL contract, capturable WITHOUT any mailbox. Locks auth/missing-continue-uri (no url), auth/invalid-continue-uri (malformed url), auth/argument-error (handleCodeInApp false), and auth/unauthorized-continue-uri (a continue domain not on the project allowlist).',
    async observe() {
      const email = `oracle-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      async function codeOf(p: Promise<unknown>): Promise<string | null> {
        try {
          await p;
          return null;
        } catch (e) {
          return (e as { code?: string }).code ?? null;
        }
      }
      // No `url` at all.
      const missingUrl = await codeOf(
        sendSignInLinkToEmail(auth, email, { handleCodeInApp: true } as unknown as ActionCodeSettings),
      );
      // `url` present but not a URL.
      const invalidUrl = await codeOf(
        sendSignInLinkToEmail(auth, email, { url: 'not-a-url', handleCodeInApp: true }),
      );
      // handleCodeInApp explicitly false — upstream requires it be true for
      // the email-link sign-in flow.
      const handleCodeInAppFalse = await codeOf(
        sendSignInLinkToEmail(auth, email, { url: 'https://example.com/finish', handleCodeInApp: false }),
      );
      // A well-formed URL on a domain that is NOT in the project's
      // authorized-domains list — the server-side arm of the contract.
      const unauthorizedDomain = await codeOf(
        sendSignInLinkToEmail(auth, email, {
          url: 'https://pyric-oracle-not-authorized.example.com/finish',
          handleCodeInApp: true,
        }),
      );
      return { missingUrl, invalidUrl, handleCodeInAppFalse, unauthorizedDomain, attemptedEmail: email };
    },
  },
  {
    name: 'auth-signinwithemaillink-invalid-link',
    matrixRow: 'auth #154',
    rowIds: ['auth#154'],
    description: 'signInWithEmailLink against a link the project never issued. The completion half of the email-link flow CANNOT be probed end to end (it needs a code from a real inbox), but its reject shape can: locks the code prod emits for a syntactically valid link carrying an unknown oobCode, and for a link with no oobCode at all.',
    async observe() {
      const email = `oracle-elink-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      async function codeOf(p: Promise<unknown>): Promise<string | null> {
        try {
          await p;
          return null;
        } catch (e) {
          return (e as { code?: string }).code ?? null;
        }
      }
      const unknownCode = await codeOf(
        signInWithEmailLink(auth, email, 'https://example.com/x?mode=signIn&oobCode=pyric-oracle-bogus&apiKey=K'),
      );
      const noOobCode = await codeOf(
        signInWithEmailLink(auth, email, 'https://example.com/x?mode=signIn&apiKey=K'),
      );
      await dropCurrentUser();
      return { unknownCode, noOobCode };
    },
  },
  {
    name: 'auth-sendpasswordresetemail-unknown-user',
    matrixRow: 'auth #155',
    rowIds: ['auth#155'],
    description: 'sendPasswordResetEmail for an email no account owns. Locks whether prod leaks account existence (auth/user-not-found) or silently resolves — the observable behavior depends on the project\'s Email Enumeration Protection setting, so the capture records what THIS project does and the row states the dependency.',
    async observe() {
      const unknown = `oracle-nobody-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      let resolved = false;
      let code: string | null = null;
      try {
        await sendPasswordResetEmail(auth, unknown);
        resolved = true;
      } catch (e) {
        code = (e as { code?: string }).code ?? null;
      }
      // Malformed email — client-side format validation, independent of
      // enumeration protection.
      let malformedCode: string | null = null;
      try {
        await sendPasswordResetEmail(auth, 'not-an-email');
      } catch (e) {
        malformedCode = (e as { code?: string }).code ?? null;
      }
      return { resolvedForUnknownUser: resolved, unknownUserCode: code, malformedEmailCode: malformedCode };
    },
  },
  {
    name: 'auth-sendemailverification-shape',
    matrixRow: 'auth #156',
    rowIds: ['auth#156'],
    description: 'sendEmailVerification — the accept/reject shape. An ANONYMOUS user has no email to verify. A real email/password user IS a valid target. NOTE: the oracle project gates outbound-email operations at the project level, so `projectBlocksOutboundEmail` records whether what we observed is the API contract or this project\'s configuration answering first. Either way, the fact the flow turns on — that SENDING does not verify; only clicking the mailed link does — is not probeable from a client at all.',
    async observe() {
      // Anonymous user — no email on the account.
      const anonCode = await attemptCode(async () => {
        await signInAnonymously(auth);
        await sendEmailVerification(auth.currentUser!);
      });
      await dropCurrentUser();

      // Real email/password user. The send targets the non-deliverable
      // `oracle.test` TLD, so nothing reaches an inbox — we capture the
      // CLIENT-observable outcome of the call, not the mail.
      const email = `oracle-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      let verifiedBefore: boolean | null = null;
      let verifiedAfterSend: boolean | null = null;
      const createCode = await attemptCode(async () => {
        await createUserWithEmailAndPassword(auth, email, 'oracle-pw-123');
        verifiedBefore = auth.currentUser!.emailVerified;
      });
      const sendCode = await attemptCode(async () => {
        await sendEmailVerification(auth.currentUser!);
      });
      await attemptCode(async () => {
        await auth.currentUser!.reload();
        verifiedAfterSend = auth.currentUser!.emailVerified;
      });
      const cleanupLeaked = (await attemptCode(async () => {
        await deleteUser(auth.currentUser!);
      })) !== null;
      await dropCurrentUser();
      return {
        anonymousUserCode: anonCode,
        createUserCode: createCode,
        sendCode,
        sendResolved: sendCode === null,
        projectBlocksOutboundEmail: sendCode === 'auth/operation-not-allowed',
        verifiedBefore,
        // The fact the whole flow exists for: sending does NOT verify.
        // Only clicking the link in the mail does — the one step no
        // client-side probe can take.
        verifiedAfterSend,
        cleanupLeaked,
      };
    },
  },
  {
    name: 'auth-verifybeforeupdateemail-shape',
    matrixRow: 'auth #157',
    rowIds: ['auth#157'],
    description: 'verifyBeforeUpdateEmail — the client-observable contract: does the call change the email immediately, or only after the mailed link is clicked? The un-clicked half is the whole point of the API and is exactly what a sandbox must model deliberately. Records `projectBlocksOutboundEmail` when this project\'s configuration answers before the API contract does.',
    async observe() {
      const email = `oracle-vbue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      const next = `oracle-vbue-next-${Date.now()}@oracle.test`;
      const createCode = await attemptCode(async () => {
        await createUserWithEmailAndPassword(auth, email, 'oracle-pw-123');
      });
      const code = await attemptCode(async () => {
        await verifyBeforeUpdateEmail(auth.currentUser!, next);
      });
      let emailAfterCall: string | null = null;
      await attemptCode(async () => {
        await auth.currentUser!.reload();
        emailAfterCall = auth.currentUser!.email;
      });
      const malformedCode = await attemptCode(async () => {
        await verifyBeforeUpdateEmail(auth.currentUser!, 'not-an-email');
      });
      const cleanupLeaked = (await attemptCode(async () => {
        await deleteUser(auth.currentUser!);
      })) !== null;
      await dropCurrentUser();
      return {
        createUserCode: createCode,
        code,
        resolved: code === null,
        projectBlocksOutboundEmail: code === 'auth/operation-not-allowed',
        emailAfterCall,
        emailUnchangedUntilLinkClicked: emailAfterCall === email,
        malformedTargetCode: malformedCode,
        cleanupLeaked,
      };
    },
  },
  {
    name: 'auth-link-email-credential-to-anonymous',
    matrixRow: 'auth #160',
    rowIds: ['auth#160'],
    description: 'linkWithCredential — the anonymous-upgrade flow, fully probeable with NO mailbox and NO OAuth popup (an email/password credential carries its own secret). Locks the returned UserCredential shape (operationType, providerId) and the effect on the user: same uid, isAnonymous flips false, providerData gains the password provider.',
    async observe() {
      const email = `oracle-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@oracle.test`;
      const password = 'oracle-pw-123';
      let anonUid: string | null = null;
      let result: Record<string, unknown> = {};
      const linkCode = await attemptCode(async () => {
        const anon = await signInAnonymously(auth);
        anonUid = anon.user.uid;
        const cred = EmailAuthProvider.credential(email, password);
        const linked = await linkWithCredential(auth.currentUser!, cred);
        result = {
          operationType: linked.operationType,
          credentialProviderId: linked.providerId,
          uidPreserved: linked.user.uid === anonUid,
          isAnonymousAfterLink: linked.user.isAnonymous,
          emailAfterLink: linked.user.email,
          providerIds: linked.user.providerData.map((p) => p.providerId),
          // The linked identity is the live current user.
          isCurrentUser: auth.currentUser?.uid === anonUid,
          additionalUserInfoIsNewUser: getAdditionalUserInfo(linked)?.isNewUser ?? null,
          additionalUserInfoProviderId: getAdditionalUserInfo(linked)?.providerId ?? null,
        };
      });
      const cleanupLeaked = (await attemptCode(async () => {
        await deleteUser(auth.currentUser!);
      })) !== null;
      await dropCurrentUser();
      return { linkCode, ...result, cleanupLeaked };
    },
  },
  {
    name: 'auth-link-conflicts',
    matrixRow: 'auth #161',
    rowIds: ['auth#161'],
    description: 'The two linking CONFLICT codes, both probeable without external infra: linking a provider the user already has (auth/provider-already-linked), and linking a credential another account already owns (locks whether prod says credential-already-in-use or email-already-in-use for an email credential).',
    async observe() {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerEmail = `oracle-owner-${stamp}@oracle.test`;
      const password = 'oracle-pw-123';
      let ownerUid: string | null = null;
      let bUid: string | null = null;

      // Account A owns `ownerEmail`.
      const setupACode = await attemptCode(async () => {
        await createUserWithEmailAndPassword(auth, ownerEmail, password);
        ownerUid = auth.currentUser!.uid;
        await signOut(auth);
      });

      // Account B: anonymous, links its OWN fresh email — then tries to
      // link a SECOND email credential onto the same account.
      const bEmail = `oracle-b-${stamp}@oracle.test`;
      const setupBCode = await attemptCode(async () => {
        await signInAnonymously(auth);
        await linkWithCredential(auth.currentUser!, EmailAuthProvider.credential(bEmail, password));
        bUid = auth.currentUser!.uid;
      });
      const providerAlreadyLinkedCode = await attemptCode(async () => {
        await linkWithCredential(
          auth.currentUser!,
          EmailAuthProvider.credential(`oracle-b2-${stamp}@oracle.test`, password),
        );
      });
      const cleanupB = await attemptCode(async () => { await deleteUser(auth.currentUser!); });
      await dropCurrentUser();

      // Account C: anonymous, tries to link the credential ACCOUNT A owns.
      const credentialAlreadyInUseCode = await attemptCode(async () => {
        await signInAnonymously(auth);
        await linkWithCredential(auth.currentUser!, EmailAuthProvider.credential(ownerEmail, password));
      });
      const cleanupC = await attemptCode(async () => { await deleteUser(auth.currentUser!); });
      await dropCurrentUser();

      // Purge account A.
      const cleanupA = await attemptCode(async () => {
        await signInWithEmailAndPassword(auth, ownerEmail, password);
        await deleteUser(auth.currentUser!);
      });
      await dropCurrentUser();

      return {
        setupACode,
        setupBCode,
        providerAlreadyLinkedCode,
        credentialAlreadyInUseCode,
        ownerUidDiffersFromB: ownerUid !== null && bUid !== null && ownerUid !== bUid,
        cleanupLeaked: cleanupA !== null || cleanupB !== null || cleanupC !== null,
      };
    },
  },
  {
    name: 'auth-unlink-provider',
    matrixRow: 'auth #162',
    rowIds: ['auth#162'],
    description: 'unlink — removing a linked provider from a user. Locks the returned User shape (providerData shrinks) and the code for unlinking a provider that was never linked (auth/no-such-provider).',
    async observe() {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const email = `oracle-unlink-${stamp}@oracle.test`;
      const password = 'oracle-pw-123';
      let beforeProviders: string[] | null = null;
      const setupCode = await attemptCode(async () => {
        await signInAnonymously(auth);
        await linkWithCredential(auth.currentUser!, EmailAuthProvider.credential(email, password));
        beforeProviders = auth.currentUser!.providerData.map((p) => p.providerId);
      });

      // Unlink a provider that was never linked.
      const noSuchProviderCode = await attemptCode(async () => {
        await unlink(auth.currentUser!, 'google.com');
      });

      // Unlink the password provider we just linked.
      let unlinkedProviders: string[] | null = null;
      let emailAfterUnlink: string | null = null;
      let isAnonymousAfterUnlink: boolean | null = null;
      const unlinkCode = await attemptCode(async () => {
        const u = await unlink(auth.currentUser!, 'password');
        unlinkedProviders = u.providerData.map((p) => p.providerId);
        emailAfterUnlink = u.email;
        isAnonymousAfterUnlink = u.isAnonymous;
      });

      const cleanupLeaked = (await attemptCode(async () => {
        await deleteUser(auth.currentUser!);
      })) !== null;
      await dropCurrentUser();
      return {
        setupCode,
        beforeProviders,
        noSuchProviderCode,
        unlinkCode,
        unlinkedProviders,
        emailAfterUnlink,
        // Does unlinking the last provider send the user back to anonymous?
        isAnonymousAfterUnlink,
        cleanupLeaked,
      };
    },
  },
  {
    name: 'auth-reauthenticate-with-credential',
    matrixRow: 'auth #170',
    rowIds: ['auth#170'],
    description: 'reauthenticateWithCredential happy path + the two reject codes. Fully probeable with an email/password credential (no popup, no mail). Locks operationType `reauthenticate`, the wrong-password code, and the user-mismatch code when the credential belongs to a DIFFERENT account.',
    async observe() {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const email = `oracle-reauth-${stamp}@oracle.test`;
      const other = `oracle-reauth-other-${stamp}@oracle.test`;
      const password = 'oracle-pw-123';
      let happy: Record<string, unknown> = {};

      const setupCode = await attemptCode(async () => {
        // A second, unrelated account whose credential we will present.
        await createUserWithEmailAndPassword(auth, other, password);
        await signOut(auth);
        await createUserWithEmailAndPassword(auth, email, password);
      });

      const reauthCode = await attemptCode(async () => {
        const uid = auth.currentUser!.uid;
        const reauthed = await reauthenticateWithCredential(
          auth.currentUser!,
          EmailAuthProvider.credential(email, password),
        );
        happy = {
          operationType: reauthed.operationType,
          providerId: reauthed.providerId,
          uidPreserved: reauthed.user.uid === uid,
        };
      });

      const wrongPasswordCode = await attemptCode(async () => {
        await reauthenticateWithCredential(auth.currentUser!, EmailAuthProvider.credential(email, 'wrong-pw-999'));
      });

      const userMismatchCode = await attemptCode(async () => {
        await reauthenticateWithCredential(auth.currentUser!, EmailAuthProvider.credential(other, password));
      });

      const cleanup1 = await attemptCode(async () => { await deleteUser(auth.currentUser!); });
      await dropCurrentUser();
      const cleanup2 = await attemptCode(async () => {
        await signInWithEmailAndPassword(auth, other, password);
        await deleteUser(auth.currentUser!);
      });
      await dropCurrentUser();

      return {
        setupCode,
        reauthCode,
        ...happy,
        wrongPasswordCode,
        userMismatchCode,
        cleanupLeaked: cleanup1 !== null || cleanup2 !== null,
      };
    },
  },
  {
    name: 'auth-additional-user-info-shape',
    matrixRow: 'auth #171',
    rowIds: ['auth#171'],
    description: 'getAdditionalUserInfo across the three credential-producing flows — anonymous sign-in, a fresh createUserWithEmailAndPassword, and a returning signInWithEmailAndPassword. Locks isNewUser + providerId + profile per flow.',
    async observe() {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const email = `oracle-aui-${stamp}@oracle.test`;
      const password = 'oracle-pw-123';
      const shape = (i: ReturnType<typeof getAdditionalUserInfo>) =>
        i === null
          ? null
          : { isNewUser: i.isNewUser, providerId: i.providerId, profile: i.profile ?? null, username: i.username ?? null };

      let anonymous: unknown = null;
      let createUser: unknown = null;
      let signInExisting: unknown = null;

      const anonCode = await attemptCode(async () => {
        anonymous = shape(getAdditionalUserInfo(await signInAnonymously(auth)));
      });
      await dropCurrentUser();

      const flowCode = await attemptCode(async () => {
        createUser = shape(getAdditionalUserInfo(await createUserWithEmailAndPassword(auth, email, password)));
        await signOut(auth);
        signInExisting = shape(getAdditionalUserInfo(await signInWithEmailAndPassword(auth, email, password)));
      });

      const cleanupLeaked = (await attemptCode(async () => {
        await deleteUser(auth.currentUser!);
      })) !== null;
      await dropCurrentUser();

      return { anonCode, flowCode, anonymous, createUser, signInExisting, cleanupLeaked };
    },
  },
  {
    name: 'auth-mechanical-surface-constants',
    matrixRow: 'auth #172',
    rowIds: ['auth#172'],
    description: 'The constant maps and inert tokens of the mechanical family, snapshotted straight from the shipped SDK: ProviderId / SignInMethod / OperationType, the `type` discriminant of every persistence token, and a sample of AuthErrorCodes. Pure static values — the mirror must reproduce them exactly or consumer code comparing against them silently mismatches.',
    async observe() {
      return {
        ProviderId: { ...ProviderId },
        SignInMethod: { ...SignInMethod },
        OperationType: { ...OperationType },
        // `.type` is the observable discriminant every persistence token
        // carries; the token objects themselves are opaque. Read through a
        // namespace import and guarded: the BROWSER-only tokens are absent
        // from the node build this harness runs under, and `absent-in-node-
        // build` is itself the honest observation (the mirror still has to
        // export the name — the census resolves the browser condition).
        persistenceTypes: {
          indexedDBLocalPersistence: persistenceType('indexedDBLocalPersistence'),
          browserCookiePersistence: persistenceType('browserCookiePersistence'),
          browserLocalPersistence: persistenceType('browserLocalPersistence'),
          browserSessionPersistence: persistenceType('browserSessionPersistence'),
          inMemoryPersistence: persistenceType('inMemoryPersistence'),
        },
        authErrorCodesSample: {
          ARGUMENT_ERROR: AuthErrorCodes.ARGUMENT_ERROR,
          INVALID_OOB_CODE: AuthErrorCodes.INVALID_OOB_CODE,
          EXPIRED_OOB_CODE: AuthErrorCodes.EXPIRED_OOB_CODE,
          PROVIDER_ALREADY_LINKED: AuthErrorCodes.PROVIDER_ALREADY_LINKED,
          NO_SUCH_PROVIDER: AuthErrorCodes.NO_SUCH_PROVIDER,
          CREDENTIAL_ALREADY_IN_USE: AuthErrorCodes.CREDENTIAL_ALREADY_IN_USE,
          USER_MISMATCH: AuthErrorCodes.USER_MISMATCH,
          INVALID_CUSTOM_TOKEN: AuthErrorCodes.INVALID_CUSTOM_TOKEN,
          UNAUTHORIZED_DOMAIN: AuthErrorCodes.UNAUTHORIZED_DOMAIN,
          INVALID_CONTINUE_URI: AuthErrorCodes.INVALID_CONTINUE_URI,
          MISSING_CONTINUE_URI: AuthErrorCodes.MISSING_CONTINUE_URI,
        },
        authErrorCodesCount: Object.keys(AuthErrorCodes).length,
      };
    },
  },
  {
    name: 'auth-signinwithcustomtoken-invalid',
    matrixRow: 'auth #173',
    rowIds: ['auth#173'],
    description: 'signInWithCustomToken with a token this project never minted. The HAPPY path needs an Admin-SDK-signed JWT (the oracle harness is a Web SDK client), so what is capturable here is the reject shape: locks auth/invalid-custom-token for a malformed token.',
    async observe() {
      let malformedCode: string | null = null;
      try {
        await signInWithCustomToken(auth, 'not-a-jwt');
      } catch (e) {
        malformedCode = (e as { code?: string }).code ?? null;
      }
      let emptyCode: string | null = null;
      try {
        await signInWithCustomToken(auth, '');
      } catch (e) {
        emptyCode = (e as { code?: string }).code ?? null;
      }
      await dropCurrentUser();
      return { malformedCode, emptyCode };
    },
  },
  {
    name: 'auth-validatepassword-status-shape',
    matrixRow: 'auth #174',
    rowIds: ['auth#174'],
    description: 'validatePassword — the PasswordValidationStatus shape prod returns for a weak and a strong password, against the project\'s live password policy.',
    async observe() {
      const shape = (s: Awaited<ReturnType<typeof validatePassword>>) => ({
        isValid: s.isValid,
        meetsMinPasswordLength: s.meetsMinPasswordLength ?? null,
        meetsMaxPasswordLength: s.meetsMaxPasswordLength ?? null,
        containsLowercaseLetter: s.containsLowercaseLetter ?? null,
        containsUppercaseLetter: s.containsUppercaseLetter ?? null,
        containsNumericCharacter: s.containsNumericCharacter ?? null,
        containsNonAlphanumericCharacter: s.containsNonAlphanumericCharacter ?? null,
        minPasswordLength: s.passwordPolicy?.customStrengthOptions?.minPasswordLength ?? null,
        maxPasswordLength: s.passwordPolicy?.customStrengthOptions?.maxPasswordLength ?? null,
        enforcementState: s.passwordPolicy?.enforcementState ?? null,
      });
      let weak: unknown = null;
      let strong: unknown = null;
      const code = await attemptCode(async () => {
        weak = shape(await validatePassword(auth, 'x'));
        strong = shape(await validatePassword(auth, 'aReasonablyStrongPassword123!'));
      });
      return { code, weak, strong };
    },
  },
  {
    name: 'auth-fetchsigninmethodsforemail-deprecated',
    matrixRow: 'auth #175',
    rowIds: ['auth#175'],
    description: 'fetchSignInMethodsForEmail — DEPRECATED upstream. Firebase documents that it returns an EMPTY list whenever Email Enumeration Protection is on (the default for new projects), irrespective of how many methods the account really has. This capture is the evidence for the disposition decision: what does prod actually return for an account we KNOW has a password method?',
    async observe() {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const email = `oracle-fsime-${stamp}@oracle.test`;
      const password = 'oracle-pw-123';
      let forKnownAccount: string[] | null = null;
      let forUnknownAccount: string[] | null = null;

      const code = await attemptCode(async () => {
        await createUserWithEmailAndPassword(auth, email, password);
        await signOut(auth);
        // This account definitively HAS a password sign-in method.
        forKnownAccount = await fetchSignInMethodsForEmail(auth, email);
        forUnknownAccount = await fetchSignInMethodsForEmail(auth, `oracle-nobody-${stamp}@oracle.test`);
      });

      const cleanupLeaked = (await attemptCode(async () => {
        await signInWithEmailAndPassword(auth, email, password);
        await deleteUser(auth.currentUser!);
      })) !== null;
      await dropCurrentUser();
      const knownMethods = forKnownAccount as string[] | null;
      return {
        code,
        forKnownAccountWithPassword: forKnownAccount,
        forUnknownAccount,
        // The tell: an account we JUST created with a password comes back
        // with an empty list => Email Enumeration Protection is on and the
        // API is functionally dead against a modern project.
        emptyForAccountThatHasAPasswordMethod: knownMethods !== null && knownMethods.length === 0,
        cleanupLeaked,
      };
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[oracle] firebase-js-sdk ${FB_SDK_VERSION}`);
  console.log(`[oracle] project: ${config.projectId}`);
  console.log(`[oracle] run id: ${RUN_ID}`);

  // Optional CLI filter: `bun run packages/conformance/src/run.ts foo bar` runs
  // only probes whose name contains any of those substrings. Empty →
  // run them all. Lets you re-run a subset without churning every
  // observation file.
  const argv = process.argv.slice(2);
  const filters = argv.filter((a) => !a.startsWith('-'));
  const selected = filters.length === 0
    ? probes
    : probes.filter((p) => filters.some((f) => p.name.includes(f)));
  if (filters.length > 0) {
    console.log(`[oracle] filter: ${filters.join(', ')} → ${selected.length} of ${probes.length} probes`);
  } else {
    console.log(`[oracle] running ${probes.length} probes against real cloud services`);
  }

  for (const probe of selected) {
    process.stdout.write(`[oracle] ${probe.name} (${probe.matrixRow}) ... `);
    const t0 = Date.now();
    try {
      const behavior = await probe.observe();
      const obs: Observation = {
        name: probe.name,
        matrixRow: probe.matrixRow,
        rowIds: probe.rowIds,
        description: probe.description,
        observedAt: new Date().toISOString(),
        fbSdkVersion: FB_SDK_VERSION,
        projectId: config.projectId,
        behavior,
      };
      writeObservation(obs);
      const dt = Date.now() - t0;
      console.log(`OK (${dt}ms) ${JSON.stringify(behavior)}`);
    } catch (e) {
      console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    } finally {
      await purge(probe.name.replace(/^firestore-|^auth-/, ''));
    }
  }

  await deleteApp(app);
  console.log('[oracle] observations written to observations/<surface>/');
}

await main();
