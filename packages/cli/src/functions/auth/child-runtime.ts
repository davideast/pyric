/**
 * The Gen 1 Firebase Auth user lifecycle trigger family inside the isolated
 * Functions child: subscribes to Auth `user_create` / `user_delete` mutations
 * over the remote sandbox channel and reports each execution over IPC.
 */
import { randomUUID } from 'node:crypto';
import type { RemoteSandbox } from '../../remote/index.js';
import { serializeError, type FunctionsChildEvent } from '../child-protocol.js';
import { RemoteAuthLifecycleTriggerDelivery } from './delivery.js';
import type { AuthLifecycleExecutionResult } from './event.js';
import {
  startAuthLifecycleTriggerExecution,
  type AuthLifecycleTriggerExecutionHost,
} from './execution.js';

export interface AuthLifecycleChildRuntimeOptions {
  exported: Record<string, unknown>;
  sandbox: RemoteSandbox;
  projectId: string;
  send(event: FunctionsChildEvent): void;
}

async function sandboxNow(sandbox: RemoteSandbox): Promise<number> {
  try {
    const read = (await sandbox.channel.op({ method: 'sandbox.clock' })) as { now: number };
    return read.now;
  } catch {
    return Date.now();
  }
}

function executionEvent(
  result: AuthLifecycleExecutionResult,
  exportName: string,
  ref: string,
): FunctionsChildEvent {
  if (result.status === 'fulfilled') {
    return { type: 'execution', exportName, ref, params: {}, status: 'fulfilled' };
  }
  return {
    type: 'execution',
    exportName,
    ref,
    params: {},
    status: 'rejected',
    error: serializeError(result.error),
  };
}

/** Start delivering Auth user lifecycle events to discovered Gen 1 Auth triggers. */
export function startAuthLifecycleChildRuntime(
  options: AuthLifecycleChildRuntimeOptions,
): AuthLifecycleTriggerExecutionHost {
  const { exported, sandbox, projectId, send } = options;
  return startAuthLifecycleTriggerExecution({
    exported,
    projectId,
    delivery: new RemoteAuthLifecycleTriggerDelivery(sandbox.channel),
    eventMetadata: async (notification, sequence) => {
      let timestampMs = notification.at;
      if (timestampMs <= 0) {
        timestampMs = await sandboxNow(sandbox);
      }
      return {
        eventId: `${randomUUID()}-${sequence}`,
        timestamp: new Date(timestampMs).toISOString(),
      };
    },
    onExecution(result, trigger, notification) {
      send(executionEvent(result, trigger.exportName, `auth/users/${notification.uid}`));
    },
    onDeliveryError(error, trigger) {
      send({
        type: 'delivery-error',
        exportName: trigger.exportName,
        error: serializeError(error),
      });
    },
  });
}
