/**
 * Lazy remote-port Auth session hydration for `FirebaseServerApp` handles
 * created with `settings.authIdToken` under `PYRIC_SANDBOX=remote`.
 */
import type { FirebaseApp, FirebaseServerApp } from 'pyric/app';
import { authStateFromServerIdToken } from 'pyric/app/internal';
import { workerClientForApp } from '../../serve/entries/app-client.js';
import { relayWorkerOp } from '../../serve/worker/index.js';

interface RecordedServerAuth {
  readonly uid: string;
  hydrated: boolean;
}

const serverAuthByApp = new WeakMap<object, RecordedServerAuth>();

export function recordRemoteServerAppToken(serverApp: FirebaseServerApp): void {
  let token: string | undefined;
  let projectId: string | undefined;
  try {
    token = serverApp.settings.authIdToken;
    projectId = serverApp.options.projectId;
  } catch (err) {
    void err;
    return;
  }
  if (typeof token !== 'string' || token.length === 0) return;
  const authState = authStateFromServerIdToken(token, projectId);
  if (authState === null) return;
  serverAuthByApp.set(serverApp, { uid: authState.uid, hydrated: false });
}

export function ensureRemoteServerAppSession(app: unknown): void {
  if (typeof app !== 'object' || app === null) return;
  const recorded = serverAuthByApp.get(app);
  if (recorded === undefined || recorded.hydrated) return;
  recorded.hydrated = true;
  const client = workerClientForApp(app as FirebaseApp);
  void relayWorkerOp(client, {
    method: 'auth.restorePortSession',
    uid: recorded.uid,
  }).catch((err: unknown) => {
    // Host refusal or unknown uid surfaces on subsequent service calls or stays unauthenticated.
    void err;
  });
}
