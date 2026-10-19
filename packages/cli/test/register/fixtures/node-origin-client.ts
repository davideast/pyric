// Child-process fixture for node-origin.test.ts: the served client surfaces
// under a Node runtime origin whose host is not the Node host (`off-host`: its
// init.json says `hosted: false`) or cannot be found (`unreachable`). Prints
// one JSON line per call, then the runtime state the test asserts on.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const mode = process.argv[2];
const server = createServer((request, response) => {
  const isInit = request.url === '/__pyric/init.json';
  if (!isInit) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ hosted: false, projectKey: null, bridgeUrl: null }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { installNodeRuntimeOrigin } = await import('../../../src/serve/entries/runtime-origin.js');
const { createNodeSocketRealm } = await import('../../../src/register/client/node-realm.js');
const { offHostRefusal } = await import('../../../src/register/client/off-host-refusal.js');
const { bindAppRegistryRefusal, clientSdkRefusal } = await import('pyric/app/internal');

const unreachable = Object.assign(new Error('no running `pyric sandbox --bridge` found'), { code: 'not-found' });
const host = mode === 'unreachable' ? Promise.reject(unreachable) : Promise.resolve(url);
host.catch(() => undefined);
installNodeRuntimeOrigin({ realm: 'node', host: () => host, socketRealm: createNodeSocketRealm(), offHostError: offHostRefusal });
bindAppRegistryRefusal(() => clientSdkRefusal('remote'));

const { initializeApp } = await import('pyric/app');
const database = await import('../../../src/serve/entries/database-surface.js');
const firestore = await import('../../../src/serve/entries/firestore-surface.js');
const storage = await import('../../../src/serve/entries/storage-surface.js');
const auth = await import('../../../src/serve/entries/auth.js');
const runtime = await import('../../../src/serve/entries/worker-runtime.js');
const { sandbox: placeholder } = await import('../../../src/serve/entries/app-backend.js');
const mirror = await import('pyric/database');

async function outcome(name: string, run: () => unknown): Promise<void> {
  try {
    await run();
    console.log(JSON.stringify({ name, ok: true }));
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    console.log(JSON.stringify({ name, ok: false, code: code ?? null, message: message ?? String(error) }));
  }
}

const app = initializeApp({ apiKey: 'demo', appId: 'demo', projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' });
await outcome('database', () => database.set(database.ref(database.getDatabase(app), 'x'), 1));
await outcome('firestore', () => firestore.setDoc(firestore.doc(firestore.getFirestore(app), 'c/d'), { a: 1 }));
await outcome('auth', () => auth.signInAnonymously(auth.getAuth(app)));
await outcome('storage', () => storage.uploadString(storage.ref(storage.getStorage(app), 'x.txt'), 'x'));
await outcome('mirror', () => mirror.getDatabase(app));
const placeholderValue = (await mirror.get(mirror.ref(mirror.getAdminDatabase(placeholder), 'x'))).val();
console.log(JSON.stringify({ name: 'state', useWorker: runtime.useWorker, useHosted: runtime.useHosted, placeholderValue }));
server.close();
process.exit(0);
