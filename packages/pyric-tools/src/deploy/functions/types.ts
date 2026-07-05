/** Internal types mirroring the Cloud Functions Gen 2 REST API. */

export interface UploadUrlResponse {
  /** Signed PUT URL valid ~30 minutes. */
  uploadUrl: string;
  /** Pass back into the function's `buildConfig.source.storageSource`. */
  storageSource: StorageSource;
}

export interface StorageSource {
  bucket: string;
  object: string;
  /** Optional generation number; present in production responses. */
  generation?: string;
}

export interface FunctionResource {
  /** `projects/{p}/locations/{r}/functions/{id}` */
  name: string;
  state?: 'STATE_UNSPECIFIED' | 'ACTIVE' | 'FAILED' | 'DEPLOYING' | 'DELETING' | 'UNKNOWN';
  buildConfig?: BuildConfig;
  serviceConfig?: ServiceConfig;
}

export interface BuildConfig {
  runtime: string;
  entryPoint: string;
  source: { storageSource: StorageSource };
}

export interface ServiceConfig {
  /** Cloud Run URI the function listens on. */
  uri?: string;
  serviceAccountEmail?: string;
  availableMemory?: string;
  timeoutSeconds?: number;
  minInstanceCount?: number;
  maxInstanceCount?: number;
}

/** Long-running operation as returned by `cloudfunctions.googleapis.com/v2`. */
export interface Operation {
  /** `operations/{operationId}` or `projects/{p}/locations/{r}/operations/{operationId}`. */
  name: string;
  done?: boolean;
  metadata?: Record<string, unknown>;
  response?: FunctionResource;
  error?: {
    code: number;
    message: string;
    details?: unknown[];
  };
}
