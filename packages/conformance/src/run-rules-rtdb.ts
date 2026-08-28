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
 * `packages/conformance/observations/rtdb-rules/rules-rtdb-<scenario.id>.json`.
 *
 * TWO INVARIANTS ARE THE GATE, and the run is clean only if BOTH read back
 * verified:
 *   RULES RESTORED — the pre-run ruleset is rewritten and read back, canonical-
 *     JSON identical to the pre-run snapshot.
 *   DATA REMOVED — the corpus ops write synthetic data beneath the run-scoped
 *     namespace `/pyric_oracle_rulesrtdb_<runId>`, so the runner deletes that
 *     namespace and proves it gone with a shallow read of the root.
 * deploy → capture → restore + cleanup → read-back verify runs as one guarded
 * sequence: ANY failure mid-run (deploy, op loop, or either read-back) aborts
 * loudly AND still attempts both the restore and the data cleanup before exit.
 * Observations are written only once both invariants verify — a run that cannot
 * prove it left the database as it found it is not a clean capture.
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
 *     bun run packages/conformance/src/run-rules-rtdb.ts \
 *     --scenario r15-validate-ancestor-scope
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
import { resolvedFirebaseVersion } from './package-version.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
// rules-rtdb-* observations belong to the 'rtdb-rules' surface subdirectory
// (surfaces/rtdb-rules.json owns the prefix), NOT the SDK-plane 'rtdb' one.
const OBS_DIR = join(HERE, '..', 'observations', 'rtdb-rules');

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

interface ObservationLinkage {
  matrixRow: string;
  rowIds: string[];
}

/** Absolute path an observation for `scenario` writes to. */
function observationPath(scenario: RtdbScenario): string {
  return join(OBS_DIR, `${rtdbObservationName(scenario)}.json`);
}

function totalCases(scenarios: readonly RtdbScenario[]): number {
  return scenarios.reduce((n, scenario) => n + scenario.cases.length, 0);
}

export function selectRtdbScenarios(args: readonly string[]): RtdbScenario[] {
  let selectedId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--scenario') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--scenario requires an id');
      if (selectedId) throw new Error('--scenario may be supplied only once');
      selectedId = value;
      index++;
      continue;
    }
    if (arg.startsWith('--scenario=')) {
      const value = arg.slice('--scenario='.length);
      if (!value) throw new Error('--scenario requires an id');
      if (selectedId) throw new Error('--scenario may be supplied only once');
      selectedId = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!selectedId) return ALL_RULES_RTDB_SCENARIOS;
  const scenario = ALL_RULES_RTDB_SCENARIOS.find((candidate) => candidate.id === selectedId);
  if (!scenario) throw new Error(`unknown RTDB scenario: ${selectedId}`);
  return [scenario];
}

export function observationLinkageOf(value: unknown): ObservationLinkage {
  if (!value || typeof value !== 'object') return { matrixRow: '', rowIds: [] };
  const record = value as Record<string, unknown>;
  return {
    matrixRow: typeof record.matrixRow === 'string' ? record.matrixRow : '',
    rowIds: Array.isArray(record.rowIds)
      ? record.rowIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

export function assertMatchingOracleProjects(
  config: Pick<FirebaseWebConfig, 'projectId'>,
  serviceAccount: Pick<ServiceAccount, 'project_id'>,
): void {
  if (config.projectId !== serviceAccount.project_id) {
    throw new Error(
      `oracle project mismatch: Web config is ${config.projectId}, service account is ${serviceAccount.project_id}`,
    );
  }
}

function printInertPlan(scenarios: readonly RtdbScenario[]): void {
  console.log('[oracle:rules-rtdb] PYRIC_ORACLE_FIREBASE_CONFIG not set — INERT preview, no network calls.\n');
  console.log('  Credential env vars expected:');
  console.log('    PYRIC_ORACLE_FIREBASE_CONFIG  (Web SDK config JSON with databaseURL + apiKey; gates capture)');
  console.log('    PYRIC_ORACLE_SA_PATH          (service-account JSON path for the rules-deploy admin token;');
  console.log('                                   defaults to ignored/service-account.json)\n');
  console.log(`  Observation output directory: ${OBS_DIR}`);
  console.log(`  Observation filename prefix:  ${RULES_RTDB_OBSERVATION_PREFIX}\n`);
  console.log('  Capture protocol: deploy → execute ops on live RTDB → restore rules + delete run data → read-back verify both.');
  console.log('                    RTDB has no server-side rules test API, so production truth is observed by deploying real rules.');
  console.log('                    Clean run = rules canonical-JSON identical to the pre-run snapshot AND the run-scoped data');
  console.log('                    namespace absent from a shallow root read.\n');
  console.log(`  Would capture ${scenarios.length} scenario(s):`);
  for (const scenario of scenarios) {
    const pending = scenario.cases.filter((c) => c.pendingCapture).length;
    const pendingNote = pending > 0 ? ` (${pending} pending-capture, excluded from replay)` : '';
    console.log(
      `    - ${scenario.id.padEnd(28)} [${scenario.fm.padEnd(8)}] ` +
        `${String(scenario.cases.length).padStart(2)} cases${pendingNote} → ${rtdbObservationName(scenario)}.json`,
    );
  }
  console.log(`\n  Total: ${scenarios.length} scenarios, ${totalCases(scenarios)} cases.`);
  console.log('\n  To capture for real:');
  console.log('    PYRIC_ORACLE_FIREBASE_CONFIG="$(cat oracle-web-config.json)" \\');
  console.log('      PYRIC_ORACLE_SA_PATH=ignored/service-account.json \\');
  console.log('      bun run packages/conformance/src/run-rules-rtdb.ts --scenario <scenario-id>');
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

/**
 * The database operations run-data cleanup needs, narrowed to two calls so the
 * cleanup contract can be tested against a fake without credentials or network.
 */
export interface RunDataStore {
  /** Delete everything beneath the run-scoped namespace (admin, rules-bypassing). */
  deleteNamespace(auditKey: string): Promise<void>;
  /** Root-level keys via a shallow read — the deletion's independent witness. */
  shallowRootKeys(): Promise<string[]>;
}

/**
 * DATA CLEANUP INVARIANT: the corpus ops write synthetic data beneath
 * `/<auditKey>`, and a run that restores the rules but leaves that data behind
 * has not cleaned up after itself. So the runner deletes the namespace and then
 * PROVES the deletion the same way it proves the rules restore — by reading
 * back. A shallow read of the root must no longer list `auditKey`; a delete that
 * "succeeded" but left the key visible is a failed cleanup, not a clean run.
 *
 * Throws on a failed deletion or a failed read-back so the caller can refuse to
 * treat the run as clean.
 */
export async function verifyRunDataCleanup(store: RunDataStore, auditKey: string): Promise<void> {
  await store.deleteNamespace(auditKey);
  const rootKeys = await store.shallowRootKeys();
  if (rootKeys.includes(auditKey)) {
    throw new Error(
      `data cleanup NOT verified — shallow read of the database root still lists the run-scoped namespace '${auditKey}' after deletion.`,
    );
  }
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

async function capture(scenarios: readonly RtdbScenario[]): Promise<void> {
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
  assertMatchingOracleProjects(config, serviceAccount);
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

  // The run-data store, over the REST API with the admin token — it bypasses
  // rules, so cleanup works regardless of whether the restored rules would let
  // the anonymous client delete its own writes (they would not).
  const auth_ = encodeURIComponent(rtdbAdminToken);
  const store: RunDataStore = {
    async deleteNamespace(auditKey: string): Promise<void> {
      const res = await fetch(`${config.databaseURL}/${auditKey}.json?access_token=${auth_}&print=silent`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`delete run data failed: ${res.status} ${await res.text()}`);
    },
    async shallowRootKeys(): Promise<string[]> {
      const res = await fetch(`${config.databaseURL}/.json?shallow=true&access_token=${auth_}`);
      if (!res.ok) throw new Error(`shallow root read failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as Record<string, unknown> | null;
      return body ? Object.keys(body) : [];
    },
  };

  // Snapshot the pre-run rules — the restore target and read-back compare basis.
  const beforeRules = await readRules();
  const beforeCanonical = canonicalize(beforeRules);
  console.log('[oracle:rules-rtdb] snapshotted pre-run rules.');

  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const auditKey = `pyric_oracle_rulesrtdb_${runId}`;

  const app = initializeApp(config, `oracle-rules-rtdb-${runId}`);
  const auth = getAuth(app);
  const rtdb = getDatabase(app);
  const adminApp = adminInitializeApp(
    {
      credential: adminCert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: serviceAccount.private_key,
      }),
      databaseURL: config.databaseURL,
    },
    `oracle-rules-rtdb-admin-${runId}`,
  );
  const adminDb = getAdminDatabase(config.databaseURL, adminApp);

  const observations: { scenario: RtdbScenario; behavior: Record<string, 'ALLOW' | 'DENY'> }[] = [];
  let restoreVerified = false;
  let dataCleanupVerified = false;

  try {
    // Deploy every scenario's subtree under `<auditKey>/<scenario.id>`, merged with the
    // existing rules so real rules are preserved.
    const auditSubtree: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      auditSubtree[scenario.id] = JSON.parse(scenario.rules);
    }
    await writeRules({ ...beforeRules, [auditKey]: auditSubtree });
    console.log(`[oracle:rules-rtdb] deployed ${scenarios.length} scenario subtree(s) under /${auditKey}. Waiting 8s to propagate.`);
    await new Promise((r) => setTimeout(r, 8_000));

    await signInAnonymously(auth);

    for (const scenario of scenarios) {
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
        const mountPath = `/${auditKey}/${scenario.id}`;
        const fullPath = `${mountPath}${opPath}`;

        // Replay starts every case from an empty root, then applies its declared
        // seed and mockData. Production capture must start from the same state:
        // clear only this scenario's run-scoped data, then write preconditions
        // through the rules-bypassing admin adapter.
        await adminDb.ref(mountPath).set(null);
        for (const [seedPath, seedValue] of Object.entries(tc.seed ?? {})) {
          await adminDb
            .ref(`${mountPath}${substituteUid(seedPath, liveUid)}`)
            .set(substituteUid(seedValue, liveUid));
        }
        if (mockData !== undefined && mockData !== null) {
          await adminDb.ref(fullPath).set(mockData);
        }

        let allowed = false;
        try {
          if (tc.operation === 'read') {
            await rtdbGet(rtdbRef(rtdb, fullPath));
          } else {
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
    // Data cleanup + read-back verify ALWAYS runs too. Restoring the rules but
    // leaving the corpus ops' synthetic data behind is not a clean run: the
    // run-scoped namespace must be gone, proven by a shallow read.
    try {
      await verifyRunDataCleanup(store, auditKey);
      dataCleanupVerified = true;
      console.log(`[oracle:rules-rtdb] data cleanup verified — /${auditKey} deleted and absent from a shallow root read.`);
    } catch (e) {
      console.error(`[oracle:rules-rtdb] DATA CLEANUP FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    try { await deleteApp(app); } catch { /* ignored */ }
    try { await adminDeleteApp(adminApp); } catch { /* ignored */ }
  }

  // Only write observations once BOTH invariants held. A run that could not
  // prove it left the database as it found it — same rules, no residual data —
  // must not be treated as a clean capture.
  if (!restoreVerified) {
    throw new Error('restore invariant NOT verified — refusing to write observations. Inspect the database rules manually.');
  }
  if (!dataCleanupVerified) {
    throw new Error(`data cleanup invariant NOT verified — refusing to write observations. Delete /${auditKey} manually.`);
  }

  mkdirSync(OBS_DIR, { recursive: true });
  for (const { scenario, behavior } of observations) {
    const path = observationPath(scenario);
    const linkage = existsSync(path)
      ? observationLinkageOf(JSON.parse(readFileSync(path, 'utf8')))
      : observationLinkageOf(undefined);
    const obs: Observation = {
      name: rtdbObservationName(scenario),
      matrixRow: linkage.matrixRow,
      rowIds: linkage.rowIds,
      description: `RTDB rules production verdicts for corpus scenario "${scenario.id}" (${scenario.fm}). Captured by deploy-observe-restore (RTDB has no server-side rules test API). ${scenario.rationale}`,
      observedAt: new Date().toISOString(),
      fbSdkVersion,
      projectId: config.projectId,
      behavior,
    };
    writeFileSync(path, JSON.stringify(obs, null, 2) + '\n');
    console.log(`  → wrote ${rtdbObservationName(scenario)}.json`);
  }

  console.log('\n[oracle:rules-rtdb] capture complete — rules restored and run data removed, both read-back verified.');
  console.log('[oracle:rules-rtdb] Existing observation matrixRow/rowIds linkage was preserved.');
  console.log('[oracle:rules-rtdb] NEXT: review the observation diff, then run `bun run compat:validate`.');
}

if (import.meta.main) {
  const scenarios = selectRtdbScenarios(process.argv.slice(2));
  if (!process.env.PYRIC_ORACLE_FIREBASE_CONFIG) {
    printInertPlan(scenarios);
    process.exit(0);
  }
  await capture(scenarios);
}
