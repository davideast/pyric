// Child-process fixture for node-origin.test.ts (#1145): under a Node runtime
// origin, `initPayload` and `initPayloadRequest` cache per (host url, Vite SSR
// server epoch) rather than latching the first server's answer forever.
const VITE_SSR_SERVER_EPOCH = Symbol.for('pyric.vite.ssrServerEpoch');

let sharedWorkerRequests = 0;
const sharedWorkerServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    sharedWorkerRequests += 1;
    return Response.json({
      hosted: false,
      projectKey: null,
      instanceId: 'sw-boot-1',
      sessionToken: 'sw-token-1',
    });
  },
});

let hostedRequests = 0;
const hostedServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    hostedRequests += 1;
    return Response.json({
      hosted: true,
      projectKey: `project-${hostedRequests}`,
      instanceId: `hosted-boot-${hostedRequests}`,
      sessionToken: `hosted-token-${hostedRequests}`,
    });
  },
});

let activeUrl = `http://127.0.0.1:${sharedWorkerServer.port}`;
let activeEpoch = 1;
(globalThis as Record<symbol, unknown>)[VITE_SSR_SERVER_EPOCH] = () => activeEpoch;

const { installNodeRuntimeOrigin } = await import('../../../src/serve/entries/runtime-origin.js');
const { createNodeSocketRealm } = await import('../../../src/register/client/node-realm.js');
const { offHostRefusal } = await import('../../../src/register/client/off-host-refusal.js');

installNodeRuntimeOrigin({
  realm: 'node',
  host: () => Promise.resolve(activeUrl),
  socketRealm: createNodeSocketRealm(),
  offHostError: offHostRefusal,
});

const { currentSessionToken, forgetSessionToken, initPayload } = await import(
  '../../../src/serve/entries/init-payload.js'
);

const firstRead = await initPayload;
const cachedFirstRead = await initPayload;

// Handover to a hosted server on another port (#1145): initPayload and sessionToken follow it.
activeUrl = `http://127.0.0.1:${hostedServer.port}`;
activeEpoch = 2;
const secondRead = await initPayload;
const secondToken = await currentSessionToken();
const cachedSecondRead = await initPayload;

// Same-port Vite SSR epoch bump: calling currentSessionToken() before initPayload
// invalidates the prior server's cached sessionTokenRequest and fetches once (#1145).
activeEpoch = 3;
const thirdToken = await currentSessionToken();
const thirdRead = await initPayload;

// Connection drop (`forgetSessionToken`) invalidates cached Node initPayload even without epoch change.
forgetSessionToken();
const fourthRead = await initPayload;

console.log(
  JSON.stringify({
    firstHosted: firstRead?.hosted ?? null,
    sameFirstInstance: cachedFirstRead?.instanceId === firstRead?.instanceId,
    sharedWorkerRequests,
    secondInstance: secondRead?.instanceId ?? null,
    secondToken,
    cachedSecondInstance: cachedSecondRead?.instanceId ?? null,
    thirdInstance: thirdRead?.instanceId ?? null,
    thirdToken,
    fourthInstance: fourthRead?.instanceId ?? null,
    hostedRequests,
  }),
);

void sharedWorkerServer.stop(true);
void hostedServer.stop(true);
process.exit(0);
