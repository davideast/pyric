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

import { FirebaseError } from 'firebase/app';
import type { AIError as FbAIError } from 'firebase/ai';

import { AiBrokerError, type WireErrorEnvelope } from './broker/index.js';

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

/** Union type: sandbox ops raise OUR AIError; prod pass-through raises the installed SDK's. */
export type AnyAIError = AIError | FbAIError;

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

/**
 * Production-shaped request URL for sandbox-minted fetch errors. There is no
 * real project behind the sandbox; the path is deterministic and mirrors the
 * GoogleAI backend's `/v1beta/projects/<project>/models/<model>:<op>` shape.
 */
export function sandboxRequestUrl(modelResource: string, op: string): string {
  return `https://firebasevertexai.googleapis.com/v1beta/projects/sandbox/${modelResource}:${op}`;
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
): AIError {
  const wire = envelope.error;
  let message = wire.message;
  let errorDetails: Array<Record<string, unknown>> | undefined;
  if (wire.details) {
    message += ` ${JSON.stringify(wire.details)}`;
    errorDetails = wire.details;
  }
  const statusText = statusTextOf(wire.code);
  const url = sandboxRequestUrl(modelResource, op);
  return new AIError(
    AIErrorCode.FETCH_ERROR,
    `Error fetching from ${url}: [${wire.code} ${statusText}] ${message}`,
    { status: wire.code, statusText, errorDetails },
  );
}

/** Rethrow broker errors as SDK errors; pass anything else through. */
export function toAIError(err: unknown, modelResource: string, op: string): unknown {
  if (err instanceof AiBrokerError) {
    return aiErrorFromEnvelope(err.envelope, modelResource, op);
  }
  return err;
}
