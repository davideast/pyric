/**
 * Live-project session helpers for modular probes (`probes/<surface>/<name>.ts`).
 *
 * Heavy `firebase/*` and `firebase-admin/*` imports are loaded lazily inside
 * each session helper so `loadModularProbes` and inert previews stay sub-100ms.
 * Isolates all test writes under `pyric_oracle/<runId>`, pins RTDB operations
 * to dedicated non-default oracle instances, reuses `OracleRulesSession` and
 * `installOracleSignalRestoreGuard` for 3-attempt verified rules restoration on
 * completion or `SIGINT`/`SIGTERM`, and cleans up data/users in `finally`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import type { Database } from 'firebase/database';
import type { Firestore } from 'firebase/firestore';
import type { Auth as AdminAuth, CreateRequest, UserRecord } from 'firebase-admin/auth';
import { RTDB_RULES_SCOPE } from './oracle-access-token.ts';
import {
  loadOracleServiceAccount,
  oracleAccessToken,
  oracleAppOptions,
  type OracleServiceAccount,
} from './oracle-credential.ts';
import {
  OracleRulesSession,
  firestoreOracleTarget,
  rtdbOracleTarget,
  runWithOracleRulesRestored,
} from './oracle-rules-session.ts';
import {
  assertDedicatedOracleRtdbUrl,
  assertWebConfigProject,
  webConfigFromEnv,
  type OracleWebConfig,
} from './oracle-run-setup.ts';
import { installOracleSignalRestoreGuard } from './oracle-signal-restore.ts';

const FIREBASE_MANAGEMENT_API = 'https://firebase.googleapis.com/v1beta1';
const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';

type ProbeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function readHttpErrorDetail(response: Response): Promise<string> {
  try {
    const raw = (await response.text()).trim();
    if (raw.length > 300) {
      return `${raw.slice(0, 300)}...`;
    }
    return raw;
  } catch {
    return '';
  }
}

async function discoverOracleWebConfig(
  projectId: string,
  token: string,
  fetchImpl: ProbeFetch,
): Promise<OracleWebConfig> {
  const encodedProject = encodeURIComponent(projectId);
  const authHeaders = { Authorization: `Bearer ${token}` };
  const listUrl = `${FIREBASE_MANAGEMENT_API}/projects/${encodedProject}/webApps`;
  const listResponse = await fetchImpl(listUrl, { headers: authHeaders });
  if (!listResponse.ok) {
    const detail = await readHttpErrorDetail(listResponse);
    let suffix = '';
    if (detail) {
      suffix = `: ${detail}`;
    }
    throw new Error(
      `Firebase Web App discovery failed for project '${projectId}' (HTTP ${listResponse.status} from firebase.googleapis.com; ensure roles/firebase.viewer is granted)${suffix}`,
    );
  }

  const listBody = (await listResponse.json()) as { apps?: Array<{ appId?: unknown }> };
  const firstApp = listBody.apps?.[0];
  let appId = '';
  if (firstApp && typeof firstApp.appId === 'string') {
    appId = firstApp.appId.trim();
  }
  if (!appId) {
    throw new Error(
      `Oracle project '${projectId}' has no registered Firebase Web App (firebase.googleapis.com webApps returned 0 apps); register a Web App in the project before running client probes (refusing to auto-create persistent project resources).`,
    );
  }

  const configUrl = `${FIREBASE_MANAGEMENT_API}/projects/${encodedProject}/webApps/${encodeURIComponent(appId)}/config`;
  const configResponse = await fetchImpl(configUrl, { headers: authHeaders });
  if (!configResponse.ok) {
    const detail = await readHttpErrorDetail(configResponse);
    let suffix = '';
    if (detail) {
      suffix = `: ${detail}`;
    }
    throw new Error(
      `Firebase Web App config fetch failed for app '${appId}' in project '${projectId}' (HTTP ${configResponse.status} from firebase.googleapis.com; ensure roles/firebase.viewer is granted)${suffix}`,
    );
  }

  return (await configResponse.json()) as OracleWebConfig;
}

export async function resolveProbeWebConfig(
  sa: OracleServiceAccount,
  options: {
    env?: Record<string, string | undefined>;
    fetchImpl?: ProbeFetch;
  } = {},
): Promise<OracleWebConfig> {
  const env = options.env ?? process.env;
  const fromEnv = webConfigFromEnv(env);
  if (fromEnv) {
    assertWebConfigProject(fromEnv, sa.project_id);
    return fromEnv;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE);
  const discovered = await discoverOracleWebConfig(sa.project_id, token, fetchImpl);
  assertWebConfigProject(discovered, sa.project_id);
  return discovered;
}

function nextProbeRunId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${nonce}`;
}

interface FirestoreProbeContext {
  runId: string;
  basePath: string;
  db: Firestore;
  firestoreSdk: typeof import('firebase/firestore');
  collectionPath(subcollection: string): string;
}

export async function withFirestoreProbeSession(
  runProbe: (ctx: FirestoreProbeContext) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const [
    { deleteApp, initializeApp },
    { deleteUser, getAuth },
    { signInOracleClientAuth },
    firestoreSdk,
    adminAppMod,
    { getFirestore: getAdminFirestore },
  ] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('./oracle-run-auth-session.ts'),
    import('firebase/firestore'),
    import('firebase-admin/app'),
    import('firebase-admin/firestore'),
  ]);

  const sa = await loadOracleServiceAccount();
  const webConfig = await resolveProbeWebConfig(sa);

  const runId = nextProbeRunId('fs');
  const basePath = `pyric_oracle/${runId}`;
  const session = new OracleRulesSession({
    projectId: sa.project_id,
    accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
  });
  const detachSignals = installOracleSignalRestoreGuard('[sdk-probes]', () =>
    session.restoreAll(),
  );

  const clientApp = initializeApp(webConfig as FirebaseOptions, `sdk-probe-fs-${runId}`);
  const clientAuth = getAuth(clientApp);
  const db = firestoreSdk.getFirestore(clientApp);
  const adminApp = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-fs-admin-${runId}`);
  const adminDb = getAdminFirestore(adminApp);

  try {
    return await runWithOracleRulesRestored(session, async () => {
      const outcome = await session.deploy(firestoreOracleTarget());
      if (outcome !== 'already-configured') {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      await signInOracleClientAuth(clientAuth, sa, `sdk-fs-${runId}`);
      try {
        return await runProbe({
          runId,
          basePath,
          db,
          firestoreSdk,
          collectionPath: (sub) => `${basePath}/${sub}`,
        });
      } finally {
        if (clientAuth.currentUser) {
          await deleteUser(clientAuth.currentUser).catch(() => undefined);
        }
        await deleteApp(clientApp).catch(() => undefined);
        await adminDb.recursiveDelete(adminDb.doc(basePath)).catch(() => undefined);
        await adminAppMod.deleteApp(adminApp).catch(() => undefined);
      }
    });
  } finally {
    detachSignals();
    if (session.restoredFirestoreOrStorage) {
      console.log('[sdk-probes] Firestore rules restored and verified');
    }
  }
}

interface RtdbProbeClientHandle {
  app: FirebaseApp;
  db: Database;
  uid: string;
}

interface RtdbProbeContext {
  runId: string;
  runPath: string;
  databaseUrl: string;
  db: Database;
  rtdbSdk: typeof import('firebase/database');
  openClient(label: string): Promise<RtdbProbeClientHandle>;
  adminRead(subpath: string, exportFormat?: boolean): Promise<unknown>;
  adminWrite(subpath: string, value: unknown): Promise<void>;
  adminRemove(subpath: string): Promise<void>;
}

interface RtdbProbeSessionOptions {
  /** Custom rules mounted at `/pyric_oracle/<runId>`; defaults to signed-in read/write. */
  runRules?: Record<string, unknown>;
  /** Propagation settle time in ms after merging `runRules`. Defaults to 5000. */
  propagationMs?: number;
  /** Client auth mode; defaults to `'custom-token'` unless `'anonymous'` is requested. */
  authMode?: 'custom-token' | 'anonymous';
}

export async function withRtdbProbeSession(
  options: RtdbProbeSessionOptions,
  runProbe: (ctx: RtdbProbeContext) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const [
    { deleteApp, initializeApp },
    { deleteUser, getAuth, signInAnonymously },
    { retryAuthTooManyRequests, signInOracleClientAuth },
    rtdbSdk,
  ] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('./oracle-run-auth-session.ts'),
    import('firebase/database'),
  ]);

  const sa = await loadOracleServiceAccount();
  const webConfig = await resolveProbeWebConfig(sa);

  let rawRtdbUrl = webConfig.databaseURL;
  const envRtdbUrl = process.env.PYRIC_ORACLE_RTDB_URL?.trim();
  if (envRtdbUrl) {
    rawRtdbUrl = envRtdbUrl;
  }
  const databaseUrl = assertDedicatedOracleRtdbUrl(rawRtdbUrl, sa.project_id);
  const runId = nextProbeRunId('rtdb');
  const runPath = `/pyric_oracle/${runId}`;

  const getRtdbToken = () => oracleAccessToken(sa, RTDB_RULES_SCOPE);
  const defaultRunRules = { '.read': 'auth != null', '.write': 'auth != null' };
  const desiredRunRules = options.runRules ?? defaultRunRules;

  const session = new OracleRulesSession({
    projectId: sa.project_id,
    accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
  });
  const detachSignals = installOracleSignalRestoreGuard('[sdk-probes]', () =>
    session.restoreAll(),
  );
  const openedClients: RtdbProbeClientHandle[] = [];

  const openClient = async (label: string): Promise<RtdbProbeClientHandle> => {
    const app = initializeApp(
      { ...(webConfig as FirebaseOptions), databaseURL: databaseUrl },
      `sdk-probe-${runId}-${label}`,
    );
    const clientAuth = getAuth(app);
    if (options.authMode === 'anonymous') {
      await retryAuthTooManyRequests(`sdk-rtdb-${runId}-${label}`, () =>
        signInAnonymously(clientAuth),
      );
    } else {
      await signInOracleClientAuth(clientAuth, sa, `sdk-rtdb-${runId}-${label}`);
    }
    const signedIn = clientAuth.currentUser;
    if (!signedIn) {
      throw new Error(`RTDB probe client '${label}' failed to establish currentUser`);
    }
    const handle: RtdbProbeClientHandle = {
      app,
      db: rtdbSdk.getDatabase(app),
      uid: signedIn.uid,
    };
    openedClients.push(handle);
    return handle;
  };

  const resolveAdminDataUrl = async (subpath: string, queryExtra = ''): Promise<string> => {
    const cleanSub = subpath.replace(/^\/+/, '');
    let full = runPath;
    if (cleanSub) {
      full = `${runPath}/${cleanSub}`;
    }
    const token = await getRtdbToken();
    return `${databaseUrl}${full}.json?access_token=${encodeURIComponent(token)}${queryExtra}`;
  };

  try {
    return await runWithOracleRulesRestored(session, async () => {
      await session.deployRtdb(
        rtdbOracleTarget(databaseUrl, getRtdbToken, {
          runId,
          rules: desiredRunRules,
          stripTopLevelGrants: Boolean(options.runRules),
        }),
      );
      const settleMs = options.propagationMs ?? 5_000;
      await new Promise((resolve) => setTimeout(resolve, settleMs));

      try {
        const primary = await openClient('main');
        return await runProbe({
          runId,
          runPath,
          databaseUrl,
          db: primary.db,
          rtdbSdk,
          openClient,
          async adminRead(subpath: string, exportFormat = false): Promise<unknown> {
            let extra = '';
            if (exportFormat) {
              extra = '&format=export';
            }
            const res = await fetch(await resolveAdminDataUrl(subpath, extra));
            if (!res.ok) throw new Error(`RTDB adminRead failed: ${res.status}`);
            return res.json();
          },
          async adminWrite(subpath: string, value: unknown): Promise<void> {
            const res = await fetch(await resolveAdminDataUrl(subpath, '&print=silent'), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(value),
            });
            if (!res.ok) throw new Error(`RTDB adminWrite failed: ${res.status}`);
          },
          async adminRemove(subpath: string): Promise<void> {
            const res = await fetch(await resolveAdminDataUrl(subpath, '&print=silent'), {
              method: 'DELETE',
            });
            if (!res.ok) throw new Error(`RTDB adminRemove failed: ${res.status}`);
          },
        });
      } finally {
        for (const client of openedClients) {
          rtdbSdk.goOnline(client.db);
          const current = getAuth(client.app).currentUser;
          if (current) {
            await deleteUser(current).catch(() => undefined);
          }
          await deleteApp(client.app).catch(() => undefined);
        }
        const delUrl = await resolveAdminDataUrl('', '&print=silent');
        await fetch(delUrl, { method: 'DELETE' }).catch(() => undefined);
      }
    });
  } finally {
    detachSignals();
    if (session.restoredRtdb) {
      console.log('[sdk-probes] RTDB rules restored and verified');
    }
  }
}

interface AdminAuthProbeContext {
  runId: string;
  uidPrefix: string;
  adminAuth: AdminAuth;
  serviceAccount: OracleServiceAccount;
  createProbeUser(properties: CreateRequest & { uid: string }): Promise<UserRecord>;
  trackUid(uid: string): string;
}

export async function withAdminAuthProbeSession(
  runProbe: (ctx: AdminAuthProbeContext) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const [adminAppMod, { getAuth: getAdminAuth }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/auth'),
  ]);

  const sa = await loadOracleServiceAccount();
  const runId = nextProbeRunId('auth');
  const uidPrefix = `pyric-probe-${runId}`;
  const adminApp = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-auth-admin-${runId}`);
  const adminAuth = getAdminAuth(adminApp);
  const trackedUids = new Set<string>();

  try {
    return await runProbe({
      runId,
      uidPrefix,
      adminAuth,
      serviceAccount: sa,
      trackUid(uid: string): string {
        trackedUids.add(uid);
        return uid;
      },
      async createProbeUser(properties: CreateRequest & { uid: string }): Promise<UserRecord> {
        trackedUids.add(properties.uid);
        return adminAuth.createUser(properties);
      },
    });
  } finally {
    for (const uid of trackedUids) {
      try {
        await adminAuth.deleteUser(uid);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code !== 'auth/user-not-found') {
          console.error(`[sdk-probes] warning: failed to delete test user ${uid}: ${String(err)}`);
        }
      }
    }
    await adminAppMod.deleteApp(adminApp).catch(() => undefined);
  }
}

const DEFAULT_PROBES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'probes');
const ANON_RULE_OR_CLAIM_PATTERN = /\b(sign_in_provider|isAnonymous)\b/;
const SHARED_SESSION_OR_RULES_PATTERN =
  /\b(withRtdbProbeSession|withFirestoreProbeSession|withStorageProbeSession|runRules|OracleRulesTarget|rules_version|deployRtdb)\b|['"]\.(read|write)['"]\s*:|\ballow\s+(read|write|get|list|create|update|delete)\b/;
const EXPLICIT_ANONYMOUS_AUTH_MODE_PATTERN = /\bauthMode\s*:\s*['"]anonymous['"]/;

function stripCodeComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function collectProbeTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectProbeTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Returns violation strings for any probe file whose security rules or shared
 * session code references `sign_in_provider` or `isAnonymous` without opting
 * into `authMode: 'anonymous'`.
 */
export function auditProbeSessionAuthModes(probesRoot = DEFAULT_PROBES_ROOT): string[] {
  const violations: string[] = [];
  for (const filePath of collectProbeTsFiles(probesRoot)) {
    const raw = readFileSync(filePath, 'utf8');
    const code = stripCodeComments(raw);
    if (
      SHARED_SESSION_OR_RULES_PATTERN.test(code) &&
      ANON_RULE_OR_CLAIM_PATTERN.test(code) &&
      !EXPLICIT_ANONYMOUS_AUTH_MODE_PATTERN.test(code)
    ) {
      const rel = relative(probesRoot, filePath).replace(/\\/g, '/');
      violations.push(
        `${rel}: mentions sign_in_provider or isAnonymous in rules/session without authMode: 'anonymous'`,
      );
    }
  }
  return violations;
}
