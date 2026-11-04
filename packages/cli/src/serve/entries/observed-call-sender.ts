/**
 * Sends an observed call (`ObservedCall` in `pyric/sandbox`) from a page to
 * the Node host, as the `observe` frame, on the page's own control
 * connection. The host stamps the page's caller from that connection, so the
 * row shows as this page's.
 *
 * Only a module served through supplied rows imports this
 * (`../vite-supplied-rows.ts`); no `pyric()` entry does. It is served from
 * this folder so it shares the page runtime's one connection and request ids.
 */
import type { ObservedCall } from 'pyric/sandbox';
import { nextId, rpc } from '../worker/client/core.js';
import { useHosted, workerDb } from './worker-runtime.js';

/** Sends one observed call. Rejects when the page has no Node host connection. */
export async function sendObservedCall(call: ObservedCall): Promise<void> {
  const db = workerDb;
  const hasHostConnection = useHosted && db !== null;
  if (!hasHostConnection) throw new Error('pyric: this page has no Node host connection to report observed calls on.');
  await rpc(db.port, { t: 'observe', id: nextId(), call });
}
