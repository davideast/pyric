/**
 * firebase-admin App Check createToken option probes: the
 * `app-check-admin-options-` observations (rigs/app-check-admin-options.ts).
 *
 * Mints App Check tokens on the oracle project with option edges (malformed
 * values, limitedUse, a chosen jti, fractional ttlMillis) and consumes two
 * same-jti tokens through verifyToken. It registers no debug token and makes
 * no AI Logic request. No token, key, or app id value is printed or written.
 *
 * Inert without PYRIC_AI_FIREBASE_CONFIG and an oracle credential
 * (PYRIC_ORACLE_SA_PATH, or PYRIC_ORACLE_PROJECT_ID with Application Default
 * Credentials): it prints what it would capture and exits 0 before any network
 * call.
 *
 * Run: PYRIC_ORACLE_PROJECT_ID=<project> PYRIC_AI_FIREBASE_CONFIG='<web config json>' \
 *   bun run packages/conformance/src/app-check-admin-option-probes.ts
 */
import { randomBytes } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { loadOracleServiceAccount, oracleCredentialConfigured } from './oracle-credential.ts';
import { formatInertPreviewFooter, requireCaptureMode } from './capture-mode-guard.ts';
import { ADMIN_OPTION_PLAN, runAdminOptionProbes } from './capture/app-check/admin-option-probes.ts';
import type { Secrets } from './capture/app-check/redact.ts';

interface WebConfig {
  apiKey: string;
  appId: string;
  projectId: string;
}

requireCaptureMode({
  label: 'app-check-admin-options',
  scriptPath: 'packages/conformance/src/app-check-admin-option-probes.ts',
  preview: () => {
    console.log('[app-check-admin-options] INERT preview; no network call was made.');
    for (const entry of ADMIN_OPTION_PLAN) console.log(`  ${entry.name}: ${entry.captures}`);
    console.log(`  ${formatInertPreviewFooter('packages/conformance/src/app-check-admin-option-probes.ts')}`);
  },
  missingCredentials: () => {
    const missing: string[] = [];
    if (!process.env.PYRIC_AI_FIREBASE_CONFIG) missing.push('PYRIC_AI_FIREBASE_CONFIG');
    if (!oracleCredentialConfigured(process.env)) {
      missing.push('PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID');
    }
    if (missing.length > 0) return missing.join(', ');
    return null;
  },
});

const rawConfig = process.env.PYRIC_AI_FIREBASE_CONFIG ?? '{}';

const sa = await loadOracleServiceAccount();
const web = JSON.parse(rawConfig) as WebConfig;
if (web.projectId !== sa.project_id) throw new Error('Web config and oracle service account target different projects');

const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const runJti = `pyric-app-check-options-${runId}`;
const projectNumber = web.appId.split(':')[1] ?? '';
const secrets: Secrets = { appId: web.appId, apiKey: web.apiKey, projectNumber, values: [runJti] };
const context = { projectId: web.projectId, secrets };
const adminApp = initializeApp({ credential: sa.credential, projectId: web.projectId }, `app-check-options-${runId}`);
const failures: string[] = [];

try {
  await runAdminOptionProbes({ context, appCheck: getAppCheck(adminApp), appId: web.appId, runJti }, failures);
} finally {
  await deleteApp(adminApp);
}

console.log(failures.length > 0 ? `\n${failures.length} probe(s) failed: ${failures.join(', ')}` : '\nall probes captured');
process.exit(failures.length > 0 ? 1 : 0);
