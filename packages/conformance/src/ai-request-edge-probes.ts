/**
 * AI Logic generateContent request-edge probes: the `ai-request-edge-`
 * observations (rigs/ai-request-edge.ts).
 *
 * Mints one App Check token with firebase-admin, then sends exactly three
 * generateContent requests (role-less contents, a top-level string
 * systemInstruction, the model name gemini-pro) and freezes status and error
 * facts. Generated text is never a claim. No token, key, or app id value is
 * printed or written.
 *
 * Inert without PYRIC_AI_FIREBASE_CONFIG and an oracle credential
 * (PYRIC_ORACLE_SA_PATH, or PYRIC_ORACLE_PROJECT_ID with Application Default
 * Credentials): it prints what it would capture and exits 0 before any network
 * call.
 *
 * Run: PYRIC_ORACLE_PROJECT_ID=<project> PYRIC_AI_FIREBASE_CONFIG='<web config json>' \
 *   bun run packages/conformance/src/ai-request-edge-probes.ts
 */
import { randomBytes } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { loadOracleServiceAccount, oracleCredentialConfigured } from './oracle-credential.ts';
import { mintWithRetry } from './capture/app-check/mint.ts';
import type { Secrets } from './capture/app-check/redact.ts';
import { REQUEST_EDGE_CASES } from './capture/ai/request-edge-cases.ts';
import { runRequestEdgeProbes } from './capture/ai/request-edge-probes.ts';

interface WebConfig {
  apiKey: string;
  appId: string;
  projectId: string;
}

const rawConfig = process.env.PYRIC_AI_FIREBASE_CONFIG;
const credentialsMissing = !oracleCredentialConfigured(process.env) || !rawConfig;

if (credentialsMissing) {
  console.log('PYRIC_AI_FIREBASE_CONFIG and an oracle credential (PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID) are not both set; no network call was made.');
  console.log('With both set, this runner mints one App Check token and sends one generateContent request per case:');
  for (const testCase of REQUEST_EDGE_CASES) console.log(`  ${testCase.name} (model ${testCase.model}): ${testCase.description}`);
  process.exit(0);
}

const sa = await loadOracleServiceAccount();
const web = JSON.parse(rawConfig) as WebConfig;
if (web.projectId !== sa.project_id) throw new Error('Web config and oracle service account target different projects');

const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const adminApp = initializeApp({ credential: sa.credential, projectId: web.projectId }, `ai-request-edge-${runId}`);
let appCheckToken: string;
try {
  appCheckToken = (await mintWithRetry(getAppCheck(adminApp), web.appId)).token;
} finally {
  await deleteApp(adminApp);
}

const projectNumber = web.appId.split(':')[1] ?? '';
const secrets: Secrets = { appId: web.appId, apiKey: web.apiKey, projectNumber, values: [appCheckToken] };
const failures: string[] = [];
await runRequestEdgeProbes({ context: { projectId: web.projectId, secrets }, apiKey: web.apiKey, appCheckToken }, failures);

console.log(failures.length > 0 ? `\n${failures.length} probe(s) failed: ${failures.join(', ')}` : '\nall probes captured');
process.exit(failures.length > 0 ? 1 : 0);
