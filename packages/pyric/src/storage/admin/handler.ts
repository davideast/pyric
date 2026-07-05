/**
 * Handlers wrapping the pure-fetch `api.ts` provisioning functions
 * with a structured outcome shape. They take a `ProjectScope`
 * (`{ projectId, resolveToken }`) — the same credential value the
 * `@pyric/deploy` factories accept — so the storage tools share the
 * resolver contract with the rest of the control plane.
 *
 * Note on permissions: `resolveToken()` typically yields a Firebase
 * Admin SDK service-account token, which is enough for the *probe*
 * but **insufficient for service enable** (the default SA lacks
 * `roles/serviceusage.serviceUsageAdmin`). Agents that need to flip
 * the service on should either grant the SA that role once, or call
 * `provisionStorage(token, projectId)` directly with a user OAuth
 * token that carries `cloud-platform` scope.
 *
 * The handler maps the underlying `StorageProvisioningError`'s
 * `reason` field to a typed error code so callers can route to
 * actionable UX.
 */
import type { ProjectScope } from 'pyric-tools/deploy';
import {
  getDefaultLocation,
  getStorageServiceState,
  listFirebaseBuckets,
  provisionStorage,
  StorageProvisioningError,
  type ProvisionProgress,
} from './api.js';
import type {
  InspectStorageResult,
  ProvisionStorageInput,
  ProvisionStorageOutcome,
  ProvisionStorageErrorCode,
} from './spec.js';

export class InspectStorageHandler {
  async execute(scope: ProjectScope): Promise<InspectStorageResult> {
    const token = await scope.resolveToken();
    const [serviceState, defaultLocation] = await Promise.all([
      getStorageServiceState(token, scope.projectId),
      getDefaultLocation(token, scope.projectId),
    ]);
    let buckets: InspectStorageResult['buckets'] = [];
    if (serviceState === 'enabled') {
      try {
        const list = await listFirebaseBuckets(token, scope.projectId);
        buckets = list.map((b) => ({ name: b.name, bucketId: b.bucketId }));
      } catch {
        // If the service is enabled but listing fails (rare), report
        // empty buckets rather than throwing — the caller already has
        // useful signal from `serviceState` and `defaultLocation`.
        buckets = [];
      }
    }
    return { serviceState, defaultLocation, buckets };
  }
}

export class ProvisionStorageHandler {
  async execute(
    scope: ProjectScope,
    input: ProvisionStorageInput,
    onProgress?: ProvisionProgress,
  ): Promise<ProvisionStorageOutcome> {
    const token = await scope.resolveToken();
    try {
      const result = await provisionStorage(token, scope.projectId, { ...input, onProgress });
      return { success: true, ...result };
    } catch (e) {
      if (e instanceof StorageProvisioningError) {
        return { success: false, error: mapError(e) };
      }
      return {
        success: false,
        error: {
          code: 'UNKNOWN',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      };
    }
  }
}

function mapError(e: StorageProvisioningError): {
  code: ProvisionStorageErrorCode;
  message: string;
  recoverable: boolean;
} {
  // Map the Google API reason codes to our typed error codes so the
  // caller doesn't have to string-match.
  const reason = e.reason ?? '';
  const msg = e.message;

  if (reason === 'AUTH_PERMISSION_DENIED' || /serviceusage\.services\.enable/.test(msg)) {
    return {
      code: 'PERMISSION_DENIED',
      message: `${msg} — the caller's identity needs roles/serviceusage.serviceUsageAdmin (or roles/owner). The default Firebase Admin SDK service account does NOT have this.`,
      recoverable: false,
    };
  }
  if (
    reason === 'SERVICE_DISABLED' ||
    /SERVICE_DISABLED/.test(msg) ||
    // Google APIs return this prose form (with no `reason` on the thrown error)
    // when the API is disabled on the project, e.g. `getProject: 403 Firebase
    // Management API has not been used in project ... before or it is disabled`.
    // Classify it recoverable so the deploy preflight's auto-enable handles it.
    /has not been used in project .* before or it is disabled/.test(msg)
  ) {
    return { code: 'SERVICE_DISABLED', message: msg, recoverable: true };
  }
  if (/defaultLocation:finalize/.test(msg)) {
    return { code: 'LOCATION_FINALIZE_FAILED', message: msg, recoverable: false };
  }
  if (/addFirebase/.test(msg)) {
    return { code: 'BUCKET_CREATE_FAILED', message: msg, recoverable: false };
  }
  if (/createRuleset|updateRelease/.test(msg)) {
    return { code: 'RULES_DEPLOY_FAILED', message: msg, recoverable: true };
  }
  if (/setBucketCors|getBucketCors/.test(msg)) {
    return { code: 'CORS_UPDATE_FAILED', message: msg, recoverable: false };
  }
  return { code: 'UNKNOWN', message: msg, recoverable: false };
}
