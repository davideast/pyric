/**
 * Shapes for the Storage provisioning + status tools.
 *
 * Types only — the agent-tool parameter schemas live inline in
 * `tools.ts` as JSON Schema (the `ToolHandler` contract).
 */

export interface ProvisionStorageInput {
  /**
   * Default GCP resources location to use when the project has not
   * been finalized yet. IRREVERSIBLE once set. Common values:
   * `us-central`, `nam5`, `eur3`. Default: `us-central`.
   */
  locationId?: string;
  /**
   * Override the default Firebase Storage bucket ID. Defaults to
   * `{projectId}.firebasestorage.app`.
   */
  bucketId?: string;
  /**
   * Storage rules source to deploy after the bucket is linked.
   * Optional; when omitted, whatever rules are currently released
   * (possibly the deny-all default) stay in place.
   */
  rules?: string;
  /**
   * CORS rules to apply to the bucket. Required for browser-side
   * reads/writes from a non-Firebase origin. Omit to leave existing
   * CORS untouched.
   */
  cors?: Array<{
    origin: string[];
    method: string[];
    responseHeader?: string[];
    maxAgeSeconds?: number;
  }>;
}

export type ProvisionStorageErrorCode =
  | 'PERMISSION_DENIED' // caller lacks serviceusage.services.enable or similar
  | 'SERVICE_DISABLED' // firebasestorage.googleapis.com not enabled and we couldn't enable it
  | 'LOCATION_FINALIZE_FAILED' // :finalize rejected (often because project already has resources)
  | 'BUCKET_CREATE_FAILED' // :addFirebase rejected
  | 'RULES_DEPLOY_FAILED' // rules step rejected
  | 'CORS_UPDATE_FAILED' // GCS bucket-update rejected
  | 'UNKNOWN';

export type ProvisionStorageOutcome =
  | {
      success: true;
      serviceEnabled: boolean;
      locationFinalized: boolean;
      locationId: string | null;
      bucketCreated: boolean;
      bucketId: string;
      rulesDeployed: boolean;
      rulesetName?: string;
      corsApplied: boolean;
    }
  | {
      success: false;
      error: {
        code: ProvisionStorageErrorCode;
        message: string;
        recoverable: boolean;
      };
    };

export interface InspectStorageResult {
  serviceState: 'enabled' | 'disabled' | 'unknown';
  defaultLocation: string | null;
  buckets: Array<{ name: string; bucketId: string }>;
}
