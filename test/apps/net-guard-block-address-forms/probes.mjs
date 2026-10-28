// Run as `node --import ./safety.mjs --import @pyric/cli/register probes.mjs`
// under PYRIC_GUARD=block. Each probe reaches for the GCE metadata server or a
// Firebase host in a way the guard has to recognize, and records the error
// code it got, or `permitted`. It prints one JSON line.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

const CLOSED_PORT = Number(process.env.SCENARIO_CLOSED_PORT);
const results = {};

/** Records one probe, and logs it so a hang names the last probe that finished. */
function record(name, value) {
  results[name] = value;
  process.stderr.write(`probe ${name}: ${value}\n`);
}

/** Answers every name with 127.0.0.1, so a permitted connect stays local. */
const localLookup = (_host, options, callback) => {
  if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};

/** The error code a synchronous connect throws, or `permitted`. */
function connectOutcome(connect) {
  try {
    const socket = connect();
    socket.on('error', () => {});
    socket.destroy();
    return 'permitted';
  } catch (error) {
    return error.code ?? String(error);
  }
}

/** The error code an http request fails with, or `permitted`. */
function requestOutcome(options) {
  return new Promise((resolve) => {
    try {
      const request = http.request({ timeout: 5_000, ...options });
      request.on('connect', (_response, socket) => { socket.destroy(); resolve('permitted'); });
      request.on('response', (response) => { response.resume(); resolve('permitted'); });
      request.on('timeout', () => { request.destroy(); resolve('timed out'); });
      request.on('error', (error) => resolve(error.code ?? String(error)));
      request.end();
    } catch (error) {
      resolve(error.code ?? String(error));
    }
  });
}

/** What a worker thread's connect to a catalog host got. */
function workerOutcome(source, options) {
  return new Promise((resolve) => {
    const worker = new Worker(source, options);
    worker.once('message', (message) => { resolve(message); void worker.terminate(); });
    worker.once('error', (error) => resolve(`worker error: ${error.message}`));
  });
}

// A local proxy: answers CONNECT and plain requests without going anywhere.
const proxy = http.createServer((_request, response) => response.end('proxy'));
proxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 200 Connection Established\r\n\r\n'));
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;

record('loopback control', await requestOutcome({ host: '127.0.0.1', port: proxyPort, path: '/' }));

for (const host of ['2852039166', '0xa9fea9fe', '169.254.43518', '0251.0376.0251.0376']) {
  record(`net.connect ${host}`, connectOutcome(() => net.connect({ host, port: 80, lookup: localLookup })));
}
for (const host of ['::ffff:169.254.169.254', '::ffff:a9fe:a9fe']) {
  record(`net.connect ${host}`, connectOutcome(() => net.connect({ host, port: 80 })));
}
record('http.request 2852039166', await requestOutcome({
  host: '2852039166',
  port: 80,
  path: '/computeMetadata/v1/',
  lookup: localLookup,
}));
record(
  'fetch http://[::ffff:169.254.169.254]/',
  await fetch('http://[::ffff:169.254.169.254]/computeMetadata/v1/', { signal: AbortSignal.timeout(5_000) })
    .then(() => 'permitted', (error) => error.cause?.code ?? error.message),
);

record('CONNECT firestore.googleapis.com:443', await requestOutcome({
  host: '127.0.0.1',
  port: proxyPort,
  method: 'CONNECT',
  path: 'firestore.googleapis.com:443',
}));
record('tls.connect servername over a tunnel', await new Promise((resolve) => {
  const tunnel = net.connect(proxyPort, '127.0.0.1', () => {
    resolve(connectOutcome(() => tls.connect({ socket: tunnel, servername: 'firestore.googleapis.com' })));
    tunnel.destroy();
  });
  tunnel.on('error', (error) => resolve(`tunnel error: ${error.code}`));
}));

const workerSource = readFileSync(new URL('./worker-probe.cjs', import.meta.url), 'utf8');
record('CommonJS eval worker', await workerOutcome(workerSource, { eval: true }));
record(
  'file worker with its own execArgv',
  await workerOutcome(new URL('./worker-probe.cjs', import.meta.url), { execArgv: [] }),
);

proxy.close();
const escaped = globalThis[Symbol.for('scenario.escaped')] ?? null;
console.log(JSON.stringify({ closedPort: CLOSED_PORT, results, escaped }));
process.exit(0);
