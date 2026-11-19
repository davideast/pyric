import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { OperationResult } from '../../../src/bridge/surface/types.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`;

const BOB_ONLY_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if request.auth != null && request.auth.uid == 'bob'; }
  }
}`;

const rawDir = process.argv[2] ?? '.';
const directory = realpathSync(rawDir);
const payload = {
  rules: null,
  rulesHash: null,
  storageRules: null,
  storageRulesHash: null,
  storageBucketRules: {
    'media-bucket': { rules: OPEN_RULES, rulesHash: 'media-hash' },
    'demo-app.appspot.com': { rules: BOB_ONLY_RULES, rulesHash: 'default-hash' },
  },
  bridgeUrl: null,
  seed: null,
  capture: false,
  hosted: true,
  projectKey: directory,
};

let reply: (response: OutboundMessage) => void = () => {};
function receive(frame: BridgeMessage): void {
  if (frame.type === 'worker-message-result') {
    reply(frame.message);
  }
}

const runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', receive, directory);
let sequence = 0;

async function request(message: Record<string, unknown>): Promise<OutboundMessage> {
  sequence += 1;
  const id = `op-${sequence}`;
  return await new Promise<OutboundMessage>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 5000);
    reply = (response) => {
      const isOwnReply = response.t === 'res' && response.id === id;
      if (!isOwnReply) return;
      clearTimeout(deadline);
      resolve(response);
    };
    runtime.receive({
      type: 'worker-message',
      clientSessionId: 'test-client',
      message: { t: 'op', id, ...message } as InboundMessage,
    });
  });
}

async function clientList(bucket?: string): Promise<string[]> {
  const opMessage: Record<string, unknown> = {
    method: 'storage.listAll',
    path: 'docs',
    actAs: { mode: 'admin' },
  };
  if (bucket !== undefined) {
    opMessage.bucket = bucket;
  }
  const response = await request(opMessage);
  assert.ok(response.t === 'res' && response.ok, JSON.stringify(response));
  const listing = response.value as { items: Array<{ fullPath: string }> };
  return listing.items.map((entry) => entry.fullPath).sort();
}

const connection = {};
function method(key: string, args: Record<string, unknown>): Promise<OperationResult> {
  return runtime.runMethod(
    { instanceId: runtime.instanceId, projectDir: directory, key, args, allowProduction: false },
    connection,
  );
}

try {
  // Register the client app's default storageBucket on the host.
  runtime.receive({
    type: 'worker-message',
    clientSessionId: 'test-client',
    message: {
      t: 'appConfig',
      options: { projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' },
    } as InboundMessage,
  });

  const encoded = Buffer.from('media-hosted').toString('base64');
  const uploaded = await method('storage.uploadBytes', {
    path: 'docs/media.txt',
    contentBase64: encoded,
    bucket: 'media-bucket',
  });
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  assert.equal(uploaded.summary, 'Uploaded docs/media.txt (12 bytes) on media-bucket');
  assert.deepEqual(await clientList('media-bucket'), ['docs/media.txt']);
  assert.deepEqual(await clientList(), []);

  // A gs:// URL selects the same named bucket and reports its real bucket name in metadata.
  const meta = await method('storage.getMetadata', {
    path: 'docs/media.txt',
    bucket: 'gs://media-bucket',
  });
  assert.equal(meta.ok, true, JSON.stringify(meta));
  assert.equal((meta.data as { metadata: { bucket: string } }).metadata.bucket, 'media-bucket');

  // The app's configured storageBucket and `default` select the default store.
  const defaultUpload = await method('storage.uploadBytes', {
    path: 'docs/default.txt',
    contentBase64: encoded,
    bucket: 'demo-app.appspot.com',
  });
  assert.equal(defaultUpload.ok, true, JSON.stringify(defaultUpload));
  assert.equal(defaultUpload.summary, 'Uploaded docs/default.txt (12 bytes)');
  assert.deepEqual(await clientList(), ['docs/default.txt']);

  const byKeyword = await method('storage.listAll', { prefix: 'docs', bucket: 'default' });
  assert.equal(byKeyword.ok, true);
  assert.equal(byKeyword.summary, '1 objects under docs');

  // An impersonated uid obeys per-bucket rules and sees undeployed buckets locked.
  assert.equal((await method('auth.createUser', { uid: 'alice', email: 'alice@example.com' })).ok, true);
  assert.equal((await method('auth.impersonate', { uid: 'alice' })).ok, true);

  const deniedDefault = await method('storage.uploadBytes', {
    path: 'docs/alice.txt',
    contentBase64: encoded,
  });
  assert.equal(deniedDefault.ok, false);
  assert.match(deniedDefault.summary, /storage\/unauthorized/);

  const allowedMedia = await method('storage.uploadBytes', {
    path: 'docs/alice.txt',
    contentBase64: encoded,
    bucket: 'gs://media-bucket/',
  });
  assert.equal(allowedMedia.ok, true, JSON.stringify(allowedMedia));

  const lockedArchive = await method('storage.uploadBytes', {
    path: 'docs/alice.txt',
    contentBase64: encoded,
    bucket: 'archive-bucket',
  });
  assert.equal(lockedArchive.ok, false);
  assert.match(lockedArchive.summary, /storage\/unauthorized/);

  const malformed = await method('storage.getBytes', {
    path: 'docs/media.txt',
    bucket: 'gs://media-bucket/docs/media.txt',
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.summary, /storage\/invalid-default-bucket/);
} finally {
  await runtime.close();
}

console.log('Hosted storage tool buckets passed');
