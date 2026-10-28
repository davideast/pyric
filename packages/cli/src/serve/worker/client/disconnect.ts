/** Browser-safe app-port teardown shared by served apps and Pyric Studio. */
import type { InboundMessage } from '../protocol.js';
import { disconnectPort, endPortSubscriptions, nextId, rawRpc } from './core.js';
import type { ClientDb, ClientPort } from './handles.js';
import { dropRtdbListenersForPort } from './rtdb-listeners.js';

export interface DisconnectClientOptions {
  /** Bound version-skew and worker-crash cases where no disconnect reply arrives. */
  ackTimeoutMs?: number;
}

const DEFAULT_ACK_TIMEOUT_MS = 5_000;

function deleteTimeoutError(): Error & { code: string } {
  return Object.assign(
    new Error(
      'Timed out waiting for SharedWorker app cleanup acknowledgment. ' +
      'Close all tabs using this pyric sandbox origin so the worker can restart.',
    ),
    { code: 'app/delete-timeout' },
  );
}

export async function disconnectClient(
  db: ClientDb,
  options: DisconnectClientOptions = {},
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const acknowledged = rawRpc(db.port, {
      t: 'disconnect',
      id: nextId(),
    } satisfies InboundMessage);
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(deleteTimeoutError()),
        options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS,
      );
    });
    await Promise.race([acknowledged, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    dropRtdbListenersForPort(db.port);
    disconnectPort(db.port);
    db.port.close();
  }
}

/**
 * Ends every subscription on a port whose connection failed with no retry
 * (ADR-0019, 2026-10-17 amendment, D6), with that failure's error. It runs the
 * teardown an app's deletion runs, but leaves the port open to the caller's
 * transport: a later operation fails with the transport's own close error.
 */
export function endFailedPort(port: ClientPort, error: Error & { code: string }): void {
  endPortSubscriptions(port, error);
  dropRtdbListenersForPort(port);
}
