/**
 * The project id an admin app resolves, in firebase-admin's order
 * (`getExplicitProjectId`, firebase-admin 13 `lib/utils/index.js`): the
 * `projectId` app option, then a cert credential's project id, then
 * `GOOGLE_CLOUD_PROJECT`, then `GCLOUD_PROJECT`.
 *
 * Pyric's `cert()` is inert: it keeps the service account's project id and
 * nothing else, so no private key or client email is held in the sandbox.
 * Both keys sit behind `Symbol.for`, as the app registry does, so the require
 * and import copies of this module that the register hook can load agree.
 */
import { readFileSync } from 'node:fs';

const CREDENTIAL_PROJECT_ID = Symbol.for('pyric.admin.credential.projectId');
const APP_CREDENTIAL_PROJECT_ID = Symbol.for('pyric.admin.app.credentialProjectId');

type WithProjectId = { [CREDENTIAL_PROJECT_ID]?: unknown; [APP_CREDENTIAL_PROJECT_ID]?: unknown };

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  return undefined;
}

/** firebase-admin's `ServiceAccount.fromPath`, except that a file it cannot read or parse yields no object. */
function readServiceAccountFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof Error) {
      return undefined;
    }
    throw error;
  }
}

/** Selects `projectId || project_id` before type validation, matching firebase-admin's `copyAttr`. */
function selectServiceAccountProjectField(account: Record<string, unknown>): unknown {
  const camelCaseProjectId = account.projectId;
  if (Boolean(camelCaseProjectId)) {
    return camelCaseProjectId;
  }
  return account.project_id;
}

/** The project id of a service account object or file path: `projectId`, then `project_id`, as firebase-admin's `copyAttr` reads it. */
function serviceAccountProjectId(serviceAccountPathOrObject: unknown): string | undefined {
  let account: unknown = serviceAccountPathOrObject;
  if (typeof serviceAccountPathOrObject === 'string') {
    account = readServiceAccountFile(serviceAccountPathOrObject);
  }
  if (typeof account !== 'object' || account === null) {
    return undefined;
  }
  const rawProjectId = selectServiceAccountProjectField(account as Record<string, unknown>);
  return nonEmptyString(rawProjectId);
}

function defineHidden(target: object, key: symbol, value: string): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });
}

/** Keeps the service account's project id on an inert credential, as a non-enumerable property. */
export function keepCredentialProjectId(credential: object, serviceAccountPathOrObject: unknown): void {
  const projectId = serviceAccountProjectId(serviceAccountPathOrObject);
  if (projectId !== undefined) defineHidden(credential, CREDENTIAL_PROJECT_ID, projectId);
}

/** Copies a cert credential's project id from initialization options onto the app, beside `options`. */
export function keepAppCredentialProjectId(app: object, config: unknown): void {
  if (typeof config !== 'object' || config === null) return;
  const credential = (config as { credential?: unknown }).credential;
  if (typeof credential !== 'object' || credential === null) return;
  const projectId = nonEmptyString((credential as WithProjectId)[CREDENTIAL_PROJECT_ID]);
  if (projectId !== undefined) defineHidden(app, APP_CREDENTIAL_PROJECT_ID, projectId);
}

/** firebase-admin's `getExplicitProjectId` for a sandbox admin app. */
export function explicitProjectId(app: {
  readonly options: { readonly projectId?: string; readonly credential?: object };
}): string | undefined {
  const optionProjectId = nonEmptyString(app.options.projectId);
  if (optionProjectId !== undefined) {
    return optionProjectId;
  }
  const credential = app.options.credential;
  if (typeof credential === 'object' && credential !== null) {
    const credentialProjectId = nonEmptyString((credential as WithProjectId)[CREDENTIAL_PROJECT_ID]);
    if (credentialProjectId !== undefined) {
      return credentialProjectId;
    }
  }
  const appCredentialProjectId = nonEmptyString((app as WithProjectId)[APP_CREDENTIAL_PROJECT_ID]);
  if (appCredentialProjectId !== undefined) {
    return appCredentialProjectId;
  }
  const googleCloudProject = nonEmptyString(process.env.GOOGLE_CLOUD_PROJECT);
  if (googleCloudProject !== undefined) {
    return googleCloudProject;
  }
  return nonEmptyString(process.env.GCLOUD_PROJECT);
}
