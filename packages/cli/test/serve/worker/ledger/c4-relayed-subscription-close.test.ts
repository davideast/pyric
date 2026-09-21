import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { wirePort, disconnectPort } from '../../../../src/serve/worker/client/core.js';
import { relayWorkerOp, relayWorkerSub } from '../../../../src/serve/worker/client/connection.js';
import type { ClientDb, ClientPort } from '../../../../src/serve/worker/client/handles.js';
import type { OutboundMessage } from '../../../../src/serve/worker/protocol.js';

test('an errored relayed listener is removed from its logical session before an auth transition', async () => {
  const sandbox = initializeSandbox();
  const ctx: HostCtx = { sandbox, db: getFirestore(sandbox), instanceId: 'close-relayed-sub', subs: new Map() };
  const delivered: OutboundMessage[] = [];
  const hostPort: PortLike = {
    postMessage(message) {
      delivered.push(message);
      queueMicrotask(() => clientPort.onmessage?.(new MessageEvent('message', { data: message })));
    },
  };
  const clientPort: ClientPort = {
    onmessage: null,
    postMessage(message) { void handleMessage(ctx, hostPort, message); },
    start() {},
    close() { clientPort.onmessage = null; },
  };
  wirePort(clientPort);
  const db: ClientDb = { __kind: 'client-db', port: clientPort };
  const sessionId = 'remote-consumer';
  const initial = Promise.withResolvers<unknown>();
  let stop = () => {};
  try {
    await relayWorkerOp(db, { method: 'setRules', source: `rules_version = '2';
      service cloud.firestore { match /databases/{database}/documents {
        match /notes/{id} { allow read, write: if request.auth != null; }
      } }` }, sessionId);
    stop = relayWorkerSub(db, { target: { __ref: 'doc', path: 'notes/one' } }, value => initial.resolve(value), sessionId);
    expect(await initial.promise).toMatchObject({ __error: { code: 'permission-denied' } });
    expect(delivered.filter(message => message.t === 'snap')).toHaveLength(1);

    await relayWorkerOp(db, { method: 'auth.signInAnonymously' }, sessionId);
    await relayWorkerOp(db, { method: 'setDoc', path: 'notes/one', data: { value: 'After sign-in' } }, sessionId);
    await new Promise(resolve => setTimeout(resolve, 0));

    // Observe host output: dropping only the client callback would hide a leaked listener.
    expect(delivered.filter(message => message.t === 'snap')).toHaveLength(1);
  } finally {
    stop();
    disconnectPort(clientPort);
    clientPort.close();
    sandbox.dispose();
  }
});
