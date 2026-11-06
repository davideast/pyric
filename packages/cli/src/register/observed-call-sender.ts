/**
 * Sends an observed call (`ObservedCall` in `pyric/sandbox`) from a Node
 * process to the Node host, as the `observe` frame, on one hosted connection
 * of its own. The host stamps the caller from that connection, a Node
 * process, so the row reads "Server (client SDK)".
 *
 * Only the live rows' observer module imports this, by the file URL the
 * register gives it (`supplied-entry.ts`); nothing else in `@pyric/cli`
 * does. The connection finds the host as the Node client does
 * (`./client/bootstrap.ts`): `PYRIC_SANDBOX=remote:<url>`, or the host
 * `.pyric/serve.json` names. It opens at the first observed call.
 */
import './client/bootstrap.js';
import type { ObservedCall } from 'pyric/sandbox';
import { openWorkerDb } from '../serve/entries/worker-runtime.js';
import { nextId, rpc } from '../serve/worker/client/core.js';
import type { ClientDb } from '../serve/worker/client/handles.js';

/** The rows' observer measures each resolved call with this, as the page's sender does. */
export { measureObservedUsage } from 'pyric/sandbox/internal';

/** The connection's name on the host; no app uses it. */
const CONNECTION_NAME = '[pyric-live]';

let connection: ClientDb | undefined;

/** Sends one observed call. Rejects when the process cannot reach the Node host. */
export async function sendObservedCall(call: ObservedCall): Promise<void> {
  connection ??= openWorkerDb(CONNECTION_NAME);
  await rpc(connection.port, { t: 'observe', id: nextId(), call });
}
