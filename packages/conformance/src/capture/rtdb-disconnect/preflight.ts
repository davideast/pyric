#!/usr/bin/env bun
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref, set, get, remove } from 'firebase/database';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

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

async function mintToken(sa: ServiceAccount, scope: string): Promise<string> {
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600,
  })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key).toString('base64url');
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${signature}`,
    }),
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
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
  if (!config.databaseURL) {
    const instancesResponse = await fetch(
      `https://firebasedatabase.googleapis.com/v1beta/projects/${encodeURIComponent(projectId)}/locations/-/instances`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!instancesResponse.ok) throw new Error(`RTDB discovery failed: ${instancesResponse.status}`);
    const instances = ((await instancesResponse.json()) as {
      instances?: Array<{ databaseUrl?: string; state?: string; type?: string }>;
    }).instances ?? [];
    const active = instances.filter((instance) => instance.state === 'ACTIVE');
    const pool = active.length > 0 ? active : instances;
    config.databaseURL = (pool.find((instance) => instance.type === 'DEFAULT_DATABASE') ?? pool[0])?.databaseUrl;
  }
  if (!config.databaseURL) throw new Error('oracle project has no discoverable RTDB instance');
  return config;
}

async function main(): Promise<void> {
  const saPath = process.env.PYRIC_ORACLE_SA_PATH;
  if (!saPath || !existsSync(saPath)) throw new Error('PYRIC_ORACLE_SA_PATH does not name a readable file');
  const serviceAccount = JSON.parse(readFileSync(saPath, 'utf8')) as ServiceAccount;
  const firebaseToken = await mintToken(serviceAccount, 'https://www.googleapis.com/auth/firebase');
  const config = await discoverConfig(firebaseToken, serviceAccount.project_id);
  if (config.projectId !== serviceAccount.project_id) throw new Error('discovered Web App belongs to a different project');

  console.log(`[oracle:rtdb-disconnect:preflight] project: ${config.projectId}`);
  console.log(`[oracle:rtdb-disconnect:preflight] database: ${config.databaseURL}`);

  const databaseToken = await mintToken(
    serviceAccount,
    'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
  );
  const rulesUrl = `${config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(databaseToken)}`;
  const readRules = async (): Promise<Record<string, unknown>> => {
    const response = await fetch(rulesUrl);
    if (!response.ok) throw new Error(`rules backup/read failed: ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };
  const writeRules = async (rules: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`${rulesUrl}&print=silent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rules),
    });
    if (!response.ok) throw new Error(`rules write failed: ${response.status}`);
  };

  const before = await readRules();
  const beforeCanonical = canonical(before);
  console.log('[oracle:rtdb-disconnect:preflight] rules backup: ok');
  const currentRules = (before.rules && typeof before.rules === 'object'
    ? before.rules : {}) as Record<string, unknown>;
  const currentOracleRules = (currentRules.pyric_oracle && typeof currentRules.pyric_oracle === 'object'
    ? currentRules.pyric_oracle : {}) as Record<string, unknown>;
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
  let restored = false;
  let temporaryUser: Awaited<ReturnType<typeof signInAnonymously>>['user'] | undefined;
  try {
    await writeRules(temporary);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const auth = getAuth(app);
    const credential = await signInAnonymously(auth);
    temporaryUser = credential.user;
    const scratch = ref(getDatabase(app), `pyric_oracle/${scratchKey}/control`);
    await set(scratch, { control: true });
    if ((await get(scratch)).val()?.control !== true) throw new Error('anonymous scratch read did not match write');
    await remove(scratch);
    if ((await get(scratch)).exists()) throw new Error('anonymous scratch cleanup did not remove data');
    console.log('[oracle:rtdb-disconnect:preflight] anonymous write/read/remove control: ok');
  } finally {
    await temporaryUser?.delete().catch(() => undefined);
    await deleteApp(app).catch(() => undefined);
    await writeRules(before);
    const after = await readRules();
    restored = canonical(after) === beforeCanonical;
  }
  if (!restored) throw new Error('rules restore read-back differs from the preflight backup');
  console.log('[oracle:rtdb-disconnect:preflight] rules restore/read-back: ok');
}

if (import.meta.main) await main();
