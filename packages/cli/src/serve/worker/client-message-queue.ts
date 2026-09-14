import type { InboundMessage } from './protocol.js';
import { MAX_PENDING_OPERATIONS, MAX_QUEUED_OPERATION_BYTES } from '../../bridge/protocol.js';

interface ClientQueue {
  tail: Promise<void>;
  pendingOperations: number;
  pendingOperationBytes: number;
}

interface ClientMessageQueueOptions {
  handle(message: InboundMessage): Promise<void>;
  refuse(message: Extract<InboundMessage, { t: 'op' | 'tool' }>, error: { code: string; message: string }): void;
}

/** Preserve each client's order without blocking other clients relayed by the same port. */
export function createClientMessageQueue(
  options: ClientMessageQueueOptions,
): (message: InboundMessage) => Promise<void> {
  const clients = new Map<string | undefined, ClientQueue>();
  const utf8 = new TextEncoder();
  let portBarrier = Promise.resolve();

  return message => {
    const clientId = message.clientSessionId || undefined;
    const client = clients.get(clientId) ?? { tail: portBarrier, pendingOperations: 0, pendingOperationBytes: 0 };
    let operationBytes = 0;
    const isOperation = message.t === 'op' || message.t === 'tool';
    if (isOperation) {
      const hasReachedCapacity = client.pendingOperations >= MAX_PENDING_OPERATIONS;
      if (hasReachedCapacity) {
        options.refuse(message, { code: 'resource-exhausted', message: 'This client already has 256 pending operations.' });
        return Promise.resolve();
      }
      try {
        operationBytes = utf8.encode(JSON.stringify(message)).byteLength;
      } catch {
        options.refuse(message, { code: 'invalid-argument', message: 'The operation must have a JSON-serializable encoding.' });
        return Promise.resolve();
      }
      const exceedsByteLimit = client.pendingOperationBytes + operationBytes > MAX_QUEUED_OPERATION_BYTES;
      if (exceedsByteLimit) {
        options.refuse(message, { code: 'resource-exhausted', message: 'This client exceeds the 24 MiB queued operation byte limit.' });
        return Promise.resolve();
      }
      client.pendingOperations += 1;
      client.pendingOperationBytes += operationBytes;
    }
    const disconnectsPort = message.t === 'disconnect' && clientId === undefined;
    const predecessors = disconnectsPort
      ? [portBarrier, ...Array.from(clients.values(), queue => queue.tail)]
      : [portBarrier, client.tail];
    const work = Promise.allSettled(predecessors).then(() => options.handle(message)).finally(() => {
      if (isOperation) {
        client.pendingOperations -= 1;
        client.pendingOperationBytes -= operationBytes;
      }
    });
    client.tail = work;
    clients.set(clientId, client);
    if (disconnectsPort) portBarrier = work;
    const release = (): void => {
      const isLatest = clients.get(clientId)?.tail === work;
      if (isLatest) clients.delete(clientId);
    };
    void work.then(release, release);
    return work;
  };
}
