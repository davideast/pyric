#!/usr/bin/env bun
/**
 * Captures for ADR-0021 (Firestore named databases) that write to the oracle
 * project. David approved both on 2026-10-28.
 *
 * - `cross-database` (C2): merges a block into the `cloud.firestore/probes`
 *   release whose rules `get()` and `exists()` run-scoped documents in
 *   `(default)`, seeds different documents at the same paths in each database,
 *   and records the client SDK's verdict for each case. The release is
 *   snapshotted before any write, restored in a finally block, read back and
 *   compared with the snapshot. The ruleset it created is then deleted.
 * - `admin-mixing` (C4): an Admin write of a reference to a `probes` document
 *   into `(default)`, a batch spanning both databases, and a transaction in
 *   `(default)` that reads and writes a `probes` document. Records each answer.
 *
 * Both write only under `__pyric_named_db_c2/<run>` in `(default)` and
 * `probes`, delete every document they wrote, and check each one reads back
 * missing. No other database and no other release is touched.
 *
 * Output: packages/conformance/observations/firestore/firestore-named-database-cross-database.json
 *         packages/conformance/observations/firestore/firestore-named-database-admin-mixing.json
 *
 * Credentials: the oracle credential, PYRIC_ORACLE_SA_PATH or
 * PYRIC_ORACLE_PROJECT_ID with Application Default Credentials (Firestore data
 * and Rules release management on the oracle project), and
 * PYRIC_AI_FIREBASE_CONFIG_PATH (the web app config file).
 *
 * Usage:
 *   PYRIC_ORACLE_PROJECT_ID=<project> PYRIC_AI_FIREBASE_CONFIG_PATH=<web.json> \
 *     bun run packages/conformance/src/capture-firestore-named-databases-deployed.ts cross-database | admin-mixing
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Firestore as AdminFirestore } from 'firebase-admin/firestore';
import { loadOracleServiceAccount, oracleAppOptions } from './oracle-credential.ts';
import {
  accessHeaders,
  jsonRequest,
  RULES_API,
  type ServiceAccount,
  type WebConfig,
} from './storage-stdlib-real-api.ts';
import { injectIntoMatch, replaceRulesFile, selectRulesFile, type Release, type Ruleset } from './storage-stdlib-real-rules.ts';

const OBSERVATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'observations', 'firestore');
const FB_SDK_VERSION = '12.13.0';
const ADMIN_SDK_VERSION = '13.10.0';
const NAMED = 'probes';
const ROOT = '__pyric_named_db_c2';
const RELEASE = `cloud.firestore/${NAMED}`;
const DOCUMENTS_MATCH = /(match\s+\/databases\/\{database\}\/documents\s*\{)/;
const PROPAGATION_LIMIT_MS = 180_000;
const SETTLE_MS = 30_000;
const READS_PER_CASE = 3;

/** Each case is one literal document under `t/`; its rule is the condition. */
function caseConditions(run: string): Record<string, string> {
  const inDefault = (path: string) => `/databases/(default)/documents/${ROOT}/${run}${path}`;
  return {
    'control-true': 'true',
    'control-false': 'false',
    'own-database-get-sees-probes-value': `get(/databases/$(database)/documents/${ROOT}/${run}).data.v == 'probes'`,
    'default-get-sees-default-value': `get(${inDefault('')}).data.v == 'default'`,
    'default-get-sees-probes-value': `get(${inDefault('')}).data.v == 'probes'`,
    'default-exists-of-default-only-document': `exists(${inDefault('/only/default')})`,
    'default-exists-of-probes-only-document': `exists(${inDefault('/only/probes')})`,
    'default-not-exists-of-default-only-document': `!exists(${inDefault('/only/default')})`,
    'default-get-or-true': `get(${inDefault('')}).data.v == 'nothing' || true`,
  };
}

function rulesBlock(run: string): string {
  const cases = Object.entries(caseConditions(run)).map(([name, condition]) =>
    `        match /t/${name} {\n          allow get: if ${condition};\n        }`);
  return `\n      // @pyric/named-db-c2 ${run}\n      match /${ROOT}/${run} {\n${cases.join('\n')}\n      }\n`;
}

interface RulesClient {
  project: string;
  headers: () => Promise<Awaited<ReturnType<typeof accessHeaders>>>;
}

async function readRelease(rules: RulesClient): Promise<Release> {
  const h = await rules.headers();
  return jsonRequest<Release>(`${RULES_API}/projects/${rules.project}/releases/${RELEASE}`, { headers: h.auth }, `read ${RELEASE}`);
}

async function deployMerged(rules: RulesClient, snapshot: Release, run: string): Promise<string> {
  const h = await rules.headers();
  const current = await jsonRequest<Ruleset>(`${RULES_API}/${snapshot.rulesetName}`, { headers: h.auth }, 'read probes ruleset');
  const file = selectRulesFile(current);
  const merged = injectIntoMatch(file.content, DOCUMENTS_MATCH, '`match /databases/{database}/documents`', rulesBlock(run));
  const created = await jsonRequest<{ name: string }>(
    `${RULES_API}/projects/${rules.project}/rulesets`,
    { method: 'POST', headers: h.json, body: JSON.stringify({ source: { files: replaceRulesFile(current, file, merged) } }) },
    'create C2 ruleset',
  );
  await jsonRequest(
    `${RULES_API}/projects/${rules.project}/releases/${RELEASE}`,
    { method: 'PATCH', headers: h.json, body: JSON.stringify({ release: { name: snapshot.name, rulesetName: created.name } }) },
    'activate C2 ruleset',
  );
  return created.name;
}

/** Points the release back at the snapshot, reads it back, and deletes the C2 ruleset. */
async function restore(rules: RulesClient, snapshot: Release, createdRuleset: string | null): Promise<Record<string, unknown>> {
  const h = await rules.headers();
  await jsonRequest(
    `${RULES_API}/projects/${rules.project}/releases/${RELEASE}`,
    { method: 'PATCH', headers: h.json, body: JSON.stringify({ release: { name: snapshot.name, rulesetName: snapshot.rulesetName } }) },
    'restore probes release',
  );
  const after = await readRelease(rules);
  if (after.rulesetName !== snapshot.rulesetName) {
    throw new Error(`RESTORE FAILED: ${RELEASE} points at ${after.rulesetName}; PATCH it back to ${snapshot.rulesetName} by hand`);
  }
  let rulesetDeleted = false;
  if (createdRuleset) {
    const res = await fetch(`${RULES_API}/${createdRuleset}`, { method: 'DELETE', headers: h.auth });
    rulesetDeleted = res.ok;
  }
  return { restoredTo: after.rulesetName, matchesSnapshot: true, createdRuleset, rulesetDeleted };
}

type Verdict = 'allowed' | 'permission-denied' | `error:${string}`;

async function clientVerdict(read: () => Promise<unknown>): Promise<Verdict> {
  try {
    await read();
    return 'allowed';
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? error);
    return code === 'permission-denied' ? 'permission-denied' : `error:${code}`;
  }
}

async function adminApp(sa: ServiceAccount, run: string) {
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = initializeApp(oracleAppOptions(sa), `named-db-c2-${run}`);
  return { defaultDb: getFirestore(app), namedDb: getFirestore(app, NAMED) };
}

/** Deletes each path from each database and returns the paths that still read back. */
async function cleanUp(dbs: AdminFirestore[], paths: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const db of dbs) {
    for (const path of paths) await db.doc(path).delete();
    for (const path of paths) if ((await db.doc(path).get()).exists) left.push(`${db.databaseId}:${path}`);
  }
  return left;
}

function writeObservation(observation: Record<string, unknown> & { name: string }): void {
  const out = join(OBSERVATIONS, `${observation.name}.json`);
  writeFileSync(out, `${JSON.stringify(observation, null, 2)}\n`);
  console.log(`[named-databases] wrote ${out}`);
}

async function captureCrossDatabase(sa: ServiceAccount, web: WebConfig): Promise<void> {
  const run = Math.random().toString(36).slice(2, 10);
  const rules: RulesClient = { project: encodeURIComponent(sa.project_id), headers: () => accessHeaders(sa) };
  const { defaultDb, namedDb } = await adminApp(sa, run);
  const base = `${ROOT}/${run}`;
  const paths = [base, `${base}/only/default`, `${base}/only/probes`];

  const snapshot = await readRelease(rules);
  console.log(`  snapshot ${RELEASE} -> ${snapshot.rulesetName}`);
  let created: string | null = null;
  let restoration: Record<string, unknown> = {};
  let left: string[] = [];
  const behavior: Record<string, string> = {};
  const reads: Record<string, Verdict[]> = {};
  const isolation: Record<string, unknown> = {};
  try {
    await defaultDb.doc(base).set({ v: 'default' });
    await defaultDb.doc(`${base}/only/default`).set({ v: 'default' });
    await namedDb.doc(base).set({ v: 'probes' });
    await namedDb.doc(`${base}/only/probes`).set({ v: 'probes' });
    isolation.defaultValue = (await defaultDb.doc(base).get()).get('v');
    isolation.probesValue = (await namedDb.doc(base).get()).get('v');
    isolation.defaultHasProbesOnly = (await defaultDb.doc(`${base}/only/probes`).get()).exists;
    isolation.probesHasDefaultOnly = (await namedDb.doc(`${base}/only/default`).get()).exists;

    created = await deployMerged(rules, snapshot, run);
    console.log(`  deployed ${created}`);

    const { initializeApp } = await import('firebase/app');
    const { getFirestore, doc, getDoc, terminate } = await import('firebase/firestore');
    const client = getFirestore(initializeApp(web, `named-db-c2-client-${run}`), NAMED);
    const readCase = (name: string) => clientVerdict(() => getDoc(doc(client, `${base}/t/${name}`)));

    const started = Date.now();
    while ((await readCase('control-true')) !== 'allowed') {
      if (Date.now() - started > PROPAGATION_LIMIT_MS) throw new Error('the C2 rules never took effect');
      await new Promise((r) => setTimeout(r, 10_000));
    }
    console.log(`  rules live after ${Math.round((Date.now() - started) / 1000)} s; settling ${SETTLE_MS / 1000} s`);
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    for (const name of Object.keys(caseConditions(run))) {
      reads[name] = [];
      for (let i = 0; i < READS_PER_CASE; i++) reads[name].push(await readCase(name));
      const distinct = [...new Set(reads[name])];
      behavior[name] = distinct.length === 1 ? distinct[0] : `inconsistent:${distinct.join('|')}`;
      console.log(`  ${name.padEnd(46)} ${behavior[name]}`);
    }
    await terminate(client);
  } finally {
    restoration = await restore(rules, snapshot, created);
    console.log(`  restored ${RELEASE} -> ${String(restoration.restoredTo)}`);
    left = await cleanUp([defaultDb, namedDb], paths);
    if (left.length > 0) console.error(`  CLEANUP LEFT ${left.join(', ')}`);
  }
  if (behavior['control-false'] !== 'permission-denied') throw new Error('control-false was not denied; the merged rules leak and the capture is invalid');

  writeObservation({
    name: 'firestore-named-database-cross-database',
    matrixRow: 'firestore MD4',
    rowIds: ['firestore#MD4'],
    description: `Deployed rules on the named database \`${NAMED}\` that get() and exists() run-scoped documents in \`(default)\`, read through the client SDK (no sign-in). The same path holds { v: 'default' } in (default) and { v: 'probes' } in ${NAMED}; only/default exists only in (default) and only/probes only in ${NAMED}. Each case is a get of one literal document under t/ whose rule is the case's condition.`,
    observedAt: new Date().toISOString(),
    fbSdkVersion: FB_SDK_VERSION,
    adminSdkVersion: ADMIN_SDK_VERSION,
    projectId: sa.project_id,
    method: `Snapshot ${RELEASE}; merge the block from rulesBlock() into its ruleset after the documents match; seed with the Admin SDK; wait until control-true is allowed, then ${SETTLE_MS / 1000} s; read each case ${READS_PER_CASE} times with getDoc(doc(getFirestore(app, '${NAMED}'), path)); restore the release, read it back, delete the C2 ruleset and every seeded document. packages/conformance/src/capture-firestore-named-databases-deployed.ts.`,
    behavior,
    diagnostics: { conditions: caseConditions('<run>'), reads, isolation, restoration, cleanupLeft: left },
  });
  if (left.length > 0) throw new Error(`cleanup left ${left.join(', ')}`);
}

async function outcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return 'committed';
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    return `error:${String(e.code ?? '')}:${String(e.message ?? error).split('\n')[0]}`;
  }
}

/** The holder's `ref` field as the REST API returns it: the full resource name the backend stored. */
async function restReferenceValue(sa: ServiceAccount, path: string): Promise<string | null> {
  const h = await accessHeaders(sa);
  const document = await jsonRequest<{ fields?: { ref?: { referenceValue?: string } } }>(
    `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`,
    { headers: h.auth },
    'read reference holder',
  );
  return document.fields?.ref?.referenceValue ?? null;
}

async function captureAdminMixing(sa: ServiceAccount): Promise<void> {
  const run = Math.random().toString(36).slice(2, 10);
  const { defaultDb, namedDb } = await adminApp(sa, run);
  const base = `${ROOT}/${run}`;
  const paths = [`${base}/c4/target`, `${base}/c4/reference-holder`, `${base}/c4/batch`, `${base}/c4/transaction`];
  const behavior: Record<string, string> = {};
  const stored: Record<string, unknown> = {};
  let left: string[] = [];
  try {
    await namedDb.doc(`${base}/c4/target`).set({ v: 'probes' });
    const namedTarget = namedDb.doc(`${base}/c4/target`);

    behavior['reference-to-other-database'] = await outcome(() =>
      defaultDb.doc(`${base}/c4/reference-holder`).set({ ref: namedTarget }));
    const holder = await defaultDb.doc(`${base}/c4/reference-holder`).get();
    if (holder.exists) {
      const ref = holder.get('ref') as { path?: string; firestore?: { databaseId?: string } } | undefined;
      stored.referenceReadBack = { path: ref?.path, databaseId: ref?.firestore?.databaseId };
      stored.referenceValueOnTheWire = await restReferenceValue(sa, `${base}/c4/reference-holder`);
    }

    behavior['batch-spanning-databases'] = await outcome(() => {
      const batch = defaultDb.batch();
      batch.set(defaultDb.doc(`${base}/c4/batch`), { v: 'default' });
      batch.set(namedDb.doc(`${base}/c4/batch`), { v: 'probes' });
      return batch.commit();
    });
    stored.batch = {
      default: (await defaultDb.doc(`${base}/c4/batch`).get()).get('v') ?? null,
      probes: (await namedDb.doc(`${base}/c4/batch`).get()).get('v') ?? null,
    };

    behavior['transaction-reads-and-writes-other-database'] = await outcome(() =>
      defaultDb.runTransaction(async (tx) => {
        await tx.get(namedTarget);
        tx.set(namedDb.doc(`${base}/c4/transaction`), { v: 'probes' });
      }, { maxAttempts: 1 }));
    stored.transaction = {
      default: (await defaultDb.doc(`${base}/c4/transaction`).get()).get('v') ?? null,
      probes: (await namedDb.doc(`${base}/c4/transaction`).get()).get('v') ?? null,
    };
    for (const [name, value] of Object.entries(behavior)) console.log(`  ${name.padEnd(46)} ${value}`);
  } finally {
    left = await cleanUp([defaultDb, namedDb], paths);
    if (left.length > 0) console.error(`  CLEANUP LEFT ${left.join(', ')}`);
  }
  writeObservation({
    name: 'firestore-named-database-admin-mixing',
    matrixRow: 'firestore MD3',
    rowIds: ['firestore#MD3'],
    description: `The Admin SDK mixing (default) and \`${NAMED}\`: a set() in (default) of a field holding a ${NAMED} DocumentReference, a WriteBatch from (default) with one set() in each database, and a (default) transaction that reads and writes ${NAMED} documents. Records whether each commits and what was stored.`,
    observedAt: new Date().toISOString(),
    adminSdkVersion: ADMIN_SDK_VERSION,
    projectId: sa.project_id,
    method: `getFirestore(adminApp) and getFirestore(adminApp, '${NAMED}') with the service account; transaction maxAttempts 1; every document under ${ROOT}/<run>/c4 deleted from both databases and read back missing. packages/conformance/src/capture-firestore-named-databases-deployed.ts.`,
    behavior,
    diagnostics: { stored, cleanupLeft: left },
  });
  if (left.length > 0) throw new Error(`cleanup left ${left.join(', ')}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const sa = await loadOracleServiceAccount();
  if (mode === 'admin-mixing') return captureAdminMixing(sa);
  if (mode === 'cross-database') {
    const configPath = process.env.PYRIC_AI_FIREBASE_CONFIG_PATH;
    if (!configPath) throw new Error('cross-database requires PYRIC_AI_FIREBASE_CONFIG_PATH');
    return captureCrossDatabase(sa, JSON.parse(readFileSync(configPath, 'utf8')) as WebConfig);
  }
  throw new Error('usage: capture-firestore-named-databases-deployed.ts cross-database | admin-mixing');
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
