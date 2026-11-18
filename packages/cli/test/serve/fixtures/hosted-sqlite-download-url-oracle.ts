import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox, ref as ipRef, updateMetadata as ipUpdateMetadata } from 'pyric/storage';
import { installStorageBackend, replaceStorageRules } from 'pyric/storage/internal';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createStorageByteRoute } from '../../../src/serve/hosted/storage-byte-route.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { uploadTokenOf } from '../../../src/serve/worker/host/storage.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import { deleteObject, getBlob, getBytes, getDownloadURL, getMetadata, getStorage, listAll, ref, uploadBytes } from '../../../src/serve/worker/client/storage.js';

// The production observations, read from the conformance package beside the cli build.
function observation(name: string): Record<string, unknown> {
  const file = new URL(`../../../src/../../conformance/observations/storage/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { behavior: Record<string, unknown> }).behavior;
}

const root = process.argv[2];
const bucket = 'pyric-default';
const SESSION = 'session-token-for-the-page';

const persistence = await createHostedPersistence(join(root, 'project'));
const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
installStorageBackend(sandbox, persistence.storage);
await replaceStorageRules(sandbox, `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_oracle/{rest=**} { allow read, write: if true; }
  }
}`);
const ctx: HostCtx = { sandbox, db: getFirestore(sandbox), instanceId: 'download-url-oracle', subs: new Map(), storageByteRoute: true };
const route = createStorageByteRoute({ storage: persistence.storage, sessionToken: SESSION, uploadToken: id => uploadTokenOf(ctx, id) });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  void route(request, response, url).then(handled => { if (!handled) response.writeHead(404).end(); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

let clientPort: ClientPort;
const hostPort: PortLike = { postMessage(message: unknown) { queueMicrotask(() => clientPort.onmessage?.(new MessageEvent('message', { data: message }))); } };
clientPort = {
  onmessage: null, start() {}, close() {},
  postMessage(message: unknown) { void handleMessage(ctx, hostPort, message as InboundMessage); },
  byteRoute: { baseUrl: base, sessionToken: async () => SESSION },
};
wirePort(clientPort);
const storage = getStorage({ __kind: 'client-db', port: clientPort } as never);

try {
  // storage-upload-bytes-roundtrip: the probe's payload, uploaded, then fetched by its download URL.
  {
    const produced = observation('storage-upload-bytes-roundtrip');
    const payload = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63, 0x21]);
    assert.equal(payload.byteLength, produced.payloadLen);
    const target = ref(storage, 'pyric_oracle/upload-bytes/payload.bin');
    await uploadBytes(target, payload);
    const url = await getDownloadURL(target);
    // No header: the URL carries its own authority, as production's does.
    const response = await fetch(url);
    assert.equal(response.ok, produced.downloadOk);
    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(body.byteLength, produced.bodyLen);
    assert.equal(Buffer.from(body).equals(Buffer.from(payload)), produced.bytesMatch);
    // Production's URL is https on Google Cloud Storage's host. The host's is http on
    // its own origin, with production's /v0/b/<bucket>/o/<path> form and a download token.
    assert.equal(produced.urlIsHttps, true);
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'http:');
    assert.equal(parsed.origin, base);
    assert.equal(parsed.pathname, `/__pyric/storage/v0/b/${bucket}/o/${encodeURIComponent('pyric_oracle/upload-bytes/payload.bin')}`);
    assert.equal(parsed.searchParams.get('alt'), 'media');
    assert.match(parsed.searchParams.get('token') ?? '', /^[0-9a-f-]{36}$/);
  }

  // storage-delete-then-get-throws: getDownloadURL after a delete throws the production code.
  {
    const produced = observation('storage-delete-then-get-throws');
    const target = ref(storage, 'pyric_oracle/delete-then-get/soon-gone.bin');
    await uploadBytes(target, new Uint8Array([1, 2, 3]));
    await deleteObject(target);
    let code: string | undefined;
    try { await getDownloadURL(target); } catch (error) { code = (error as { code?: string }).code; }
    assert.equal(code !== undefined, produced.getUrlThrew);
    assert.equal(code, produced.code);
  }

  // client-storage-getblob-root-ref: getBlob(ref(storage)) throws synchronously before any route fetch.
  {
    const produced = observation('client-storage-getblob-root-ref');
    const browserRoot = produced.browserRootRef as {
      rootFullPath: string;
      rootName: string;
      threwSynchronously: boolean;
      code: string;
    };
    const rootRef = ref(storage);
    assert.equal(rootRef.fullPath, browserRoot.rootFullPath);
    assert.equal(rootRef.name, browserRoot.rootName);
    let threwSynchronously = false;
    let code: string | undefined;
    try {
      getBlob(rootRef).catch(() => {});
    } catch (error) {
      threwSynchronously = true;
      code = (error as { code?: string }).code;
    }
    assert.equal(threwSynchronously, browserRoot.threwSynchronously);
    assert.equal(code, browserRoot.code);
  }

  // storage-delete-then-getmetadata-throws: getMetadata reads stored metadata, then throws after deleteObject.
  {
    const produced = observation('storage-delete-then-getmetadata-throws');
    const beforeDelete = produced.beforeDelete as {
      size: number;
      contentType: string;
      customMetadata: Record<string, string>;
      hasGeneration: boolean;
      metageneration: string;
    };
    const afterDelete = produced.afterDeleteGetMetadata as {
      threw: boolean;
      code: string;
    };
    const target = ref(storage, 'pyric_oracle/delete-then-getmetadata/ephemeral.bin');
    await uploadBytes(target, new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]), {
      contentType: beforeDelete.contentType,
      customMetadata: beforeDelete.customMetadata,
    });
    const preMeta = await getMetadata(target);
    assert.equal(preMeta.size, beforeDelete.size);
    assert.equal(preMeta.contentType, beforeDelete.contentType);
    assert.deepEqual(preMeta.customMetadata, beforeDelete.customMetadata);
    assert.equal(preMeta.generation.length > 0, beforeDelete.hasGeneration);
    assert.equal(preMeta.metageneration, beforeDelete.metageneration);
    await deleteObject(target);
    assert.equal(produced.deleteCompleted, true);
    let code: string | undefined;
    try {
      await getMetadata(target);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert.equal(code !== undefined, afterDelete.threw);
    assert.equal(code, afterDelete.code);
  }

  // client-storage-uploadbytes-root-ref: uploadBytes(ref(storage), data) throws synchronously before any route fetch.
  {
    const produced = observation('client-storage-uploadbytes-root-ref');
    const rootRef = ref(storage);
    assert.equal(rootRef.fullPath, produced.rootFullPath);
    assert.equal(rootRef.name, produced.rootName);
    let threwSynchronously = false;
    let code: string | undefined;
    try {
      uploadBytes(rootRef, new Uint8Array([0x01])).catch(() => {});
    } catch (error) {
      threwSynchronously = true;
      code = (error as { code?: string }).code;
    }
    assert.equal(threwSynchronously, produced.threwSynchronously);
    assert.equal(code, produced.code);
  }

  // storage-uploadbytes-payload-types: Blob, Uint8Array, and ArrayBuffer round-trip over the hosted SQLite byte route.
  {
    const produced = observation('storage-uploadbytes-payload-types');
    const inputBytes = produced.inputBytes as number[];
    const raw = new Uint8Array(inputBytes);
    const padded = new ArrayBuffer(8);
    new Uint8Array(padded).set([99, 98, ...inputBytes, 97, 96]);
    const sliced = padded.slice(2, 6);

    const payloadCases = [
      { subpath: 'pyric_oracle/uploadbytes-payloads/from-blob.bin', data: new Blob([raw]), expected: produced.blobPayload as { metadataName: string; metadataSize: number; readBytes: number[] } },
      { subpath: 'pyric_oracle/uploadbytes-payloads/from-uint8array.bin', data: raw, expected: produced.uint8ArrayPayload as { metadataName: string; metadataSize: number; readBytes: number[] } },
      { subpath: 'pyric_oracle/uploadbytes-payloads/from-arraybuffer.bin', data: sliced, expected: produced.arrayBufferPayload as { metadataName: string; metadataSize: number; readBytes: number[] } },
    ];
    for (const item of payloadCases) {
      const target = ref(storage, item.subpath);
      const uploaded = await uploadBytes(target, item.data);
      const readBack = Array.from(new Uint8Array(await getBytes(target)));
      assert.equal(uploaded.ref.fullPath, target.fullPath);
      assert.equal(uploaded.metadata.fullPath, target.fullPath);
      assert.equal(uploaded.metadata.name, item.expected.metadataName);
      assert.equal(uploaded.metadata.bucket, bucket);
      assert.equal(uploaded.metadata.size, item.expected.metadataSize);
      assert.deepEqual(readBack, item.expected.readBytes);
    }
  }

  // storage-uploadbytes-contenttype-precedence + storage-uploadbytes-custom-metadata + storage-uploadbytes-overwrite-generations.
  {
    const ctObs = observation('storage-uploadbytes-contenttype-precedence');
    const ctRaw = new Uint8Array(ctObs.expectedBytes as number[]);
    const overrideExpected = ctObs.typedBlobCallerOverride as { uploadContentType: string; storedContentType: string; size: number; readBytes: number[] };
    const emptyExpected = ctObs.emptyBlobNoHint as { uploadContentType: string; storedContentType: string; size: number; readBytes: number[] };

    const emptyTarget = ref(storage, 'pyric_oracle/uploadbytes-ct/empty-blob.bin');
    const emptyUp = await uploadBytes(emptyTarget, new Blob([ctRaw]));
    assert.equal(emptyUp.metadata.contentType, emptyExpected.uploadContentType);
    assert.equal((await getMetadata(emptyTarget)).contentType, emptyExpected.storedContentType);

    const overrideTarget = ref(storage, 'pyric_oracle/uploadbytes-ct/override.pdf');
    const overrideUp = await uploadBytes(overrideTarget, new Blob([ctRaw], { type: 'image/png' }), { contentType: 'application/pdf' });
    assert.equal(overrideUp.metadata.contentType, overrideExpected.uploadContentType);
    assert.equal((await getMetadata(overrideTarget)).contentType, overrideExpected.storedContentType);
    assert.deepEqual(Array.from(new Uint8Array(await getBytes(overrideTarget))), overrideExpected.readBytes);

    const customObs = observation('storage-uploadbytes-custom-metadata');
    const withoutExpected = customObs.withoutCustomMetadata as { uploadHasCustomMetadataProperty: boolean };
    const withExpected = customObs.withCustomMetadata as { uploadHasCustomMetadataProperty: boolean; uploadCustomMetadata: Record<string, string> };

    const plainTarget = ref(storage, 'pyric_oracle/uploadbytes-meta/plain.bin');
    const plainUp = await uploadBytes(plainTarget, new Uint8Array([1, 2, 3, 4]));
    assert.equal('customMetadata' in plainUp.metadata, withoutExpected.uploadHasCustomMetadataProperty);
    assert.equal('customMetadata' in (await getMetadata(plainTarget)), withoutExpected.uploadHasCustomMetadataProperty);

    const richTarget = ref(storage, 'pyric_oracle/uploadbytes-meta/rich.bin');
    const richUp = await uploadBytes(richTarget, new Uint8Array([1, 2, 3, 4]), { customMetadata: withExpected.uploadCustomMetadata });
    assert.equal('customMetadata' in richUp.metadata, withExpected.uploadHasCustomMetadataProperty);
    assert.deepEqual(richUp.metadata.customMetadata, withExpected.uploadCustomMetadata);
    assert.deepEqual((await getMetadata(richTarget)).customMetadata, withExpected.uploadCustomMetadata);

    const overwriteObs = observation('storage-uploadbytes-overwrite-generations');
    const firstExpected = overwriteObs.firstUpload as { contentType: string; customMetadata: Record<string, string>; metageneration: string };
    const secondExpected = overwriteObs.secondUpload as { contentType: string; customMetadata: Record<string, string>; metageneration: string };
    const overwriteTarget = ref(storage, 'pyric_oracle/uploadbytes-overwrite/versioned.bin');
    const first = await uploadBytes(overwriteTarget, new Uint8Array([1, 2, 3, 4, 5, 6, 7]), { contentType: firstExpected.contentType, customMetadata: firstExpected.customMetadata });
    const second = await uploadBytes(overwriteTarget, new Uint8Array(overwriteObs.afterOverwriteReadBytes as number[]), { contentType: secondExpected.contentType, customMetadata: secondExpected.customMetadata });
    assert.equal(first.metadata.metageneration, firstExpected.metageneration);
    assert.equal(second.metadata.metageneration, secondExpected.metageneration);
    assert.equal(BigInt(second.metadata.generation) > BigInt(first.metadata.generation), overwriteObs.generationStrictlyIncreased);
    assert.deepEqual(Array.from(new Uint8Array(await getBytes(overwriteTarget))), overwriteObs.afterOverwriteReadBytes);
    assert.deepEqual((await getMetadata(overwriteTarget)).customMetadata, secondExpected.customMetadata);
  }

  // client-storage-ref-root-and-segments + hierarchy + identity on the Node-hosted client.
  {
    const rootObs = observation('client-storage-ref-root-and-segments');
    const bareExpected = rootObs.bareRoot as { fullPath: string; name: string; rootStrictEqualSelf: boolean; rootToStringMatchesSelf: boolean };
    const bareRoot = ref(storage);
    assert.equal(bareRoot.fullPath, bareExpected.fullPath);
    assert.equal(bareRoot.name, bareExpected.name);
    assert.equal(bareRoot.root === bareRoot, bareExpected.rootStrictEqualSelf);
    assert.equal(bareRoot.root.toString() === bareRoot.toString(), bareExpected.rootToStringMatchesSelf);

    const hierObs = observation('client-storage-ref-hierarchy-and-traversal');
    const emptyJoinExpected = hierObs.emptyChildJoin as { fullPath: string; name: string; parentFullPath: string };
    const emptyChild = ref(ref(storage, 'users/u1'), '');
    assert.equal(emptyChild.fullPath, emptyJoinExpected.fullPath);
    assert.equal(emptyChild.name, emptyJoinExpected.name);
    assert.equal(emptyChild.parent?.fullPath, emptyJoinExpected.parentFullPath);

    const idObs = observation('client-storage-ref-identity-and-storage-handle');
    const firstSame = ref(storage, 'a/b');
    const secondSame = ref(storage, 'a/b');
    assert.equal(firstSame === secondSame, idObs.samePathStrictEqual);
    assert.equal(firstSame.storage === storage, idObs.directPreservesStorageHandle);
    assert.equal(firstSame.root.storage === storage, idObs.rootPreservesStorageHandle);
  }

  // storage-listall-empty-and-result-shape + hierarchy + lexicographic-order + rules-enforcement on hosted SQLite.
  {
    const shapeObs = observation('storage-listall-empty-and-result-shape');
    const emptyExpected = shapeObs.emptyDirectory as { itemCount: number; prefixCount: number; hasNextPageTokenOwnProperty: boolean };
    const emptyRes = await listAll(ref(storage, 'pyric_oracle/listall-empty'));
    assert.equal(emptyRes.items.length, emptyExpected.itemCount);
    assert.equal(emptyRes.prefixes.length, emptyExpected.prefixCount);
    assert.equal('nextPageToken' in emptyRes, emptyExpected.hasNextPageTokenOwnProperty);

    const hierObs = observation('storage-listall-hierarchy-dedup-and-self-exclusion');
    for (const sub of ['scan-tree', 'scan-tree/direct-two.bin', 'scan-tree/direct-one.bin', 'scan-tree/shared-folder/part-a.bin', 'scan-tree/shared-folder/part-b.bin', 'scan-tree/deep-folder/nested/grandchild.bin']) {
      await uploadBytes(ref(storage, `pyric_oracle/listall-hier/${sub}`), new Uint8Array([0x41]));
    }
    const hierRes = await listAll(ref(storage, 'pyric_oracle/listall-hier/scan-tree'));
    assert.deepEqual(hierRes.items.map(i => i.name), hierObs.itemNames);
    assert.deepEqual(hierRes.prefixes.map(p => p.name), hierObs.prefixNames);

    const orderObs = observation('storage-listall-lexicographic-order');
    for (const itemName of orderObs.uploadedItemOrder as string[]) {
      await uploadBytes(ref(storage, `pyric_oracle/listall-order/${itemName}`), new Uint8Array([0x01]));
    }
    for (const prefixName of orderObs.uploadedPrefixOrder as string[]) {
      await uploadBytes(ref(storage, `pyric_oracle/listall-order/${prefixName}/leaf.bin`), new Uint8Array([0x01]));
    }
    const orderRes = await listAll(ref(storage, 'pyric_oracle/listall-order'));
    assert.deepEqual(orderRes.items.map(i => i.name), orderObs.observedItemNames);
    assert.deepEqual(orderRes.prefixes.map(p => p.name), orderObs.observedPrefixNames);

    const rulesObs = observation('storage-listall-rules-enforcement');
    const outsideExpected = rulesObs.authenticatedOutsideGrant as { threw: boolean; code: string };
    let deniedCode: string | undefined;
    try {
      await listAll(ref(storage, 'pyric_oracle_denied_list/forbidden-dir'));
    } catch (error) {
      deniedCode = (error as { code?: string }).code;
    }
    assert.equal(deniedCode !== undefined, outsideExpected.threw);
    assert.equal(deniedCode, outsideExpected.code);
  }

  // getMetadata + updateMetadata observations (storage#79..85, #87, #88) on hosted SQLite.
  {
    const sqliteDirect = getStorageSandbox(sandbox);
    const getRootObs = observation('client-storage-getmetadata-root-ref');
    const updateRootObs = observation('client-storage-updatemetadata-root-ref');

    let getRootSync = false;
    let getRootCode: string | undefined;
    try {
      void getMetadata(ref(storage));
    } catch (error) {
      getRootSync = true;
      getRootCode = (error as { code?: string }).code;
    }
    assert.equal(getRootSync, getRootObs.threwSynchronously);
    assert.equal(getRootCode, getRootObs.code);

    let updateRootSync = false;
    let updateRootCode: string | undefined;
    try {
      void ipUpdateMetadata(ipRef(sqliteDirect), { contentType: 'text/plain' });
    } catch (error) {
      updateRootSync = true;
      updateRootCode = (error as { code?: string }).code;
    }
    assert.equal(updateRootSync, updateRootObs.threwSynchronously);
    assert.equal(updateRootCode, updateRootObs.code);

    const shapeObs = observation('storage-getmetadata-full-shape');
    const upShape = shapeObs.uploadedShape as {
      name: string;
      size: number;
      metageneration: string;
      contentType: string;
      cacheControl: string;
      contentDisposition: string;
      contentEncoding: string;
      contentLanguage: string;
      customMetadata: Record<string, string>;
    };
    const fetchedShape = shapeObs.fetchedShape as typeof upShape & {
      generationMatchesUpload: boolean;
      timeCreatedMatchesUpload: boolean;
      updatedMatchesUpload: boolean;
    };
    const shapeTarget = ref(storage, 'pyric_oracle/metadata-full-shape/doc.json');
    const shapeUp = await uploadBytes(shapeTarget, new Uint8Array([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x31, 0x7d]), {
      contentType: upShape.contentType,
      cacheControl: upShape.cacheControl,
      contentDisposition: upShape.contentDisposition,
      contentEncoding: upShape.contentEncoding,
      contentLanguage: upShape.contentLanguage,
      customMetadata: upShape.customMetadata,
    });
    const shapeGot = await getMetadata(shapeTarget);
    assert.equal(shapeGot.name, fetchedShape.name);
    assert.equal(shapeGot.size, fetchedShape.size);
    assert.equal(shapeGot.metageneration, fetchedShape.metageneration);
    assert.equal(shapeGot.contentType, fetchedShape.contentType);
    assert.equal(shapeGot.cacheControl, fetchedShape.cacheControl);
    assert.equal(shapeGot.contentDisposition, fetchedShape.contentDisposition);
    assert.equal(shapeGot.contentEncoding, fetchedShape.contentEncoding);
    assert.equal(shapeGot.contentLanguage, fetchedShape.contentLanguage);
    assert.deepEqual(shapeGot.customMetadata, fetchedShape.customMetadata);
    assert.equal(shapeGot.generation === shapeUp.metadata.generation, fetchedShape.generationMatchesUpload);
    assert.equal(shapeGot.timeCreated === shapeUp.metadata.timeCreated, fetchedShape.timeCreatedMatchesUpload);
    assert.equal(shapeGot.updated === shapeUp.metadata.updated, fetchedShape.updatedMatchesUpload);

    const missingObs = observation('storage-metadata-missing-object-errors');
    const getMissingExp = missingObs.getMetadataMissing as { threw: boolean; code: string };
    const updMissingExp = missingObs.updateMetadataMissing as { threw: boolean; code: string };
    let missingGetCode: string | undefined;
    try {
      await getMetadata(ref(storage, 'pyric_oracle/metadata-missing/absent.bin'));
    } catch (error) {
      missingGetCode = (error as { code?: string }).code;
    }
    assert.equal(missingGetCode !== undefined, getMissingExp.threw);
    assert.equal(missingGetCode, getMissingExp.code);

    let missingUpdCode: string | undefined;
    try {
      await ipUpdateMetadata(ipRef(sqliteDirect, 'pyric_oracle/metadata-missing/absent.bin'), { contentType: 'text/plain' });
    } catch (error) {
      missingUpdCode = (error as { code?: string }).code;
    }
    assert.equal(missingUpdCode !== undefined, updMissingExp.threw);
    assert.equal(missingUpdCode, updMissingExp.code);

    const fieldsObs = observation('storage-updatemetadata-fields-and-bytes');
    const beforeExp = fieldsObs.beforeUpdate as {
      contentType: string;
      cacheControl: string;
      contentDisposition: string;
      contentEncoding: string;
      contentLanguage: string;
      customMetadata: Record<string, string>;
    };
    const afterExp = fieldsObs.afterGetMetadata as typeof beforeExp;
    const fieldsPath = 'pyric_oracle/metadata-fields/item.bin';
    await uploadBytes(ref(storage, fieldsPath), new Uint8Array(fieldsObs.initialBytes as number[]), beforeExp);
    await ipUpdateMetadata(ipRef(sqliteDirect, fieldsPath), {
      contentType: afterExp.contentType,
      cacheControl: afterExp.cacheControl,
      contentDisposition: afterExp.contentDisposition,
      contentEncoding: afterExp.contentEncoding,
      contentLanguage: afterExp.contentLanguage,
      customMetadata: { k2: 'v2-next', k3: 'v3' },
    });
    const afterMeta = await getMetadata(ref(storage, fieldsPath));
    assert.deepEqual(afterMeta.customMetadata, afterExp.customMetadata);
    assert.equal(afterMeta.contentLanguage, afterExp.contentLanguage);
    assert.deepEqual(Array.from(new Uint8Array(await getBytes(ref(storage, fieldsPath)))), fieldsObs.afterReadBytes);

    const verObs = observation('storage-updatemetadata-versioning-and-timestamps');
    const verPath = 'pyric_oracle/metadata-ver/item.bin';
    const v0 = await uploadBytes(ref(storage, verPath), new Uint8Array([1, 2, 3, 4]), { contentType: 'text/plain' });
    await new Promise(resolve => setTimeout(resolve, 5));
    const v1 = await ipUpdateMetadata(ipRef(sqliteDirect, verPath), { customMetadata: { step: '1' } });
    await new Promise(resolve => setTimeout(resolve, 5));
    await ipUpdateMetadata(ipRef(sqliteDirect, verPath), { customMetadata: { step: '2' } });
    const v2 = await getMetadata(ref(storage, verPath));
    assert.equal(v0.metadata.metageneration, verObs.initialMetageneration);
    assert.equal(v1.metageneration, verObs.firstUpdateMetageneration);
    assert.equal(v2.metageneration, verObs.secondUpdateMetageneration);
    assert.equal(v2.generation === v0.metadata.generation, verObs.generationPinnedAcrossUpdates);
    assert.equal(v2.timeCreated === v0.metadata.timeCreated, verObs.timeCreatedPinnedAcrossUpdates);
    assert.equal(Date.parse(v2.updated) > Date.parse(v0.metadata.updated), verObs.secondUpdatedStrictlyAfterInitialUpdated);
  }
} finally {
  server.close();
  sandbox.dispose();
  persistence.close();
}

console.log('Download URL oracle replay passed');
