/**
 * Structural types for the Pyric Studio Functions inspector.
 *
 * Mirrors the JSON shapes returned by the existing CLI bridge methods
 * (`functions.listTriggers`, `functions.executions`, `functions.fire`) and the
 * `service: 'functions'` sandbox event stream without importing Node-only
 * modules into the browser bundle.
 */

export type FunctionFamily =
  | 'http'
  | 'callable'
  | 'firestore'
  | 'rtdb'
  | 'storage'
  | 'identity'
  | 'pubsub'
  | 'scheduler'
  | 'tasks'
  | 'other';

export interface DiscoveredTrigger {
  exportName: string;
  eventType: string;
  reference?: string;
  instance?: string;
  document?: string;
  database?: string;
  namespace?: string;
  bucket?: string;
  schedule?: string;
  timeZone?: string;
  topic?: string;
  topicResource?: string;
  regions?: string[];
  platform?: 'gcfv1' | 'gcfv2';
  location?: string;
}

export interface UnsupportedTrigger {
  exportName: string;
  eventType: string;
}

interface FunctionsDiscoveryResult {
  triggers: DiscoveredTrigger[];
  unsupported: UnsupportedTrigger[];
  summary?: string;
}

export type FunctionExecutionStatus = 'fulfilled' | 'rejected' | 'timeout';

export interface FunctionExecution {
  id: string;
  trigger: string;
  cause: {
    ref: string;
    params: Record<string, string>;
  };
  startedAt: number;
  durationMs: number;
  status: FunctionExecutionStatus;
  result?: unknown;
  error?: string;
  retryConfig?: Record<string, number>;
  source?: 'bridge' | 'live';
}

export type HttpFireMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface FireTriggerInput {
  /** Concrete RTDB path for RTDB triggers, or optional subpath for HTTP triggers. */
  path?: string;
  /** Parsed JSON value/data payload (or undefined when omitted). */
  payload?: unknown;
  /** Optional Pub/Sub attributes object (string values). */
  attributes?: Record<string, string>;
  /** HTTP method for onRequest endpoints. */
  httpMethod?: HttpFireMethod;
  /** Selected region for HTTP/Callable endpoints when multi-region. */
  region?: string;
  /** Optional execution timeout in milliseconds (RTDB fire). */
  timeoutMs?: number;
}

export interface FireOutcome {
  ok: boolean;
  summary: string;
  executionId?: string;
  statusCode?: number;
  durationMs?: number;
  result?: unknown;
  event?: Record<string, unknown>;
  error?: string;
}

export type FunctionsTransportMode =
  | 'loading'
  | 'ready'
  | 'shared-worker-fallback'
  | 'no-bridge'
  | 'live-mode'
  | 'error';

type FunctionsApiFailureKind =
  | 'shared-worker-fallback'
  | 'no-bridge'
  | 'stale-instance'
  | 'unauthorized'
  | 'error';

interface FunctionsApiFailure {
  kind: FunctionsApiFailureKind;
  message: string;
}

export type FunctionsApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: FunctionsApiFailure };

export interface FunctionsApi {
  readonly projectId?: string | null;
  readonly origin?: string;
  listTriggers(signal?: AbortSignal): Promise<FunctionsApiResult<FunctionsDiscoveryResult>>;
  listExecutions(
    since?: number,
    signal?: AbortSignal,
  ): Promise<FunctionsApiResult<FunctionExecution[]>>;
  fireTrigger(
    trigger: DiscoveredTrigger,
    input: FireTriggerInput,
    signal?: AbortSignal,
  ): Promise<FireOutcome>;
}
