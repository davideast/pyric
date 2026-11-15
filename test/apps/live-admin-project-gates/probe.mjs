import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { initializeApp } from 'firebase-admin/app';
import { v1 } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const HOST = process.env.PROBE_HOST_PROJECT;
const OTHER = process.env.PROBE_OTHER_PROJECT;
const ORIGIN = process.env.PROBE_ORIGIN;
const PORT = Number(process.env.PROBE_PORT);
const OTHER_CONFIG_FILE = process.env.PROBE_OTHER_CONFIG_FILE;

const app = initializeApp({
  projectId: HOST,
  storageBucket: `${HOST}.appspot.com`,
});

const gapicClient = new v1.FirestoreClient({
  projectId: HOST,
  servicePath: '127.0.0.1',
  port: PORT,
  protocol: 'http',
  fallback: 'rest',
  auth: {
    getProjectId: async () => HOST,
    getRequestHeaders: async () => ({ Authorization: 'Bearer test-token' }),
    getUniverseDomain: async () => 'googleapis.com',
  },
});

const GetDocumentRequest = gapicClient._protos.lookupType('google.firestore.v1.GetDocumentRequest');

class CustomGapicRequest {
  constructor(name) {
    this.name = name;
  }
}

class BucketQueryOpts {
  constructor(project) {
    this.project = project;
  }
}

async function codeOf(promise) {
  try {
    await promise;
    return 'OK';
  } catch (err) {
    return String(err?.code ?? err?.message ?? err);
  }
}

const bucket = getStorage(app).bucket(`${HOST}.appspot.com`);
const storage = bucket.storage;
storage.retryOptions = { autoRetry: false };

function runAuthReq(opts) {
  return new Promise((resolveReq) => {
    storage.makeAuthenticatedRequest(opts, (err) => {
      resolveReq(err ? String(err.code ?? err.message) : 'OK');
    });
  });
}

function runStream(target, opts) {
  return new Promise((resolveStream) => {
    const stream = target.requestStream(opts);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolveStream(value);
    };
    stream.on('error', (err) => done(String(err?.code ?? err?.message ?? err)));
    stream.on('data', () => {});
    stream.on('end', () => done('OK'));
  });
}

const callOpts = { timeout: 2000, retry: null };
const nonEnumProto = {};
Object.defineProperty(nonEnumProto, 'name', {
  value: `projects/${OTHER}/databases/(default)/documents/items/1`,
  enumerable: false,
});
const gapic = {
  hostProto: await codeOf(
    gapicClient.getDocument(
      GetDocumentRequest.create({ name: `projects/${HOST}/databases/(default)/documents/items/1` }),
      callOpts,
    ),
  ),
  classOther: await codeOf(
    gapicClient.getDocument(
      new CustomGapicRequest(`projects/${OTHER}/databases/(default)/documents/items/1`),
      callOpts,
    ),
  ),
  nonEnumProtoOther: await codeOf(gapicClient.getDocument(Object.create(nonEnumProto), callOpts)),
  protoOther: await codeOf(
    gapicClient.getDocument(
      GetDocumentRequest.create({ name: `projects/${OTHER}/databases/(default)/documents/items/1` }),
      callOpts,
    ),
  ),
  protoNamedDb: await codeOf(
    gapicClient.getDocument(
      GetDocumentRequest.create({ name: `projects/${HOST}/databases/other-db/documents/items/1` }),
      callOpts,
    ),
  ),
};

const storageResults = {
  hostFiles: await codeOf(bucket.getFiles()),
  requestStreamOtherBucket: await runStream(storage, { uri: `/b/${OTHER}.appspot.com/o` }),
  projectsPathAuthReq: await runAuthReq({ uri: `${ORIGIN}/storage/v1/projects/${OTHER}/hmacKeys` }),
  queryProjectAuthReq: await runAuthReq({ uri: `${ORIGIN}/storage/v1/b?project=${OTHER}` }),
  qsBucketAuthReq: await runAuthReq({ uri: `${ORIGIN}/storage/v1/b`, qs: { bucket: `${OTHER}.appspot.com` } }),
  nonPlainGetBuckets: await codeOf(storage.getBuckets(new BucketQueryOpts(OTHER))),
  interceptorRewrite: await runStream(storage, {
    uri: '/b',
    interceptors_: [
      {
        request(reqOpts) {
          return { ...reqOpts, uri: `${ORIGIN}/storage/v1/b/${OTHER}.appspot.com/o` };
        },
      },
    ],
  }),
};

const configProbePath = resolve('config-probe.mjs');
const childRes = spawnSync(process.execPath, [configProbePath], {
  env: { ...process.env, FIREBASE_CONFIG: OTHER_CONFIG_FILE },
  encoding: 'utf8',
});

const workerRefused = await new Promise((resolveWorker) => {
  const worker = new Worker(pathToFileURL(configProbePath), {
    env: { ...process.env, FIREBASE_CONFIG: OTHER_CONFIG_FILE },
  });
  worker.once('message', () => resolveWorker(false));
  worker.once('error', (err) =>
    resolveWorker(err?.code === 'PYRIC_LIVE_REFUSED' || String(err).includes('PYRIC_LIVE_REFUSED')),
  );
});

const nestedConfig = {
  childExitedNonZero: childRes.status !== 0,
  childRefused: childRes.stderr.includes('PYRIC_LIVE_REFUSED'),
  workerRefused,
};

process.stdout.write(`RESULT ${JSON.stringify({ gapic, storage: storageResults, nestedConfig })}\n`);
