// Child-process fixture for node-origin.test.ts: under a Node runtime origin,
// `currentHostInstanceId()` reads init.json afresh each time, and that read
// also answers the next session-token read. Each init.json answer carries the
// request's count. Prints one JSON line with what each read returned.
let requests = 0;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    requests += 1;
    return Response.json({ hosted: true, projectKey: 'demo-project', instanceId: `boot-${requests}`, sessionToken: `token-${requests}` });
  },
});
const url = `http://127.0.0.1:${server.port}`;

const { installNodeRuntimeOrigin } = await import('../../../src/serve/entries/runtime-origin.js');
const { createNodeSocketRealm } = await import('../../../src/register/client/node-realm.js');
const { offHostRefusal } = await import('../../../src/register/client/off-host-refusal.js');
installNodeRuntimeOrigin({ realm: 'node', host: () => Promise.resolve(url), socketRealm: createNodeSocketRealm(), offHostError: offHostRefusal });

const { currentHostInstanceId, currentSessionToken, forgetSessionToken } = await import('../../../src/serve/entries/init-payload.js');
const first = await currentHostInstanceId();
// A reconnect: the host may have restarted, then the client reads the boot before it reattaches.
forgetSessionToken();
const second = await currentHostInstanceId();
const token = await currentSessionToken();
console.log(JSON.stringify({ first, second, token, requests }));
void server.stop(true);
process.exit(0);
