#!/usr/bin/env bun
import { initializeApp, deleteApp } from 'firebase/app';
import { deleteUser, getAuth } from 'firebase/auth';
import { getDatabase, ref, set, get, remove } from 'firebase/database';
import { requireCaptureMode } from '../../capture-mode-guard.ts';
import { RTDB_RULES_SCOPE } from '../../oracle-access-token.ts';
import {
  loadOracleServiceAccount,
  oracleAccessToken,
  oracleCredentialConfigured,
} from '../../oracle-credential.ts';
import { signInOracleClientAuth } from '../../oracle-run-auth-session.ts';
import {
  assertDedicatedOracleRtdbUrl,
  isDedicatedOracleRtdbUrl,
  selectDedicatedRtdbInstanceUrl,
  type RtdbInstanceSummary,
} from '../../oracle-run-setup.ts';
import {
  createSignalRestoreCoordinator,
  restoreRtdbRulesWithRetry,
} from '../../oracle-signal-restore.ts';

interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  appId?: string;
  databaseURL?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function discoverConfig(token: string, projectId: string): Promise<FirebaseWebConfig> {
  const appsResponse = await fetch(
    `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/webApps`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!appsResponse.ok) throw new Error(`web-app discovery failed: ${appsResponse.status}`);
  const apps = ((await appsResponse.json()) as { apps?: Array<{ appId: string }> }).apps ?? [];
  if (!apps[0]) throw new Error('oracle project has no Web App; run the main oracle bootstrap first');
  const configResponse = await fetch(
    `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/webApps/${encodeURIComponent(apps[0].appId)}/config`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!configResponse.ok) throw new Error(`web config discovery failed: ${configResponse.status}`);
  const config = (await configResponse.json()) as FirebaseWebConfig;
  const explicitUrl = process.env.PYRIC_ORACLE_RTDB_URL?.trim();
  if (explicitUrl) {
    config.databaseURL = assertDedicatedOracleRtdbUrl(explicitUrl, projectId);
  } else if (!config.databaseURL || !isDedicatedOracleRtdbUrl(config.databaseURL, projectId)) {
    const instancesResponse = await fetch(
      `https://firebasedatabase.googleapis.com/v1beta/projects/${encodeURIComponent(projectId)}/locations/-/instances`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!instancesResponse.ok) throw new Error(`RTDB discovery failed: ${instancesResponse.status}`);
    const instances = ((await instancesResponse.json()) as {
      instances?: RtdbInstanceSummary[];
    }).instances ?? [];
    const selected = selectDedicatedRtdbInstanceUrl(instances, projectId);
    if (!selected) {
      throw new Error('oracle project has no discoverable dedicated RTDB instance');
    }
    config.databaseURL = selected;
  }
  config.databaseURL = assertDedicatedOracleRtdbUrl(config.databaseURL, projectId);
  return config;
}

async function main(): Promise<void> {
  requireCaptureMode({
    label: 'oracle:rtdb-disconnect:preflight',
    scriptPath: 'packages/conformance/src/capture/rtdb-disconnect/preflight.ts',
    summary: 'would verify dedicated RTDB rules backup, anonymous scratch read/write/delete, and rules restore.',
    missingCredentials: () => {
      if (oracleCredentialConfigured(process.env)) return null;
      return 'PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID';
    },
  });

  const serviceAccount = await loadOracleServiceAccount();
  const firebaseToken = await oracleAccessToken(serviceAccount, 'https://www.googleapis.com/auth/firebase');
  const config = await discoverConfig(firebaseToken, serviceAccount.project_id);
  if (config.projectId !== serviceAccount.project_id) throw new Error('discovered Web App belongs to a different project');

  console.log(`[oracle:rtdb-disconnect:preflight] project: ${config.projectId}`);
  console.log(`[oracle:rtdb-disconnect:preflight] database: ${config.databaseURL}`);

  const coordinator = createSignalRestoreCoordinator('[oracle:rtdb-disconnect:preflight]');
  const uninstallSignals = coordinator.installSignals();

  const databaseToken = await oracleAccessToken(serviceAccount, RTDB_RULES_SCOPE);
  const rulesUrl = `${config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(databaseToken)}`;
  const readRulesText = async (): Promise<string> => {
    const response = await fetch(rulesUrl);
    if (!response.ok) throw new Error(`rules backup/read failed: ${response.status}`);
    return response.text();
  };
  const writeRulesText = async (bodyText: string): Promise<void> => {
    const response = await coordinator.trackMutation(
      fetch(`${rulesUrl}&print=silent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: bodyText,
      }),
    );
    if (!response.ok) throw new Error(`rules write failed: ${response.status}`);
  };

  const beforeText = await readRulesText();
  const before = JSON.parse(beforeText) as Record<string, unknown>;
  console.log('[oracle:rtdb-disconnect:preflight] rules backup: ok');
  let currentRules: Record<string, unknown> = {};
  if (before.rules && typeof before.rules === 'object') {
    currentRules = before.rules as Record<string, unknown>;
  }
  let currentOracleRules: Record<string, unknown> = {};
  if (currentRules.pyric_oracle && typeof currentRules.pyric_oracle === 'object') {
    currentOracleRules = currentRules.pyric_oracle as Record<string, unknown>;
  }
  const scratchKey = `__disconnect_preflight_${Date.now()}`;
  const temporary = {
    ...before,
    rules: {
      ...currentRules,
      pyric_oracle: {
        ...currentOracleRules,
        [scratchKey]: { '.read': 'auth != null', '.write': 'auth != null' },
      },
    },
  };

  const app = initializeApp(config, `rtdb-disconnect-preflight-${Date.now()}`);
  const auth = getAuth(app);
  coordinator.registerCleanup(() =>
    restoreRtdbRulesWithRetry({
      beforeText,
      writeText: writeRulesText,
      readText: readRulesText,
      canonicalize: (text) => canonical(JSON.parse(text)),
    }),
  );
  try {
    await writeRulesText(JSON.stringify(temporary));
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await signInOracleClientAuth(auth, serviceAccount, scratchKey);
    const scratch = ref(getDatabase(app), `pyric_oracle/${scratchKey}/control`);
    await set(scratch, { control: true });
    if ((await get(scratch)).val()?.control !== true) throw new Error('anonymous scratch read did not match write');
    await remove(scratch);
    if ((await get(scratch)).exists()) throw new Error('anonymous scratch cleanup did not remove data');
    console.log('[oracle:rtdb-disconnect:preflight] anonymous write/read/remove control: ok');
  } finally {
    if (auth.currentUser) {
      await deleteUser(auth.currentUser).catch(() => undefined);
    }
    await deleteApp(app).catch(() => undefined);
    try {
      await coordinator.runRestore();
    } finally {
      uninstallSignals();
    }
  }
  console.log('[oracle:rtdb-disconnect:preflight] rules restore/read-back: ok');
}

if (import.meta.main) await main();
