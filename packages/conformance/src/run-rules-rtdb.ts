#!/usr/bin/env bun
/**
 * RTDB rules oracle capture runner (`deploy -> observe -> restore + read-back`).
 *
 * Enforces two invariants before writing observations into `observations/rtdb-rules/`:
 *   1. RULES RESTORED: pre-run rules rewritten and read back (3-attempt retry,
 *      guarded against SIGINT/SIGTERM and in-flight PUT races).
 *   2. DATA & USERS REMOVED: `/pyric_oracle_rulesrtdb_<runId>` deleted and
 *      proven absent via shallow root read, and run-created Auth users deleted.
 *
 * Requires `--write` plus `PYRIC_ORACLE_FIREBASE_CONFIG` (or `PYRIC_ORACLE_RTDB_URL`
 * naming a dedicated non-default RTDB instance) and an oracle credential.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
  RULES_RTDB_OBSERVATION_PREFIX,
  rtdbObservationName,
  type RtdbCaseQuery,
  type RtdbDeployScenario,
  type RtdbCaseIdentity,
  type RtdbScenario,
  type RtdbTestCase,
} from '../rules-corpus/rtdb/index.ts';
import { RTDB_RULES_SCOPE } from './oracle-access-token.ts';
import {
  loadOracleServiceAccount,
  oracleAccessToken,
  oracleAppOptions,
  oracleCredentialConfigured,
  oracleServiceAccountEmail,
  signOracleJwt,
  type OracleServiceAccount,
} from './oracle-credential.ts';
import { assertDedicatedOracleRtdbUrl } from './oracle-run-setup.ts';
import {
  createSignalRestoreCoordinator,
  restoreRtdbRulesWithRetry,
} from './oracle-signal-restore.ts';
import { resolvedFirebaseVersion } from './package-version.ts';
import { canonicalize, type RulesDeployEndpoint } from './rtdb-rules-deploy.ts';
import { orderDeployScenarios, runDeployScenarios } from './rtdb-rules-deploy-run.ts';
import { restoreRulesBeforeLatePhase, runCapturePhases, type CapturedObservation } from './rtdb-rules-capture-run.ts';
import { fetchWithRateLimitRetry } from './rtdb-rules-rate-limit.ts';
import {
  formatInertPreviewFooter,
  requireCaptureMode,
  stripCaptureFlags,
} from './capture-mode-guard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// rules-rtdb-* observations belong to the 'rtdb-rules' surface subdirectory
// (surfaces/rtdb-rules.json owns the prefix), NOT the SDK-plane 'rtdb' one.
const OBS_DIR = join(HERE, '..', 'observations', 'rtdb-rules');

interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  databaseURL?: string;
}

/** The oracle credential: a key file, or Application Default Credentials. */
type ServiceAccount = OracleServiceAccount;

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
function observationPath(scenario: { id: string }): string {
  return join(OBS_DIR, `${rtdbObservationName(scenario)}.json`);
}

function totalCases(scenarios: readonly RtdbScenario[]): number {
  return scenarios.reduce((n, scenario) => n + scenario.cases.length, 0);
}

/** The operation and deploy scenarios one run captures. */
export interface RtdbSelection {
  scenarios: RtdbScenario[];
  deployScenarios: RtdbDeployScenario[];
}

/** The ids one `--scenario` value names, comma-separated. */
function scenarioIdsOf(value: string | undefined): string[] {
  const isMissing = !value || value.startsWith('--');
  if (isMissing) throw new Error('--scenario requires an id');
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => id === '')) throw new Error('--scenario requires an id between each comma');
  return ids;
}

/** Every id the `--scenario` flags name, in either form and repeated or not. */
function selectedScenarioIds(args: readonly string[]): Set<string> {
  const cleaned = stripCaptureFlags(args);
  const ids = new Set<string>();
  for (let index = 0; index < cleaned.length; index++) {
    const arg = cleaned[index];
    if (!arg) continue;
    if (arg === '--scenario') {
      for (const id of scenarioIdsOf(cleaned[index + 1])) ids.add(id);
      index++;
      continue;
    }
    if (arg.startsWith('--scenario=')) {
      for (const id of scenarioIdsOf(arg.slice('--scenario='.length))) ids.add(id);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return ids;
}

/**
 * The scenarios `--scenario` names, in corpus order, or the whole corpus when
 * it is absent. `--scenario` takes a comma-separated list and may be repeated,
 * so one run (one rules snapshot and restore) can re-capture a chosen set.
 */
export function selectRtdbScenarios(args: readonly string[]): RtdbSelection {
  const ids = selectedScenarioIds(args);
  if (ids.size === 0) {
    return { scenarios: ALL_RULES_RTDB_SCENARIOS, deployScenarios: ALL_RULES_RTDB_DEPLOY_SCENARIOS };
  }
  const known = new Set([...ALL_RULES_RTDB_SCENARIOS, ...ALL_RULES_RTDB_DEPLOY_SCENARIOS].map((scenario) => scenario.id));
  const unknown = [...ids].filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown RTDB scenario: ${unknown.join(', ')}`);
  return {
    scenarios: ALL_RULES_RTDB_SCENARIOS.filter((scenario) => ids.has(scenario.id)),
    deployScenarios: ALL_RULES_RTDB_DEPLOY_SCENARIOS.filter((scenario) => ids.has(scenario.id)),
  };
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

function printDeployScenarios(deployScenarios: readonly RtdbDeployScenario[]): void {
  for (const scenario of deployScenarios) {
    const limit = scenario.largeRuleset ? `, ${scenario.largeRuleset.timeoutMs / 1_000}s limit` : '';
    console.log(
      `    - ${scenario.id.padEnd(28)} [${scenario.fm.padEnd(8)}] ` +
        `${String(scenario.deployCases.length).padStart(2)} rulesets${limit}, expects deploy verdict → ${rtdbObservationName(scenario)}.json`,
    );
  }
}

function printInertPlan({ scenarios, deployScenarios }: RtdbSelection): void {
  console.log('[oracle:rules-rtdb] PYRIC_ORACLE_FIREBASE_CONFIG not set — INERT preview, no network calls.\n');
  console.log('  Credential env vars expected:');
  console.log('    PYRIC_ORACLE_FIREBASE_CONFIG  (Web SDK config JSON with databaseURL + apiKey; gates capture)');
  console.log('    PYRIC_ORACLE_SA_PATH          (service-account JSON path for the rules-deploy admin token;');
  console.log('                                   unset, Application Default Credentials are used)');
  console.log('    PYRIC_ORACLE_PROJECT_ID       (the oracle project id, read when PYRIC_ORACLE_SA_PATH is unset)\n');
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
  const order = orderDeployScenarios(deployScenarios);
  console.log(`\n  Would dry-run ${deployScenarios.length} deploy scenario(s) (PUT /.settings/rules.json?dryRun=true, nothing deployed):`);
  printDeployScenarios(order.beforeOperations);
  if (order.afterOperations.length > 0) {
    console.log('\n  Then, after the operation scenarios, the large-ruleset deploy scenarios:');
    printDeployScenarios(order.afterOperations);
  }
  console.log('\n  To capture for real:');
  console.log('    PYRIC_ORACLE_FIREBASE_CONFIG="$(cat oracle-web-config.json)" \\');
  console.log('      PYRIC_ORACLE_PROJECT_ID=<oracle project id> \\');
  console.log('      bun run packages/conformance/src/run-rules-rtdb.ts --scenario <scenario-id>[,<scenario-id>...]');
}

/**
 * A Firebase custom token for `uid` with developer `claims`, signed as the
 * oracle service account (a key file locally, IAM Credentials `signBlob` under
 * Application Default Credentials). The issue time is set two minutes back so
 * a local clock somewhat ahead of Google's does not make the token's `iat` lie
 * in the future, which Auth rejects as an invalid custom token.
 */
async function mintCustomToken(sa: ServiceAccount, uid: string, claims: Record<string, unknown>): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - 120;
  const email = oracleServiceAccountEmail(sa);
  return signOracleJwt(sa, {
    iss: email,
    sub: email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat,
    exp: iat + 3600,
    uid,
    ...(Object.keys(claims).length > 0 ? { claims } : {}),
  });
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

/**
 * The run's user-cleanup operations, narrowed so the contract can be tested
 * against a fake. Only uids the run created are ever passed: the custom-token
 * uid, each identity user's uid, and each anonymous uid.
 */
export interface RunUserStore {
  deleteUser(uid: string): Promise<void>;
  userExists(uid: string): Promise<boolean>;
}

/**
 * USER CLEANUP INVARIANT: every sign-in the run makes creates its uid in Auth.
 * The runner deletes each such uid and proves the deletion by looking it up. A
 * recorded uid Auth never stored finds no user and is clean.
 */
export async function verifyRunUserCleanup(store: RunUserStore, uid: string): Promise<void> {
  if (await store.userExists(uid)) await store.deleteUser(uid);
  if (await store.userExists(uid)) {
    throw new Error(`user cleanup NOT verified: the run-created user '${uid}' still exists after deletion.`);
  }
}

/** The Auth user a case identity signs in as: a run-scoped uid and, when the
 *  identity names an email domain, its email and verification flag. */
export interface RunUserProps {
  uid: string;
  email?: string;
  emailVerified?: boolean;
}

/** The run's user-creation operation, narrowed so the contract can be tested
 *  against a fake. */
export interface RunUserCreator {
  createUser(props: RunUserProps): Promise<void>;
}

/**
 * Create an identity user and record its uid for the cleanup invariant. The uid
 * is recorded before the creation request, so a request that fails after Auth
 * stored the user still leaves the user in the set the run deletes.
 */
export async function createRunUser(creator: RunUserCreator, runUids: Set<string>, props: RunUserProps): Promise<void> {
  runUids.add(props.uid);
  await creator.createUser(props);
}

/** One SDK query constraint: the `firebase/database` function name and its arguments. */
export type QueryConstraintSpec =
  | ['orderByChild', string]
  | ['orderByKey']
  | ['orderByValue']
  | ['orderByPriority']
  | ['equalTo' | 'startAt' | 'endAt', string | number | boolean | null]
  | ['limitToFirst' | 'limitToLast', number];

/** The constraints a case query applies: ordering first, then range, then limits. */
export function queryConstraintsOf(query: RtdbCaseQuery): QueryConstraintSpec[] {
  const out: QueryConstraintSpec[] = [];
  if (query.orderByChild !== undefined) out.push(['orderByChild', query.orderByChild]);
  if (query.orderByKey) out.push(['orderByKey']);
  if (query.orderByValue) out.push(['orderByValue']);
  if (query.orderByPriority) out.push(['orderByPriority']);
  if (query.equalTo !== undefined) out.push(['equalTo', query.equalTo]);
  if (query.startAt !== undefined) out.push(['startAt', query.startAt]);
  if (query.endAt !== undefined) out.push(['endAt', query.endAt]);
  if (query.limitToFirst !== undefined) out.push(['limitToFirst', query.limitToFirst]);
  if (query.limitToLast !== undefined) out.push(['limitToLast', query.limitToLast]);
  return out;
}

/** Recursively substitute the `<UID>` token, mirroring the agreement probe. */
function substituteUid<T>(v: T, uid: string): T {
  if (typeof v === 'string') return v.replaceAll('<UID>', uid) as unknown as T;
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((item) => substituteUid(item, uid)) as unknown as T;
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k.replaceAll('<UID>', uid)] = substituteUid(val, uid);
    return out as unknown as T;
  }
  return v;
}

/** Captures the selection and returns the exit code: non-zero when a scenario produced no observation. */
async function capture({ scenarios, deployScenarios }: RtdbSelection): Promise<number> {
  // Heavy SDK imports are deferred to the credentialed path so the inert
  // preview stays dependency-light and always runnable.
  const { initializeApp, deleteApp } = await import('firebase/app');
  const { getAuth, signInAnonymously, signInWithCustomToken, signOut } = await import('firebase/auth');
  const {
    getDatabase,
    ref: rtdbRef,
    get: rtdbGet,
    set: rtdbSet,
    update: rtdbUpdate,
    query: rtdbQuery,
    orderByChild,
    orderByKey,
    orderByValue,
    orderByPriority,
    equalTo,
    startAt,
    endAt,
    limitToFirst,
    limitToLast,
  } = await import('firebase/database');
  const {
    initializeApp: adminInitializeApp,
    deleteApp: adminDeleteApp,
  } = await import('firebase-admin/app');
  const { getDatabaseWithUrl: getAdminDatabase } = await import('firebase-admin/database');
  const { getAuth: getAdminAuth } = await import('firebase-admin/auth');

  const rawConfigText = process.env.PYRIC_ORACLE_FIREBASE_CONFIG ?? '{}';
  const config = JSON.parse(rawConfigText) as FirebaseWebConfig;
  const serviceAccount = await loadOracleServiceAccount();
  assertMatchingOracleProjects(config, serviceAccount);
  config.databaseURL = assertDedicatedOracleRtdbUrl(
    process.env.PYRIC_ORACLE_RTDB_URL ?? config.databaseURL,
    config.projectId,
  );
  const fbSdkVersion = resolvedFirebaseVersion();

  console.log(`[oracle:rules-rtdb] project: ${config.projectId}`);
  console.log(`[oracle:rules-rtdb] database: ${config.databaseURL}`);
  console.log(`[oracle:rules-rtdb] firebase ${fbSdkVersion}\n`);

  const coordinator = createSignalRestoreCoordinator('[oracle:rules-rtdb]');
  const uninstallSignals = coordinator.installSignals();
  const rtdbAdminToken = await oracleAccessToken(serviceAccount, RTDB_RULES_SCOPE);
  const rulesGetUrl = `${config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}`;
  const rulesPutUrl = `${config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(rtdbAdminToken)}&print=silent`;

  async function readRules(): Promise<Record<string, unknown>> {
    const res = await fetchWithRateLimitRetry(rulesGetUrl, undefined, 'read rules');
    if (!res.ok) throw new Error(`read rules failed: ${res.status} ${await res.text()}`);
    return capturableRules('the database', await res.text()).rules;
  }
  const endpoint: RulesDeployEndpoint = {
    async dryRun(rules, options = {}) {
      const started = Date.now();
      const limit = options.timeoutMs === undefined ? 'default limit' : `limit ${options.timeoutMs / 1_000}s`;
      try {
        const res = await fetchWithRateLimitRetry(`${rulesGetUrl}&dryRun=true`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rules }),
        }, 'dry run', { timeoutMs: options.timeoutMs });
        const body = await res.text();
        if (options.timeoutMs !== undefined) {
          console.log(`[oracle:rules-rtdb] dry run answered ${res.status} in ${Date.now() - started}ms (${limit}).`);
        }
        return { status: res.status, body };
      } catch (error) {
        console.log(`[oracle:rules-rtdb] dry run failed after ${Date.now() - started}ms (${limit}): ${error instanceof Error ? error.name : String(error)}`);
        throw error;
      }
    },
    readRules,
  };
  async function writeRules(rules: Record<string, unknown>): Promise<void> {
    const res = await coordinator.trackMutation(
      fetchWithRateLimitRetry(rulesPutUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      }, 'write rules'),
    );
    if (!res.ok) throw new Error(`write rules failed: ${res.status} ${await res.text()}`);
  }

  // The run-data store, over the REST API with the admin token — it bypasses
  // rules, so cleanup works regardless of whether the restored rules would let
  // the anonymous client delete its own writes (they would not).
  const auth_ = encodeURIComponent(rtdbAdminToken);
  const store: RunDataStore = {
    async deleteNamespace(auditKey: string): Promise<void> {
      const res = await fetchWithRateLimitRetry(`${config.databaseURL}/${auditKey}.json?access_token=${auth_}&print=silent`, {
        method: 'DELETE',
      }, 'delete run data');
      if (!res.ok) throw new Error(`delete run data failed: ${res.status} ${await res.text()}`);
    },
    async shallowRootKeys(): Promise<string[]> {
      const res = await fetchWithRateLimitRetry(`${config.databaseURL}/.json?shallow=true&access_token=${auth_}`, undefined, 'shallow root read');
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
      ...oracleAppOptions(serviceAccount),
      databaseURL: config.databaseURL,
    },
    `oracle-rules-rtdb-admin-${runId}`,
  );
  const adminDb = getAdminDatabase(config.databaseURL, adminApp);
  const adminAuth = getAdminAuth(adminApp);
  // The one uid every claims case signs in as. It, every identity user's uid,
  // and every anonymous uid the run signs in as are Auth users the run created;
  // all are recorded here and deleted at the end.
  const claimsUid = `pyric-oracle-rulesrtdb-${runId}`;
  const runUids = new Set<string>([claimsUid]);
  // Auth users created for case identities, one per distinct identity, with
  // run-scoped uids and emails.
  const identityUids = new Map<string, string>();
  async function identityUser(identity: RtdbCaseIdentity): Promise<string> {
    const key = JSON.stringify(identity);
    const existing = identityUids.get(key);
    if (existing) return existing;
    const uid = `pyric-oracle-rulesrtdb-${runId}-${identityUids.size}`;
    identityUids.set(key, uid);
    await createRunUser(
      { async createUser(props) { await adminAuth.createUser(props); } },
      runUids,
      {
        uid,
        ...(identity.emailDomain
          ? { email: `${uid}@${identity.emailDomain}`, emailVerified: identity.emailVerified ?? false }
          : {}),
      },
    );
    return uid;
  }
  const userStore: RunUserStore = {
    async deleteUser(uid) {
      await adminAuth.deleteUser(uid);
    },
    async userExists(uid) {
      try {
        await adminAuth.getUser(uid);
        return true;
      } catch (e) {
        if ((e as { code?: string }).code === 'auth/user-not-found') return false;
        throw e;
      }
    },
  };

  const deployOrder = orderDeployScenarios(deployScenarios);
  const deployInput = { beforeRules, mountKey: auditKey };
  let restoreVerified = false;
  let dataCleanupVerified = false;
  let userCleanupVerified = false;
  // Set before the rules write, so a write that fails partway is still restored.
  let deployed = false;
  coordinator.registerCleanup(async () => {
    if (!deployed) return;
    await restoreRtdbRulesWithRetry({
      beforeText: JSON.stringify(beforeRules),
      writeText: (text) => writeRules(JSON.parse(text) as Record<string, unknown>),
      readText: async () => JSON.stringify(await readRules()),
      canonicalize: (text) => canonicalize(JSON.parse(text)),
    });
    deployed = false;
    restoreVerified = true;
  });

  async function captureOperations(): Promise<CapturedObservation[]> {
    const observations: CapturedObservation[] = [];
    if (scenarios.length === 0) return observations;
    // Deploy every scenario's subtree under `<auditKey>/<scenario.id>`, merged with the
    // existing rules so real rules are preserved.
    const auditSubtree: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      auditSubtree[scenario.id] = JSON.parse(scenario.rules);
    }
    deployed = true;
    await writeRules({ ...beforeRules, [auditKey]: auditSubtree });
    console.log(`[oracle:rules-rtdb] deployed ${scenarios.length} scenario subtree(s) under /${auditKey}. Waiting 8s to propagate.`);
    await new Promise((r) => setTimeout(r, 8_000));

    for (const scenario of scenarios) {
      const behavior: Record<string, 'ALLOW' | 'DENY'> = {};
      for (const tc of scenario.cases as RtdbTestCase[]) {
        // Match auth context to the case. An identity case signs in as the
        // run-scoped Auth user created for that identity. A claims case signs
        // in fresh with a custom token carrying exactly its claims. Every other
        // signed-in case uses an anonymous sign-in, whose uid is recorded for
        // cleanup.
        if (tc.identity) {
          const uid = await identityUser(tc.identity);
          if (auth.currentUser?.uid !== uid) {
            if (auth.currentUser) await signOut(auth);
            // Auth intermittently refuses a freshly minted custom token as
            // invalid; a new token a moment later is accepted, so the sign-in
            // is retried a bounded number of times before the run fails.
            let lastError: unknown;
            for (let attempt = 0; attempt < 5 && auth.currentUser?.uid !== uid; attempt++) {
              if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
              try {
                await signInWithCustomToken(auth, await mintCustomToken(serviceAccount, uid, tc.identity.claims ?? {}));
              } catch (e) {
                lastError = e;
              }
            }
            if (auth.currentUser?.uid !== uid) {
              throw new Error(`custom-token sign-in for case "${tc.description}" failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
            }
          }
        } else if (tc.claims) {
          if (auth.currentUser) await signOut(auth);
          await signInWithCustomToken(auth, await adminAuth.createCustomToken(claimsUid, tc.claims));
        } else if (tc.authPresent && (!auth.currentUser || !auth.currentUser.isAnonymous)) {
          if (auth.currentUser) await signOut(auth);
          runUids.add((await signInAnonymously(auth)).user.uid);
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
          } else if (tc.operation === 'query') {
            const constraints = queryConstraintsOf(substituteUid(tc.query!, liveUid)).map((spec) => {
              switch (spec[0]) {
                case 'orderByChild': return orderByChild(spec[1]);
                case 'orderByKey': return orderByKey();
                case 'orderByValue': return orderByValue();
                case 'orderByPriority': return orderByPriority();
                case 'equalTo': return equalTo(spec[1]);
                case 'startAt': return startAt(spec[1]);
                case 'endAt': return endAt(spec[1]);
                case 'limitToFirst': return limitToFirst(spec[1]);
                case 'limitToLast': return limitToLast(spec[1]);
              }
            });
            await rtdbGet(rtdbQuery(rtdbRef(rtdb, fullPath), ...constraints));
          } else if (tc.operation === 'update') {
            await rtdbUpdate(rtdbRef(rtdb, fullPath), newData as Record<string, unknown>);
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
    return observations;
  }

  // Restore before the large-ruleset dry runs: their read-back compares the
  // live rules with the snapshot, and an unanswered one can leave the rules
  // endpoint answering 429 for minutes, so no rules write follows it.
  async function restoreBeforeLate(): Promise<void> {
    if (!deployed) return;
    await restoreRulesBeforeLatePhase({ writeRules, readRules }, beforeRules);
    deployed = false;
  }

  async function restoreAndCleanUp(): Promise<void> {
    try {
      if (deployed) {
        await coordinator.runRestore();
        console.log('[oracle:rules-rtdb] restore verified -- rules read back identical to pre-run snapshot.');
      } else {
        const afterRules = await readRules();
        if (canonicalize(afterRules) === beforeCanonical) {
          restoreVerified = true;
          console.log('[oracle:rules-rtdb] restore verified -- rules read back identical to pre-run snapshot.');
        } else {
          console.error('[oracle:rules-rtdb] RESTORE VERIFY FAILED -- read-back rules differ from the pre-run snapshot.');
        }
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
    try {
      // Every recorded uid is attempted, so one failure does not leave the
      // rest behind.
      const failures: string[] = [];
      for (const uid of runUids) {
        try {
          await verifyRunUserCleanup(userStore, uid);
        } catch (e) {
          failures.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (failures.length > 0) throw new Error(failures.join('; '));
      userCleanupVerified = true;
      console.log(`[oracle:rules-rtdb] user cleanup verified: ${runUids.size} run-created Auth uid(s) deleted and absent from a lookup.`);
    } catch (e) {
      console.error(`[oracle:rules-rtdb] USER CLEANUP FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    try { await deleteApp(app); } catch { /* ignored */ }
    try { await adminDeleteApp(adminApp); } catch { /* ignored */ }
  }

  // Only write observations once every invariant held. A run that could not
  // prove it left the database as it found it — same rules, no residual data,
  // no run users — must not be treated as a clean capture.
  function assertCleanRun(): void {
    if (!restoreVerified) {
      throw new Error('restore invariant NOT verified — refusing to write observations. Inspect the database rules manually.');
    }
    if (!dataCleanupVerified) {
      throw new Error(`data cleanup invariant NOT verified — refusing to write observations. Delete /${auditKey} manually.`);
    }
    if (!userCleanupVerified) {
      throw new Error(`user cleanup invariant NOT verified; refusing to write observations. Delete the Auth users ${[...runUids].join(', ')} manually.`);
    }
  }

  function writeObservation({ scenario, behavior }: CapturedObservation): void {
    mkdirSync(OBS_DIR, { recursive: true });
    const path = observationPath(scenario);
    const linkage = existsSync(path)
      ? observationLinkageOf(JSON.parse(readFileSync(path, 'utf8')))
      : observationLinkageOf(undefined);
    const obs: Observation = {
      name: rtdbObservationName(scenario),
      matrixRow: linkage.matrixRow,
      rowIds: linkage.rowIds,
      description: 'deployCases' in scenario
        ? `RTDB rules deploy verdicts for corpus scenario "${scenario.id}" (${scenario.fm}). Captured by dry-run deploys to the rules endpoint, which validate without deploying. ${scenario.rationale}`
        : `RTDB rules production verdicts for corpus scenario "${scenario.id}" (${scenario.fm}). Captured by deploy-observe-restore (RTDB has no server-side rules test API). ${scenario.rationale}`,
      observedAt: new Date().toISOString(),
      fbSdkVersion,
      projectId: config.projectId,
      behavior,
    };
    writeFileSync(path, JSON.stringify(obs, null, 2) + '\n');
    console.log(`  → wrote ${rtdbObservationName(scenario)}.json`);
  }

  let exitCode = 1;
  try {
    exitCode = await runCapturePhases({
      earlyDeploys: () => runDeployScenarios(endpoint, deployOrder.beforeOperations, deployInput),
      operations: captureOperations,
      restoreBeforeLate,
      lateDeploys: () => runDeployScenarios(endpoint, deployOrder.afterOperations, deployInput),
      restoreAndCleanUp,
      assertClean: assertCleanRun,
      write: writeObservation,
      log: (line) => console.error(line),
    });
  } finally {
    uninstallSignals();
  }

  const outcome = exitCode === 0 ? 'capture complete' : 'capture incomplete (the scenarios named above have no observation)';
  console.log(`\n[oracle:rules-rtdb] ${outcome}: rules restored, run data and run users removed, all read-back verified.`);
  console.log('[oracle:rules-rtdb] Existing observation matrixRow/rowIds linkage was preserved.');
  console.log('[oracle:rules-rtdb] NEXT: review the observation diff, then run `bun run compat:validate`.');
  return exitCode;
}

// ─── Multiple database instances ────────────────────────────────────────────

/** The observation the multi-instance capture writes. */
export const MULTI_INSTANCE_OBSERVATION = 'rtdb-modular-multiple-instances';

/** Rules each instance runs under the run-scoped key during the capture. */
export const MULTI_INSTANCE_RULES = {
  default: { '.read': 'auth != null', '.write': 'auth != null' },
  second: {
    open: { '.read': true, '.write': true },
    users: { $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' } },
  },
} as const;

/** Merges `subtree` under `auditKey` after verifying strict JSON and `false` root grants. */
export function instanceRulesForCapture(instance: string, beforeText: string, auditKey: string, subtree: unknown): string {
  const before = capturableRules(instance, beforeText);
  return JSON.stringify({ ...before, rules: { ...before.rules, [auditKey]: subtree } });
}

export function capturableRules(
  instance: string,
  beforeText: string,
): { rules: Record<string, unknown> } & Record<string, unknown> {
  let before: { rules?: Record<string, unknown> } & Record<string, unknown>;
  try {
    before = JSON.parse(beforeText) as typeof before;
  } catch {
    throw new Error(`refusing to run: the rules of ${instance} are not plain JSON (they may carry comments), so the run cannot add its subtree and keep them in force.`);
  }
  const root = before.rules ?? {};
  for (const access of ['.read', '.write']) {
    const grant = root[access];
    if (grant !== undefined && grant !== false) {
      throw new Error(`refusing to run: the root ${access} rule of ${instance} is not false, so it would grant access inside the run's subtree.`);
    }
  }
  return { ...before, rules: root };
}

export function verifyRulesTextRestored(instance: string, beforeText: string, afterText: string): { exact: boolean } {
  if (afterText === beforeText) return { exact: true };
  let same = false;
  try {
    same = canonicalize(JSON.parse(afterText)) === canonicalize(JSON.parse(beforeText));
  } catch {
    same = false;
  }
  if (!same) throw new Error(`restore NOT verified on ${instance}: the read-back rules differ from the pre-run rules.`);
  return { exact: false };
}

/** Captures cross-instance RTDB isolation (`deploy -> observe -> restore + read-back` on both instances). */
async function captureMultiInstance(): Promise<void> {
  const { initializeApp, deleteApp } = await import('firebase/app');
  const { getAuth, signInWithCustomToken, signOut } = await import('firebase/auth');
  const { getDatabase, ref: rtdbRef, get: rtdbGet, set: rtdbSet, onValue } = await import('firebase/database');
  const { initializeApp: adminInitializeApp, deleteApp: adminDeleteApp } = await import('firebase-admin/app');
  const { getAuth: getAdminAuth } = await import('firebase-admin/auth');

  const rawConfigText = process.env.PYRIC_ORACLE_FIREBASE_CONFIG ?? '{}';
  const config = JSON.parse(rawConfigText) as FirebaseWebConfig;
  const secondUrl = process.env.PYRIC_ORACLE_SECOND_DATABASE_URL;
  if (!config.databaseURL) throw new Error('PYRIC_ORACLE_FIREBASE_CONFIG has no databaseURL.');
  if (!secondUrl) throw new Error('PYRIC_ORACLE_SECOND_DATABASE_URL names the second instance the capture runs against.');
  const defaultUrl = config.databaseURL.replace(/\/$/, '');
  const second = assertDedicatedOracleRtdbUrl(secondUrl, config.projectId);
  const serviceAccount = await loadOracleServiceAccount();
  assertMatchingOracleProjects(config, serviceAccount);
  const fbSdkVersion = resolvedFirebaseVersion();
  const instances = { default: defaultUrl, second } as const;
  console.log(`[oracle:rtdb-instances] project: ${config.projectId}`);
  console.log(`[oracle:rtdb-instances] instances: ${new URL(defaultUrl).host}, ${new URL(second).host}`);

  const coordinator = createSignalRestoreCoordinator('[oracle:rtdb-instances]');
  const uninstallSignals = coordinator.installSignals();
  const adminToken = encodeURIComponent(await oracleAccessToken(serviceAccount, RTDB_RULES_SCOPE));
  async function readRulesText(url: string): Promise<string> {
    const res = await fetch(`${url}/.settings/rules.json?access_token=${adminToken}`);
    if (!res.ok) throw new Error(`read rules failed on ${new URL(url).host}: ${res.status}`);
    return res.text();
  }
  async function writeRulesText(url: string, text: string): Promise<void> {
    const res = await coordinator.trackMutation(
      fetch(`${url}/.settings/rules.json?access_token=${adminToken}&print=silent`, { method: 'PUT', body: text }),
    );
    if (!res.ok) throw new Error(`write rules failed on ${new URL(url).host}: ${res.status} ${await res.text()}`);
  }
  async function adminRead(url: string, path: string): Promise<unknown> {
    const res = await fetch(`${url}/${path}.json?access_token=${adminToken}`);
    if (!res.ok) throw new Error(`admin read failed on ${new URL(url).host}: ${res.status}`);
    return res.json();
  }
  function dataStore(url: string): RunDataStore {
    return {
      async deleteNamespace(auditKey) {
        const res = await fetch(`${url}/${auditKey}.json?access_token=${adminToken}&print=silent`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`delete run data failed on ${new URL(url).host}: ${res.status}`);
      },
      async shallowRootKeys() {
        const res = await fetch(`${url}/.json?shallow=true&access_token=${adminToken}`);
        if (!res.ok) throw new Error(`shallow root read failed on ${new URL(url).host}: ${res.status}`);
        const body = (await res.json()) as Record<string, unknown> | null;
        return body ? Object.keys(body) : [];
      },
    };
  }

  const before = { default: await readRulesText(defaultUrl), second: await readRulesText(second) };
  console.log('[oracle:rtdb-instances] snapshotted the rules of both instances.');
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const auditKey = `pyric_oracle_instances_${runId}`;
  // Built before any app, user or deploy, so a refusal leaves both instances untouched.
  const deploy = {
    default: instanceRulesForCapture('the default instance', before.default, auditKey, MULTI_INSTANCE_RULES.default),
    second: instanceRulesForCapture('the second instance', before.second, auditKey, MULTI_INSTANCE_RULES.second),
  };
  const uid = `pyric-oracle-instances-${runId}`;
  const app = initializeApp(config, `oracle-rtdb-instances-${runId}`);
  const auth = getAuth(app);
  const adminApp = adminInitializeApp(oracleAppOptions(serviceAccount), `oracle-rtdb-instances-admin-${runId}`);
  const adminAuth = getAdminAuth(adminApp);
  const runUids = new Set<string>([uid]);
  const userStore: RunUserStore = {
    async deleteUser(id) { await adminAuth.deleteUser(id); },
    async userExists(id) {
      try {
        await adminAuth.getUser(id);
        return true;
      } catch (e) {
        if ((e as { code?: string }).code === 'auth/user-not-found') return false;
        throw e;
      }
    },
  };
  const outcome = (operation: Promise<unknown>): Promise<'ALLOW' | 'DENY'> =>
    operation.then(() => 'ALLOW' as const, () => 'DENY' as const);
  const behavior: Record<string, unknown> = {};
  const restored: Record<string, { exact: boolean } | string> = {};
  let deployed = false;
  coordinator.registerCleanup(async () => {
    for (const [name, url] of Object.entries(instances)) {
      const targetBefore = before[name as keyof typeof before];
      try {
        if (deployed) {
          await restoreRtdbRulesWithRetry({
            beforeText: targetBefore,
            writeText: (text) => writeRulesText(url, text),
            readText: () => readRulesText(url),
            canonicalize: (text) => canonicalize(JSON.parse(text)),
          });
        }
        const checked = verifyRulesTextRestored(name, targetBefore, await readRulesText(url));
        restored[name] = checked;
        let suffix = ' (same rules, reformatted)';
        if (checked.exact) {
          suffix = ' (text identical)';
        }
        console.log(`[oracle:rtdb-instances] restore verified on ${name}${suffix}.`);
      } catch (e) {
        if (e instanceof Error) {
          restored[name] = e.message;
        } else {
          restored[name] = String(e);
        }
        console.error(`[oracle:rtdb-instances] RESTORE FAILED on ${name}: ${restored[name]}`);
      }
    }
  });
  let dataCleanupVerified = false;
  let userCleanupVerified = false;

  try {
    deployed = true;
    await writeRulesText(defaultUrl, deploy.default);
    await writeRulesText(second, deploy.second);
    console.log(`[oracle:rtdb-instances] deployed a different subtree to each instance under /${auditKey}. Waiting 8s to propagate.`);
    await new Promise((r) => setTimeout(r, 8_000));

    const defaultDb = getDatabase(app);
    const secondDb = getDatabase(app, second);
    const probe = `${auditKey}/open/probe`;
    behavior.signedOut = {
      defaultWrite: await outcome(rtdbSet(rtdbRef(defaultDb, probe), 'default')),
      secondWrite: await outcome(rtdbSet(rtdbRef(secondDb, probe), 'second')),
    };
    behavior.isolation = {
      secondWriteReadOnSecond: await adminRead(second, probe),
      secondWriteReadOnDefault: await adminRead(defaultUrl, probe),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 5 && auth.currentUser?.uid !== uid; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        await signInWithCustomToken(auth, await mintCustomToken(serviceAccount, uid, {}));
      } catch (e) {
        lastError = e;
      }
    }
    if (auth.currentUser?.uid !== uid) {
      throw new Error(`custom-token sign-in failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    behavior.signedIn = {
      defaultWrite: await outcome(rtdbSet(rtdbRef(defaultDb, probe), 'default')),
      secondOwnUserPath: await outcome(rtdbSet(rtdbRef(secondDb, `${auditKey}/users/${uid}`), 'own')),
      secondOtherUserPath: await outcome(rtdbSet(rtdbRef(secondDb, `${auditKey}/users/another-user`), 'other')),
      secondPathWithoutRules: await outcome(rtdbGet(rtdbRef(secondDb, `${auditKey}/closed`))),
      defaultReadOfSecondOnlyPath: await outcome(rtdbGet(rtdbRef(defaultDb, `${auditKey}/users/${uid}`))),
    };
    behavior.isolationAfterBothWrites = {
      defaultHolds: await adminRead(defaultUrl, probe),
      secondHolds: await adminRead(second, probe),
      secondUserPathOnDefault: await adminRead(defaultUrl, `${auditKey}/users/${uid}`),
    };
    await signOut(auth);

    // An instance that does not exist: the SDK logs one warning and no
    // operation or listener settles.
    const missingName = `pyric-oracle-missing-${runId.replace('_', '-')}`;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const missing = getDatabase(app, `https://${missingName}.firebaseio.com`);
      const settles = (operation: Promise<unknown>) => Promise.race([
        operation.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`),
        new Promise<string>((r) => setTimeout(() => r('pending after 20s'), 20_000)),
      ]);
      const listened = new Promise((resolve, reject) => {
        onValue(rtdbRef(missing, 'probe'), resolve, reject);
      });
      behavior.missingInstance = {
        get: await settles(rtdbGet(rtdbRef(missing, 'probe'))),
        onValue: await settles(listened),
        warnings: warnings
          .filter((line) => line.includes('FIREBASE WARNING'))
          .map((line) => line.replace(/^\[[^\]]+\]\s+/, '').replaceAll(missingName, '<missing>').trim()),
      };
    } finally {
      console.warn = warn;
    }
  } finally {
    try {
      await coordinator.runRestore();
    } finally {
      uninstallSignals();
    }
    try {
      for (const url of Object.values(instances)) await verifyRunDataCleanup(dataStore(url), auditKey);
      dataCleanupVerified = true;
      console.log(`[oracle:rtdb-instances] data cleanup verified: /${auditKey} absent from both instances.`);
    } catch (e) {
      console.error(`[oracle:rtdb-instances] DATA CLEANUP FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      for (const id of runUids) await verifyRunUserCleanup(userStore, id);
      userCleanupVerified = true;
      console.log(`[oracle:rtdb-instances] user cleanup verified: ${runUids.size} run-created Auth uid deleted.`);
    } catch (e) {
      console.error(`[oracle:rtdb-instances] USER CLEANUP FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    try { await deleteApp(app); } catch { /* ignored */ }
    try { await adminDeleteApp(adminApp); } catch { /* ignored */ }
  }

  const unrestored = Object.entries(restored).filter(([, result]) => typeof result === 'string');
  if (unrestored.length > 0 || Object.keys(restored).length !== 2) {
    throw new Error('restore invariant NOT verified on every instance; refusing to write the observation. Inspect both instances\' rules manually.');
  }
  if (!dataCleanupVerified) throw new Error(`data cleanup NOT verified; delete /${auditKey} on both instances manually.`);
  if (!userCleanupVerified) throw new Error(`user cleanup NOT verified; delete Auth user ${uid} manually.`);

  const observation: Observation = {
    name: MULTI_INSTANCE_OBSERVATION,
    matrixRow: 'rtdb-modular#MI1',
    rowIds: ['rtdb-modular#MI1', 'rtdb-modular#MI2', 'rtdb-modular#MI3', 'rtdb-modular#MI5', 'rtdb-modular#MI6', 'rtdb-modular#MI7'],
    description: 'Two RTDB instances of one project, the default instance and a second one, each with a different ruleset deployed under a run-scoped key: client writes signed out and as one custom-token user, the value each instance holds afterwards read with an admin token, and the SDK\'s behavior for an instance URL that names no instance. Captured by deploy-observe-restore on both instances; rules restored and read back, run data and the run user deleted.',
    observedAt: new Date().toISOString(),
    fbSdkVersion,
    projectId: config.projectId,
    behavior: { rules: MULTI_INSTANCE_RULES, ...behavior, sdk: await captureMultiInstanceSdk() },
  };
  const path = join(HERE, '..', 'observations', 'rtdb-modular', `${MULTI_INSTANCE_OBSERVATION}.json`);
  writeFileSync(path, `${JSON.stringify(observation, null, 2).replaceAll(uid, '<UID>').replaceAll(auditKey, '<run>')}\n`);
  console.log(`  → wrote ${MULTI_INSTANCE_OBSERVATION}.json`);
}

/**
 * The production SDK's handle and reference identity across instances, which
 * it decides without a connection: the URL a reference reports, `refFromURL`'s
 * host check, and a second URL argument naming an instance the app already
 * opened. Read-only and offline; recorded under `behavior.sdk` of the
 * multi-instance observation.
 */
export async function captureMultiInstanceSdk(): Promise<Record<string, unknown>> {
  const { initializeApp, deleteApp } = await import('firebase/app');
  const { getDatabase, ref, refFromURL } = await import('firebase/database');
  const outcome = (run: () => unknown): Record<string, unknown> => {
    try {
      const value = run();
      return { value: typeof value === 'string' ? value : 'returned' };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };
  const app = initializeApp({ projectId: 'sdk-project', apiKey: 'unused' }, `oracle-rtdb-instances-sdk-${Date.now()}`);
  const noProject = initializeApp({ apiKey: 'unused' }, `oracle-rtdb-instances-sdk-none-${Date.now()}`);
  // The SDK logs each fatal error before it throws it.
  const error = console.error;
  console.error = () => {};
  try {
    const defaultDb = getDatabase(app);
    const second = getDatabase(app, 'https://second.firebaseio.com');
    return {
      referenceUrls: {
        defaultRoot: ref(defaultDb).toString(),
        secondPath: ref(second, 'a b/c').toString(),
        regional: ref(getDatabase(app, 'https://reg.europe-west1.firebasedatabase.app'), 'a').toString(),
        namespaceQuery: ref(getDatabase(app, 'https://host.firebaseio.com?ns=named'), 'a').toString(),
      },
      sameArgumentSameHandle: getDatabase(app, 'https://second.firebaseio.com') === second,
      defaultUrlAfterDefault: outcome(() => getDatabase(app, 'https://sdk-project-default-rtdb.firebaseio.com')),
      trailingSlashAfterOpen: outcome(() => getDatabase(app, 'https://second.firebaseio.com/')),
      refFromUrlSameHost: outcome(() => refFromURL(second, 'https://second.firebaseio.com/a/b%20c').toString()),
      refFromUrlOtherHost: outcome(() => refFromURL(second, 'https://third.firebaseio.com/a')),
      noProjectNoUrl: outcome(() => getDatabase(noProject)),
    };
  } finally {
    console.error = error;
    await deleteApp(app);
    await deleteApp(noProject);
  }
}

if (import.meta.main && process.argv.includes('--multi-instance-sdk')) {
  requireCaptureMode({
    label: 'oracle:rtdb-instances',
    scriptPath: 'packages/conformance/src/run-rules-rtdb.ts',
    extraFlags: '--multi-instance-sdk',
  });
  const path = join(HERE, '..', 'observations', 'rtdb-modular', `${MULTI_INSTANCE_OBSERVATION}.json`);
  const observation = JSON.parse(readFileSync(path, 'utf8')) as Observation;
  if (observation.fbSdkVersion !== resolvedFirebaseVersion()) {
    throw new Error(`the observation records firebase ${observation.fbSdkVersion}; this checkout resolves ${resolvedFirebaseVersion()}.`);
  }
  observation.behavior.sdk = await captureMultiInstanceSdk();
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`);
  console.log(`  -> recorded behavior.sdk in ${MULTI_INSTANCE_OBSERVATION}.json`);
  process.exit(0);
}

if (import.meta.main && process.argv.includes('--multi-instance')) {
  requireCaptureMode({
    label: 'oracle:rtdb-instances',
    scriptPath: 'packages/conformance/src/run-rules-rtdb.ts',
    extraFlags: '--multi-instance',
    missingCredentials: () => {
      const missing: string[] = [];
      if (!process.env.PYRIC_ORACLE_FIREBASE_CONFIG) missing.push('PYRIC_ORACLE_FIREBASE_CONFIG');
      if (!process.env.PYRIC_ORACLE_SECOND_DATABASE_URL) {
        missing.push('PYRIC_ORACLE_SECOND_DATABASE_URL');
      }
      if (!oracleCredentialConfigured(process.env)) {
        missing.push('PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID');
      }
      if (missing.length > 0) return missing.join(', ');
      return null;
    },
  });
  await captureMultiInstance();
  process.exit(0);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const selection = selectRtdbScenarios(args);
  requireCaptureMode({
    label: 'oracle:rules-rtdb',
    scriptPath: 'packages/conformance/src/run-rules-rtdb.ts',
    argv: args,
    preview: () => printInertPlan(selection),
    missingCredentials: () => {
      const missing: string[] = [];
      if (!process.env.PYRIC_ORACLE_FIREBASE_CONFIG) missing.push('PYRIC_ORACLE_FIREBASE_CONFIG');
      if (!oracleCredentialConfigured(process.env)) {
        missing.push('PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID');
      }
      if (missing.length > 0) return missing.join(', ');
      return null;
    },
  });
  process.exitCode = await capture(selection);
}
