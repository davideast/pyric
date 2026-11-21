/**
 * Firestore document trigger runtime inside the isolated Functions child process.
 */
import { randomUUID } from 'node:crypto';
import type { RemoteSandbox } from '../../remote/index.js';
import {
  serializeError,
  type FunctionsChildEvent,
} from '../child-protocol.js';
import { discoverFirestoreTriggers } from './discovery.js';
import type { FirestoreTriggerExecutionResult } from './event.js';
import {
  startFirestoreTriggerExecution,
  type FirestoreTriggerExecutionHost,
} from './execution.js';
import { RemoteFirestoreTriggerDelivery } from './remote-delivery.js';
import { installChildFirestoreSnapshotBridge } from './snapshot-bridge.js';

export interface FirestoreChildRuntimeOptions {
  readonly entry: string;
  readonly exported: Record<string, unknown>;
  readonly sandbox: RemoteSandbox;
  readonly projectId: string;
  readonly location: string;
  send(event: FunctionsChildEvent): void;
}

function toExecutionEvent(
  result: FirestoreTriggerExecutionResult,
  exportName: string,
  documentPath: string,
  params: Record<string, string>,
): FunctionsChildEvent {
  if (result.status === 'fulfilled') {
    return {
      type: 'execution',
      exportName,
      ref: documentPath,
      params,
      status: 'fulfilled',
    };
  }
  return {
    type: 'execution',
    exportName,
    ref: documentPath,
    params,
    status: 'rejected',
    error: serializeError(result.error),
  };
}

/** Start delivering Firestore document mutations to discovered triggers in the child. */
export function startFirestoreChildRuntime(
  options: FirestoreChildRuntimeOptions,
): FirestoreTriggerExecutionHost {
  const { entry, exported, sandbox, projectId, location, send } = options;
  const discovered = discoverFirestoreTriggers(exported);

  let bridgeReady = Promise.resolve();
  if (discovered.length > 0) {
    bridgeReady = installChildFirestoreSnapshotBridge(entry, projectId, sandbox);
  }

  const executionHost = startFirestoreTriggerExecution({
    exported,
    delivery: new RemoteFirestoreTriggerDelivery(sandbox.channel),
    envelopeOptions: async (matched, sequence, trigger) => {
      await bridgeReady;
      return {
        id: `${randomUUID()}-${sequence}`,
        time: matched.mutation.time,
        projectId,
        location: trigger.location ?? location,
      };
    },
    onExecution(result, trigger, matched) {
      send(
        toExecutionEvent(
          result,
          trigger.exportName,
          matched.document,
          matched.params,
        ),
      );
    },
    onDeliveryError(error, trigger) {
      send({
        type: 'delivery-error',
        exportName: trigger.exportName,
        error: serializeError(error),
      });
    },
  });

  const combinedReady = Promise.all([bridgeReady, executionHost.ready]).then(
    () => undefined,
  );

  return {
    triggerCount: executionHost.triggerCount,
    ready: combinedReady,
    idle: () => executionHost.idle(),
    close: () => executionHost.close(),
  };
}
