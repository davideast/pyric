import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { FirebaseError } from 'pyric/app';
import { getAuth, signInAnonymously, signOut } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import * as ip from 'pyric/storage';
import { installStorageBackend, replaceStorageRules } from 'pyric/storage/internal';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createStorageByteRoute } from '../../../src/serve/hosted/storage-byte-route.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { uploadTokenOf } from '../../../src/serve/worker/host/storage.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import {
  getAuth as getClientAuth,
  signInAnonymously as signInClientAnonymously,
  signOut as signOutClient,
} from '../../../src/serve/worker/client/auth.js';
import {
  deleteObject,
  getBytes,
  getMetadata,
  getStorage,
  listAll,
  ref,
  uploadBytes,
} from '../../../src/serve/worker/client/storage.js';

function observation(name: string): Record<string, unknown> {
  const file = new URL(
    `../../../src/../../conformance/observations/storage/${name}.json`,
    import.meta.url,
  );
  return (JSON.parse(readFileSync(file, 'utf8')) as { behavior: Record<string, unknown> }).behavior;
}

async function captureClientError(runOp: () => Promise<unknown>) {
  try {
    await runOp();
    return {
      threw: false,
      code: null,
      errorName: null,
      isFirebaseError: false,
    };
  } catch (err) {
    let code: string | null = null;
    let errorName: string | null = null;
    const rawCode = (err as { code?: unknown }).code;
    const rawName = (err as { name?: unknown }).name;
    if (typeof rawCode === 'string') code = rawCode;
    if (typeof rawName === 'string') errorName = rawName;
    return {
      threw: true,
      code,
      errorName,
      isFirebaseError: err instanceof FirebaseError,
    };
  }
}

function isSortedByCodeUnits(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1];
    const curr = values[i];
    if (prev !== undefined && curr !== undefined && prev > curr) {
      return false;
    }
  }
  return true;
}

const rawRootArg = process.argv[2] ?? '.';
const SESSION = 'session-token-s9-oracle';

const persistence = await createHostedPersistence(join(rawRootArg, 'project'));
const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
installStorageBackend(sandbox, persistence.storage);
await replaceStorageRules(
  sandbox,
  `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow list: if request.auth != null;
    }
    match /pyric_oracle/{run}/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
    match /pyric_oracle_root_r1.bin {
      allow read, write: if request.auth != null;
    }
    match /pyric_oracle_root_r1/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
    match /pyric_oracle_root_r1-dash/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`,
);

const hostAuth = getAuth(sandbox);
await signInAnonymously(hostAuth);

const ctx: HostCtx = {
  sandbox,
  db: getFirestore(sandbox),
  instanceId: 's9-delete-listall-rules-oracle',
  subs: new Map(),
  storageByteRoute: true,
};
const route = createStorageByteRoute({
  storage: persistence.storage,
  sessionToken: SESSION,
  uploadToken: (id) => uploadTokenOf(ctx, id),
});
const server = createServer((request, response) => {
  const rawUrl = request.url ?? '/';
  const parsedUrl = new URL(rawUrl, 'http://localhost');
  void route(request, response, parsedUrl).then((handled) => {
    if (!handled) {
      response.writeHead(404).end();
    }
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

let clientPort: ClientPort;
const hostPort: PortLike = {
  postMessage(message: unknown) {
    queueMicrotask(() => clientPort.onmessage?.(new MessageEvent('message', { data: message })));
  },
};
clientPort = {
  onmessage: null,
  start() {},
  close() {},
  postMessage(message: unknown) {
    void handleMessage(ctx, hostPort, message as InboundMessage);
  },
  byteRoute: { baseUrl: base, sessionToken: async () => SESSION },
};
wirePort(clientPort);
const clientDb = { __kind: 'client-db', port: clientPort } as never;
const clientAuth = getClientAuth(clientDb);
await signInClientAnonymously(clientAuth);
const storage = getStorage(clientDb);

try {
  // client-storage-deleteobject-root-ref
  {
    const produced = observation('client-storage-deleteobject-root-ref');
    const rootRef = ref(storage);
    assert.equal(rootRef.fullPath, produced.rootFullPath);
    assert.equal(rootRef.name, produced.rootName);
    let threwSynchronously = false;
    let code: string | undefined;
    try {
      void deleteObject(rootRef);
    } catch (err) {
      threwSynchronously = true;
      code = (err as { code?: string }).code;
    }
    assert.equal(threwSynchronously, produced.threwSynchronously);
    assert.equal(code, produced.code);
  }

  // storage-deleteobject-removes-bytes-and-metadata
  {
    const produced = observation('storage-deleteobject-removes-bytes-and-metadata');
    const targetRef = ref(storage, 'pyric_oracle/run-1/delete-atomic/item.bin');
    await uploadBytes(targetRef, new Uint8Array([16, 32, 48, 64]), {
      contentType: 'application/octet-stream',
      customMetadata: { tag: 'ephemeral' },
    });
    const beforeBuf = await getBytes(targetRef);
    const beforeMeta = await getMetadata(targetRef);
    assert.deepEqual(
      {
        threw: false,
        code: null,
        errorName: null,
        isFirebaseError: false,
        byteLength: beforeBuf.byteLength,
        bytes: [...new Uint8Array(beforeBuf)],
      },
      produced.beforeDeleteBytes,
    );
    assert.deepEqual(
      {
        threw: false,
        code: null,
        errorName: null,
        isFirebaseError: false,
        size: beforeMeta.size,
        contentType: beforeMeta.contentType ?? null,
        customMetadata: beforeMeta.customMetadata ?? null,
      },
      produced.beforeDeleteMetadata,
    );
    const deleteOut = await deleteObject(targetRef);
    assert.equal(deleteOut === undefined, produced.deleteResolvedUndefined);

    const afterBytesErr = await captureClientError(() => getBytes(targetRef));
    assert.deepEqual({ ...afterBytesErr, byteLength: null, bytes: null }, produced.afterDeleteBytes);

    const afterMetaErr = await captureClientError(() => getMetadata(targetRef));
    assert.deepEqual(
      { ...afterMetaErr, size: null, contentType: null, customMetadata: null },
      produced.afterDeleteMetadata,
    );
  }

  // storage-delete-missing-throws
  {
    const produced = observation('storage-delete-missing-throws');
    const expected = {
      threw: produced.threw,
      code: produced.code,
      errorName: produced.errorName,
      isFirebaseError: produced.isFirebaseError,
    };
    const missingRef = ref(storage, 'pyric_oracle/run-1/delete-missing/never-existed.bin');
    assert.deepEqual(await captureClientError(() => deleteObject(missingRef)), expected);

    const onceRef = ref(storage, 'pyric_oracle/run-1/delete-missing/once.bin');
    await uploadBytes(onceRef, new Uint8Array([7, 8, 9]));
    await deleteObject(onceRef);
    assert.deepEqual(await captureClientError(() => deleteObject(onceRef)), expected);
  }

  // storage-listall-root-ref
  {
    const produced = observation('storage-listall-root-ref');
    const rootItemName = 'pyric_oracle_root_r1.bin';
    const rootPrefixName = 'pyric_oracle_root_r1';
    const nestedChildFullPath = 'pyric_oracle_root_r1/nested/child.bin';
    await uploadBytes(ref(storage, rootItemName), new Uint8Array([0x41]));
    await uploadBytes(ref(storage, nestedChildFullPath), new Uint8Array([0x42, 0x43]));
    await uploadBytes(
      ref(storage, 'pyric_oracle_root_r1-dash/nested/child.bin'),
      new Uint8Array([0x44]),
    );

    const rootRef = ref(storage);
    const rootRes = await listAll(rootRef);
    const rootObserved = {
      rootFullPath: rootRef.fullPath,
      rootName: rootRef.name,
      rootParentIsNull: rootRef.parent === null,
      containsSeededRootItem: rootRes.items.some(
        (item) =>
          item.fullPath === rootItemName &&
          item.name === rootItemName &&
          item.parent !== null &&
          item.parent.fullPath === '',
      ),
      containsSeededRootPrefix: rootRes.prefixes.some(
        (prefix) =>
          prefix.fullPath === rootPrefixName &&
          prefix.name === rootPrefixName &&
          prefix.parent !== null &&
          prefix.parent.fullPath === '',
      ),
      nestedChildExcludedFromRootItems: !rootRes.items.some(
        (item) => item.fullPath === nestedChildFullPath || item.fullPath.includes('/'),
      ),
      itemsSortedLexicographically: isSortedByCodeUnits(rootRes.items.map((item) => item.fullPath)),
      prefixesSortedLexicographically: isSortedByCodeUnits(
        rootRes.prefixes.map((prefix) => prefix.fullPath),
      ),
      nextPageTokenIsUndefined: rootRes.nextPageToken === undefined,
    };
    assert.deepEqual(rootObserved, produced);
  }

  // storage-rules-canonical-bucket-namespace
  {
    const produced = observation('storage-rules-canonical-bucket-namespace');
    const ordinaryPath = 'pyric_oracle/<runId>/namespace-mapping/item.txt';
    const ordinaryRef = ref(storage, ordinaryPath);
    const uploaded = await uploadBytes(ordinaryRef, new Uint8Array([111, 107]), {
      contentType: 'text/plain',
    });
    const fetched = await getMetadata(ordinaryRef);
    assert.deepEqual(
      {
        refFullPath: ordinaryRef.fullPath,
        uploadMetadataFullPath: uploaded.metadata.fullPath,
        fetchedMetadataFullPath: fetched.fullPath,
        fetchedMetadataName: fetched.name,
        startsWithCanonicalBucketPrefix: fetched.fullPath.startsWith('b/'),
        metadataMatchesRefFullPath: fetched.fullPath === ordinaryRef.fullPath,
      },
      produced.ordinaryObjectPath,
    );

    const prefixedRef = ref(storage, `/b/pyric-default/o/${ordinaryPath}`);
    const prefixedErr = await captureClientError(() =>
      uploadBytes(prefixedRef, new Uint8Array([111, 107])),
    );
    assert.deepEqual(
      {
        normalizedRefStartsWithB: prefixedRef.fullPath.startsWith('b/pyric-default/o/'),
        uploadThrew: prefixedErr.threw,
        uploadCode: prefixedErr.code,
        uploadIsFirebaseError: prefixedErr.isFirebaseError,
      },
      produced.explicitRulesPrefixPath,
    );
  }

  // storage-rules-denied-metadata-and-delete
  {
    const produced = observation('storage-rules-denied-metadata-and-delete');
    const ipStorage = ip.getStorageSandbox(sandbox);
    const protectedRef = ref(storage, 'pyric_oracle/run-1/denied-ops/protected.txt');
    const outsideRef = ref(storage, 'pyric_oracle_denied_ops/run-1/forbidden.txt');
    await uploadBytes(protectedRef, new Uint8Array([104, 101, 108, 108, 111]), {
      contentType: 'text/plain',
      customMetadata: { stage: 'initial' },
    });

    assert.deepEqual(await captureClientError(() => getMetadata(outsideRef)), produced.getMetadataOutsideGrant);
    const updateOutsideErr = await captureClientError(() =>
      ip.updateMetadata(ip.ref(ipStorage, 'pyric_oracle_denied_ops/run-1/forbidden.txt'), {
        customMetadata: { stage: 'mutated' },
      }),
    );
    assert.deepEqual(
      { threw: updateOutsideErr.threw, code: updateOutsideErr.code },
      {
        threw: (produced.updateMetadataOutsideGrant as { threw: boolean }).threw,
        code: (produced.updateMetadataOutsideGrant as { code: string }).code,
      },
    );
    assert.deepEqual(await captureClientError(() => deleteObject(outsideRef)), produced.deleteObjectOutsideGrant);

    await signOutClient(clientAuth);
    await signOut(hostAuth);
    assert.deepEqual(
      await captureClientError(() => getMetadata(protectedRef)),
      produced.getMetadataSignedOutExisting,
    );
    const updateSignedOutErr = await captureClientError(() =>
      ip.updateMetadata(ip.ref(ipStorage, 'pyric_oracle/run-1/denied-ops/protected.txt'), {
        customMetadata: { stage: 'mutated' },
      }),
    );
    assert.deepEqual(
      { threw: updateSignedOutErr.threw, code: updateSignedOutErr.code },
      {
        threw: (produced.updateMetadataSignedOutExisting as { threw: boolean }).threw,
        code: (produced.updateMetadataSignedOutExisting as { code: string }).code,
      },
    );
    assert.deepEqual(
      await captureClientError(() => deleteObject(protectedRef)),
      produced.deleteObjectSignedOutExisting,
    );

    await signInClientAnonymously(clientAuth);
    await signInAnonymously(hostAuth);
    const preserved = await getMetadata(protectedRef);
    assert.deepEqual(
      {
        size: preserved.size,
        customMetadata: preserved.customMetadata ?? null,
      },
      produced.existingPreservedAfterDenials,
    );
  }
} finally {
  server.close();
  sandbox.dispose();
  persistence.close();
}

console.log('Delete, listAll root, and rules oracle replay passed');
