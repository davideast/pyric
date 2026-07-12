#!/usr/bin/env bun
/**
 * RTDB rules oracle capture runner.
 *
 * The RTDB sibling of run-rules.ts / run-rules-storage.ts — but RTDB has NO
 * server-side rules test API (no `firebaserules projects.test` equivalent), so
 * production truth cannot be read from an endpoint. This runner captures it the
 * way the `rtdb-simulator-vs-prod-agreement` probe does: it DEPLOYS each corpus
 * scenario's ruleset subtree to the dedicated oracle database under a unique
 * run-scoped audit namespace (merged with, never replacing, the existing
 * rules), EXECUTES each op against the live service to record the production
 * allow/deny verdict, then RESTORES the prior ruleset and VERIFIES the restore
 * by reading the rules back and comparing (canonical JSON) to the pre-run
 * snapshot. One observation per scenario is written into
 * `packages/conformance/observations/rtdb/rules-rtdb-<scenario.id>.json`.
 *
 * THE RESTORE INVARIANT IS THE GATE. deploy → capture → restore → read-back
 * verify runs as one guarded sequence: ANY failure mid-run (deploy, op loop, or
 * read-back mismatch) aborts loudly AND attempts a restore before exit. The run
 * only reports success once the read-back byte-compare confirms the database's
 * rules are exactly what they were before the run.
 *
 * CREDENTIAL CONTRACT (mirrors the moved oracle run's RTDB rules deploy):
 *   PYRIC_ORACLE_FIREBASE_CONFIG — Web SDK config JSON (must carry databaseURL
 *     and apiKey). Provides the client used to run corpus ops and the RTDB
 *     instance URL. Its presence gates capture.
 *   PYRIC_ORACLE_SA_PATH — path to a service-account JSON (defaults to
 *     ignored/service-account.json). Required to mint the firebase.database-
 *     scoped OAuth token the /.settings/rules.json deploy endpoint demands and
 *     to seed data via the admin SDK. A web config alone cannot deploy RTDB
 *     rules.
 *
 * RUNNABLE-BUT-INERT WITHOUT CREDENTIALS:
 *   With PYRIC_ORACLE_FIREBASE_CONFIG absent, this runner makes NO network
 *   calls. It prints exactly what it WOULD capture (every scenario, its case count,
 *   the observation file each lands in) plus the env vars it needs, then exits
 *   0. No observation files are fabricated.
 *
 * Usage:
 *   # inert preview (no creds):
 *   bun run packages/conformance/src/run-rules-rtdb.ts
 *   # real capture (credentialed):
 *   PYRIC_ORACLE_FIREBASE_CONFIG="$(cat oracle-web-config.json)" \
 *     PYRIC_ORACLE_SA_PATH=ignored/service-account.json \
 *     bun run packages/conformance/src/run-rules-rtdb.ts
 */
import { createSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_RULES_RTDB_SCENARIOS,
  RULES_RTDB_OBSERVATION_PREFIX,
  rtdbObservationName,
  type RtdbScenario,
  type RtdbTestCase,
} from '../rules-corpus/rtdb/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
// rules-rtdb-* observations belong to the 'rtdb' surface subdirectory.
const OBS_DIR = join(HERE, '..', 'observations', 'rtdb');

interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  databaseURL?: string;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

interface Observation {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observedAt: string;
  fbSdkVersion: string;
  projectId: string;
  behavior: Record<string, unknown>;
}

/** Resolved (installed) firebase version — the value check-observation-versions.ts
 *  compares every observation against. */
function resolvedFirebaseVersion(): string {
  const pkgPath = fileURLToPath(import.meta.resolve('firebase/package.json'));
  const meta = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!meta.version) throw new Error('could not resolve installed firebase version');
  return meta.version;
}

/** Absolute path an observation for `scenario` writes to. */
function observationPath(scenario: RtdbScenario): string {
  return join(OBS_DIR, `${rtdbObservationName(scenario)}.json`);
}

function totalCases(): number {
  return ALL_RULES_RTDB_SCENARIOS.reduce((n, scenario) => n + scenario.cases.length, 0);
}

function printInertPlan(): void {
  console.log('[oracle:rules-rtdb] PYRIC_ORACLE_FIREBASE_CONFIG not set — INERT preview, no network calls.\n');
  console.log('  Credential env vars expected:');
  console.log('    PYRIC_ORACLE_FIREBASE_CONFIG  (Web SDK config JSON with databaseURL + apiKey; gates capture)');
  console.log('    PYRIC_ORACLE_SA_PATH          (service-account JSON path for the rules-deploy admin token;');
  console.log('                                   defaults to ignored/service-account.json)\n');
  console.log(`  Observation output directory: ${OBS_DIR}`);
  console.log(`  Observation filename prefix:  ${RULES_RTDB_OBSERVATION_PREFIX}\n`);
  console.log('  Capture protocol: deploy → execute ops on live RTDB → restore → read-back verify (canonical-JSON compare).');
  console.log('                    RTDB has no server-side rules test API, so production truth is observed by deploying real rules.\n');
  console.log(`  Would capture ${ALL_RULES_RTDB_SCENARIOS.length} scenario(s):`);
  for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
    const pending = scenario.cases.filter((c) => c.pendingCapture).length;
    const pendingNote = pending > 0 ? ` (${pending} pending-capture, excluded from replay)` : '';
    console.log(
      `    - ${scenario.id.padEnd(28)} [${scenario.fm.padEnd(8)}] ` +
        `${String(scenario.cases.length).padStart(2)} cases${pendingNote} → ${rtdbObservationName(scenario)}.json`,
    );
  }
  console.log(`\n  Total: ${ALL_RULES_RTDB_SCENARIOS.length} scenarios, ${totalCases()} cases.`);
  console.log('\n  To capture for real:');
  console.log('    PYRIC_ORACLE_FIREBASE_CONFIG="$(cat oracle-web-config.json)" \\');
  console.log('      PYRIC_ORACLE_SA_PATH=ignored/service-account.json \\');
  console.log('      bun run packages/conformance/src/run-rules-rtdb.ts');
}

/** Mint a short-lived OAuth access token from a service account for `scope`. */
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

/** Stable JSON serialization (sorted keys) for the restore read-back compare —
 *  a structural byte-compare resilient to key ordering / whitespace RTDB may
 *  reformat. */
function canonicalize(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

/** Recursively substitute the `<UID>` token, mirroring the agreement probe. */
function substituteUid<T>(v: T, uid: string): T {
  if (typeof v === 'string') return v.replaceAll('<UID>', uid) as unknown as T;
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((item) => substituteUid(item, uid)) as unknown as T;
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = substituteUid(val, uid);
    return out as unknown as T;
  }
  return v;
}

async function capture(): Promise<void> {
  // Heavy SDK imports are deferred to the credentialed path so the inert
  // preview stays dependency-light and always runnable.
  const { initializeApp, deleteApp } = await import('firebase/app');
  const { getAuth, signInAnonymously, signOut } = await import('firebase/auth');
  const { getDatabase, ref: rtdbRef, get: rtdbGet, set: rtdbSet } = await import('firebase/database');
  const {
    cert: adminCert,
    initializeApp: adminInitializeApp,
    deleteApp: adminDeleteApp,
  } = await import('firebase-admin/app');
  const { getDatabaseWithUrl: getAdminDatabase } = await import('firebase-admin/database');

  const config = JSON.parse(process.env.PYRIC_ORACLE_FIREBASE_CONFIG!) as FirebaseWebConfig;
  if (!config.databaseURL) {
    throw new Error('PYRIC_ORACLE_FIREBASE_CONFIG has no databaseURL — an RTDB instance URL is required to deploy and run rules.');
  }
  const saPath = process.env.PYRIC_ORACLE_SA_PATH ?? join(REPO_ROOT, 'ignored', 'service-account.json');
  if (!existsSync(saPath)) {
    throw new Error(`service account not found at ${saPath}. RTDB rules deploy requires an SA to mint the firebase.database token. Set PYRIC_ORACLE_SA_PATH.`);
  }
  const serviceAccount = JSON.parse(readFileSync(saPath, 'utf8')) as ServiceAccount;
  const fbSdkVersion = resolvedFirebaseVersion();

  console.log(`[oracle:rules-rtdb] project: ${config.projectId}`);
  console.log(`[oracle:rules-rtdb] database: ${config.databaseURL}`);
  console.log(`[oracle:rules-rtdb] service account: ${serviceAccount.client_email}`);
  console.log(`[oracle:rules-rtdb] firebase ${fbSdkVersion}\n`);

  const rtdbAdminToken = await mintToken(
    serviceAccount,
    'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
  );
  const rulesGetUrl = `${config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}`;
  const rulesPutUrl = `${config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}&print=silent`;

  async function readRules(): Promise<Record<string, unknown>> {
    const res = await fetch(rulesGetUrl);
    if (!res.ok) throw new Error(`read rules failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as Record<string, unknown>;
    return (body.rules ?? {}) as Record<string, unknown>;
  }
  async function writeRules(rules: Record<string, unknown>): Promise<void> {
    const res = await fetch(rulesPutUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    if (!res.ok) throw new Error(`write rules failed: ${res.status} ${await res.text()}`);
  }

  // Snapshot the pre-run rules — the restore target and read-back compare basis.
  const beforeRules = await readRules();
  const beforeCanonical = canonicalize(beforeRules);
  console.log('[oracle:rules-rtdb] snapshotted pre-run rules.');

  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const auditKey = `pyric_oracle_rulesrtdb_${runId}`;

  const app = initializeApp(config, `oracle-rules-rtdb-${runId}`);
  const auth = getAuth(app);
  const rtdb = getDatabase(app);

  const observations: { scenario: RtdbScenario; behavior: Record<string, 'ALLOW' | 'DENY'> }[] = [];
  let restoreVerified = false;

  try {
    // Deploy every scenario's subtree under `<auditKey>/<scenario.id>`, merged with the
    // existing rules so real rules are preserved.
    const auditSubtree: Record<string, unknown> = {};
    for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
      auditSubtree[scenario.id] = JSON.parse(scenario.rules);
    }
    await writeRules({ ...beforeRules, [auditKey]: auditSubtree });
    console.log(`[oracle:rules-rtdb] deployed ${ALL_RULES_RTDB_SCENARIOS.length} scenario subtree(s) under /${auditKey}. Waiting 8s to propagate.`);
    await new Promise((r) => setTimeout(r, 8_000));

    await signInAnonymously(auth);

    for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
      const behavior: Record<string, 'ALLOW' | 'DENY'> = {};
      for (const tc of scenario.cases as RtdbTestCase[]) {
        // Match auth context to the case.
        if (tc.authPresent && !auth.currentUser) {
          await signInAnonymously(auth);
        } else if (!tc.authPresent && auth.currentUser) {
          await signOut(auth);
        }
        const liveUid = auth.currentUser?.uid ?? '';
        const opPath = substituteUid(tc.opPath, liveUid);
        const newData = tc.newData !== undefined ? substituteUid(tc.newData, liveUid) : undefined;
        const mockData = tc.mockData !== undefined ? substituteUid(tc.mockData, liveUid) : undefined;
        const fullPath = `/${auditKey}/${scenario.id}${opPath}`;

        let allowed = false;
        try {
          if (tc.operation === 'read') {
            await rtdbGet(rtdbRef(rtdb, fullPath));
          } else {
            // Seed the pre-existing value (mockData) via the admin SDK so the
            // rule sees it, bypassing the rule under test.
            if (mockData !== undefined && mockData !== null) {
              const seedApp = adminInitializeApp(
                {
                  credential: adminCert({
                    projectId: serviceAccount.project_id,
                    clientEmail: serviceAccount.client_email,
                    privateKey: serviceAccount.private_key,
                  }),
                  databaseURL: config.databaseURL,
                },
                `oracle-rules-rtdb-seed-${runId}-${scenario.id}-${tc.description.replace(/\s+/g, '_')}`,
              );
              try {
                await getAdminDatabase(config.databaseURL, seedApp).ref(fullPath).set(mockData);
              } finally {
                try { await adminDeleteApp(seedApp); } catch { /* ignored */ }
              }
            }
            await rtdbSet(rtdbRef(rtdb, fullPath), newData ?? null);
          }
          allowed = true;
        } catch {
          allowed = false;
        }
        behavior[tc.description] = allowed ? 'ALLOW' : 'DENY';
      }
      observations.push({ scenario, behavior });
      const allows = Object.values(behavior).filter((v) => v === 'ALLOW').length;
      const denies = Object.values(behavior).filter((v) => v === 'DENY').length;
      console.log(`  ✓ ${scenario.id.padEnd(28)} allow=${allows} deny=${denies}`);
    }

    if (auth.currentUser) {
      try { await signOut(auth); } catch { /* ignored */ }
    }
  } finally {
    // Restore + read-back verify ALWAYS runs, success or failure.
    try {
      await writeRules(beforeRules);
      const afterRules = await readRules();
      if (canonicalize(afterRules) === beforeCanonical) {
        restoreVerified = true;
        console.log('[oracle:rules-rtdb] restore verified — rules read back identical to pre-run snapshot.');
      } else {
        console.error('[oracle:rules-rtdb] RESTORE VERIFY FAILED — read-back rules differ from the pre-run snapshot!');
      }
    } catch (e) {
      console.error(`[oracle:rules-rtdb] RESTORE FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    try { await deleteApp(app); } catch { /* ignored */ }
  }

  // Only write observations once the restore invariant held. A run that could
  // not prove it left the database as it found it must not be treated as a
  // clean capture.
  if (!restoreVerified) {
    throw new Error('restore invariant NOT verified — refusing to write observations. Inspect the database rules manually.');
  }

  mkdirSync(OBS_DIR, { recursive: true });
  for (const { scenario, behavior } of observations) {
    const obs: Observation = {
      name: rtdbObservationName(scenario),
      matrixRow: '',
      rowIds: [],
      description: `RTDB rules production verdicts for corpus scenario "${scenario.id}" (${scenario.fm}). Captured by deploy-observe-restore (RTDB has no server-side rules test API). ${scenario.rationale}`,
      observedAt: new Date().toISOString(),
      fbSdkVersion,
      projectId: config.projectId,
      behavior,
    };
    writeFileSync(observationPath(scenario), JSON.stringify(obs, null, 2) + '\n');
    console.log(`  → wrote ${rtdbObservationName(scenario)}.json`);
  }

  console.log('\n[oracle:rules-rtdb] capture complete.');
  console.log('[oracle:rules-rtdb] NEXT: promote the rules-rtdb- prefix from pendingPrefixes to');
  console.log('               observationPrefixes on rig rtdb-rules, wire each observation into the');
  console.log('               compat registry (a matrix row citing it, or an observationExceptions');
  console.log('               entry), then run `bun run compat:validate`.');
}

if (import.meta.main) {
  if (!process.env.PYRIC_ORACLE_FIREBASE_CONFIG) {
    printInertPlan();
    process.exit(0);
  }
  await capture();
}
