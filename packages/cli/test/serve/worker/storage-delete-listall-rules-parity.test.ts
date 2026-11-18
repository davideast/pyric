/**
 * Served-entry + SharedWorker conformance for `deleteObject`, root `listAll`,
 * and Storage Security Rules enforcement (`storage#63, #65, #75, #106..109`).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp, FirebaseError } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as ip from 'pyric/storage';
import { replaceStorageRules } from 'pyric/storage/internal';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

function loadBehavior(name: string): Record<string, unknown> {
  const fileUrl = new URL(
    `../../../../conformance/observations/storage/${name}.json`,
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(fileUrl, 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return parsed.behavior;
}

interface DeniedOutcome {
  threw: boolean;
  code: string | null;
  errorName: string | null;
  isFirebaseError: boolean;
}

async function captureServedError(runOp: () => Promise<unknown>): Promise<DeniedOutcome> {
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
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
    if (typeof rawName === 'string') {
      errorName = rawName;
    }
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

let appSeq = 0;

describe('served entry + SharedWorker deleteObject, root listAll, and rules parity (storage#63, #65, #75, #106..109)', () => {
  let restoreSharedWorker: () => void = () => {};

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  async function setupServedStorage() {
    const ctx = await makeHostCtx();
    let storageOpMessages = 0;

    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          const inbound = event.data as InboundMessage;
          if (inbound.t === 'op' && inbound.method.startsWith('storage.')) {
            storageOpMessages += 1;
          }
          void handleMessage(ctx, hostPortLike, inbound);
        };
        this.port = clientPort;
      }
    };

    const servedStorage = await import('../../../src/serve/entries/storage.js');
    const servedAuth = await import('../../../src/serve/entries/auth.js');
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage', storageBucket: 'buckets-default' },
      `served-s9-${++appSeq}`,
    );
    const storage = servedStorage.getStorage(app);
    const ipStorage = ip.getStorageSandbox(ctx.sandbox, { bucket: 'buckets-default' });
    const auth = servedAuth.getAuth(app);

    return {
      ctx,
      servedStorage,
      servedAuth,
      storage,
      ipStorage,
      auth,
      getStorageOpCount: () => storageOpMessages,
      cleanup: async () => {
        await deleteApp(app);
        ctx.sandbox.dispose();
      },
    };
  }

  test('storage#65 and storage#63: root deleteObject throws synchronously with zero RPCs and deleteObject removes bytes and metadata atomically', async () => {
    const rootObs = loadBehavior('client-storage-deleteobject-root-ref');
    const atomicObs = loadBehavior('storage-deleteobject-removes-bytes-and-metadata');
    const session = await setupServedStorage();

    try {
      const rootRef = session.servedStorage.ref(session.storage);
      expect(rootRef.fullPath).toBe(rootObs.rootFullPath);
      expect(rootRef.name).toBe(rootObs.rootName);

      const beforeRootDelete = session.getStorageOpCount();
      let threwSync = false;
      let code: string | null = null;
      let errorName: string | null = null;
      let isFbError = false;
      try {
        void session.servedStorage.deleteObject(rootRef);
      } catch (err) {
        threwSync = true;
        isFbError = err instanceof FirebaseError;
        const rawCode = (err as { code?: unknown }).code;
        const rawName = (err as { name?: unknown }).name;
        if (typeof rawCode === 'string') code = rawCode;
        if (typeof rawName === 'string') errorName = rawName;
      }
      expect(threwSync).toBe(rootObs.threwSynchronously);
      expect(code).toBe(rootObs.code);
      expect(errorName).toBe(rootObs.errorName);
      expect(isFbError).toBe(rootObs.isFirebaseError);
      expect(session.getStorageOpCount() - beforeRootDelete).toBe(rootObs.fetchCalls);

      const targetRef = session.servedStorage.ref(session.storage, 'delete-atomic/item.bin');
      await session.servedStorage.uploadBytes(targetRef, new Uint8Array([16, 32, 48, 64]), {
        contentType: 'application/octet-stream',
        customMetadata: { tag: 'ephemeral' },
      });

      const beforeBuf = await session.servedStorage.getBytes(targetRef);
      const beforeMeta = await session.servedStorage.getMetadata(targetRef);
      expect({
        threw: false,
        code: null,
        errorName: null,
        isFirebaseError: false,
        byteLength: beforeBuf.byteLength,
        bytes: [...new Uint8Array(beforeBuf)],
      }).toEqual(atomicObs.beforeDeleteBytes);
      expect({
        threw: false,
        code: null,
        errorName: null,
        isFirebaseError: false,
        size: beforeMeta.size,
        contentType: beforeMeta.contentType ?? null,
        customMetadata: beforeMeta.customMetadata ?? null,
      }).toEqual(atomicObs.beforeDeleteMetadata);

      const deleteOut = await session.servedStorage.deleteObject(targetRef);
      expect(deleteOut === undefined).toBe(atomicObs.deleteResolvedUndefined);

      const afterBytesErr = await captureServedError(() => session.servedStorage.getBytes(targetRef));
      expect({ ...afterBytesErr, byteLength: null, bytes: null }).toEqual(atomicObs.afterDeleteBytes);

      const afterMetaErr = await captureServedError(() => session.servedStorage.getMetadata(targetRef));
      expect({
        ...afterMetaErr,
        size: null,
        contentType: null,
        customMetadata: null,
      }).toEqual(atomicObs.afterDeleteMetadata);
    } finally {
      await session.cleanup();
    }
  });

  test('storage#75 and storage#106..109: root listAll and rules enforcement over SharedWorker', async () => {
    const deniedObs = loadBehavior('storage-rules-denied-metadata-and-delete');
    const canonicalObs = loadBehavior('storage-rules-canonical-bucket-namespace');
    const rootListObs = loadBehavior('storage-listall-root-ref');
    const session = await setupServedStorage();

    try {
      await replaceStorageRules(
        session.ctx.sandbox,
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

      await session.servedAuth.signInAnonymously(session.auth);

      const rootItemName = 'pyric_oracle_root_r1.bin';
      const rootPrefixName = 'pyric_oracle_root_r1';
      const nestedChildFullPath = 'pyric_oracle_root_r1/nested/child.bin';
      await session.servedStorage.uploadBytes(
        session.servedStorage.ref(session.storage, rootItemName),
        new Uint8Array([0x41]),
      );
      await session.servedStorage.uploadBytes(
        session.servedStorage.ref(session.storage, nestedChildFullPath),
        new Uint8Array([0x42, 0x43]),
      );
      await session.servedStorage.uploadBytes(
        session.servedStorage.ref(session.storage, 'pyric_oracle_root_r1-dash/nested/child.bin'),
        new Uint8Array([0x44]),
      );

      const rootRef = session.servedStorage.ref(session.storage);
      const rootRes = await session.servedStorage.listAll(rootRef);
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
        itemsSortedLexicographically: isSortedByCodeUnits(
          rootRes.items.map((item) => item.fullPath),
        ),
        prefixesSortedLexicographically: isSortedByCodeUnits(
          rootRes.prefixes.map((prefix) => prefix.fullPath),
        ),
        nextPageTokenIsUndefined: rootRes.nextPageToken === undefined,
      };
      expect(rootObserved).toEqual(rootListObs);

      const ordinaryPath = 'pyric_oracle/<runId>/namespace-mapping/item.txt';
      const ordinaryRef = session.servedStorage.ref(session.storage, ordinaryPath);
      const uploaded = await session.servedStorage.uploadBytes(
        ordinaryRef,
        new Uint8Array([111, 107]),
        { contentType: 'text/plain' },
      );
      const fetched = await session.servedStorage.getMetadata(ordinaryRef);
      expect({
        refFullPath: ordinaryRef.fullPath,
        uploadMetadataFullPath: uploaded.metadata.fullPath,
        fetchedMetadataFullPath: fetched.fullPath,
        fetchedMetadataName: fetched.name,
        startsWithCanonicalBucketPrefix: fetched.fullPath.startsWith('b/'),
        metadataMatchesRefFullPath: fetched.fullPath === ordinaryRef.fullPath,
      }).toEqual(canonicalObs.ordinaryObjectPath);

      const prefixedRef = session.servedStorage.ref(
        session.storage,
        `/b/buckets-default/o/${ordinaryPath}`,
      );
      const prefixedErr = await captureServedError(() =>
        session.servedStorage.uploadBytes(prefixedRef, new Uint8Array([111, 107])),
      );
      expect({
        normalizedRefStartsWithB: prefixedRef.fullPath.startsWith('b/buckets-default/o/'),
        uploadThrew: prefixedErr.threw,
        uploadCode: prefixedErr.code,
        uploadIsFirebaseError: prefixedErr.isFirebaseError,
      }).toEqual(canonicalObs.explicitRulesPrefixPath);

      const protectedRef = session.servedStorage.ref(
        session.storage,
        'pyric_oracle/run-1/denied-ops/protected.txt',
      );
      const outsideRef = session.servedStorage.ref(
        session.storage,
        'pyric_oracle_denied_ops/run-1/forbidden.txt',
      );
      await session.servedStorage.uploadBytes(
        protectedRef,
        new Uint8Array([104, 101, 108, 108, 111]),
        { contentType: 'text/plain', customMetadata: { stage: 'initial' } },
      );

      expect(
        await captureServedError(() => session.servedStorage.getMetadata(outsideRef)),
      ).toEqual(deniedObs.getMetadataOutsideGrant);
      const updateOutsideErr = await captureServedError(() =>
        ip.updateMetadata(ip.ref(session.ipStorage, 'pyric_oracle_denied_ops/run-1/forbidden.txt'), {
          customMetadata: { stage: 'mutated' },
        }),
      );
      expect({
        threw: updateOutsideErr.threw,
        code: updateOutsideErr.code,
      }).toEqual({
        threw: (deniedObs.updateMetadataOutsideGrant as DeniedOutcome).threw,
        code: (deniedObs.updateMetadataOutsideGrant as DeniedOutcome).code,
      });
      expect(
        await captureServedError(() => session.servedStorage.deleteObject(outsideRef)),
      ).toEqual(deniedObs.deleteObjectOutsideGrant);

      await session.servedAuth.signOut(session.auth);
      expect(
        await captureServedError(() => session.servedStorage.getMetadata(protectedRef)),
      ).toEqual(deniedObs.getMetadataSignedOutExisting);
      const updateSignedOutErr = await captureServedError(() =>
        ip.updateMetadata(ip.ref(session.ipStorage, 'pyric_oracle/run-1/denied-ops/protected.txt'), {
          customMetadata: { stage: 'mutated' },
        }),
      );
      expect({
        threw: updateSignedOutErr.threw,
        code: updateSignedOutErr.code,
      }).toEqual({
        threw: (deniedObs.updateMetadataSignedOutExisting as DeniedOutcome).threw,
        code: (deniedObs.updateMetadataSignedOutExisting as DeniedOutcome).code,
      });
      expect(
        await captureServedError(() => session.servedStorage.deleteObject(protectedRef)),
      ).toEqual(deniedObs.deleteObjectSignedOutExisting);

      await session.servedAuth.signInAnonymously(session.auth);
      const preserved = await session.servedStorage.getMetadata(protectedRef);
      expect({
        size: preserved.size,
        customMetadata: preserved.customMetadata ?? null,
      }).toEqual(deniedObs.existingPreservedAfterDenials);
    } finally {
      await session.cleanup();
    }
  });
});
