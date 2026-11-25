/**
 * Lazy remote-port Auth session hydration for `FirebaseServerApp` handles
 * created with `settings.authIdToken` under `PYRIC_SANDBOX=remote`.
 */
import type { FirebaseApp, FirebaseServerApp } from 'pyric/app';
import { workerClientForApp } from '../../serve/entries/app-client.js';
import { nextId, rawRpc } from '../../serve/worker/client/core.js';
import { reserveSend } from '../../serve/worker/client/send-order.js';
import type { InboundMessage, OpMessage } from '../../serve/worker/protocol.js';

interface RecordedServerAuth {
  readonly token: string;
  readonly projectId: string | undefined;
  hydrated: boolean;
}

const serverAuthByApp = new WeakMap<object, RecordedServerAuth>();

function buildServerAuthRestoreOp(token: string, projectId: string | undefined): OpMessage {
  const payload: Record<string, unknown> = {
    t: 'op',
    id: nextId(),
    method: 'auth.restorePortSession',
    uid: '',
    authIdToken: token,
    issuer: undefined,
    relaySource: 'remote',
  };
  if (typeof projectId === 'string' && projectId.length > 0) {
    payload.expectedProjectId = projectId;
  }
  return payload as OpMessage;
}

export function recordRemoteServerAppToken(serverApp: FirebaseServerApp): void {
  if (serverAuthByApp.has(serverApp)) return;
  let token: string | undefined;
  let projectId: string | undefined;
  try {
    token = serverApp.settings.authIdToken;
    projectId = serverApp.options.projectId;
  } catch (err) {
    // Deleted or inaccessible server app handles cannot hydrate remote sessions.
    void err;
    return;
  }
  if (typeof token !== 'string' || token.length === 0) return;
  serverAuthByApp.set(serverApp, { token, projectId, hydrated: false });
}

export function ensureRemoteServerAppSession(app: unknown): void {
  if (typeof app !== 'object' || app === null) return;
  const recorded = serverAuthByApp.get(app);
  if (recorded === undefined || recorded.hydrated) return;
  recorded.hydrated = true;
  const client = workerClientForApp(app as FirebaseApp);
  if (client.port.restoreAuth === undefined) {
    client.port.restoreAuth = async (request) => {
      await request(buildServerAuthRestoreOp(recorded.token, recorded.projectId));
    };
  }
  const reservation = reserveSend(client.port);
  const restoreMessage = buildServerAuthRestoreOp(recorded.token, recorded.projectId) as InboundMessage;
  void rawRpc(client.port, restoreMessage, undefined, reservation)
    .catch((err: unknown) => {
      // Host refusal or transport failure leaves the port unauthenticated so
      // subsequent rules-enforced calls fail closed.
      void err;
    })
    .finally(() => {
      reservation.release();
    });
}
