// The canary's Node plants. The harness runs this as
// `node --import @pyric/cli/register node-plants.mjs` with the recorder in
// NODE_OPTIONS, under pyric's default guard. Each plant reaches for a Google
// host or the metadata server in one of the ways a server can; the recorder
// must record it and refuse it. One local request must work. Prints one JSON
// line: { plants: [{ name, host, outcome }], local: { outcome } }.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Worker } from 'node:worker_threads';

// Nothing is planted unless the recorder loaded first: without it, a plant
// would leave the machine.
if (globalThis[Symbol.for('pyric.builders.node-egress')] !== true) {
  throw new Error('the builder recorder is not loaded in this process; refusing to plant any request');
}
const LOCAL_URL = process.env.CANARY_LOCAL_URL;
if (!LOCAL_URL) throw new Error('CANARY_LOCAL_URL is not set');
const PLANT_TIMEOUT_MS = 5_000;
const SUCCEEDED = 'succeeded';

/** The error's code, or its message when it has none. */
const failure = (error) => `failed: ${error?.cause?.code ?? error?.code ?? error?.message ?? String(error)}`;

function withTimeout(promise) {
  const limit = new Promise((resolve) => setTimeout(() => resolve('failed: timed out'), PLANT_TIMEOUT_MS).unref());
  return Promise.race([promise, limit]);
}

async function fetchOutcome(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PLANT_TIMEOUT_MS) });
    await response.arrayBuffer();
    return SUCCEEDED;
  } catch (error) {
    return failure(error);
  }
}

function requestOutcome(module, options) {
  return new Promise((resolve) => {
    try {
      const request = module.request(options);
      request.on('response', (response) => { response.resume(); resolve(SUCCEEDED); });
      request.on('error', (error) => resolve(failure(error)));
      request.end();
    } catch (error) {
      resolve(failure(error));
    }
  });
}

function socketOutcome(connect) {
  return new Promise((resolve) => {
    try {
      const socket = connect();
      socket.once('connect', () => { socket.destroy(); resolve(SUCCEEDED); });
      socket.once('secureConnect', () => { socket.destroy(); resolve(SUCCEEDED); });
      socket.once('error', (error) => resolve(failure(error)));
    } catch (error) {
      resolve(failure(error));
    }
  });
}

function lookupOutcome(host) {
  return new Promise((resolve) => {
    dns.lookup(host, (error) => resolve(error ? failure(error) : SUCCEEDED));
  });
}

/** A local stand-in proxy. Any request that reaches it counts as a success. */
async function startProxy() {
  const proxy = http.createServer((_request, response) => response.end('reached the proxy'));
  proxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 200 Connection Established\r\n\r\n'));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return proxy;
}

const WORKER_FETCH = `
const { parentPort } = require('node:worker_threads');
fetch('https://firebasestorage.googleapis.com/v0/b/demo-canary.appspot.com/o')
  .then(() => parentPort.postMessage('succeeded'), (error) => parentPort.postMessage('failed: ' + (error.cause?.code ?? error.message)));
`;

function workerOutcome() {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_FETCH, { eval: true });
    worker.once('message', (message) => { resolve(message); void worker.terminate(); });
    worker.once('error', (error) => resolve(failure(error)));
  });
}

const proxy = await startProxy();
const proxyPort = proxy.address().port;

const PLANTS = [
  ['fetch to Cloud Firestore', 'firestore.googleapis.com',
    () => fetchOutcome('https://firestore.googleapis.com/v1/projects/demo-canary/databases/(default)/documents/canary/a')],
  ['fetch to the metadata server by address', '169.254.169.254',
    () => fetchOutcome('http://169.254.169.254/computeMetadata/v1/')],
  ['http.request to the metadata server by name', 'metadata.google.internal',
    () => requestOutcome(http, { host: 'metadata.google.internal', path: '/computeMetadata/v1/instance/service-accounts/default/token', headers: { 'Metadata-Flavor': 'Google' } })],
  ['https.request to a Google host the catalog does not list', 'oauth2.googleapis.com',
    () => requestOutcome(https, { host: 'oauth2.googleapis.com', path: '/token', method: 'POST' })],
  ['raw socket to the metadata server', '169.254.169.254',
    () => socketOutcome(() => net.connect({ host: '169.254.169.254', port: 80 }))],
  ['raw socket to the metadata server, respelled', '169.254.169.254',
    () => socketOutcome(() => net.connect(80, '2852039166'))],
  ['raw TLS socket to Firebase Rules', 'firebaserules.googleapis.com',
    () => socketOutcome(() => tls.connect({ host: 'firebaserules.googleapis.com', port: 443, servername: 'firebaserules.googleapis.com' }))],
  ['dns.lookup of Firebase Authentication', 'identitytoolkit.googleapis.com',
    () => lookupOutcome('identitytoolkit.googleapis.com')],
  ['http.request through a local proxy to Cloud Firestore', 'firestore.googleapis.com',
    () => requestOutcome(http, { host: '127.0.0.1', port: proxyPort, path: 'http://firestore.googleapis.com/v1/projects/demo-canary' })],
  ['fetch from a worker thread to Cloud Storage', 'firebasestorage.googleapis.com',
    () => workerOutcome()],
];

const plants = [];
for (const [name, host, run] of PLANTS) {
  plants.push({ name, host, outcome: await withTimeout(run()) });
}
const local = { url: LOCAL_URL, outcome: await withTimeout(fetchOutcome(LOCAL_URL)) };
proxy.close();
console.log(JSON.stringify({ plants, local }));
process.exit(0);
