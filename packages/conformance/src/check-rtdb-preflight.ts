/**
 * RTDB preflight for the empirical oracle harness.
 *
 * The RTDB probes in `run.ts` need three things that the Firestore/Auth
 * probes don't, and each one fails in a different, easy-to-misread way if
 * it's missing. This script checks all three BEFORE a full oracle run and
 * prints a precise, copy-pasteable remediation per failure so you don't
 * burn a run discovering the setup gap probe-by-probe:
 *
 *   1. the configured project has an RTDB instance (a `databaseURL`);
 *   2. Anonymous sign-in is enabled (every RTDB probe signs in anon);
 *   3. `/pyric_oracle/*` is writable by an authed anon user (the rules
 *      namespace the whole RTDB suite writes under).
 *
 * It is READ-MOSTLY: the only write is a single scratch node under
 * `/pyric_oracle/__preflight__/<ts>` which it removes on the way out. It
 * runs entirely against the client Web SDK using the config in
 * `PYRIC_ORACLE_FIREBASE_CONFIG` — no service account, no admin token, no
 * Management API. That mirrors exactly what the client-plane RTDB probes
 * can see, so a green preflight means the probes' happy path is reachable.
 *
 * Usage:
 *   export PYRIC_ORACLE_FIREBASE_CONFIG='{"apiKey":"…","authDomain":"…","projectId":"…","databaseURL":"https://<id>-default-rtdb.<region>.firebasedatabase.app","appId":"…"}'
 *   bun run packages/conformance/src/check-rtdb-preflight.ts
 *
 * Exit code is 0 when every check passes, 1 otherwise. Intended as a gate
 * you can run before `bun run packages/conformance/src/run.ts`.
 */

import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  signInAnonymously,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  getDatabase,
  ref as rtdbRef,
  set as rtdbSet,
  get as rtdbGet,
  remove as rtdbRemove,
  type Database,
} from 'firebase/database';

// ─── Config ───────────────────────────────────────────────────────────

interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  databaseURL?: string;
}

// The exact RTDB rules the harness needs — mirrored from
// packages/conformance/docs/oracle-project-setup.md ("Loosen the rules"). Printed verbatim in the
// permission-denied remediation so the fix is copy-paste.
const ORACLE_RTDB_RULES_SNIPPET = `{
  "rules": {
    ".read": false,
    ".write": false,
    "pyric_oracle": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}`;

// ─── Result plumbing ──────────────────────────────────────────────────

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Multi-line remediation printed when `ok` is false. */
  remediation?: string;
}

const results: CheckResult[] = [];

function pass(name: string, detail: string): void {
  results.push({ name, ok: true, detail });
}

function fail(name: string, detail: string, remediation: string): void {
  results.push({ name, ok: false, detail, remediation });
}

/** Load + validate the Web config from the environment. Throws with a
 *  remediation-shaped message when the var is missing or not JSON — that
 *  is a hard stop (nothing else can run). */
function loadConfig(): FirebaseWebConfig {
  const raw = process.env.PYRIC_ORACLE_FIREBASE_CONFIG;
  if (!raw) {
    throw new Error(
      [
        'PYRIC_ORACLE_FIREBASE_CONFIG is not set.',
        '',
        'Remediation:',
        '  1. Firebase Console → Project Settings → General → Your apps → Web app.',
        '  2. Copy the config object (apiKey, authDomain, projectId, databaseURL, appId).',
        "  3. export PYRIC_ORACLE_FIREBASE_CONFIG='{\"apiKey\":\"…\",\"authDomain\":\"…\",\"projectId\":\"…\",\"databaseURL\":\"https://<id>-default-rtdb.<region>.firebasedatabase.app\",\"appId\":\"…\"}'",
        '',
        'See packages/conformance/docs/oracle-project-setup.md → "One-time project setup".',
      ].join('\n'),
    );
  }
  try {
    return JSON.parse(raw) as FirebaseWebConfig;
  } catch (e) {
    throw new Error(
      `PYRIC_ORACLE_FIREBASE_CONFIG is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n` +
        'It must be the Web config object as a single-line JSON string.',
    );
  }
}

// ─── Check 1: RTDB instance present ───────────────────────────────────

/** A pasted Web config only carries `databaseURL` when the project had an
 *  RTDB instance at app-creation time. Absent → the project either has no
 *  RTDB or the config predates it. Either way, client-side probes cannot
 *  reach RTDB, so this is a hard stop. */
function checkRtdbInstance(config: FirebaseWebConfig): boolean {
  const url = config.databaseURL?.trim();
  if (url && /^https?:\/\/.+/.test(url)) {
    pass('rtdb-instance', `databaseURL present: ${url}`);
    return true;
  }
  fail(
    'rtdb-instance',
    url
      ? `databaseURL is present but not a URL: ${JSON.stringify(url)}`
      : 'databaseURL is missing from PYRIC_ORACLE_FIREBASE_CONFIG',
    [
      'The oracle project has no reachable RTDB instance in this config.',
      '',
      'Remediation:',
      '  1. Firebase Console → Build → Realtime Database → Create Database.',
      '     Pick any region; stay on the free (Spark) tier — probe traffic is negligible.',
      '  2. Firebase Console → Project Settings → General → Your apps → Web app,',
      '     re-copy the config: it now includes a "databaseURL" field.',
      '  3. Re-export PYRIC_ORACLE_FIREBASE_CONFIG with that "databaseURL", e.g.',
      '     "databaseURL": "https://<projectId>-default-rtdb.<region>.firebasedatabase.app"',
      '',
      'Note: run.ts can also discover the instance via the Firebase Database',
      'Management API when it runs from a service account, but this preflight',
      'is client-only and needs databaseURL in the config to reach RTDB.',
    ].join('\n'),
  );
  return false;
}

// ─── Check 2: anonymous auth enabled ──────────────────────────────────

/** Signs in anonymously. Returns the signed-in user (for cleanup) or null
 *  on failure. The most common failure is Anonymous sign-in being disabled
 *  in the console, which surfaces as `auth/operation-not-allowed`,
 *  `auth/admin-restricted-operation`, or `auth/configuration-not-found`. */
async function checkAnonymousAuth(auth: Auth): Promise<User | null> {
  try {
    const cred = await signInAnonymously(auth);
    pass('anonymous-auth', `signed in anonymously (uid ${cred.user.uid})`);
    return cred.user;
  } catch (e) {
    const code = (e as { code?: string }).code ?? '(no code)';
    const message = e instanceof Error ? e.message : String(e);
    fail(
      'anonymous-auth',
      `signInAnonymously failed: ${code} — ${message}`,
      [
        'Anonymous sign-in appears to be disabled on the oracle project.',
        '',
        'Remediation:',
        '  1. Firebase Console → Build → Authentication → Sign-in method.',
        '  2. Add / enable the "Anonymous" provider → Save.',
        '  3. Wait a few seconds for the setting to propagate, then re-run.',
        '',
        'Every RTDB probe signs in anonymously, so all of them will fail until',
        'this is enabled. See packages/conformance/docs/oracle-project-setup.md → "Enable Anonymous sign-in".',
      ].join('\n'),
    );
    return null;
  }
}

// ─── Check 3: writable /pyric_oracle path ─────────────────────────────

/** Round-trips a scratch write under /pyric_oracle. A rules gap surfaces
 *  as a PERMISSION_DENIED on the set (plain Error, message contains
 *  "permission_denied"); the remediation prints the exact rules JSON. */
async function checkWritablePath(db: Database): Promise<void> {
  const scratchPath = `/pyric_oracle/__preflight__/${Date.now()}`;
  const scratchRef = rtdbRef(db, scratchPath);
  try {
    await rtdbSet(scratchRef, { preflight: true, at: Date.now() });
    // Read it back so we exercise the .read rule too, not just .write.
    const snap = await rtdbGet(scratchRef);
    const roundTripped =
      snap.exists() &&
      (snap.val() as { preflight?: boolean } | null)?.preflight === true;
    if (roundTripped) {
      pass('writable-pyric-oracle', `set + get round-tripped at ${scratchPath}`);
    } else {
      fail(
        'writable-pyric-oracle',
        `write succeeded but read-back did not match at ${scratchPath} (exists=${snap.exists()})`,
        rulesRemediation(
          'The .write rule allowed the write but the .read rule did not return it.',
        ),
      );
    }
  } catch (e) {
    const code = (e as { code?: string }).code ?? '(no code)';
    const message = e instanceof Error ? e.message : String(e);
    fail(
      'writable-pyric-oracle',
      `write/read under /pyric_oracle denied: ${code || '(no code)'} — ${message}`,
      rulesRemediation(
        `The authed anon user could not read/write /pyric_oracle (${message}).`,
      ),
    );
  } finally {
    // Best-effort cleanup of the scratch node regardless of outcome.
    try {
      await rtdbRemove(scratchRef);
    } catch {
      /* ignored — leftover scratch node is harmless and self-namespaced */
    }
  }
}

function rulesRemediation(lead: string): string {
  return [
    lead,
    '',
    'Remediation:',
    '  1. Firebase Console → Build → Realtime Database → Rules.',
    '  2. Ensure the /pyric_oracle subtree is authed-read/write. Paste (or merge):',
    '',
    ORACLE_RTDB_RULES_SNIPPET.split('\n')
      .map((l) => `     ${l}`)
      .join('\n'),
    '',
    '  3. Publish the rules and wait ~5s for propagation, then re-run.',
    '',
    'See packages/conformance/docs/oracle-project-setup.md → "Realtime Database probes" → "Loosen the rules".',
  ].join('\n');
}

// ─── Runner ───────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let config: FirebaseWebConfig;
  try {
    config = loadConfig();
  } catch (e) {
    console.error('[rtdb-preflight] FATAL: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  console.log(`[rtdb-preflight] project: ${config.projectId ?? '(unknown)'}`);

  // Check 1 is a gate: without a databaseURL, initializeApp has no RTDB
  // to talk to, so checks 2/3 can't run meaningfully.
  const hasInstance = checkRtdbInstance(config);

  let app: FirebaseApp | null = null;
  let user: User | null = null;
  if (hasInstance) {
    app = initializeApp(config, `pyric-rtdb-preflight-${Date.now()}`);
    const auth: Auth = getAuth(app);
    user = await checkAnonymousAuth(auth);
    // Check 3 needs an authed user (rules require auth != null). Only run
    // it once anon sign-in succeeded — otherwise the denial is just a
    // restatement of check 2 and would print a misleading rules message.
    if (user) {
      const db: Database = getDatabase(app);
      await checkWritablePath(db);
    } else {
      fail(
        'writable-pyric-oracle',
        'skipped — anonymous sign-in failed, cannot exercise authed rules',
        'Fix "anonymous-auth" above first; the /pyric_oracle rules require auth != null.',
      );
    }
  } else {
    // Surface the downstream checks as skipped so the summary is complete.
    fail(
      'anonymous-auth',
      'skipped — no RTDB instance to authenticate against',
      'Fix "rtdb-instance" above first.',
    );
    fail(
      'writable-pyric-oracle',
      'skipped — no RTDB instance to write to',
      'Fix "rtdb-instance" above first.',
    );
  }

  // Cleanup — delete the anon user we minted and tear down the app.
  if (user && user.isAnonymous) {
    try {
      await user.delete();
    } catch {
      /* ignored — leaked anon user is free up to 50k MAU (see README) */
    }
  }
  if (app) {
    try {
      await deleteApp(app);
    } catch {
      /* ignored */
    }
  }

  // ─── Report ─────────────────────────────────────────────────────────
  console.log('');
  console.log('[rtdb-preflight] results:');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
  }
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.log('');
    for (const f of failures) {
      console.log(`─── remediation: ${f.name} ─────────────────────────────`);
      console.log(f.remediation ?? '(no remediation)');
      console.log('');
    }
    console.log(`[rtdb-preflight] ${failures.length} check(s) failed — RTDB probes are NOT ready.`);
    return 1;
  }
  console.log('');
  console.log('[rtdb-preflight] all checks passed — RTDB probes are ready to run.');
  return 0;
}

process.exit(await main());
