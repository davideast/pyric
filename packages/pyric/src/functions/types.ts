import type { FirebaseApp } from '../app/types.js';

/**
 * Functions error code string appended after the `functions/` product prefix.
 */
export type FunctionsErrorCodeCore =
  | 'ok'
  | 'cancelled'
  | 'unknown'
  | 'invalid-argument'
  | 'deadline-exceeded'
  | 'not-found'
  | 'already-exists'
  | 'permission-denied'
  | 'resource-exhausted'
  | 'failed-precondition'
  | 'aborted'
  | 'out-of-range'
  | 'unimplemented'
  | 'internal'
  | 'unavailable'
  | 'data-loss'
  | 'unauthenticated';

/**
 * The set of Firebase Functions status codes (`functions/<codeCore>`).
 */
export type FunctionsErrorCode = `functions/${FunctionsErrorCodeCore}`;

/**
 * A `Functions` service instance associated with a {@link FirebaseApp}.
 */
export interface Functions {
  app: FirebaseApp;
  region: string;
  customDomain: string | null;
}

/**
 * Metadata options controlling how callable invocations are executed.
 */
export interface HttpsCallableOptions {
  /**
   * Time in milliseconds after which to cancel if there is no response.
   * Defaults to 70000.
   */
  timeout?: number;
  /**
   * When true, attaches a fresh limited-use App Check token to each request.
   */
  limitedUseAppCheckTokens?: boolean;
}

/**
 * Metadata options controlling how streaming callable invocations are executed.
 */
export interface HttpsCallableStreamOptions {
  /**
   * Optional AbortSignal that cancels the streaming response when aborted.
   */
  signal?: AbortSignal;
  /**
   * When true, attaches a fresh limited-use App Check token to the request.
   */
  limitedUseAppCheckTokens?: boolean;
}

/**
 * Wraps a single decoded result from a callable function invocation.
 */
export interface HttpsCallableResult<ResponseData = unknown> {
  readonly data: ResponseData;
}

/**
 * Wraps the async chunk stream and final result promise of a streaming callable.
 */
export interface HttpsCallableStreamResult<ResponseData = unknown, StreamData = unknown> {
  readonly data: Promise<ResponseData>;
  readonly stream: AsyncIterable<StreamData>;
}

/**
 * A reference to a callable HTTPS trigger in Cloud Functions.
 */
export interface HttpsCallable<
  RequestData = unknown,
  ResponseData = unknown,
  StreamData = unknown,
> {
  (data?: RequestData | null): Promise<HttpsCallableResult<ResponseData>>;
  stream: (
    data?: RequestData | null,
    options?: HttpsCallableStreamOptions,
  ) => Promise<HttpsCallableStreamResult<ResponseData, StreamData>>;
}
