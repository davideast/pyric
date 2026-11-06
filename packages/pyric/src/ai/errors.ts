/**
 * `pyric/ai` error surface — `AIError` / `AIErrorCode` mirroring the
 * installed `@firebase/ai@2.12.0` shapes exactly, plus the ONE translation
 * point from the broker's captured wire error envelopes
 * ({@link AiBrokerError}) to the SDK-equivalent `AIError`.
 *
 * The installed SDK turns a non-ok HTTP response into
 *   `AIError('fetch-error', 'Error fetching from <url>: [<status> <statusText>] <message>', { status, statusText, errorDetails })`
 * with `message` growing ` ${JSON.stringify(details)}` when the envelope
 * carries details (dist/index.node.mjs `makeRequest`). The sandbox mints the
 * same error from the wire envelope, with a production-shaped URL.
 */

import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { AiBrokerError, type WireErrorEnvelope } from './broker/index.js';
import { BackendType, type Backend, type VertexAIBackend } from './backend.js';

const AI_TYPE = 'AI';

/** Standardized error codes the SDK can throw — 14 codes in 2.12.0. */
export const AIErrorCode = {
  ERROR: 'error',
  REQUEST_ERROR: 'request-error',
  RESPONSE_ERROR: 'response-error',
  FETCH_ERROR: 'fetch-error',
  SESSION_CLOSED: 'session-closed',
  INVALID_CONTENT: 'invalid-content',
  API_NOT_ENABLED: 'api-not-enabled',
  INVALID_SCHEMA: 'invalid-schema',
  NO_API_KEY: 'no-api-key',
  NO_APP_ID: 'no-app-id',
  NO_MODEL: 'no-model',
  NO_PROJECT_ID: 'no-project-id',
  PARSE_FAILED: 'parse-failed',
  UNSUPPORTED: 'unsupported',
} as const;
export type AIErrorCode = (typeof AIErrorCode)[keyof typeof AIErrorCode];

/** Data from a bad HTTP response (upstream `CustomErrorData` shape). */
export interface CustomErrorData {
  status?: number;
  statusText?: string;
  response?: unknown;
  errorDetails?: Array<Record<string, unknown>>;
}

/**
 * Error class for the AI mirror — constructor and message format copied
 * from the installed SDK: `AI: <message> (AI/<code>)`, `code` set to the
 * short code, `customErrorData` carried through.
 */
export class AIError extends FirebaseError {
  override readonly code: AIErrorCode;
  readonly customErrorData?: CustomErrorData;

  constructor(code: AIErrorCode, message: string, customErrorData?: CustomErrorData) {
    const fullCode = `${AI_TYPE}/${code}`;
    const fullMessage = `${AI_TYPE}: ${message} (${fullCode})`;
    super(code, fullMessage);
    this.code = code;
    this.customErrorData = customErrorData;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AIError);
    }
    Object.setPrototypeOf(this, AIError.prototype);
    this.toString = () => fullMessage;
  }
}

/** Minimal HTTP status text table for the statuses the sandbox mints. */
export function statusTextOf(status: number): string {
  switch (status) {
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 429: return 'Too Many Requests';
    case 500: return 'Internal Server Error';
    case 502: return 'Bad Gateway';
    case 503: return 'Service Unavailable';
    default: return '';
  }
}

const SANDBOX_REQUEST_ORIGIN = 'https://firebasevertexai.googleapis.com/v1beta/projects/sandbox';
const VERTEX_MODEL_PREFIX = 'publishers/google/models/';
const STREAM_TASK = 'streamGenerateContent';

/**
 * The model path under the project, as the SDK's backend classes build it:
 * Google AI's `models/<name>`, and Vertex AI's
 * `locations/<location>/publishers/google/models/<name>`
 * (`_getModelPath`, @firebase/ai 2.12.0). The sandbox's own model resource
 * stays `models/<name>` on either backend; only the URL changes.
 */
function modelPath(modelResource: string, backend: Backend | undefined): string {
  const isVertexAI = backend?.backendType === BackendType.VERTEX_AI;
  if (!isVertexAI) return modelResource;
  const name = modelResource.replace(/^models\//, '');
  return `locations/${(backend as VertexAIBackend).location}/${VERTEX_MODEL_PREFIX}${name}`;
}

/**
 * Production-shaped request URL for sandbox-minted fetch errors, the
 * `RequestURL` the SDK interpolates into its `Error fetching from <url>`
 * message. There is no real project behind the sandbox, so the project is
 * `sandbox`; the model path follows the handle's backend (Google AI when none
 * is given), and a stream carries `?alt=sse`, as the SDK's `queryParams` add
 * it (#1640).
 */
export function sandboxRequestUrl(modelResource: string, op: string, backend?: Backend): string {
  const query = op === STREAM_TASK ? '?alt=sse' : '';
  return `${SANDBOX_REQUEST_ORIGIN}/${modelPath(modelResource, backend)}:${op}${query}`;
}

/**
 * Translate a broker wire error envelope into the SDK-equivalent
 * `AIError('fetch-error', ...)` — the exact decoration `makeRequest` applies
 * to a non-ok response in the installed 2.12.0.
 */
export function aiErrorFromEnvelope(
  envelope: WireErrorEnvelope,
  modelResource: string,
  op: string,
  backend?: Backend,
): AIError {
  const wire = envelope.error;
  let message = wire.message;
  let errorDetails: Array<Record<string, unknown>> | undefined;
  if (wire.details) {
    message += ` ${JSON.stringify(wire.details)}`;
    errorDetails = wire.details;
  }
  const statusText = statusTextOf(wire.code);
  const url = sandboxRequestUrl(modelResource, op, backend);
  return new AIError(
    AIErrorCode.FETCH_ERROR,
    `Error fetching from ${url}: [${wire.code} ${statusText}] ${message}`,
    { status: wire.code, statusText, errorDetails },
  );
}

/**
 * A failure while building a request's headers, before anything is sent: the
 * App Check provider rejected a limited-use token request. Upstream
 * `getHeaders` runs inside `makeRequest`'s `try`, so its `catch` decorates
 * the failure; this carries it there.
 */
export class RequestHeadersFailure extends Error {
  constructor(readonly reason: unknown) {
    super('request headers failed');
    this.name = 'RequestHeadersFailure';
  }
}

const ABORT_ERROR_NAME = 'AbortError';

/** Upstream `makeRequest`'s `catch` wraps an `Error` unless it is an abort or already a fetch-level `AIError`. */
function isWrappedByMakeRequest(reason: unknown): reason is Error {
  if (!(reason instanceof Error)) return false;
  const code = (reason as { code?: unknown }).code;
  const isFetchLevel = code === AIErrorCode.FETCH_ERROR || code === AIErrorCode.API_NOT_ENABLED;
  return !isFetchLevel && reason.name !== ABORT_ERROR_NAME;
}

/** `AIError('error', 'Error fetching from <url>: <message>')` with the original stack, as `makeRequest` throws it. */
function aiErrorFromHeadersFailure(
  failure: RequestHeadersFailure,
  modelResource: string,
  op: string,
  backend: Backend | undefined,
): unknown {
  const reason = failure.reason;
  if (!isWrappedByMakeRequest(reason)) return reason;
  const url = sandboxRequestUrl(modelResource, op, backend);
  const error = new AIError(AIErrorCode.ERROR, `Error fetching from ${url}: ${reason.message}`);
  error.stack = reason.stack;
  return error;
}

/** Rethrow broker errors and header failures as SDK errors; pass anything else through. */
export function toAIError(err: unknown, modelResource: string, op: string, backend?: Backend): unknown {
  if (err instanceof AiBrokerError) {
    return aiErrorFromEnvelope(err.envelope, modelResource, op, backend);
  }
  if (err instanceof RequestHeadersFailure) {
    return aiErrorFromHeadersFailure(err, modelResource, op, backend);
  }
  return err;
}
