// Child-process fixture for node-origin.test.ts: the served client surfaces
// under a Node runtime origin whose host is not the Node host (`off-host`: its
// init.json says `hosted: false`), cannot be found (`unreachable`), cannot be
// found at the first calls and then answers (`late-host`), or is the Node host
// (`attach`: the fixture prints the attach frame the client sends, and exits).
// Prints one JSON line per call, then the runtime state the test asserts on.
const mode = process.argv[2];
const isNodeHost = mode === 'attach';
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request, bunServer) {
    const { pathname } = new URL(request.url);
    const isSocket = pathname === '/__pyric/sandbox';
    if (isSocket && bunServer.upgrade(request)) return undefined;
    const isInit = pathname === '/__pyric/init.json';
    if (!isInit) return new Response(null, { status: 404 });
    const payload = isNodeHost
      ? { hosted: true, projectKey: 'demo-project', bridgeUrl: `ws://127.0.0.1:${bunServer.port}/__pyric/sandbox`, instanceId: 'host-boot-1' }
      : { hosted: false, projectKey: null, bridgeUrl: null };
    return Response.json(payload);
  },
  websocket: {
    message(_socket, frame) {
      const attach = JSON.parse(String(frame)) as { type?: string; hostInstanceId?: string };
      console.log(JSON.stringify({ name: 'attach', type: attach.type, hostInstanceId: attach.hostInstanceId ?? null }));
      process.exit(0);
    },
  },
});
const url = `http://127.0.0.1:${server.port}`;

const { installNodeRuntimeOrigin } = await import('../../../src/serve/entries/runtime-origin.js');
const { createNodeSocketRealm } = await import('../../../src/register/client/node-realm.js');
const { offHostRefusal } = await import('../../../src/register/client/off-host-refusal.js');
const { bindAppRegistryRefusal, clientSdkRefusal } = await import('pyric/app/internal');

const unreachable = Object.assign(new Error('no running `pyric sandbox --bridge` found'), { code: 'not-found' });
let hostIsUp = mode !== 'unreachable' && mode !== 'late-host';
const host = (): Promise<string> => (hostIsUp ? Promise.resolve(url) : Promise.reject(unreachable));
installNodeRuntimeOrigin({ realm: 'node', host, socketRealm: createNodeSocketRealm(), offHostError: offHostRefusal });
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

if (isNodeHost) {
  // The attach frame ends the fixture; the call itself never settles.
  void database.set(database.ref(database.getDatabase(app), 'x'), 1);
  await new Promise(() => {});
}

async function callEachService(suffix: string): Promise<void> {
  await outcome(`database${suffix}`, () => database.set(database.ref(database.getDatabase(app), 'x'), 1));
  await outcome(`firestore${suffix}`, () => firestore.setDoc(firestore.doc(firestore.getFirestore(app), 'c/d'), { a: 1 }));
  await outcome(`auth${suffix}`, () => auth.signInAnonymously(auth.getAuth(app)));
  await outcome(`storage${suffix}`, () => storage.uploadString(storage.ref(storage.getStorage(app), 'x.txt'), 'x'));
}

await callEachService('');
if (mode === 'late-host') {
  // The host appears: the same app's next calls find it and hear its answer.
  hostIsUp = true;
  await callEachService('.again');
}
await outcome('mirror', () => mirror.getDatabase(app));
const placeholderValue = (await mirror.get(mirror.ref(mirror.getAdminDatabase(placeholder), 'x'))).val();
console.log(JSON.stringify({ name: 'state', useWorker: runtime.useWorker, useHosted: runtime.useHosted, placeholderValue }));
void server.stop(true);
process.exit(0);
