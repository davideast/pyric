/**
 * Served-entry + SharedWorker conformance for `getBytes` and `uploadString`
 * (`storage#39, #40, #42..45, #53, #55..57`).
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

function decodeValidUtf8OrNull(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

let appSeq = 0;

describe('served entry + SharedWorker getBytes and uploadString parity (storage#39, #40, #42..45, #53, #55..57)', () => {
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
      `served-s8-${++appSeq}`,
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

  test('storage#57 and storage#45: root getBytes/uploadString and malformed data_url throw FirebaseError synchronously with zero worker RPCs', async () => {
    const rootObs = loadBehavior('client-storage-getbytes-root-ref');
    const malformedObs = loadBehavior('client-storage-uploadstring-malformed-data-url');
    const session = await setupServedStorage();

    try {
      const rootRef = session.served.ref(session.storage);
      expect(rootRef.fullPath).toBe(rootObs.rootFullPath);
      expect(rootRef.name).toBe(rootObs.rootName);

      const beforeRootGetBytes = session.getStorageOpCount();
      let getBytesThrewSync = false;
      let getBytesCode: string | null = null;
      let getBytesName: string | null = null;
      try {
        void session.served.getBytes(rootRef);
      } catch (err) {
        getBytesThrewSync = true;
        const rawCode = (err as { code?: unknown }).code;
        const rawName = (err as { name?: unknown }).name;
        if (typeof rawCode === 'string') getBytesCode = rawCode;
        if (typeof rawName === 'string') getBytesName = rawName;
      }
      expect(getBytesThrewSync).toBe(rootObs.threwSynchronously);
      expect(getBytesCode).toBe(rootObs.code);
      expect(getBytesName).toBe(rootObs.errorName);
      expect(session.getStorageOpCount() - beforeRootGetBytes).toBe(rootObs.fetchCalls);

      const itemRef = session.served.ref(session.storage, 'items/malformed.txt');
      const malformedCases = [
        { input: 'plain-text,hello', expected: malformedObs.missingDataPrefix as Record<string, unknown> },
        { input: 'data:text/plain;base64', expected: malformedObs.missingComma as Record<string, unknown> },
        { input: 'data:text/plain,%ZZ', expected: malformedObs.invalidPercentEncoding as Record<string, unknown> },
      ];

      for (const entry of malformedCases) {
        const beforeCall = session.getStorageOpCount();
        let threwSync = false;
        let code: string | null = null;
        let errorName: string | null = null;
        try {
          void session.served.uploadString(itemRef, entry.input, 'data_url');
        } catch (err) {
          threwSync = true;
          const rawCode = (err as { code?: unknown }).code;
          const rawName = (err as { name?: unknown }).name;
          if (typeof rawCode === 'string') code = rawCode;
          if (typeof rawName === 'string') errorName = rawName;
        }
        expect(threwSync).toBe(entry.expected.threwSynchronously);
        expect(code).toBe(entry.expected.code);
        expect(errorName).toBe(entry.expected.errorName);
        expect(session.getStorageOpCount() - beforeCall).toBe(entry.expected.fetchCalls);
      }
    } finally {
      await session.cleanup();
    }
  });

  test('storage#39, #40, #42..44, #53, #55, #56: getBytes cap and uploadString raw/base64/data_url round-trip over SharedWorker', async () => {
    const capObs = loadBehavior('storage-getbytes-roundtrip-and-cap');
    const dataUrlObs = loadBehavior('storage-uploadstring-data-url-variants');
    const rawObs = loadBehavior('storage-uploadstring-raw-and-base64');
    const session = await setupServedStorage();

    try {
      const capRef = session.served.ref(session.storage, 'getbytes-cap/payload.bin');
      const payload = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      await session.served.uploadBytes(capRef, payload, { contentType: 'application/octet-stream' });

      async function readCap(cap?: number) {
        let result: ArrayBuffer;
        if (cap === undefined) {
          result = await session.served.getBytes(capRef);
        } else {
          result = await session.served.getBytes(capRef, cap);
        }
        return {
          threw: false,
          code: null,
          errorName: null,
          isFirebaseError: false,
          isArrayBuffer: result instanceof ArrayBuffer,
          byteLength: result.byteLength,
          bytes: [...new Uint8Array(result)],
        };
      }

      expect(await readCap()).toEqual(capObs.unbounded);
      expect(await readCap(6)).toEqual(capObs.truncatedMax6);
      expect(await readCap(16)).toEqual(capObs.exactMax16);
      expect(await readCap(32)).toEqual(capObs.aboveMax32);

      async function runDataUrl(
        subpath: string,
        dataUrl: string,
        metadata?: { contentType: string },
      ) {
        const targetRef = session.served.ref(session.storage, subpath);
        const uploaded = await session.served.uploadString(targetRef, dataUrl, 'data_url', metadata);
        const fetched = await session.served.getMetadata(targetRef);
        const bytes = new Uint8Array(await session.served.getBytes(targetRef));
        return {
          size: uploaded.metadata.size,
          uploadedContentType: uploaded.metadata.contentType ?? null,
          fetchedContentType: fetched.contentType ?? null,
          decodedBytes: [...bytes],
          decodedUtf8: new TextDecoder('utf-8').decode(bytes),
        };
      }

      expect(
        await runDataUrl('data-url/json.json', 'data:application/json;base64,eyJvayI6dHJ1ZX0='),
      ).toEqual(dataUrlObs.base64JsonDataUrl);
      expect(
        await runDataUrl('data-url/plain.txt', 'data:text/plain,hello%20world%21'),
      ).toEqual(dataUrlObs.percentEncodedDataUrl);
      expect(
        await runDataUrl('data-url/override.csv', 'data:text/plain;base64,YSwx', {
          contentType: 'text/csv',
        }),
      ).toEqual(dataUrlObs.callerContentTypeOverride);

      async function runRawOrBase64(subpath: string, value: string, format?: 'raw' | 'base64') {
        const targetRef = session.served.ref(session.storage, subpath);
        let uploaded;
        if (format === undefined) {
          uploaded = await session.served.uploadString(targetRef, value);
        } else {
          uploaded = await session.served.uploadString(targetRef, value, format);
        }
        const fetched = await session.served.getMetadata(targetRef);
        const bytes = new Uint8Array(await session.served.getBytes(targetRef));
        return {
          size: uploaded.metadata.size,
          uploadedContentType: uploaded.metadata.contentType ?? null,
          fetchedContentType: fetched.contentType ?? null,
          decodedBytes: [...bytes],
          decodedUtf8: decodeValidUtf8OrNull(bytes),
        };
      }

      const defaultRaw = await runRawOrBase64('uploadstring/default-raw.txt', 'Hello, UTF-8!');
      const explicitRaw = await runRawOrBase64('uploadstring/explicit-raw.txt', 'Explicit raw line', 'raw');
      const standardBase64 = await runRawOrBase64('uploadstring/standard-b64.bin', 'AQID/w==', 'base64');

      expect(defaultRaw).toEqual(rawObs.defaultRaw);
      expect(explicitRaw).toEqual(rawObs.explicitRaw);
      expect(standardBase64).toEqual(rawObs.standardBase64);
    } finally {
      await session.cleanup();
    }
  });
});
