// Probes for the recorder's own test, run with NODE_OPTIONS
// `--import sink-preload.mjs --import node-egress.mjs`. Each probe reaches a
// Google host or the metadata server one way and records what it got. Prints
// one JSON line: { outcomes: { [probe]: outcome }, workers: { [kind]: boolean } }.
import dns from 'node:dns';
import { lookup as namedLookup } from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { Worker } from 'node:worker_threads';

const code = (error) => error?.cause?.code ?? error?.code ?? String(error);

function settle(start) {
  return new Promise((resolve) => {
    try {
      start(resolve);
    } catch (error) {
      resolve(code(error));
    }
  });
}

const socket = (connect) => settle((resolve) => {
  const s = connect();
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', (error) => resolve(code(error)));
});

const request = (options) => settle((resolve) => {
  const r = http.request(options);
  r.once('response', (response) => { response.resume(); resolve('responded'); });
  r.once('error', (error) => resolve(code(error)));
  r.end();
});

const outcomes = {
  'fetch firestore.googleapis.com': await fetch('https://firestore.googleapis.com/v1/x').then(() => 'responded', code),
  'http.request metadata.google.internal': await request({ host: 'metadata.google.internal', path: '/computeMetadata/v1/' }),
  'net.connect 169.254.169.254': await socket(() => net.connect({ host: '169.254.169.254', port: 80 })),
  'net.connect 0xa9fea9fe': await socket(() => net.connect(80, '0xa9fea9fe')),
  'tls.connect through a tunnel to firebaserules.googleapis.com': await socket(() => tls.connect({ host: '127.0.0.1', port: 9, servername: 'firebaserules.googleapis.com' })),
  'dns.lookup oauth2.googleapis.com': await settle((resolve) => dns.lookup('oauth2.googleapis.com', (error) => resolve(error ? code(error) : 'resolved'))),
  'named lookup identitytoolkit.googleapis.com': await settle((resolve) => namedLookup('identitytoolkit.googleapis.com', (error) => resolve(error ? code(error) : 'resolved'))),
  'dns.promises.resolve4 firebaseio.com': await dns.promises.resolve4('firebaseio.com').then(() => 'resolved', code),
};

function workerHasRecorder(source, options) {
  return new Promise((resolve) => {
    const worker = new Worker(source, options);
    worker.once('message', (message) => { resolve(message); void worker.terminate(); });
    worker.once('error', (error) => resolve(String(error)));
  });
}

const REPORT_CJS = `require('node:worker_threads').parentPort.postMessage(globalThis[Symbol.for('pyric.builders.node-egress')] === true);`;
const REPORT_ESM = `import { parentPort } from 'node:worker_threads'; parentPort.postMessage(globalThis[Symbol.for('pyric.builders.node-egress')] === true);`;

const workers = {
  'CommonJS eval': await workerHasRecorder(REPORT_CJS, { eval: true }),
  'own execArgv': await workerHasRecorder(new URL(`data:text/javascript,${encodeURIComponent(REPORT_ESM)}`), { execArgv: [] }),
};

console.log(JSON.stringify({ outcomes, workers }));
