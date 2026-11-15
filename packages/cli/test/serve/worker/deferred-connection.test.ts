import { expect, test } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import { getDeferredFirestore } from '../../../src/serve/worker/client/deferred-connection.js';
import { nextId, nextSubId, openSnapshotSubscription, rawRpc } from '../../../src/serve/worker/client/core.js';
import type { ClientDb, ClientPort } from '../../../src/serve/worker/client/handles.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

// A promise choice (a page's Service Worker) is made once: a failure fails
// every later call too. A function choice (a Node process) chooses again at
// the next call, so a process started before its host reaches it later.

const ping = (): InboundMessage => ({ t: 'op', id: nextId(), method: 'ping' } as unknown as InboundMessage);

/** A transport that answers every op with `pong`. */
function answeringTransport(sent: InboundMessage[]): (port: ClientPort) => ClientDb {
  return (port) => {
    port.postMessage = (message) => {
      sent.push(message);
      const isOp = message.t === 'op';
      if (isOp) {
        const { id } = message as { id: string };
        queueMicrotask(() => port.onmessage?.(new MessageEvent('message', { data: { t: 'res', id, ok: true, value: 'pong' } })));
      }
    };
    return { __kind: 'client-db', port };
  };
}

test('a promise choice that rejects fails a later call with the same error, without choosing again', async () => {
  const refusal = new FirebaseError('failed-precondition', 'not the Node host');
  const choice = Promise.reject(refusal);
  const db = getDeferredFirestore(choice);
  await expect(rawRpc(db.port, ping())).rejects.toBe(refusal);
  // The choice is settled for good: the next call is refused where it is posted.
  expect(() => db.port.postMessage(ping())).toThrow(refusal);
  await expect(rawRpc(db.port, ping())).rejects.toBe(refusal);
});

test('a function choice that rejects fails the waiting call, and the next call chooses again', async () => {
  const sent: InboundMessage[] = [];
  let choices = 0;
  const db = getDeferredFirestore(() => {
    choices += 1;
    const isFirst = choices === 1;
    if (isFirst) return Promise.reject(new Error('no host found'));
    return Promise.resolve(answeringTransport(sent));
  });
  db.port.postMessage({ t: 'appConfig', options: { projectId: 'demo' } } as InboundMessage);

  await expect(rawRpc(db.port, ping())).rejects.toMatchObject({ code: 'unavailable', message: 'no host found' });
  expect(choices).toBe(1);
  expect(await rawRpc(db.port, ping())).toBe('pong');
  expect(choices).toBe(2);
  // The app configuration waited for the choice that succeeded, and went once, before the op.
  const kinds = sent.map(message => message.t);
  expect(kinds.filter(kind => kind === 'appConfig')).toHaveLength(1);
  expect(kinds.indexOf('appConfig')).toBeLessThan(kinds.indexOf('op'));
});

test('a rejected choice stops internal Auth and presence subscriptions silently while delivering Firestore listener errors', async () => {
  let rejectChoice!: (reason: unknown) => void;
  const choice = new Promise<(port: ClientPort) => ClientDb>((_resolve, reject) => {
    rejectChoice = reject;
  });
  const db = getDeferredFirestore(choice);
  const authSubId = nextSubId();
  const presenceSubId = nextSubId();
  const handledSubId = nextSubId();
  const unhandledSubId = nextSubId();
  const handledErrors: unknown[] = [];

  openSnapshotSubscription(db.port, authSubId, { port: db.port, next: () => {} }, { t: 'sub', subId: authSubId, target: 'idToken' });
  openSnapshotSubscription(db.port, presenceSubId, { port: db.port, next: () => {} }, { t: 'sub', subId: presenceSubId, target: 'presence' });
  openSnapshotSubscription(
    db.port,
    handledSubId,
    { port: db.port, service: 'firestore', next: () => {}, error: (err) => handledErrors.push(err) },
    { t: 'sub', subId: handledSubId, target: { __ref: 'doc', path: 'items/a' } },
  );
  openSnapshotSubscription(
    db.port,
    unhandledSubId,
    { port: db.port, service: 'firestore', next: () => {} },
    { t: 'sub', subId: unhandledSubId, target: { __ref: 'doc', path: 'items/b' } },
  );

  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    rejectChoice(new Error('This Node host serves project data only to clients on its own machine.'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.error = originalConsoleError;
  }

  expect(handledErrors).toHaveLength(1);
  expect(logged).toHaveLength(1);
  expect(String(logged[0]?.[0])).toContain('pyric/firestore: Uncaught Error in snapshot listener:');
});
