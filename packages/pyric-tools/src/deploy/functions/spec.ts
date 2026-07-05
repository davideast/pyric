/**
 * Public types for `FunctionsDeployHandler`. One handler call deploys
 * one or more HTTP-triggered Cloud Functions Gen 2 from a single
 * source directory; each function gets its own per-function config.
 */

export type DeployFunctionsResult =
  | { success: true; data: DeployFunctionsSuccess }
  | { success: false; error: DeployFunctionsError };

export interface DeployFunctionsSuccess {
  /** One entry per function in the input. Order preserved. */
  deployed: DeployedFunction[];
}

export interface DeployedFunction {
  id: string;
  region: string;
  /** Full Cloud Run URI the function listens on. */
  uri: string;
  /** Whether public invocation was granted (post PR 3 — `false` until then). */
  publicInvoker: boolean;
}

export interface DeployFunctionsError {
  code: FunctionsErrorCode;
  message: string;
  recoverable: boolean;
  /** When set, the function index that triggered the failure. Earlier
   *  functions in the array may have deployed successfully. */
  functionIndex?: number;
}

export type FunctionsErrorCode =
  | 'INVALID_INPUT'
  | 'PERMISSION_DENIED'
  | 'SOURCE_BUNDLE_FAILED'
  | 'UPLOAD_URL_FAILED'
  | 'UPLOAD_FAILED'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'OPERATION_TIMED_OUT'
  | 'OPERATION_FAILED'
  | 'IAM_GRANT_FAILED'
  | 'NETWORK_ERROR';

/**
 * Per-function deploy config. Required: `id` and `entryPoint`.
 * Other fields fall back to Cloud Functions Gen 2 defaults.
 */
export interface FunctionDeployConfig {
  /** Function id. URL-safe; matches the rewrite's `functionId`. */
  id: string;
  /** Exported symbol the runtime invokes. e.g. `stitchProxy`. */
  entryPoint: string;
  /** Default `us-central1`. */
  region?: string;
  /**
   * Default derived from the source `package.json`'s `engines.node`,
   * fallback `nodejs22`. Pass to override explicitly (e.g. `nodejs20`).
   */
  runtime?: string;
  /** e.g. `256Mi`, `512Mi`, `1Gi`. Default `256Mi`. */
  memory?: string;
  /** Default `60`. Cloud Functions max is 3600. */
  timeoutSeconds?: number;
  /** Default `0`. Set non-zero to keep instances warm. */
  minInstances?: number;
  /** Default `100`. */
  maxInstances?: number;
  /**
   * `'public'` adds an IAM binding that grants `roles/run.invoker`
   * to `allUsers` after the function is live. `'private'` skips the
   * grant — the function is reachable only by Hosting rewrites and
   * other authenticated callers. Default `'private'`.
   *
   * NOTE: PR 2 ships with `invoker: 'public'` raising
   * `IAM_GRANT_FAILED` because the grant lives in PR 3.
   */
  invoker?: 'public' | 'private';
}
