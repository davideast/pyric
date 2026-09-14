import type { InboundMessage } from './protocol.js';
import { createOperationBudget } from '../../bridge/operation-budget.js';

interface ClientQueue {
  tail: Promise<void>;
  budget: ReturnType<typeof createOperationBudget>;
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
  let portBarrier = Promise.resolve();

  return message => {
    const clientId = message.clientSessionId || undefined;
    const client = clients.get(clientId) ?? { tail: portBarrier, budget: createOperationBudget() };
    let releaseOperation: (() => void) | undefined;
    const isOperation = message.t === 'op' || message.t === 'tool';
    if (isOperation) {
      const reservation = client.budget.reserve(message);
      const isRefused = !reservation.accepted;
      if (isRefused) {
        options.refuse(message, reservation.error);
        return Promise.resolve();
      }
      releaseOperation = reservation.release;
    }
    const disconnectsPort = message.t === 'disconnect' && clientId === undefined;
    const predecessors = disconnectsPort
      ? [portBarrier, ...Array.from(clients.values(), queue => queue.tail)]
      : [portBarrier, client.tail];
    const work = Promise.allSettled(predecessors).then(() => options.handle(message)).finally(() => {
      releaseOperation?.();
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
