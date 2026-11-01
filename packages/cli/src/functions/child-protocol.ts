/**
 * The IPC messages between the host and the isolated Functions child, shared
 * by both sides so neither re-declares the other's shapes.
 */
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
    };

export interface FunctionsChildReady {
  triggerCount: number;
  unsupportedTriggers: UnsupportedFunctionsTrigger[];
}

export type FunctionsChildMessage =
  | ({ type: 'ready' } & FunctionsChildReady)
  | FunctionsChildEvent
  | { type: 'fatal'; error: SerializedFunctionsError }
  | { type: 'stopped' };

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
