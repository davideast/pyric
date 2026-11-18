/**
 * Served-entry + SharedWorker conformance for `uploadBytes` (`storage#24..35, #38, #118`):
 *   - `client-storage-uploadbytes-root-ref` (`storage#31`): synchronous throw, 0 RPCs
 *   - `storage-uploadbytes-payload-types` (`storage#24..26, #32..34`)
 *   - `storage-uploadbytes-contenttype-precedence` (`storage#27, #28, #30`)
 *   - `storage-uploadbytes-custom-metadata` (`storage#29`)
 *   - `storage-uploadbytes-overwrite-generations` (`storage#35, #38, #118`)
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
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

describe('served entry + SharedWorker uploadBytes parity (storage#24..35, #38, #118)', () => {
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
      `served-uploadbytes-${++appSeq}`,
    );
    const storage = served.getStorage(app);

    return {
      served,
      storage,
      getStorageOpCount: () => storageOpMessages,
      cleanup: async () => {
        await deleteApp(app);
        ctx.sandbox.dispose();
      },
    };
  }

  test('storage#31: uploadBytes(ref(storage), data) throws storage/invalid-root-operation synchronously with zero storage RPCs', async () => {
    const obs = loadBehavior('client-storage-uploadbytes-root-ref');
    const session = await setupServedStorage();
    try {
      const rootRef = session.served.ref(session.storage);
      expect(rootRef.fullPath).toBe(obs.rootFullPath as string);
      expect(rootRef.name).toBe(obs.rootName as string);

      const opsBefore = session.getStorageOpCount();
      let threwSynchronously = false;
      let caughtCode: string | null = null;
      try {
        session.served.uploadBytes(rootRef, new Uint8Array([0x01])).catch(() => {});
      } catch (err) {
        threwSynchronously = true;
        const code = (err as { code?: string }).code;
        if (typeof code === 'string') {
          caughtCode = code;
        }
      }
      expect(threwSynchronously).toBe(obs.threwSynchronously as boolean);
      expect(caughtCode).toBe(obs.code as string);
      expect(session.getStorageOpCount() - opsBefore).toBe(obs.fetchCalls as number);
    } finally {
      await session.cleanup();
    }
  });

  test('storage#24..26, #32..34: uploadBytes accepts Blob, Uint8Array, and ArrayBuffer and returns matching metadata', async () => {
    const obs = loadBehavior('storage-uploadbytes-payload-types');
    const inputBytes = obs.inputBytes as number[];
    const raw = new Uint8Array(inputBytes);
    const padded = new ArrayBuffer(8);
    new Uint8Array(padded).set([99, 98, ...inputBytes, 97, 96]);
    const slicedBuffer = padded.slice(2, 6);

    const session = await setupServedStorage();
    try {
      const handleBucket = session.served.ref(session.storage).bucket;
      const payloads: Array<{
        subpath: string;
        data: Blob | Uint8Array | ArrayBuffer;
        recorded: {
          metadataName: string;
          metadataSize: number;
          readBytes: number[];
        };
      }> = [
        {
          subpath: 'uploadbytes-payloads/from-blob.bin',
          data: new Blob([raw]),
          recorded: obs.blobPayload as { metadataName: string; metadataSize: number; readBytes: number[] },
        },
        {
          subpath: 'uploadbytes-payloads/from-uint8array.bin',
          data: raw,
          recorded: obs.uint8ArrayPayload as { metadataName: string; metadataSize: number; readBytes: number[] },
        },
        {
          subpath: 'uploadbytes-payloads/from-arraybuffer.bin',
          data: slicedBuffer,
          recorded: obs.arrayBufferPayload as { metadataName: string; metadataSize: number; readBytes: number[] },
        },
      ];

      for (const entry of payloads) {
        const target = session.served.ref(session.storage, entry.subpath);
        const uploaded = await session.served.uploadBytes(target, entry.data);
        const downloaded = await session.served.getBytes(target);
        expect(uploaded.ref.fullPath).toBe(target.fullPath);
        expect(uploaded.metadata.fullPath).toBe(target.fullPath);
        expect(uploaded.metadata.name).toBe(entry.recorded.metadataName);
        expect(uploaded.metadata.bucket).toBe(handleBucket);
        expect(uploaded.metadata.size).toBe(entry.recorded.metadataSize);
        expect(Array.from(new Uint8Array(downloaded))).toEqual(entry.recorded.readBytes);
      }
    } finally {
      await session.cleanup();
    }
  });

  test('storage#27..30, #35, #38, #118: contentType precedence, customMetadata omission/round-trip, and overwrite generation monotonicity', async () => {
    const ctObs = loadBehavior('storage-uploadbytes-contenttype-precedence');
    const customObs = loadBehavior('storage-uploadbytes-custom-metadata');
    const overwriteObs = loadBehavior('storage-uploadbytes-overwrite-generations');

    const session = await setupServedStorage();
    try {
      const ctRaw = new Uint8Array(ctObs.expectedBytes as number[]);
      const ctCases: Array<{
        subpath: string;
        data: Blob | Uint8Array;
        metadata?: { contentType?: string };
        expected: { uploadContentType: string; storedContentType: string; size: number; readBytes: number[] };
      }> = [
        {
          subpath: 'ct/empty-blob.bin',
          data: new Blob([ctRaw]),
          expected: ctObs.emptyBlobNoHint as { uploadContentType: string; storedContentType: string; size: number; readBytes: number[] },
        },
        {
          subpath: 'ct/typed-blob.png',
          data: new Blob([ctRaw], { type: 'image/png' }),
          expected: ctObs.typedBlobNoHint as { uploadContentType: string; storedContentType: string; size: number; readBytes: number[] },
        },
        {
          subpath: 'ct/override-blob.pdf',
          data: new Blob([ctRaw], { type: 'image/png' }),
          metadata: { contentType: 'application/pdf' },
          expected: ctObs.typedBlobCallerOverride as { uploadContentType: string; storedContentType: string; size: number; readBytes: number[] },
        },
        {
          subpath: 'ct/empty-hint.wav',
          data: new Blob([ctRaw]),
          metadata: { contentType: 'audio/wav' },
          expected: ctObs.emptyBlobCallerHint as { uploadContentType: string; storedContentType: string; size: number; readBytes: number[] },
        },
        {
          subpath: 'ct/uint8.bin',
          data: ctRaw,
          expected: ctObs.uint8NoHint as { uploadContentType: string; storedContentType: string; size: number; readBytes: number[] },
        },
      ];

      for (const entry of ctCases) {
        const target = session.served.ref(session.storage, entry.subpath);
        const up = await session.served.uploadBytes(target, entry.data, entry.metadata);
        const md = await session.served.getMetadata(target);
        const bytes = await session.served.getBytes(target);
        expect(up.metadata.contentType).toBe(entry.expected.uploadContentType);
        expect(md.contentType).toBe(entry.expected.storedContentType);
        expect(up.metadata.size).toBe(entry.expected.size);
        expect(Array.from(new Uint8Array(bytes))).toEqual(entry.expected.readBytes);
      }

      const withoutExpected = customObs.withoutCustomMetadata as {
        uploadHasCustomMetadataProperty: boolean;
      };
      const withExpected = customObs.withCustomMetadata as {
        uploadHasCustomMetadataProperty: boolean;
        uploadCustomMetadata: Record<string, string>;
        getMetadataCustomMetadata: Record<string, string>;
      };

      const plainRef = session.served.ref(session.storage, 'meta/plain.bin');
      const plainUp = await session.served.uploadBytes(plainRef, new Uint8Array([1, 2, 3, 4]));
      const plainMd = await session.served.getMetadata(plainRef);
      expect('customMetadata' in plainUp.metadata).toBe(
        withoutExpected.uploadHasCustomMetadataProperty,
      );
      expect('customMetadata' in plainMd).toBe(withoutExpected.uploadHasCustomMetadataProperty);

      const richRef = session.served.ref(session.storage, 'meta/rich.bin');
      const richUp = await session.served.uploadBytes(richRef, new Uint8Array([1, 2, 3, 4]), {
        customMetadata: withExpected.uploadCustomMetadata,
      });
      const richMd = await session.served.getMetadata(richRef);
      expect('customMetadata' in richUp.metadata).toBe(withExpected.uploadHasCustomMetadataProperty);
      expect(richUp.metadata.customMetadata).toEqual(withExpected.uploadCustomMetadata);
      expect(richMd.customMetadata).toEqual(withExpected.getMetadataCustomMetadata);

      const firstExpected = overwriteObs.firstUpload as {
        size: number;
        contentType: string;
        customMetadata: Record<string, string>;
        metageneration: string;
      };
      const secondExpected = overwriteObs.secondUpload as {
        size: number;
        contentType: string;
        customMetadata: Record<string, string>;
        metageneration: string;
      };
      const versionedRef = session.served.ref(session.storage, 'overwrite/versioned.bin');
      const first = await session.served.uploadBytes(
        versionedRef,
        new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
        { contentType: firstExpected.contentType, customMetadata: firstExpected.customMetadata },
      );
      const second = await session.served.uploadBytes(
        versionedRef,
        new Uint8Array(overwriteObs.afterOverwriteReadBytes as number[]),
        { contentType: secondExpected.contentType, customMetadata: secondExpected.customMetadata },
      );
      expect(first.metadata.metageneration).toBe(firstExpected.metageneration);
      expect(second.metadata.metageneration).toBe(secondExpected.metageneration);
      expect(BigInt(second.metadata.generation) > BigInt(first.metadata.generation)).toBe(
        overwriteObs.generationStrictlyIncreased as boolean,
      );
      const finalBytes = Array.from(new Uint8Array(await session.served.getBytes(versionedRef)));
      expect(finalBytes).toEqual(overwriteObs.afterOverwriteReadBytes as number[]);
      const finalMd = await session.served.getMetadata(versionedRef);
      expect(finalMd.customMetadata).toEqual(secondExpected.customMetadata);
      expect(finalMd.generation).toBe(second.metadata.generation);
    } finally {
      await session.cleanup();
    }
  });
});
