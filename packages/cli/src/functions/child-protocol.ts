/**
 * The IPC messages between the host and the isolated Functions child, shared
 * by both sides so neither re-declares the other's shapes.
 */
import type { HttpFunctionInfo } from './http/discovery.js';
import type {
  PubSubPublishResult,
  PubSubWirePublishRequest,
} from './pubsub/delivery.js';
import type {
  TasksChildResult,
  TasksHostRequest,
} from './tasks/child-runtime.js';
import { redactActiveSecretString } from './secret-redaction.js';
import type { UnsupportedFunctionsTrigger } from './unsupported.js';

export interface SerializedFunctionsError {
  name: string;
  message: string;
  stack?: string;
}

export type FunctionsChildEvent =
  | {
      type: 'execution';
      exportName: string;
      ref: string;
      params: Record<string, string>;
      status: 'fulfilled';
      startedAt?: number;
      durationMs?: number;
      retryConfig?: Record<string, number>;
      codebase?: string;
    }
  | {
      type: 'execution';
      exportName: string;
      ref: string;
      params: Record<string, string>;
      status: 'rejected';
      error: SerializedFunctionsError;
      startedAt?: number;
      durationMs?: number;
      retryConfig?: Record<string, number>;
      codebase?: string;
    }
  | {
      type: 'delivery-error';
      exportName: string;
      error: SerializedFunctionsError;
      codebase?: string;
    }
  | {
      /** An exception no handler caught, which the child logged and survived (functions-http#12). */
      type: 'uncaught-error';
      error: SerializedFunctionsError;
      codebase?: string;
    };

/** The child's HTTP listener and the onRequest functions it serves, as the child reports them. */
export interface FunctionsChildHttpListener {
  port: number;
  functions: HttpFunctionInfo[];
}

/** One codebase's HTTP listener when multiple codebases serve HTTP/callable functions. */
export interface FunctionsChildHttpBackend {
  codebase: string;
  port: number;
  token: string;
  functions: HttpFunctionInfo[];
}

/** The listener plus the token the host made for this spawn, which the proxy must send. */
export interface FunctionsChildHttpReady extends FunctionsChildHttpListener {
  token: string;
  /** Per-codebase HTTP listeners when running multiple codebases. */
  backends?: readonly FunctionsChildHttpBackend[];
}

/** Trigger metadata preserved across codebases in ready snapshots and listings. */
export interface FunctionsReadyTriggerInfo {
  exportName: string;
  kind: string;
  codebase?: string;
  regions?: readonly string[];
}

/** Per-codebase ready summary attached when running one or more named codebases. */
export interface FunctionsCodebaseReadySummary {
  codebase: string;
  sourceDir: string;
  entry: string;
  triggerCount: number;
  httpFunctionCount: number;
  unsupportedTriggers: UnsupportedFunctionsTrigger[];
}

export interface FunctionsChildReady {
  triggerCount: number;
  unsupportedTriggers: UnsupportedFunctionsTrigger[];
  /** Present when the source exports at least one onRequest function. */
  http?: FunctionsChildHttpReady;
  /** All declared Firebase endpoint export names in this child (used for cross-codebase collision checks). */
  exportNames?: string[];
  /** Active trigger listing preserving per-trigger `codebase` metadata. */
  triggers?: FunctionsReadyTriggerInfo[];
  /** Per-codebase summaries when running multi-codebase or named-codebase projects. */
  codebases?: FunctionsCodebaseReadySummary[];
}

/** What the child's ready message carries: it never sends the token back. */
type FunctionsChildReadyMessage = Omit<FunctionsChildReady, 'http'> & {
  http?: FunctionsChildHttpListener;
  /** Declared `timeoutSeconds` (or `null` when unset) for each active non-HTTP trigger. */
  eventTimeouts?: Array<number | null>;
};

export interface TriggerScheduledHostRequest {
  type: 'trigger-scheduled';
  requestId: string;
  exportName: string;
  scheduleTime?: string;
  jobName?: string;
  hasJobNameOverride?: boolean;
}

export interface PublishPubSubHostRequest extends PubSubWirePublishRequest {
  type: 'publish-pubsub';
  requestId: string;
}

export type FunctionsHostMessage =
  | { type: 'stop' }
  | TriggerScheduledHostRequest
  | PublishPubSubHostRequest
  | TasksHostRequest;

export type TriggerScheduledChildResult =
  | {
      type: 'trigger-scheduled-result';
      requestId: string;
      outcome: 'fulfilled';
      exportName: string;
      jobName?: string;
      scheduleTime: string;
      startedAt: number;
      durationMs: number;
      retryConfig: Record<string, number>;
      result?: unknown;
    }
  | {
      type: 'trigger-scheduled-result';
      requestId: string;
      outcome: 'rejected';
      exportName: string;
      jobName?: string;
      scheduleTime: string;
      startedAt: number;
      durationMs: number;
      retryConfig: Record<string, number>;
      error: SerializedFunctionsError;
    }
  | {
      type: 'trigger-scheduled-result';
      requestId: string;
      outcome: 'not-found';
      exportName: string;
    }
  | {
      type: 'trigger-scheduled-result';
      requestId: string;
      outcome: 'invalid-argument';
      exportName: string;
      message: string;
    };

export type PublishPubSubChildResult =
  | {
      type: 'publish-pubsub-result';
      requestId: string;
      outcome: 'published';
      result: PubSubPublishResult;
    }
  | {
      type: 'publish-pubsub-result';
      requestId: string;
      outcome: 'invalid-argument';
      message: string;
    };

export type FunctionsChildMessage =
  | ({ type: 'ready' } & FunctionsChildReadyMessage)
  | FunctionsChildEvent
  | TriggerScheduledChildResult
  | PublishPubSubChildResult
  | TasksChildResult
  | { type: 'fatal'; error: SerializedFunctionsError }
  /** Sent every HEARTBEAT_INTERVAL_MS while the child's event loop runs. */
  | { type: 'heartbeat' }
  | { type: 'stopped' };

/** How long the host waits after asking the child to stop before it force-kills it; the child keeps to the same deadline. */
export const STOP_DEADLINE_MS = 2_000;

/** How often the child beats. */
export const HEARTBEAT_INTERVAL_MS = 1_000;

export function serializeError(error: unknown): SerializedFunctionsError {
  if (error instanceof Error) {
    return {
      name: redactActiveSecretString(error.name),
      message: redactActiveSecretString(error.message),
      ...(error.stack === undefined ? {} : { stack: redactActiveSecretString(error.stack) }),
    };
  }
  return { name: 'Error', message: redactActiveSecretString(String(error)) };
}

export function isChildMessage(value: unknown): value is FunctionsChildMessage {
  return typeof value === 'object' && value !== null && 'type' in value;
}

export function isHostMessage(value: unknown): value is FunctionsHostMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const kind = (value as { type?: unknown }).type;
  return (
    kind === 'stop' ||
    kind === 'trigger-scheduled' ||
    kind === 'publish-pubsub' ||
    kind === 'enqueue-task' ||
    kind === 'delete-task' ||
    kind === 'drain-tasks'
  );
}
