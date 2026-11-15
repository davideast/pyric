import assert from 'node:assert/strict';
import { runtimeRealm } from '../worker-runtime-realm.ts';

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function readStatusErrors(snapshot: unknown): Array<{ message: string }> {
  if (typeof snapshot !== 'object' || snapshot === null || !('errors' in snapshot)) {
    return [];
  }
  const raw = snapshot.errors;
  if (!Array.isArray(raw)) return [];
  const entries: Array<{ message: string }> = [];
  for (const item of raw) {
    if (typeof item === 'object' && item !== null && 'message' in item && typeof item.message === 'string') {
      entries.push({ message: item.message });
    }
  }
  return entries;
}

async function runRemotePeerCase(): Promise<void> {
  const realm = await runtimeRealm({
    hostedWithoutIdentity: true,
    sharedWorker: true,
    pageSdk: true,
    captureConsoleErrors: true,
  });
  try {
    await realm.evaluation;
    const stopAuth = realm.registerAuth();
    assert.equal(realm.runtime.useHosted, true);
    assert.deepEqual(realm.connections, []);
    const app = realm.sdk.app.initializeApp({ projectId: 'demo-items' });
    const db = realm.sdk.firestore.getFirestore(app);
    const pendingRead = realm.sdk.firestore.getDoc(realm.sdk.firestore.doc(db, 'items/a'));
    realm.respond({ hosted: true, remotePeer: true, bridgeUrl: null });
    let readError: unknown;
    try {
      await pendingRead;
    } catch (error) {
      readError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    stopAuth();
    const readMessage = errorMessage(readError);
    assert.ok(
      readMessage.includes('This Node host serves project data only to clients on its own machine'),
      `unexpected read error: ${readMessage}`,
    );
    assert.deepEqual(realm.connections, []);
    assert.equal(realm.initFetches(), 1);
    assert.equal(realm.consoleErrors.length, 1);
    assert.ok(realm.consoleErrors[0]?.includes('[pyric sandbox] init payload unavailable:'));
    assert.ok(!realm.consoleErrors[0]?.includes('Uncaught Error in snapshot listener'));
    const errors = readStatusErrors(realm.status());
    assert.equal(errors.length, 1);
    assert.ok(errors[0]?.message.includes('only to clients on its own machine'));
    await realm.sdk.app.deleteApp(app);
  } finally {
    realm.respond({ hosted: false });
    await realm.evaluation.catch(() => {});
    realm.dispose();
  }
}

async function runTerminalHttpCase(): Promise<void> {
  const cases = [
    {
      response: new Response('Forbidden: host not allowed', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      }),
      expectedCode: '403',
      expectedDetail: 'Forbidden: host not allowed',
    },
    {
      response: new Response(JSON.stringify({ error: 'Unauthorized: invalid session' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
      expectedCode: '401',
      expectedDetail: 'Unauthorized: invalid session',
    },
  ];
  for (const testCase of cases) {
    const realm = await runtimeRealm({
      hostedWithoutIdentity: true,
      sharedWorker: true,
      pageSdk: true,
      captureConsoleErrors: true,
    });
    try {
      await realm.evaluation;
      const app = realm.sdk.app.initializeApp({ projectId: 'demo-items' });
      const db = realm.sdk.firestore.getFirestore(app);
      const pendingRead = realm.sdk.firestore.getDoc(realm.sdk.firestore.doc(db, 'items/a'));
      realm.respondRaw(testCase.response);
      let readError: unknown;
      try {
        await pendingRead;
      } catch (error) {
        readError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
      const readMessage = errorMessage(readError);
      assert.ok(readMessage.includes(testCase.expectedCode), `missing ${testCase.expectedCode} in ${readMessage}`);
      assert.ok(readMessage.includes(testCase.expectedDetail), `missing ${testCase.expectedDetail} in ${readMessage}`);
      assert.equal(realm.initFetches(), 1);
      assert.deepEqual(realm.connections, []);
      assert.equal(realm.consoleErrors.length, 1);
      const errors = readStatusErrors(realm.status());
      assert.equal(errors.length, 1);
      await realm.sdk.app.deleteApp(app);
    } finally {
      realm.respond({ hosted: false });
      await realm.evaluation.catch(() => {});
      realm.dispose();
    }
  }
}

const mode = process.argv[2];
if (mode === 'remote-peer') {
  await runRemotePeerCase();
} else if (mode === 'terminal-http') {
  await runTerminalHttpCase();
} else {
  throw new Error(`Unknown fixture mode: ${String(mode)}`);
}
