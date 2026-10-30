#!/usr/bin/env bun
/**
 * Captures for ADR-0021 (Firestore named databases) that change no
 * production state.
 *
 * - `rules-api`: submits rulesets to the Rules Test API (`projects.test`),
 *   which compiles and evaluates them without deploying, with test cases whose
 *   `request.path` names the oracle project's existing named database
 *   `probes` and `(default)`. It records what `database` binds to, whether a
 *   literal database segment matches, what `request.path` holds, and whether a
 *   mocked `get()` of another database's path evaluates.
 * - `absent-database`: reads one document that does not exist from databases
 *   the project does not have (a valid id, an id outside the naming rules, and
 *   `default`), through the client SDK, the Admin SDK and the REST API, plus
 *   the same read against `(default)` and `probes` as controls. Against the
 *   missing databases only, it also tries a client `setDoc`, a client
 *   `onSnapshot` and an Admin `set()`. A write to a database that does not
 *   exist creates nothing.
 *
 * Output: packages/conformance/observations/firestore/firestore-named-database-rules-api.json
 *         packages/conformance/observations/firestore/firestore-named-database-absent.json
 *
 * Credentials: `rules-api` uses the Rules Test API credential `run-rules.ts`
 * uses (packages/pyric/test/rules/parity/credential.ts; PARITY_PROJECT_ID names
 * the project). `absent-database` uses the oracle credential (PYRIC_ORACLE_SA_PATH,
 * or PYRIC_ORACLE_PROJECT_ID with Application Default Credentials) and PYRIC_AI_FIREBASE_CONFIG (the web app
 * config JSON, or PYRIC_AI_FIREBASE_CONFIG_PATH naming a file that holds it).
 *
 * Usage:
 *   PARITY_PROJECT_ID=<project> bun run packages/conformance/src/capture-firestore-named-databases.ts rules-api
 *   PYRIC_ORACLE_PROJECT_ID=<project> PYRIC_AI_FIREBASE_CONFIG="$(cat web.json)" \
 *     bun run packages/conformance/src/capture-firestore-named-databases.ts absent-database
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOracleServiceAccount, oracleAppOptions } from './oracle-credential.ts';
import {
  accessHeaders,
  RULES_API,
  type ServiceAccount,
  type WebConfig,
} from './storage-stdlib-real-api.ts';

const OBSERVATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'observations');
const FB_SDK_VERSION = '12.13.0';
const ADMIN_SDK_VERSION = '13.10.0';
const NAMED = 'probes';

/** A Firestore ruleset whose document match is `block`. */
function firestoreRuleset(block: string): string {
  return `rules_version = '2';\nservice cloud.firestore {\n${block}\n}\n`;
}

const WILDCARD = (condition: string): string =>
  firestoreRuleset(`  match /databases/{database}/documents {\n    match /p/{d} {\n      allow read: if ${condition};\n    }\n  }`);

interface RulesProbe {
  ruleset: string;
  /** Mocks for `get()`, as the Test API takes them. */
  functionMocks?: unknown[];
}

/** Every probe runs a `get` of `p/d1` in `probes` and in `(default)`. */
const RULES_PROBES: Record<string, RulesProbe> = {
  'database-binds-named-id': { ruleset: WILDCARD(`database == '${NAMED}'`) },
  'database-binds-default-id': { ruleset: WILDCARD(`database == '(default)'`) },
  'request-path-database-segment-is-named-id': { ruleset: WILDCARD(`request.path[1] == '${NAMED}'`) },
  'request-path-equals-interpolated-path': {
    ruleset: WILDCARD('request.path == /databases/$(database)/documents/p/$(d)'),
  },
  'literal-named-database-match': {
    ruleset: firestoreRuleset(`  match /databases/${NAMED}/documents {\n    match /p/{d} {\n      allow read: if true;\n    }\n  }`),
  },
  'literal-default-database-match': {
    ruleset: firestoreRuleset(`  match /databases/(default)/documents {\n    match /p/{d} {\n      allow read: if true;\n    }\n  }`),
  },
  'mocked-get-of-default-database-path': {
    ruleset: WILDCARD('get(/databases/(default)/documents/c/x).data.v == 1'),
    functionMocks: [{
      function: 'get',
      args: [{ exactValue: '/databases/(default)/documents/c/x' }],
      result: { value: { data: { v: 1 } } },
    }],
  },
  'mocked-get-of-named-database-path': {
    ruleset: WILDCARD(`get(/databases/${NAMED}/documents/c/x).data.v == 1`),
    functionMocks: [{
      function: 'get',
      args: [{ exactValue: `/databases/${NAMED}/documents/c/x` }],
      result: { value: { data: { v: 1 } } },
    }],
  },
  // A file with one literal root block per database: does it compile, and
  // does each database get only its own block?
  'two-literal-root-blocks': {
    ruleset: firestoreRuleset(`  match /databases/${NAMED}/documents {\n    match /p/{d} {\n      allow read: if true;\n    }\n  }\n  match /databases/(default)/documents {\n    match /p/{d} {\n      allow read: if false;\n    }\n  }`),
  },
  // The same file with the verdicts swapped, so each block's own verdict shows.
  'two-literal-root-blocks-swapped': {
    ruleset: firestoreRuleset(`  match /databases/${NAMED}/documents {\n    match /p/{d} {\n      allow read: if false;\n    }\n  }\n  match /databases/(default)/documents {\n    match /p/{d} {\n      allow read: if true;\n    }\n  }`),
  },
  // Under a literal root, is `database` bound at all?
  'database-under-literal-root': {
    ruleset: firestoreRuleset(`  match /databases/${NAMED}/documents {\n    match /p/{d} {\n      allow read: if database == '${NAMED}';\n    }\n  }`),
  },
};

const RULES_CASES = [
  { description: 'get probes/p/d1', path: `/databases/${NAMED}/documents/p/d1` },
  { description: 'get (default)/p/d1', path: '/databases/(default)/documents/p/d1' },
] as const;

interface RulesApiResult {
  issues: string[];
  cases: Record<string, { decision: 'ALLOW' | 'DENY'; state: string; debugMessages: string[] }>;
}

/** The Rules Test API caller: the project and a bearer token for it. */
interface RulesScope {
  projectId: string;
  resolveToken(): Promise<string>;
}

async function testRuleset(scope: RulesScope, probe: RulesProbe): Promise<RulesApiResult> {
  const headers = { Authorization: `Bearer ${await scope.resolveToken()}`, 'Content-Type': 'application/json' };
  const testCases = RULES_CASES.map((c) => ({
    expectation: 'ALLOW',
    request: { auth: { uid: 'a', token: {} }, method: 'get', path: c.path },
    ...(probe.functionMocks ? { functionMocks: probe.functionMocks } : {}),
  }));
  const body = JSON.stringify({
    source: { files: [{ name: 'firestore.rules', content: probe.ruleset }] },
    testSuite: { testCases },
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${RULES_API}/projects/${scope.projectId}:test`, { method: 'POST', headers, body });
    const transient = res.status === 500 || res.status === 503;
    if (transient && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Rules Test API ${res.status}: ${await res.text()}`);
    const data = await res.json() as {
      issues?: { severity?: string; description: string }[];
      testResults?: { state?: string; debugMessages?: string[] }[];
    };
    const results = data.testResults ?? [];
    const cases: RulesApiResult['cases'] = {};
    RULES_CASES.forEach((c, i) => {
      const r = results[i];
      const state = r?.state ?? 'MISSING';
      // Every case expects ALLOW, so SUCCESS means production granted it.
      cases[c.description] = { decision: state === 'SUCCESS' ? 'ALLOW' : 'DENY', state, debugMessages: r?.debugMessages ?? [] };
    });
    return { issues: (data.issues ?? []).map((i) => `${i.severity ?? ''} ${i.description}`.trim()), cases };
  }
}

async function captureRulesApi(scope: RulesScope): Promise<void> {
  const behavior: Record<string, string> = {};
  const diagnostics: Record<string, unknown> = {};
  for (const [name, probe] of Object.entries(RULES_PROBES)) {
    const result = await testRuleset(scope, probe);
    for (const [description, outcome] of Object.entries(result.cases)) {
      behavior[`${name}:${description}`] = outcome.decision;
    }
    diagnostics[name] = { ruleset: probe.ruleset, functionMocks: probe.functionMocks ?? [], ...result };
    console.log(`  ${name.padEnd(46)} ${Object.entries(result.cases).map(([d, o]) => `${d}=${o.decision}`).join(', ')}`);
  }
  const observation = {
    name: 'firestore-named-database-rules-api',
    matrixRow: 'firestore MD4',
    rowIds: ['firestore#MD4'],
    description: 'Rules Test API (projects.test) evaluating Firestore rulesets against request paths in the named database `probes` and in `(default)`: what `database` and `request.path` bind to, whether a literal database segment matches, and whether a mocked get() of either database evaluates. The Test API deploys nothing.',
    observedAt: new Date().toISOString(),
    fbSdkVersion: FB_SDK_VERSION,
    projectId: scope.projectId,
    method: 'One projects.test call per probe in RULES_PROBES, packages/conformance/src/capture-firestore-named-databases.ts; each runs a get of p/d1 as uid a under /databases/probes/documents and /databases/(default)/documents, expecting ALLOW (SUCCESS means granted).',
    behavior,
    diagnostics,
  };
  const out = join(OBSERVATIONS, 'firestore', `${observation.name}.json`);
  writeFileSync(out, `${JSON.stringify(observation, null, 2)}\n`);
  console.log(`[named-databases] wrote ${out}`);
}

const TIMEOUT_MS = 20_000;

interface ReadOutcome {
  outcome: 'exists' | 'missing' | 'error' | 'timeout';
  code?: string;
  message?: string;
  status?: number;
}

async function bounded(read: () => Promise<boolean>): Promise<ReadOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReadOutcome>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ outcome: 'timeout' }), TIMEOUT_MS);
  });
  const attempt = read().then(
    (exists): ReadOutcome => ({ outcome: exists ? 'exists' : 'missing' }),
    (error: unknown): ReadOutcome => {
      const e = error as { code?: unknown; message?: unknown };
      return { outcome: 'error', code: String(e.code ?? ''), message: String(e.message ?? error) };
    },
  );
  const result = await Promise.race([attempt, timeout]);
  clearTimeout(timer);
  return result;
}

function describeOutcome(result: ReadOutcome): string {
  if (result.outcome === 'exists') return 'resolved';
  return result.code ? `${result.outcome}:${result.code}` : result.outcome;
}

type ListenOutcome =
  | { kind: 'snapshot'; fromCache: boolean; exists: boolean; afterMs: number }
  | { kind: 'error'; code: string; message: string; afterMs: number }
  | { kind: 'timeout' };

function describeListen(result: ListenOutcome): string {
  switch (result.kind) {
    case 'snapshot': return `snapshot:fromCache=${result.fromCache}:exists=${result.exists}`;
    case 'error': return `error:${result.code}`;
    case 'timeout': return 'timeout';
  }
}

/** The first event an `onSnapshot` listener delivers within the timeout. */
async function firstSnapshot(
  listen: typeof import('firebase/firestore').onSnapshot,
  ref: import('firebase/firestore').DocumentReference,
): Promise<ListenOutcome> {
  const started = Date.now();
  return new Promise<ListenOutcome>((resolveListen) => {
    let unsubscribe = (): void => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolveListen({ kind: 'timeout' });
    }, TIMEOUT_MS);
    const settle = (outcome: ListenOutcome): void => {
      clearTimeout(timer);
      unsubscribe();
      resolveListen(outcome);
    };
    unsubscribe = listen(
      ref,
      (snapshot) => settle({ kind: 'snapshot', fromCache: snapshot.metadata.fromCache, exists: snapshot.exists(), afterMs: Date.now() - started }),
      (error) => settle({ kind: 'error', code: String((error as { code?: unknown }).code ?? ''), message: error.message, afterMs: Date.now() - started }),
    );
  });
}

async function restRead(sa: ServiceAccount, databaseId: string, path: string): Promise<ReadOutcome> {
  const headers = await accessHeaders(sa);
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/${encodeURIComponent(databaseId)}/documents/${path}`;
  const res = await fetch(url, { headers: headers.auth });
  const body = await res.json().catch(() => ({})) as { error?: { status?: string; message?: string } };
  if (res.ok) return { outcome: 'exists', status: res.status };
  // A missing document is `Document "<name>" not found.`; a missing database
  // is also a 404, with `The database <id> does not exist ...`.
  const missing = res.status === 404 && body.error?.message?.startsWith('Document ') === true;
  return { outcome: missing ? 'missing' : 'error', status: res.status, code: body.error?.status, message: body.error?.message };
}

async function captureAbsentDatabase(sa: ServiceAccount, web: WebConfig): Promise<void> {
  const { initializeApp: initializeClient } = await import('firebase/app');
  const { getFirestore: clientFirestore, doc, getDoc, setDoc, onSnapshot, terminate } = await import('firebase/firestore');
  const { initializeApp: initializeAdmin } = await import('firebase-admin/app');
  const { getFirestore: adminFirestore } = await import('firebase-admin/firestore');

  const runId = Math.random().toString(36).slice(2, 10);
  const docPath = `__pyric_named_db_probe/${runId}`;
  const databases: Record<string, string> = {
    'absent-valid-id': `pyric-absent-${runId}`,
    'absent-invalid-id': 'Bad_Id',
    'keyword-default': 'default',
    'control-default': '(default)',
    'control-probes': NAMED,
  };

  const client = initializeClient(web, `named-db-${runId}`);
  const admin = initializeAdmin(oracleAppOptions(sa), `named-db-admin-${runId}`);
  const behavior: Record<string, string> = {};
  const diagnostics: Record<string, unknown> = {};
  for (const [label, databaseId] of Object.entries(databases)) {
    const clientDb = clientFirestore(client, databaseId);
    const clientRead = await bounded(async () => (await getDoc(doc(clientDb, docPath))).exists());
    await terminate(clientDb);
    const adminRead = await bounded(async () => (await adminFirestore(admin, databaseId).doc(docPath).get()).exists);
    const rest = await restRead(sa, databaseId, docPath);
    behavior[`${label}:client`] = clientRead.code ? `${clientRead.outcome}:${clientRead.code}` : clientRead.outcome;
    behavior[`${label}:admin`] = adminRead.code ? `${adminRead.outcome}:${adminRead.code}` : adminRead.outcome;
    behavior[`${label}:rest`] = rest.status !== undefined ? `${rest.outcome}:${rest.status}` : rest.outcome;
    diagnostics[label] = { databaseId, client: clientRead, admin: adminRead, rest };
    console.log(`  ${label.padEnd(18)} client=${behavior[`${label}:client`]} admin=${behavior[`${label}:admin`]} rest=${behavior[`${label}:rest`]}`);

    // Writes and a listener only against databases that do not exist, where a
    // write cannot land: production holds no database to write into.
    const isAbsent = label !== 'control-default' && label !== 'control-probes';
    if (!isAbsent) continue;
    const writeDb = clientFirestore(client, databaseId);
    const clientWrite = await bounded(async () => {
      await setDoc(doc(writeDb, docPath), { probe: runId });
      return true;
    });
    await terminate(writeDb);
    const listenDb = clientFirestore(client, databaseId);
    const clientListen = await firstSnapshot(onSnapshot, doc(listenDb, docPath));
    await terminate(listenDb);
    const adminWrite = await bounded(async () => {
      await adminFirestore(admin, databaseId).doc(docPath).set({ probe: runId });
      return true;
    });
    behavior[`${label}:client-setDoc`] = describeOutcome(clientWrite);
    behavior[`${label}:client-onSnapshot`] = describeListen(clientListen);
    behavior[`${label}:admin-set`] = describeOutcome(adminWrite);
    diagnostics[`${label}:writes`] = { databaseId, clientSetDoc: clientWrite, clientOnSnapshot: clientListen, adminSet: adminWrite };
    console.log(`  ${label.padEnd(18)} setDoc=${behavior[`${label}:client-setDoc`]} onSnapshot=${behavior[`${label}:client-onSnapshot`]} admin.set=${behavior[`${label}:admin-set`]}`);
  }

  const observation = {
    name: 'firestore-named-database-absent',
    matrixRow: 'firestore MD1',
    rowIds: ['firestore#MD1'],
    description: 'Reading a document that does not exist from a database the project lacks (a valid id, an id outside the naming rules, and the keyword `default`) through the client SDK (unauthenticated), the Admin SDK and the REST API, with `(default)` and the existing named database `probes` as controls; then, against the missing databases only, a client setDoc, the first event of a client onSnapshot, and an Admin set(). No write targets a database that exists, so nothing is created.',
    observedAt: new Date().toISOString(),
    fbSdkVersion: FB_SDK_VERSION,
    adminSdkVersion: ADMIN_SDK_VERSION,
    projectId: sa.project_id,
    method: `getDoc(doc(getFirestore(app, id), path)) with the web config and no sign-in; getFirestore(adminApp, id).doc(path).get() with the service account; GET firestore.googleapis.com/v1/projects/<p>/databases/<id>/documents/<path> with the service account token. Each SDK read is bounded at ${TIMEOUT_MS} ms. packages/conformance/src/capture-firestore-named-databases.ts.`,
    behavior,
    diagnostics,
  };
  const out = join(OBSERVATIONS, 'firestore', `${observation.name}.json`);
  writeFileSync(out, `${JSON.stringify(observation, null, 2)}\n`);
  console.log(`[named-databases] wrote ${out}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'rules-api') {
    // The Rules Test API credential run-rules.ts uses: GOOGLE_APPLICATION_CREDENTIALS,
    // then a firebase-tools login, then gcloud ADC (test/rules/parity/credential.ts).
    const { parityScope } = await import('../../pyric/test/rules/parity/harness.ts');
    return captureRulesApi(parityScope() as RulesScope);
  }
  const sa = await loadOracleServiceAccount();
  if (mode === 'absent-database') {
    const configPath = process.env.PYRIC_AI_FIREBASE_CONFIG_PATH;
    const config = configPath ? readFileSync(configPath, 'utf8') : process.env.PYRIC_AI_FIREBASE_CONFIG;
    if (!config) throw new Error('absent-database requires PYRIC_AI_FIREBASE_CONFIG or PYRIC_AI_FIREBASE_CONFIG_PATH');
    return captureAbsentDatabase(sa, JSON.parse(config) as WebConfig);
  }
  throw new Error('usage: capture-firestore-named-databases.ts rules-api | absent-database');
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
