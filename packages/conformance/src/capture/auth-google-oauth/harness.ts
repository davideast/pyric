#!/usr/bin/env bun
/**
 * Local human-witnessed capture runner for `auth-google-oauth` (#1814).
 *
 * Usage:
 *   PYRIC_ORACLE_PROJECT_ID=<oracle-project-id> \
 *     bun run packages/conformance/src/capture/auth-google-oauth/harness.ts \
 *     --write --gmail=<throwaway@gmail.com> --non-gmail=<throwaway@custom-domain>
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp as deleteClientApp, initializeApp as initializeClientApp } from 'firebase/app';
import {
  getAuth as getClientAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth, type UserRecord } from 'firebase-admin/auth';
import { requireCaptureMode } from '../../capture-mode-guard.ts';
import {
  loadOracleServiceAccount,
  oracleAccessToken,
  oracleAppOptions,
  oracleCredentialConfigured,
  type OracleServiceAccount,
} from '../../oracle-credential.ts';
import { assertWebConfigProject, webConfigFromEnv, type OracleWebConfig } from '../../oracle-run-setup.ts';
import { resolvedAdminVersion, resolvedFirebaseVersion } from '../../package-version.ts';
import { startGoogleOAuthPopupBridge } from './browser-bridge.ts';
import { missingExplicitEmailFlags, parseAuthGoogleOAuthCliArgs } from './cli-args.ts';
import { sanitizeAuthErrorCode } from './observation-writer.ts';
import {
  runGoogleOAuthCollisionCapture,
  type AdminAuthDriver,
  type AdminUserSnapshot,
  type PasswordAuthDriver,
} from './session-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', '..', '..', 'observations', 'auth');
const SCRIPT_REL = 'packages/conformance/src/capture/auth-google-oauth/harness.ts';
const CLOUD_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase.readonly';

const rawArgs = process.argv.slice(2);
const strippedArgs = requireCaptureMode({
  label: 'auth-google-oauth',
  scriptPath: SCRIPT_REL,
  argv: rawArgs,
  extraFlags: '--gmail=<throwaway@gmail.com> --non-gmail=<throwaway@custom-domain>',
  summary:
    'would run two human-witnessed Google OAuth popup sign-ins against run-scoped unverified accounts (@gmail.com and non-@gmail.com) and write sanitized collision facts.',
  missingCredentials: () => {
    const missing: string[] = [];
    const emailFlags = missingExplicitEmailFlags(rawArgs);
    if (emailFlags) {
      missing.push(emailFlags);
    }
    if (!oracleCredentialConfigured(process.env)) {
      missing.push('PYRIC_ORACLE_PROJECT_ID or PYRIC_ORACLE_SA_PATH');
    }
    if (missing.length === 0) {
      return null;
    }
    return missing.join(', ');
  },
});

const cli = parseAuthGoogleOAuthCliArgs(strippedArgs);
const sa = await loadOracleServiceAccount();

async function fetchOracleWebConfig(account: OracleServiceAccount): Promise<OracleWebConfig> {
  const fromEnv = webConfigFromEnv(process.env);
  if (fromEnv) {
    assertWebConfigProject(fromEnv, account.project_id);
    return fromEnv;
  }
  const token = await oracleAccessToken(account, CLOUD_SCOPE);
  const listResp = await fetch(
    `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(account.project_id)}/webApps`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listResp.ok) {
    throw new Error(`Failed to list Firebase Web Apps (${listResp.status}): ${await listResp.text()}`);
  }
  const listed = (await listResp.json()) as { apps?: Array<{ name?: string }> };
  const firstApp = listed.apps?.[0];
  if (!firstApp?.name) {
    throw new Error(`No Firebase Web App registered on project '${account.project_id}'.`);
  }
  const cfgResp = await fetch(`https://firebase.googleapis.com/v1beta1/${firstApp.name}/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!cfgResp.ok) {
    throw new Error(`Failed to fetch Firebase Web App config (${cfgResp.status}): ${await cfgResp.text()}`);
  }
  const cfg = (await cfgResp.json()) as OracleWebConfig;
  assertWebConfigProject(cfg, account.project_id);
  return cfg;
}

async function fetchAllowDuplicateEmails(account: OracleServiceAccount): Promise<boolean | null> {
  try {
    const token = await oracleAccessToken(account, CLOUD_SCOPE);
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(account.project_id)}/config`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      return null;
    }
    const body = (await resp.json()) as { signIn?: { allowDuplicateEmails?: unknown } };
    if (typeof body.signIn?.allowDuplicateEmails === 'boolean') {
      return body.signIn.allowDuplicateEmails;
    }
    return false;
  } catch {
    return null;
  }
}

function toUserSnapshot(record: UserRecord): AdminUserSnapshot {
  return {
    uid: record.uid,
    email: record.email ?? null,
    emailVerified: record.emailVerified,
    hasPasswordHash: typeof record.passwordHash === 'string' && record.passwordHash.length > 0,
    providerIds: record.providerData.map((p) => p.providerId),
    customClaims: (record.customClaims as Record<string, unknown> | undefined) ?? null,
    displayName: record.displayName ?? null,
    photoURL: record.photoURL ?? null,
  };
}

function isUserNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'auth/user-not-found'
  );
}

const webConfig = await fetchOracleWebConfig(sa);
const allowDuplicateEmails = await fetchAllowDuplicateEmails(sa);

const runTag = `${Date.now().toString(36)}`;
const adminApp = initializeAdminApp(oracleAppOptions(sa), `auth-google-oauth-admin-${runTag}`);
const clientApp = initializeClientApp(webConfig, `auth-google-oauth-client-${runTag}`);
const adminAuthSdk = getAdminAuth(adminApp);
const clientAuthSdk = getClientAuth(clientApp);
await setPersistence(clientAuthSdk, inMemoryPersistence);

const adminDriver: AdminAuthDriver = {
  async getUserByEmail(email) {
    try {
      return toUserSnapshot(await adminAuthSdk.getUserByEmail(email));
    } catch (err: unknown) {
      if (isUserNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
  async getUser(uid) {
    try {
      return toUserSnapshot(await adminAuthSdk.getUser(uid));
    } catch (err: unknown) {
      if (isUserNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
  async listUsers(maxResults, pageToken) {
    const res = await adminAuthSdk.listUsers(maxResults, pageToken);
    return {
      users: res.users.map(toUserSnapshot),
      pageToken: res.pageToken,
    };
  },
  async createUser(input) {
    return toUserSnapshot(await adminAuthSdk.createUser(input));
  },
  async setCustomUserClaims(uid, claims) {
    await adminAuthSdk.setCustomUserClaims(uid, claims);
  },
  async deleteUser(uid) {
    await adminAuthSdk.deleteUser(uid);
  },
};

const passwordDriver: PasswordAuthDriver = {
  async signInWithPassword(email, password) {
    try {
      const cred = await signInWithEmailAndPassword(clientAuthSdk, email, password);
      const snapshot = {
        ok: true as const,
        uid: cred.user.uid,
        emailVerified: cred.user.emailVerified,
        providerIds: cred.user.providerData.map((p) => p.providerId),
      };
      await signOut(clientAuthSdk);
      return snapshot;
    } catch (err: unknown) {
      return {
        ok: false as const,
        errorCode: sanitizeAuthErrorCode(err),
      };
    }
  },
};

const webConfigRecord: Record<string, string> = {
  apiKey: webConfig.apiKey,
  authDomain: webConfig.authDomain,
  projectId: webConfig.projectId,
};
if (webConfig.appId) {
  webConfigRecord.appId = webConfig.appId;
}

const bridge = await startGoogleOAuthPopupBridge({
  webConfig: webConfigRecord,
  port: cli.port,
  openBrowser: cli.openBrowser,
});

try {
  await runGoogleOAuthCollisionCapture({
    gmailEmail: cli.gmailEmail,
    nonGmailEmail: cli.nonGmailEmail,
    obsDir: OBS_DIR,
    fbSdkVersion: resolvedFirebaseVersion(),
    adminSdkVersion: resolvedAdminVersion(),
    projectAllowDuplicateEmails: allowDuplicateEmails,
    adminAuth: adminDriver,
    passwordDriver,
    popupDriver: bridge.popupDriver,
    extraSensitiveValues: [
      sa.project_id,
      webConfig.apiKey,
      webConfig.appId ?? '',
    ],
  });
  bridge.finish('Capture complete and test users cleaned up. You may close this browser tab.');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
} catch (err: unknown) {
  bridge.finish('Capture aborted; any test users created in this run were cleaned up.');
  throw err;
} finally {
  await bridge.close();
  await deleteClientApp(clientApp).catch(() => {});
  await deleteAdminApp(adminApp).catch(() => {});
}
