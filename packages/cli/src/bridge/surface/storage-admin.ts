/**
 * The surface's side of the Cloud Storage control plane.
 *
 * `storage.status` and `storage.provision` are the surface's second and third
 * `production` methods. What they reach is the provisioning client pyric
 * already ships, `InspectStorageHandler` and `ProvisionStorageHandler` in
 * `pyric/storage`, which talk to Service Usage, the Firebase management API,
 * and the Firebase Storage API with the caller's own token. Nothing here mints
 * a credential or reimplements a call to Google.
 *
 * The client seam lives in this module rather than beside the handlers because
 * the surface is its only caller in this package, so there is one construction
 * of it in the tree and a test can count the constructions. That is what lets a
 * test prove that a run without the flag, without a confirmation, or without
 * credentials never builds one.
 *
 * The order the boundary depends on is not translated, it is structural. The
 * effect gate refuses the call before this module is reached at all, the
 * confirmation is refused next, and credentials are looked for before a client
 * is built.
 */
import {
  PROJECT_ID_ENV_KEY,
  resolveScope,
  SERVICE_ACCOUNT_BASE64_ENV_KEY,
  SERVICE_ACCOUNT_FILE_ENV_KEY,
} from '../../credentials/node/scope.js';
import type { ProjectScope } from '../../credentials/core/types.js';
import type {
  InspectStorageResult,
  ProvisionStorageInput,
  ProvisionStorageOutcome,
} from 'pyric/storage';
import { operationFailure } from './context.js';
import type { OperationResult } from './types.js';

/** The credential sources the control plane reads, in the order it reads them. */
export const STORAGE_ADMIN_CREDENTIAL_SOURCES = `${SERVICE_ACCOUNT_BASE64_ENV_KEY}, ${SERVICE_ACCOUNT_FILE_ENV_KEY}, or Application Default Credentials from \`gcloud auth application-default login\` with a project id in ${PROJECT_ID_ENV_KEY}`;

/** The environment keys credential discovery reads, in that order. */
export const STORAGE_ADMIN_CREDENTIAL_ENV_KEYS: readonly string[] = [
  SERVICE_ACCOUNT_BASE64_ENV_KEY,
  SERVICE_ACCOUNT_FILE_ENV_KEY,
  PROJECT_ID_ENV_KEY,
];

/** No credentials were found, with the sources that were checked for one. */
export interface MissingStorageCredentials {
  missing: string;
  sources: readonly string[];
}

/** The credentials a control-plane call will use, and which source supplied them. */
export interface StorageAdminCredentials {
  scope: ProjectScope;
  source: string;
}

/** Whether one outcome is the absence of credentials rather than an answer. */
export function isMissingStorageCredentials<Answered extends object>(
  outcome: Answered | MissingStorageCredentials,
): outcome is MissingStorageCredentials {
  return 'missing' in outcome;
}

/** Which project a control-plane call asks about, and which environment it reads. */
export interface StorageAdminScope {
  projectId?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * The project scope a control-plane call would use, or the sentence that says
 * which credentials are missing and how to supply them. Reading is all this
 * does: a source that is absent is reported, never created.
 */
export async function storageAdminCredentials(
  scope: StorageAdminScope = {},
): Promise<StorageAdminCredentials | MissingStorageCredentials> {
  const env = scope.env ?? process.env;
  try {
    const resolved = await resolveScope({ env, projectId: scope.projectId });
    return { scope: resolved.scope, source: resolved.source };
  } catch {
    return {
      missing: `No Google credentials were found for the Cloud Storage control plane. It reads ${STORAGE_ADMIN_CREDENTIAL_SOURCES}.`,
      sources: STORAGE_ADMIN_CREDENTIAL_ENV_KEYS,
    };
  }
}

/** What one control-plane run needs beyond a scope: the two calls it can make. */
export interface StorageAdminClient {
  status(scope: ProjectScope): Promise<InspectStorageResult>;
  provision(scope: ProjectScope, input: ProvisionStorageInput): Promise<ProvisionStorageOutcome>;
}

/** The real client: one pair of handlers per run, calling Google. */
function defaultClient(): StorageAdminClient {
  return {
    async status(scope) {
      const { InspectStorageHandler } = await import('pyric/storage');
      return new InspectStorageHandler().execute(scope);
    },
    async provision(scope, input) {
      const { ProvisionStorageHandler } = await import('pyric/storage');
      return new ProvisionStorageHandler().execute(scope, input);
    },
  };
}

/**
 * Build the client that talks to the control plane.
 *
 * Held as a replaceable value so a test can count constructions and assert
 * that none happened. Nothing but a test replaces it, and a test that does
 * restores it through the function it is handed back.
 */
let buildClient: () => StorageAdminClient = defaultClient;

/** Replace the client builder for one test, and restore it through the returned function. */
export function useStorageAdminClient(next: () => StorageAdminClient): () => void {
  const previous = buildClient;
  buildClient = next;
  return () => {
    buildClient = previous;
  };
}

/** One control-plane call, once credentials have been found. */
type StorageAdminCall<Answer> = (client: StorageAdminClient, scope: ProjectScope) => Promise<Answer>;

/**
 * Find credentials and run one control-plane call. Credentials are looked for
 * first, so a run without them never builds a client.
 */
async function runWithCredentials<Answer>(
  scope: StorageAdminScope,
  call: StorageAdminCall<Answer>,
): Promise<{ credentials: StorageAdminCredentials; answer: Answer } | MissingStorageCredentials> {
  const credentials = await storageAdminCredentials(scope);
  if (isMissingStorageCredentials(credentials)) return credentials;
  const answer = await call(buildClient(), credentials.scope);
  return { credentials, answer };
}

/** Probe the project's Storage service and report what came back. */
export async function storageStatusResult(scope: StorageAdminScope = {}): Promise<OperationResult> {
  const outcome = await runWithCredentials(scope, (client, resolved) => client.status(resolved));
  if (isMissingStorageCredentials(outcome)) return operationFailure(outcome.missing);

  const { credentials, answer } = outcome;
  return {
    ok: true,
    summary: `Firebase Storage is ${answer.serviceState} on project '${credentials.scope.projectId}', with ${answer.buckets.length} linked bucket(s).`,
    data: {
      project: credentials.scope.projectId,
      credentials: credentials.source,
      serviceState: answer.serviceState,
      defaultLocation: answer.defaultLocation,
      buckets: answer.buckets,
    },
  };
}

/** Enable Storage on the project end to end and report what came back. */
export async function storageProvisionResult(
  input: ProvisionStorageInput,
  scope: StorageAdminScope = {},
): Promise<OperationResult> {
  const outcome = await runWithCredentials(scope, (client, resolved) =>
    client.provision(resolved, input),
  );
  if (isMissingStorageCredentials(outcome)) return operationFailure(outcome.missing);

  const { credentials, answer } = outcome;
  if (!answer.success) {
    return operationFailure(
      `Provisioning Storage on project '${credentials.scope.projectId}' failed: ${answer.error.message}`,
      { code: answer.error.code, recoverable: answer.error.recoverable },
    );
  }
  return {
    ok: true,
    summary: `Provisioned Storage bucket ${answer.bucketId} on project '${credentials.scope.projectId}'.`,
    data: {
      project: credentials.scope.projectId,
      credentials: credentials.source,
      bucket: answer.bucketId,
      serviceEnabled: answer.serviceEnabled,
      locationFinalized: answer.locationFinalized,
      locationId: answer.locationId,
      bucketCreated: answer.bucketCreated,
    },
  };
}
