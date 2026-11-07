/**
 * Sends an observed call (`ObservedCall` in `pyric/sandbox`) from a Node
 * process to the Node host, as the `observe` frame, on one hosted connection
 * of its own. The host stamps the caller from that connection, a Node
 * process, so the row reads "Node process".
 *
 * Only the live rows' observer module imports this, by the file URL the
 * register gives it (`supplied-entry.ts`); nothing else in `@pyric/cli`
 * does. The connection finds the host as the Node client does
 * (`./client/bootstrap.ts`): `PYRIC_SANDBOX=remote:<url>`, or the host
 * `.pyric/serve.json` names. It opens at the first observed call.
 *
 * It ends the connection as the process exits (`./node-client.ts`), so the
 * host detaches the listeners the process reported at once, and each frame
 * names the process's project root and entry script by a hashed label, so the
 * host can detach an earlier run's listeners when a restart connects again.
 */
import './client/bootstrap.js';
import type { ObservedCall } from 'pyric/sandbox';
import { openWorkerDb } from '../serve/entries/worker-runtime.js';
import { nextId, rpc } from '../serve/worker/client/core.js';
import { disconnectClient } from '../serve/worker/client/disconnect.js';
import type { ClientDb } from '../serve/worker/client/handles.js';
import { liveProjectRoot } from './live-package.js';
import { endWithProcess, nodeClientLabel } from './node-client.js';

/** The rows' observer measures each resolved call with this, as the page's sender does. */
export { measureObservedUsage } from 'pyric/sandbox/internal';

/** The connection's name on the host; no app uses it. */
const CONNECTION_NAME = '[pyric-live]';

/** How long an exiting process waits for the host to acknowledge the end. */
const END_ACK_TIMEOUT_MS = 1_000;

let connection: ClientDb | undefined;
let endsWithProcess = false;
let label: string | undefined;

/** End the open connection, if any; a later call opens a new one. */
function endConnection(): Promise<void> {
  const open = connection;
  connection = undefined;
  if (open === undefined) return Promise.resolve();
  return disconnectClient(open, { ackTimeoutMs: END_ACK_TIMEOUT_MS });
}

function openConnection(): ClientDb {
  if (!endsWithProcess) {
    endsWithProcess = true;
    endWithProcess(endConnection);
  }
  return openWorkerDb(CONNECTION_NAME);
}

function nodeClient(): string {
  const cwd = process.cwd();
  label ??= nodeClientLabel({ projectRoot: liveProjectRoot(process.env, cwd), cwd, entry: process.argv[1], execArgv: process.execArgv });
  return label;
}

/** Sends one observed call. Rejects when the process cannot reach the Node host. */
export async function sendObservedCall(call: ObservedCall): Promise<void> {
  connection ??= openConnection();
  await rpc(connection.port, { t: 'observe', id: nextId(), call, nodeClient: nodeClient() });
}
