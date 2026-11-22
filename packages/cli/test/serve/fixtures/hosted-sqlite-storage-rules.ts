import assert from 'node:assert/strict';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } }
}`;

const directory = process.argv[2];
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory };
let reply: (response: OutboundMessage) => void = () => {};
function receive(frame: BridgeMessage) {
  const isReply = frame.type === 'worker-message-result';
  if (isReply) reply(frame.message);
}
const persistence = await createHostedPersistence(directory);
const runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', receive, directory, { persistence });
// A client list is evaluated against the read rules on the prefix.
async function list(id: string): Promise<OutboundMessage> {
  const message: InboundMessage = { t: 'op', id, method: 'storage.listAll', path: 'uploads' };
  return await new Promise<OutboundMessage>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 3000);
    reply = response => {
      const isEvent = response.t !== 'res';
      if (isEvent) return;
      clearTimeout(deadline);
      resolve(response);
    };
    runtime.receive({ type: 'worker-message', clientSessionId: 'test', message });
  });
}
const errorCode = (response: OutboundMessage): string | undefined =>
  response.t === 'res' && !response.ok ? response.error.code : undefined;
try {
  assert.equal(errorCode(await list('without-rules')), 'storage/unauthorized');
  await runtime.deployRules('storage', OPEN_RULES);
  const allowed = await list('with-rules');
  assert.equal(allowed.t === 'res' && allowed.ok, true);

  // Staged hosted SQLite upload populates md5Hash, big-endian crc32c, etag, and content headers for resource.* rules (#1342).
  const send = async (message: InboundMessage): Promise<OutboundMessage> =>
    await new Promise<OutboundMessage>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 3000);
      reply = response => {
        if (response.t !== 'res') return;
        clearTimeout(deadline);
        resolve(response);
      };
      runtime.receive({ type: 'worker-message', clientSessionId: 'test', message });
    });
  const begun = await send({
    t: 'op',
    id: 'begin-six',
    method: 'storage.beginUpload',
    path: 'uploads/six.bin',
    size: 6,
    contentType: 'application/octet-stream',
    metadata: {
      cacheControl: 'no-cache',
      contentDisposition: 'inline',
      contentEncoding: 'gzip',
      contentLanguage: 'en',
    },
  });
  assert.equal(begun.t === 'res' && begun.ok, true);
  if (begun.t !== 'res' || !begun.ok) {
    throw new Error('beginUpload failed');
  }
  const uploadId = (begun.value as { uploadId: string }).uploadId;
  await persistence.storage.appendUpload(uploadId, 0, new Uint8Array([1, 2, 3, 4, 5, 6]));
  const finished = await send({ t: 'op', id: 'finish-six', method: 'storage.finishUpload', uploadId });
  assert.equal(finished.t === 'res' && finished.ok, true);

  await runtime.deployRules('storage', `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/six.bin {
      allow get: if resource.md5Hash == 'asHla8ePAxBZvnvoVFIsTA=='
        && resource.crc32c == 'T037qw=='
        && resource.etag is string
        && resource.etag != ''
        && resource.cacheControl == 'no-cache'
        && resource.contentDisposition == 'inline'
        && resource.contentEncoding == 'gzip'
        && resource.contentLanguage == 'en'
        && request.auth.token is map
        && request.auth.token.size() == 0;
    }
  }
}`);
  const metaAllowed = await send({
    t: 'op',
    id: 'get-six',
    method: 'storage.getMetadata',
    path: 'uploads/six.bin',
    actAs: { mode: 'as', uid: 'alice' },
  });
  assert.equal(metaAllowed.t === 'res' && metaAllowed.ok, true);

  // Staged SQLite upload and metadata update under request.resource.{md5Hash,crc32c,etag} rules (#3258).
  await runtime.deployRules('storage', `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/verified-six.bin {
      allow create: if request.resource.md5Hash == 'asHla8ePAxBZvnvoVFIsTA=='
        && request.resource.crc32c == 'T037qw=='
        && request.resource.etag == null;
      allow update: if request.resource.md5Hash == resource.md5Hash
        && request.resource.crc32c == resource.crc32c
        && request.resource.etag is string
        && request.resource.etag == resource.etag;
    }
  }
}`);
  const begunVerified = await send({
    t: 'op',
    id: 'begin-verified',
    method: 'storage.beginUpload',
    path: 'uploads/verified-six.bin',
    size: 6,
    contentType: 'application/octet-stream',
  });
  assert.equal(begunVerified.t === 'res' && begunVerified.ok, true);
  if (begunVerified.t !== 'res' || !begunVerified.ok) {
    throw new Error('beginUpload verified failed');
  }
  const verifiedUploadId = (begunVerified.value as { uploadId: string }).uploadId;
  await persistence.storage.appendUpload(verifiedUploadId, 0, new Uint8Array([1, 2, 3, 4, 5, 6]));
  const finishedVerified = await send({
    t: 'op',
    id: 'finish-verified',
    method: 'storage.finishUpload',
    uploadId: verifiedUploadId,
  });
  assert.equal(finishedVerified.t === 'res' && finishedVerified.ok, true);

  const updatedVerified = await runtime.runMethod(
    {
      key: 'storage.updateMetadata',
      args: {
        path: 'uploads/verified-six.bin',
        metadata: { customMetadata: { stage: 'checked' } },
      },
      projectDir: directory,
    },
    {},
  );
  assert.equal(updatedVerified.ok, true);

  await runtime.deployRules('storage', null);
  assert.equal(errorCode(await list('rules-removed')), 'storage/unauthorized');
} finally {
  await runtime.close();
  persistence.close();
}
console.log('Hosted Storage rules reload passed');
