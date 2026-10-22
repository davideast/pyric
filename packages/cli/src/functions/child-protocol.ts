/**
 * The IPC messages between the host and the isolated Functions child, shared
 * by both sides so neither re-declares the other's shapes.
 */
import type { HttpFunctionInfo } from './http/discovery.js';
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
    }
  | {
      type: 'execution';
      exportName: string;
      ref: string;
      params: Record<string, string>;
      status: 'rejected';
      error: SerializedFunctionsError;
    }
  | {
      type: 'delivery-error';
      exportName: string;
      error: SerializedFunctionsError;
    }
  | {
      /** An exception no handler caught, which the child logged and survived (functions-http#12). */
      type: 'uncaught-error';
      error: SerializedFunctionsError;
    };

/** The child's HTTP listener and the onRequest functions it serves. */
export interface FunctionsChildHttpReady {
  port: number;
  functions: HttpFunctionInfo[];
}

export interface FunctionsChildReady {
  triggerCount: number;
  unsupportedTriggers: UnsupportedFunctionsTrigger[];
  /** Present when the source exports at least one onRequest function. */
  http?: FunctionsChildHttpReady;
}

export type FunctionsChildMessage =
  | ({ type: 'ready' } & FunctionsChildReady)
  | FunctionsChildEvent
  | { type: 'fatal'; error: SerializedFunctionsError }
  /** Sent every HEARTBEAT_INTERVAL_MS while the child's event loop runs. */
  | { type: 'heartbeat' }
  | { type: 'stopped' };

/** How often the child beats. */
export const HEARTBEAT_INTERVAL_MS = 1_000;

export function serializeError(error: unknown): SerializedFunctionsError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: 'Error', message: String(error) };
}

export function isChildMessage(value: unknown): value is FunctionsChildMessage {
  return typeof value === 'object' && value !== null && 'type' in value;
}
