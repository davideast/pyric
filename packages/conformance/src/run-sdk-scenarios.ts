#!/usr/bin/env bun
/**
 * Captures SDK behavior scenarios (`src/capture/sdk-scenarios/`) against the
 * production oracle and writes each result as an observation.
 *
 *   PYRIC_ORACLE_PROJECT_ID=<project> PYRIC_ORACLE_FIREBASE_CONFIG='<web config json>' \
 *   PYRIC_ORACLE_RTDB_URL=https://<dedicated-instance>.firebaseio.com \
 *     bun run packages/conformance/src/run-sdk-scenarios.ts <observation-name>...
 *
 * - Names are required. With none, or without credentials, it prints the plan
 *   and exits 0 without a network call.
 * - Firestore scenarios deploy nothing. They write under `pyric_oracle/<runId>`,
 *   which the oracle rules allow when signed in; the run tree is deleted with
 *   the admin SDK and read back afterwards.
 * - RTDB scenarios run only against `PYRIC_ORACLE_RTDB_URL`, which must name a
 *   dedicated instance, never the default one. The runner snapshots that
 *   instance's rules, merges the scenario's rules under `/pyric_oracle/$run`,
 *   and in a `finally` path deletes the run's data and restores the exact
 *   rules text, then reads both back and prints the result.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteApp, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously } from 'firebase/auth';
import * as firestoreSdk from 'firebase/firestore';
import * as databaseSdk from 'firebase/database';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { loadFirestoreScenarios, loadRtdbScenarios } from './capture/sdk-scenarios/load-scenarios.ts';
import { productionTiming } from './capture/sdk-scenarios/scenario-timing.ts';
import { SIGNED_IN_RULES, type FirestoreScenario, type RtdbScenario, type ScenarioObservation } from './capture/sdk-scenarios/scenario-types.ts';
import {
  loadOracleServiceAccount,
  oracleAppOptions,
  oracleCredentialConfigured,
  type OracleServiceAccount,
} from './oracle-credential.ts';
import {
  formatInertPreviewFooter,
  requireCaptureMode,
} from './capture-mode-guard.ts';
import { assertDedicatedOracleRtdbUrl } from './oracle-run-setup.ts';
import {
  createSignalRestoreCoordinator,
  restoreRtdbRulesWithRetry,
} from './oracle-signal-restore.ts';
import { resolvedFirebaseVersion } from './package-version.ts';

const OBSERVATIONS = join(import.meta.dir, '..', 'observations');
const SCENARIO_MS = 120_000;

interface Credentials {
  serviceAccount: OracleServiceAccount;
  config: FirebaseOptions & { projectId: string };
  rtdbUrl: string | undefined;
}

async function credentials(): Promise<Credentials> {
  const rawConfig = process.env.PYRIC_ORACLE_FIREBASE_CONFIG;
  if (!oracleCredentialConfigured(process.env) || !rawConfig) {
    throw new Error('missing PYRIC_ORACLE_FIREBASE_CONFIG or PYRIC_ORACLE_SA_PATH / PYRIC_ORACLE_PROJECT_ID');
  }
  return {
    serviceAccount: await loadOracleServiceAccount(),
    config: JSON.parse(rawConfig),
    rtdbUrl: process.env.PYRIC_ORACLE_RTDB_URL,
  };
}

const runId = () => `sdkhunt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Signed-in clients for one scenario, removed afterwards. */
function clientPool(config: FirebaseOptions, id: string, databaseURL?: string) {
  const apps: FirebaseApp[] = [];
  return {
    async open(name: string): Promise<FirebaseApp> {
      const app = initializeApp(databaseURL ? { ...config, databaseURL } : config, `${id}-${name}`);
      apps.push(app);
      await signInAnonymously(getAuth(app));
      return app;
    },
    async closeAll(): Promise<void> {
      for (const app of apps) {
        const user = getAuth(app).currentUser;
        if (user) await deleteUser(user).catch(() => undefined);
        await deleteApp(app).catch(() => undefined);
      }
    },
  };
}

function writeObservation(surface: string, observation: ScenarioObservation, projectId: string, behavior: Record<string, unknown>): void {
  const record = {
    name: observation.name,
    matrixRow: observation.rowIds.join(', '),
    rowIds: observation.rowIds,
    description: observation.description,
    observedAt: new Date().toISOString(),
    fbSdkVersion: resolvedFirebaseVersion(),
    projectId,
    behavior,
  };
  writeFileSync(join(OBSERVATIONS, surface, `${observation.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[sdk-scenarios] wrote observations/${surface}/${observation.name}.json`);
}

async function captureFirestore(scenario: FirestoreScenario, creds: Credentials): Promise<void> {
  const id = runId();
  const base = `pyric_oracle/${id}`;
  const pool = clientPool(creds.config, id);
  const admin = initializeAdminApp(oracleAppOptions(creds.serviceAccount), `sdk-scenarios-admin-${id}`);
  const adminDb = getAdminFirestore(admin);
  try {
    const open = async (name: string) => ({ db: firestoreSdk.getFirestore(await pool.open(name)) });
    const main = await open('main');
    const ctx = { ...productionTiming, fs: firestoreSdk, db: main.db, base, deniedDocPath: `pyric_oracle_denied_${id}/x`, newClient: open };
    const behavior = await productionTiming.bounded('scenario', scenario.run(ctx), SCENARIO_MS);
    writeObservation('firestore', scenario.observation, creds.config.projectId, behavior);
  } finally {
    await pool.closeAll();
    await adminDb.recursiveDelete(adminDb.doc(base));
    const left = (await adminDb.doc(base).listCollections()).length;
    console.log(`[sdk-scenarios] cleanup: ${base} subcollections left=${left}`);
    await deleteAdminApp(admin);
  }
}

async function rtdbAdminHeaders(serviceAccount: OracleServiceAccount): Promise<Record<string, string>> {
  const { access_token: token } = await serviceAccount.credential.getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

const canonicalRules = (text: string) => JSON.stringify(JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')));

async function captureRtdb(scenario: RtdbScenario, creds: Credentials): Promise<void> {
  const url = assertDedicatedOracleRtdbUrl(creds.rtdbUrl, creds.config.projectId);
  const coordinator = createSignalRestoreCoordinator('[sdk-scenarios]');
  const uninstallSignals = coordinator.installSignals();
  const headers = await rtdbAdminHeaders(creds.serviceAccount);
  const rulesUrl = `${url}/.settings/rules.json`;
  const readRulesText = async (): Promise<string> => {
    const res = await fetch(rulesUrl, { headers });
    if (!res.ok) throw new Error(`rules GET ${res.status}`);
    return res.text();
  };
  const writeRulesText = async (body: string): Promise<void> => {
    const res = await coordinator.trackMutation(
      fetch(rulesUrl, { method: 'PUT', headers, body }),
    );
    if (!res.ok) throw new Error(`rules PUT ${res.status}`);
  };
  const before = await readRulesText();
  const id = runId();
  const base = `/pyric_oracle/${id}`;
  const merged = { rules: { ...JSON.parse(before.replace(/^\s*\/\/.*$/gm, '')).rules, pyric_oracle: { $run: scenario.rules ?? SIGNED_IN_RULES } } };
  const pool = clientPool(creds.config, id, url);
  let deployed = false;
  let restored = false;
  coordinator.registerCleanup(async () => {
    if (!deployed) return;
    await restoreRtdbRulesWithRetry({
      beforeText: before,
      writeText: writeRulesText,
      readText: readRulesText,
      canonicalize: canonicalRules,
    });
    restored = true;
  });
  try {
    deployed = true;
    await writeRulesText(JSON.stringify(merged));
    const open = async (name: string) => ({ db: databaseSdk.getDatabase(await pool.open(name)) });
    const main = await open('main');
    const ctx = { ...productionTiming, rtdb: databaseSdk, db: main.db, base, newClient: open };
    const behavior = await productionTiming.bounded('scenario', scenario.run(ctx), SCENARIO_MS);
    writeObservation('rtdb-modular', scenario.observation, creds.config.projectId, behavior);
  } finally {
    await pool.closeAll();
    await fetch(`${url}${base}.json`, { method: 'DELETE', headers });
    try {
      await coordinator.runRestore();
    } finally {
      uninstallSignals();
    }
    const left = await (await fetch(`${url}${base}.json?shallow=true`, { headers })).text();
    console.log(`[sdk-scenarios] rules restored: ${restored}; ${base} after cleanup: ${left}`);
    if (deployed && !restored) throw new Error('RTDB rules restore verification failed');
  }
}

async function main(): Promise<void> {
  const firestore = await loadFirestoreScenarios();
  const rtdb = await loadRtdbScenarios();
  const all = [...firestore, ...rtdb].map((scenario) => scenario.observation.name);
  const cliArgs = requireCaptureMode({
    label: 'sdk-scenarios',
    scriptPath: 'packages/conformance/src/run-sdk-scenarios.ts',
    extraFlags: '<scenario-name>...',
    preview: () => {
      console.log('[sdk-scenarios] INERT preview (pass --write and scenario names to capture):');
      for (const name of all) console.log(`  ${name}`);
      console.log(`  ${formatInertPreviewFooter('packages/conformance/src/run-sdk-scenarios.ts', '<scenario-name>...')}`);
    },
    missingCredentials: () => {
      const missing: string[] = [];
      if (!oracleCredentialConfigured(process.env)) {
        missing.push('PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID');
      }
      if (!process.env.PYRIC_ORACLE_FIREBASE_CONFIG) {
        missing.push('PYRIC_ORACLE_FIREBASE_CONFIG');
      }
      if (missing.length > 0) return missing.join(', ');
      return null;
    },
  });
  const names = cliArgs.filter((arg) => !arg.startsWith('-'));
  if (names.length === 0) {
    throw new Error('pass one or more <scenario-name> arguments with --write');
  }
  const creds = await credentials();
  const unknown = names.filter((name) => !all.includes(name));
  if (unknown.length > 0) throw new Error(`unknown scenario: ${unknown.join(', ')}`);
  for (const scenario of firestore.filter((s) => names.includes(s.observation.name))) await captureFirestore(scenario, creds);
  for (const scenario of rtdb.filter((s) => names.includes(s.observation.name))) await captureRtdb(scenario, creds);
}

await main();
process.exit(0);
