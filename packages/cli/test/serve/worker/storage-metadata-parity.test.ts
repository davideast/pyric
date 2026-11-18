/**
 * Served-entry + SharedWorker + in-process conformance for `getMetadata` and `updateMetadata`
 * (`storage#79..85, #87, #88`):
 *   - `client-storage-getmetadata-root-ref` (`storage#81`): synchronous throw, 0 RPCs
 *   - `client-storage-updatemetadata-root-ref` (`storage#88`): synchronous throw on in-process plane
 *   - `storage-getmetadata-full-shape` (`storage#79`): field-by-field FullMetadata parity across planes
 *   - `storage-metadata-missing-object-errors` (`storage#80, #87`): object-not-found on getMetadata, unauthorized on updateMetadata
 *   - `storage-updatemetadata-fields-and-bytes` (`storage#82, #85`): settable fields + RFC 7396 customMetadata merge + byte preservation read back over SharedWorker
 *   - `storage-updatemetadata-versioning-and-timestamps` (`storage#83, #84`): metageneration +1 bumps and timestamp invariants read back over SharedWorker
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { getClock } from 'pyric/sandbox';
import * as ip from 'pyric/storage';
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

let appSeq = 0;

describe('served entry + SharedWorker getMetadata and updateMetadata parity (storage#79..85, #87, #88)', () => {
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

    const served = await import('../../../src/serve/entries/storage.js');
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage', storageBucket: 'buckets-default' },
      `served-metadata-${++appSeq}`,
    );
    const storage = served.getStorage(app);
    const ipStorage = ip.getStorageSandbox(ctx.sandbox);

    return {
      ctx,
      served,
      storage,
      ipStorage,
      getStorageOpCount: () => storageOpMessages,
      cleanup: async () => {
        await deleteApp(app);
      },
    };
  }

  test('replays client-storage-getmetadata-root-ref and client-storage-updatemetadata-root-ref synchronously with zero RPCs (storage#81, #88)', async () => {
    const getObs = loadBehavior('client-storage-getmetadata-root-ref');
    const updateObs = loadBehavior('client-storage-updatemetadata-root-ref');
    const { served, storage, ipStorage, getStorageOpCount, cleanup } = await setupServedStorage();

    try {
      const beforeOps = getStorageOpCount();
      const servedRoot = served.ref(storage);
      expect(servedRoot.fullPath).toBe(getObs.rootFullPath as string);
      expect(servedRoot.name).toBe(getObs.rootName as string);

      let servedThrewSync = false;
      let servedCode: string | null = null;
      try {
        void served.getMetadata(servedRoot);
      } catch (err) {
        servedThrewSync = true;
        servedCode = String((err as { code?: unknown }).code);
      }
      expect(servedThrewSync).toBe(getObs.threwSynchronously as boolean);
      expect(servedCode).toBe(getObs.code as string);
      expect(getStorageOpCount() - beforeOps).toBe(getObs.fetchCalls as number);

      let ipUpdateThrewSync = false;
      let ipUpdateCode: string | null = null;
      try {
        void ip.updateMetadata(ip.ref(ipStorage), { contentType: 'text/plain' });
      } catch (err) {
        ipUpdateThrewSync = true;
        ipUpdateCode = String((err as { code?: unknown }).code);
      }
      expect(ipUpdateThrewSync).toBe(updateObs.threwSynchronously as boolean);
      expect(ipUpdateCode).toBe(updateObs.code as string);
    } finally {
      await cleanup();
    }
  });

  test('replays storage-getmetadata-full-shape and storage-metadata-missing-object-errors across SharedWorker and sandbox (storage#79, #80, #87)', async () => {
    const shapeObs = loadBehavior('storage-getmetadata-full-shape');
    const missingObs = loadBehavior('storage-metadata-missing-object-errors');
    const { served, storage, ipStorage, cleanup } = await setupServedStorage();

    try {
      const upExpected = shapeObs.uploadedShape as {
        name: string;
        scrubbedFullPath: string;
        size: number;
        metageneration: string;
        contentType: string;
        cacheControl: string;
        contentDisposition: string;
        contentEncoding: string;
        contentLanguage: string;
        customMetadata: Record<string, string>;
        bucketMatchesHandle: boolean;
        generationIsDigits: boolean;
      };
      const fetchedExpected = shapeObs.fetchedShape as typeof upExpected & {
        generationMatchesUpload: boolean;
        timeCreatedMatchesUpload: boolean;
        updatedMatchesUpload: boolean;
      };

      const targetRef = served.ref(storage, upExpected.scrubbedFullPath);
      const uploaded = await served.uploadBytes(
        targetRef,
        new Uint8Array([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x31, 0x7d]),
        {
          contentType: upExpected.contentType,
          cacheControl: upExpected.cacheControl,
          contentDisposition: upExpected.contentDisposition,
          contentEncoding: upExpected.contentEncoding,
          contentLanguage: upExpected.contentLanguage,
          customMetadata: upExpected.customMetadata,
        },
      );
      const fetched = await served.getMetadata(targetRef);

      expect(fetched.name).toBe(fetchedExpected.name);
      expect(fetched.fullPath).toBe(fetchedExpected.scrubbedFullPath);
      expect(fetched.size).toBe(fetchedExpected.size);
      expect(fetched.metageneration).toBe(fetchedExpected.metageneration);
      expect(fetched.contentType).toBe(fetchedExpected.contentType);
      expect(fetched.cacheControl).toBe(fetchedExpected.cacheControl);
      expect(fetched.contentDisposition).toBe(fetchedExpected.contentDisposition);
      expect(fetched.contentEncoding).toBe(fetchedExpected.contentEncoding);
      expect(fetched.contentLanguage).toBe(fetchedExpected.contentLanguage);
      expect(fetched.customMetadata).toEqual(fetchedExpected.customMetadata);
      expect(fetched.bucket === targetRef.bucket).toBe(fetchedExpected.bucketMatchesHandle);
      expect(/^\d+$/.test(fetched.generation)).toBe(fetchedExpected.generationIsDigits);
      expect(fetched.generation === uploaded.metadata.generation).toBe(
        fetchedExpected.generationMatchesUpload,
      );
      expect(fetched.timeCreated === uploaded.metadata.timeCreated).toBe(
        fetchedExpected.timeCreatedMatchesUpload,
      );
      expect(fetched.updated === uploaded.metadata.updated).toBe(
        fetchedExpected.updatedMatchesUpload,
      );

      const getMissingExpected = missingObs.getMetadataMissing as { threw: boolean; code: string };
      const updateMissingExpected = missingObs.updateMetadataMissing as {
        threw: boolean;
        code: string;
      };
      let getMissingCode: string | null = null;
      try {
        await served.getMetadata(served.ref(storage, 'pyric_oracle/<runId>/metadata-missing/none.bin'));
      } catch (err) {
        getMissingCode = String((err as { code?: unknown }).code);
      }
      expect(getMissingCode !== null).toBe(getMissingExpected.threw);
      expect(getMissingCode).toBe(getMissingExpected.code);

      let updateMissingCode: string | null = null;
      try {
        await ip.updateMetadata(
          ip.ref(ipStorage, 'pyric_oracle/<runId>/metadata-missing/none.bin'),
          { contentType: 'text/plain' },
        );
      } catch (err) {
        updateMissingCode = String((err as { code?: unknown }).code);
      }
      expect(updateMissingCode !== null).toBe(updateMissingExpected.threw);
      expect(updateMissingCode).toBe(updateMissingExpected.code);
    } finally {
      await cleanup();
    }
  });

  test('replays storage-updatemetadata-fields-and-bytes and versioning/timestamps with SharedWorker getMetadata and getBytes read-back (storage#82..85)', async () => {
    const fieldsObs = loadBehavior('storage-updatemetadata-fields-and-bytes');
    const verObs = loadBehavior('storage-updatemetadata-versioning-and-timestamps');
    const { ctx, served, storage, ipStorage, cleanup } = await setupServedStorage();

    try {
      const initialBytes = fieldsObs.initialBytes as number[];
      const beforeExpected = fieldsObs.beforeUpdate as {
        size: number;
        contentType: string;
        cacheControl: string;
        contentDisposition: string;
        contentEncoding: string;
        contentLanguage: string;
        customMetadata: Record<string, string>;
      };
      const updateExpected = fieldsObs.updateReturn as typeof beforeExpected;
      const afterGetExpected = fieldsObs.afterGetMetadata as typeof beforeExpected;

      const path = 'pyric_oracle/<runId>/metadata-fields/item.bin';
      await served.uploadBytes(served.ref(storage, path), new Uint8Array(initialBytes), {
        contentType: beforeExpected.contentType,
        cacheControl: beforeExpected.cacheControl,
        contentDisposition: beforeExpected.contentDisposition,
        contentEncoding: beforeExpected.contentEncoding,
        contentLanguage: beforeExpected.contentLanguage,
        customMetadata: beforeExpected.customMetadata,
      });

      const updated = await ip.updateMetadata(ip.ref(ipStorage, path), {
        contentType: updateExpected.contentType,
        cacheControl: updateExpected.cacheControl,
        contentDisposition: updateExpected.contentDisposition,
        contentEncoding: updateExpected.contentEncoding,
        contentLanguage: updateExpected.contentLanguage,
        customMetadata: { k2: 'v2-next', k3: 'v3' },
      });
      expect(updated.customMetadata).toEqual(updateExpected.customMetadata);

      const workerFetched = await served.getMetadata(served.ref(storage, path));
      expect(workerFetched.size).toBe(afterGetExpected.size);
      expect(workerFetched.contentType).toBe(afterGetExpected.contentType);
      expect(workerFetched.cacheControl).toBe(afterGetExpected.cacheControl);
      expect(workerFetched.contentDisposition).toBe(afterGetExpected.contentDisposition);
      expect(workerFetched.contentEncoding).toBe(afterGetExpected.contentEncoding);
      expect(workerFetched.contentLanguage).toBe(afterGetExpected.contentLanguage);
      expect(workerFetched.customMetadata).toEqual(afterGetExpected.customMetadata);

      const workerBytes = Array.from(
        new Uint8Array(await served.getBytes(served.ref(storage, path))),
      );
      expect(workerBytes).toEqual(fieldsObs.afterReadBytes as number[]);

      const verPath = 'pyric_oracle/<runId>/metadata-versioning/item.bin';
      const uploadedVer = await served.uploadBytes(
        served.ref(storage, verPath),
        new Uint8Array([1, 2, 3, 4]),
        { contentType: 'text/plain' },
      );
      getClock(ctx.sandbox).advance(25);
      const firstVer = await ip.updateMetadata(ip.ref(ipStorage, verPath), {
        customMetadata: { step: '1' },
      });
      getClock(ctx.sandbox).advance(25);
      await ip.updateMetadata(ip.ref(ipStorage, verPath), {
        customMetadata: { step: '2' },
      });
      const secondVer = await served.getMetadata(served.ref(storage, verPath));

      expect(uploadedVer.metadata.metageneration).toBe(verObs.initialMetageneration as string);
      expect(firstVer.metageneration).toBe(verObs.firstUpdateMetageneration as string);
      expect(secondVer.metageneration).toBe(verObs.secondUpdateMetageneration as string);
      expect(secondVer.generation === uploadedVer.metadata.generation).toBe(
        verObs.generationPinnedAcrossUpdates as boolean,
      );
      expect(secondVer.timeCreated === uploadedVer.metadata.timeCreated).toBe(
        verObs.timeCreatedPinnedAcrossUpdates as boolean,
      );
      expect(Date.parse(secondVer.updated) > Date.parse(uploadedVer.metadata.updated)).toBe(
        verObs.secondUpdatedStrictlyAfterInitialUpdated as boolean,
      );
    } finally {
      await cleanup();
    }
  });
});
