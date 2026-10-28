/**
 * Firebase App Check probes: the first `app-check-` observations.
 *
 * Captures what production App Check does on three planes, with enforcement
 * off: firebase-admin createToken/verifyToken, the raw exchangeDebugToken REST
 * envelope, and the real web SDK in headless Chromium in debug mode, including
 * the X-Firebase-AppCheck header the real firebase/ai SDK attaches. The plan,
 * including the enforcement captures this script does not run, is
 * packages/conformance/docs/app-check/capture-plan.md.
 *
 * No token, debug token, key, or app id value is ever printed or written: the
 * observation writer stores shapes and refuses a file that still contains one.
 *
 * Re-run safety: one debug token named `pyric-app-check-capture-<runId>` is
 * registered per run and deleted in a finally block; tokens left by an
 * interrupted run are swept before registering.
 *
 * Requires PYRIC_ORACLE_SA_PATH and PYRIC_AI_FIREBASE_CONFIG (same project).
 * Run: bun --env-file=<repo>/.env packages/conformance/src/app-check-probes.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { accessHeaders, resolveServiceAccount } from './storage-stdlib-real-api.ts';
import { registerDebugToken, deleteDebugToken, listRunTokens, sweepRunTokens } from './capture/app-check/debug-tokens.ts';
import { runAdminProbes } from './capture/app-check/admin-probes.ts';
import { runBrowserProbes } from './capture/app-check/browser-probes.ts';
import { runAiWireProbes } from './capture/app-check/ai-wire-probes.ts';
import type { Secrets } from './capture/app-check/redact.ts';

interface WebConfig {
  apiKey: string;
  appId: string;
  projectId: string;
  [key: string]: unknown;
}

if (!process.env.PYRIC_ORACLE_SA_PATH || !process.env.PYRIC_AI_FIREBASE_CONFIG) {
  console.error('PYRIC_ORACLE_SA_PATH and PYRIC_AI_FIREBASE_CONFIG are required; nothing was run.');
  process.exit(1);
}
const sa = resolveServiceAccount(process.env.PYRIC_ORACLE_SA_PATH);
const web = JSON.parse(process.env.PYRIC_AI_FIREBASE_CONFIG) as WebConfig;
if (web.projectId !== sa.project_id) throw new Error('Web config and oracle service account target different projects');

const projectNumber = web.appId.split(':')[1] ?? '';
const unregisteredDebugToken = randomUUID();
const secrets: Secrets = { appId: web.appId, apiKey: web.apiKey, projectNumber, values: [unregisteredDebugToken] };
const context = { projectId: web.projectId, secrets };
const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const { json: headers } = await accessHeaders(sa);
const failures: string[] = [];

/** App Check names AI Logic `firebaseml.googleapis.com` in its services API. */
async function readAiLogicEnforcement(): Promise<string> {
  const url = `https://firebaseappcheck.googleapis.com/v1/projects/${web.projectId}/services/firebaseml.googleapis.com`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`read AI Logic enforcement failed: ${response.status}`);
  return ((await response.json()) as { enforcementMode?: string }).enforcementMode ?? 'UNSET';
}

const swept = await sweepRunTokens(headers, web.projectId, web.appId);
if (swept > 0) console.log(`swept ${swept} debug token(s) left by an earlier run`);
const debugToken = await registerDebugToken(headers, web.projectId, web.appId, runId);
secrets.values.push(debugToken.value);
const adminApp = initializeApp({ credential: cert(sa as Parameters<typeof cert>[0]), projectId: web.projectId }, `app-check-probe-${runId}`);

try {
  const validToken = await runAdminProbes(
    { context, appCheck: getAppCheck(adminApp), appId: web.appId, apiKey: web.apiKey, debugToken: debugToken.value, unregisteredDebugToken },
    failures,
  );
  const enforcementMode = await readAiLogicEnforcement();
  if (enforcementMode !== 'UNENFORCED' && enforcementMode !== 'OFF') {
    throw new Error(`firebaseml.googleapis.com enforcementMode is ${enforcementMode}; this run expects enforcement off`);
  }
  await runAiWireProbes({ context, appCheck: getAppCheck(adminApp), appId: web.appId, apiKey: web.apiKey, validToken, enforcementMode }, failures);
  await runBrowserProbes({ context, firebaseConfig: web, debugToken: debugToken.value, unregisteredDebugToken }, failures);
} catch (error) {
  failures.push('runner');
  const text = String(error);
  console.error(`run failed: ${secrets.values.reduce((out, value) => out.split(value).join('<token>'), text)}`);
} finally {
  await deleteDebugToken(headers, debugToken.name);
  const remaining = await listRunTokens(headers, web.projectId, web.appId);
  console.log(`debug token deleted; run-scoped tokens remaining: ${remaining.length}`);
  if (remaining.length > 0) failures.push('cleanup');
  await deleteApp(adminApp);
}

console.log(failures.length > 0 ? `\n${failures.length} probe(s) failed: ${failures.join(', ')}` : '\nall probes captured');
process.exit(failures.length > 0 ? 1 : 0);
