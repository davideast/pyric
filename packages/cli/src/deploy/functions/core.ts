/**
 * Portable Cloud Functions Gen 2 deploy core. Zero `node:*` imports —
 * source bundling and token acquisition are pushed to the caller.
 *
 * Per function, four-call dance:
 *
 *   1. POST /v2/projects/{p}/locations/{r}/functions:generateUploadUrl
 *   2. PUT  <signedUploadUrl>           (zip bytes)
 *   3. POST /v2/projects/{p}/locations/{r}/functions?functionId={id}
 *      (or PATCH if 409)
 *   4. GET  /v2/{operation}             (poll until done)
 *
 * IAM grant for `invoker: 'public'` is deferred to PR 3 — a public
 * invoker request returns IAM_GRANT_FAILED for now.
 */
import { grantPublicInvoker } from './iam.js';
import { pollOperation } from './operation.js';
import type {
  DeployFunctionsError,
  DeployFunctionsResult,
  DeployedFunction,
  FunctionDeployConfig,
  FunctionsErrorCode,
} from './spec.js';
import type {
  FunctionResource,
  Operation,
  StorageSource,
  UploadUrlResponse,
} from './types.js';

const FUNCTIONS_API = 'https://cloudfunctions.googleapis.com/v2';
const DEFAULT_REGION = 'us-central1';
const DEFAULT_RUNTIME = 'nodejs22';
const DEFAULT_MEMORY = '256Mi';
const DEFAULT_TIMEOUT = 60;
const DEFAULT_MIN_INSTANCES = 0;
const DEFAULT_MAX_INSTANCES = 100;

export interface DeployFunctionsCoreInput {
  projectId: string;
  /**
   * Pre-bundled source zip. The Node adapter produces this via
   * `bundleFunctionSource`; a future browser adapter could supply
   * a zip from any source.
   */
  sourceZip: Uint8Array;
  /** Functions to deploy in order. */
  functions: FunctionDeployConfig[];
  /** Default runtime when a per-function `runtime` isn't set. */
  defaultRuntime?: string;
  /** Opaque OAuth 2.0 access token. */
  accessToken: string;
}

export async function deployFunctions(
  input: DeployFunctionsCoreInput,
): Promise<DeployFunctionsResult> {
  const validation = validateInput(input);
  if (validation) return { success: false, error: validation };

  const deployed: DeployedFunction[] = [];

  for (let i = 0; i < input.functions.length; i++) {
    const fn = input.functions[i];
    const region = fn.region ?? DEFAULT_REGION;
    const runtime = fn.runtime ?? input.defaultRuntime ?? DEFAULT_RUNTIME;

    // 1. Generate upload URL for THIS function. Source is per-call —
    //    the same zip is uploaded once per function. (Cloud Functions
    //    binds the storageSource to a build, so even identical zips
    //    need their own signed URL per function. Tradeoff: O(n)
    //    uploads, but each ~1MB so it's cheap.)
    const uploadOut = await safeJsonFetch<UploadUrlResponse>(
      `${FUNCTIONS_API}/projects/${input.projectId}/locations/${region}/functions:generateUploadUrl`,
      { method: 'POST', headers: jsonHeaders(input.accessToken), body: '{}' },
    );
    if (uploadOut.kind !== 'ok') {
      return { success: false, error: translate(uploadOut, 'UPLOAD_URL_FAILED', i, `generateUploadUrl for ${fn.id}`) };
    }
    const { uploadUrl, storageSource } = uploadOut.value;

    // 2. PUT zip to the signed URL.
    const putOut = await safeFetchOnly(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: input.sourceZip as BodyInit,
    });
    if (putOut.kind !== 'ok') {
      return { success: false, error: translate(putOut, 'UPLOAD_FAILED', i, `upload zip for ${fn.id}`) };
    }

    // 3. Create or update. Always POST first; on 409 (already exists)
    //    fall through to PATCH. Avoids a precursor GET on the common
    //    fresh-deploy path.
    const body = buildFunctionBody({ projectId: input.projectId, region, runtime, fn, storageSource });
    const createOut = await safeJsonFetch<Operation>(
      `${FUNCTIONS_API}/projects/${input.projectId}/locations/${region}/functions?functionId=${encodeURIComponent(fn.id)}`,
      { method: 'POST', headers: jsonHeaders(input.accessToken), body: JSON.stringify(body) },
    );
    let operation: Operation;
    if (createOut.kind === 'ok') {
      operation = createOut.value;
    } else if (createOut.kind === 'http_error' && createOut.res.status === 409) {
      const updateOut = await safeJsonFetch<Operation>(
        `${FUNCTIONS_API}/projects/${input.projectId}/locations/${region}/functions/${encodeURIComponent(fn.id)}?updateMask=buildConfig,serviceConfig`,
        { method: 'PATCH', headers: jsonHeaders(input.accessToken), body: JSON.stringify(body) },
      );
      if (updateOut.kind !== 'ok') {
        return { success: false, error: translate(updateOut, 'UPDATE_FAILED', i, `patch ${fn.id}`) };
      }
      operation = updateOut.value;
    } else {
      return { success: false, error: translate(createOut, 'CREATE_FAILED', i, `create ${fn.id}`) };
    }

    // 4. Poll the operation. The serving URL comes back inside
    //    operation.response.serviceConfig.uri.
    const pollResult = await pollOperation(operation.name, input.accessToken);
    if (pollResult.kind === 'timeout') {
      return { success: false, error: { code: 'OPERATION_TIMED_OUT', message: `Deploy of ${fn.id} did not complete within the polling deadline. The function may still be building — check the Functions console.`, recoverable: true, functionIndex: i } };
    }
    if (pollResult.kind === 'failed') {
      return { success: false, error: { code: 'OPERATION_FAILED', message: `Cloud Functions reported deploy failure for ${fn.id}: ${pollResult.operation.error?.message ?? 'unknown error'}`, recoverable: false, functionIndex: i } };
    }
    if (pollResult.kind === 'network_error') {
      return { success: false, error: { code: 'NETWORK_ERROR', message: `Polling deploy operation for ${fn.id}: ${pollResult.message}`, recoverable: true, functionIndex: i } };
    }
    if (pollResult.kind === 'http_error') {
      return { success: false, error: { code: 'OPERATION_FAILED', message: `Polling deploy operation for ${fn.id}: HTTP ${pollResult.status} ${pollResult.body.slice(0, 300)}`, recoverable: false, functionIndex: i } };
    }

    const resource = pollResult.operation.response;
    const uri = resource?.serviceConfig?.uri;
    if (!uri) {
      return { success: false, error: { code: 'OPERATION_FAILED', message: `Deploy of ${fn.id} completed but no serviceConfig.uri returned`, recoverable: false, functionIndex: i } };
    }

    // 5. IAM grant for public functions. Cloud Functions Gen 2 = a
    //    Cloud Run service under the hood, so the binding goes on
    //    the underlying service. The service name is the function id
    //    LOWERCASED (per Cloud Functions Gen 2 naming rules) — using
    //    the camelCase function id verbatim returns 404.
    let publicInvoker = false;
    if (fn.invoker === 'public') {
      const grant = await grantPublicInvoker({
        projectId: input.projectId,
        region,
        serviceId: fn.id.toLowerCase(),
        accessToken: input.accessToken,
      });
      if (grant.kind !== 'ok') {
        const detail = grant.kind === 'network_error'
          ? grant.message
          : `HTTP ${grant.status} ${grant.body.slice(0, 300)}`;
        return {
          success: false,
          error: {
            code: 'IAM_GRANT_FAILED',
            message: `Function ${fn.id} deployed at ${uri} but the public-invoker IAM grant failed — service account needs roles/run.admin: ${detail}`,
            recoverable: false,
            functionIndex: i,
          },
        };
      }
      publicInvoker = true;
    }

    deployed.push({ id: fn.id, region, uri, publicInvoker });
  }

  return { success: true, data: { deployed } };
}

interface FunctionBodyInput {
  projectId: string;
  region: string;
  runtime: string;
  fn: FunctionDeployConfig;
  storageSource: StorageSource;
}

function buildFunctionBody(input: FunctionBodyInput): Record<string, unknown> {
  const { projectId, region, runtime, fn, storageSource } = input;
  return {
    name: `projects/${projectId}/locations/${region}/functions/${fn.id}`,
    buildConfig: {
      runtime,
      entryPoint: fn.entryPoint,
      source: { storageSource },
    },
    serviceConfig: {
      availableMemory: fn.memory ?? DEFAULT_MEMORY,
      timeoutSeconds: fn.timeoutSeconds ?? DEFAULT_TIMEOUT,
      minInstanceCount: fn.minInstances ?? DEFAULT_MIN_INSTANCES,
      maxInstanceCount: fn.maxInstances ?? DEFAULT_MAX_INSTANCES,
    },
  } satisfies Partial<FunctionResource>;
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

type FetchOnly =
  | { kind: 'ok' }
  | { kind: 'http_error'; res: Response }
  | { kind: 'network_error'; message: string };

type FetchJson<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'http_error'; res: Response }
  | { kind: 'network_error'; message: string };

async function safeFetchOnly(url: string, init: RequestInit): Promise<FetchOnly> {
  try {
    const res = await fetch(url, init);
    return res.ok ? { kind: 'ok' } : { kind: 'http_error', res };
  } catch (e) {
    return { kind: 'network_error', message: e instanceof Error ? e.message : String(e) };
  }
}

async function safeJsonFetch<T>(url: string, init: RequestInit): Promise<FetchJson<T>> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return { kind: 'http_error', res };
    const value = (await res.json()) as T;
    return { kind: 'ok', value };
  } catch (e) {
    return { kind: 'network_error', message: e instanceof Error ? e.message : String(e) };
  }
}

function translate(
  outcome: Exclude<FetchOnly | FetchJson<unknown>, { kind: 'ok' } | { kind: 'ok'; value: unknown }>,
  defaultCode: FunctionsErrorCode,
  functionIndex: number,
  context: string,
): DeployFunctionsError {
  if (outcome.kind === 'network_error') {
    return { code: 'NETWORK_ERROR', message: `network error (${context}): ${outcome.message}`, recoverable: true, functionIndex };
  }
  const status = outcome.res.status;
  if (status === 403) {
    return {
      code: 'PERMISSION_DENIED',
      message: `Cloud Functions denied the request (${context}) — service account needs roles/cloudfunctions.developer + roles/storage.admin on the source bucket`,
      recoverable: false,
      functionIndex,
    };
  }
  return { code: defaultCode, message: `HTTP ${status} (${context})`, recoverable: status >= 500, functionIndex };
}

function validateInput(input: DeployFunctionsCoreInput): DeployFunctionsError | null {
  if (!input || typeof input !== 'object') {
    return { code: 'INVALID_INPUT', message: 'input must be an object', recoverable: true };
  }
  if (!input.projectId || typeof input.projectId !== 'string') {
    return { code: 'INVALID_INPUT', message: 'projectId must be a non-empty string', recoverable: true };
  }
  if (!input.accessToken || typeof input.accessToken !== 'string') {
    return { code: 'INVALID_INPUT', message: 'accessToken must be a non-empty string', recoverable: true };
  }
  if (!(input.sourceZip instanceof Uint8Array) || input.sourceZip.byteLength === 0) {
    return { code: 'INVALID_INPUT', message: 'sourceZip must be a non-empty Uint8Array', recoverable: true };
  }
  if (!Array.isArray(input.functions) || input.functions.length === 0) {
    return { code: 'INVALID_INPUT', message: 'functions must be a non-empty array', recoverable: true };
  }
  for (let i = 0; i < input.functions.length; i++) {
    const fn = input.functions[i];
    if (!fn || typeof fn.id !== 'string' || !fn.id) {
      return { code: 'INVALID_INPUT', message: `functions[${i}].id must be a non-empty string`, recoverable: true, functionIndex: i };
    }
    if (typeof fn.entryPoint !== 'string' || !fn.entryPoint) {
      return { code: 'INVALID_INPUT', message: `functions[${i}].entryPoint must be a non-empty string`, recoverable: true, functionIndex: i };
    }
  }
  return null;
}
