import { describe, expect, it } from 'bun:test';
import { probe as getBytesRootProbe } from '../../probes/storage/client-storage-getbytes-root-ref.ts';
import { probe as malformedDataUrlProbe } from '../../probes/storage/client-storage-uploadstring-malformed-data-url.ts';
import {
  observeStorageGetBytesRoundtripAndCap,
  probe as getBytesCapProbe,
  type StorageGetBytesCapSubject,
} from '../../probes/storage/storage-getbytes-roundtrip-and-cap.ts';
import {
  observeStorageUploadStringDataUrlVariants,
  probe as dataUrlVariantsProbe,
  type StorageUploadStringDataUrlSubject,
} from '../../probes/storage/storage-uploadstring-data-url-variants.ts';
import {
  observeStorageUploadStringRawAndBase64,
  probe as rawAndBase64Probe,
  type StorageUploadStringRawAndBase64Subject,
} from '../../probes/storage/storage-uploadstring-raw-and-base64.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const SDK_PROBES = [
  { name: 'storage-getbytes-roundtrip-and-cap', probe: getBytesCapProbe },
  { name: 'storage-uploadstring-raw-and-base64', probe: rawAndBase64Probe },
  { name: 'storage-uploadstring-data-url-variants', probe: dataUrlVariantsProbe },
] as const;

const CLIENT_STORAGE_PROBES = [
  { name: 'client-storage-getbytes-root-ref', probe: getBytesRootProbe },
  { name: 'client-storage-uploadstring-malformed-data-url', probe: malformedDataUrlProbe },
] as const;

describe('storage getBytes and uploadString staged probes (storage#39, #40, #42..45, #53, #55..57)', () => {
  it('observeStorageGetBytesRoundtripAndCap records unbounded, truncated, exact-cap, and above-cap reads', async () => {
    const store = new Map<string, Uint8Array>();
    const subject: StorageGetBytesCapSubject = {
      async seedPayload(subpath, bytes) {
        store.set(subpath, new Uint8Array(bytes));
      },
      async readBytes(subpath, maxDownloadSizeBytes) {
        const stored = store.get(subpath) ?? new Uint8Array();
        let sliced = stored;
        if (maxDownloadSizeBytes !== undefined) {
          sliced = stored.slice(0, maxDownloadSizeBytes);
        }
        return {
          threw: false,
          code: null,
          errorName: null,
          isFirebaseError: false,
          isArrayBuffer: true,
          byteLength: sliced.byteLength,
          bytes: [...sliced],
        };
      },
    };

    const observed = await observeStorageGetBytesRoundtripAndCap(subject);
    expect(observed.uploadedLength).toBe(16);
    expect(observed.unbounded).toMatchObject({
      threw: false,
      isArrayBuffer: true,
      byteLength: 16,
    });
    expect(observed.truncatedMax6).toMatchObject({
      threw: false,
      isArrayBuffer: true,
      byteLength: 6,
      bytes: [0, 1, 2, 3, 4, 5],
    });
    expect(observed.exactMax16).toMatchObject({
      threw: false,
      byteLength: 16,
    });
    expect(observed.aboveMax32).toMatchObject({
      threw: false,
      byteLength: 16,
    });
  });

  it('observeStorageUploadStringRawAndBase64 and observeStorageUploadStringDataUrlVariants record content types and decoded bytes', async () => {
    const rawSubject: StorageUploadStringRawAndBase64Subject = {
      async uploadAndRead(_subpath, value, format) {
        let bytes: Uint8Array;
        let contentType = 'text/plain;charset=utf-8';
        if (format === 'base64') {
          bytes = new Uint8Array(Buffer.from(value, 'base64'));
          contentType = 'application/octet-stream';
        } else {
          bytes = new TextEncoder().encode(value);
        }
        return {
          size: bytes.byteLength,
          uploadedContentType: contentType,
          fetchedContentType: contentType,
          decodedBytes: [...bytes],
          decodedUtf8: new TextDecoder().decode(bytes),
        };
      },
    };

    const rawObserved = await observeStorageUploadStringRawAndBase64(rawSubject);
    expect(rawObserved.defaultRaw).toMatchObject({
      uploadedContentType: 'text/plain;charset=utf-8',
      decodedUtf8: 'Hello, UTF-8!',
    });
    expect(rawObserved.standardBase64).toMatchObject({
      size: 4,
      decodedBytes: [1, 2, 3, 255],
    });

    const dataUrlSubject: StorageUploadStringDataUrlSubject = {
      async uploadDataUrlAndRead(_subpath, dataUrl, metadata) {
        const comma = dataUrl.indexOf(',');
        const header = dataUrl.slice(5, comma);
        const body = dataUrl.slice(comma + 1);
        const isBase64 = header.endsWith(';base64');
        let inferred = header;
        if (isBase64) {
          inferred = header.slice(0, header.length - 7);
        }
        const effectiveType = metadata?.contentType ?? inferred;
        let bytes: Uint8Array;
        if (isBase64) {
          bytes = new Uint8Array(Buffer.from(body, 'base64'));
        } else {
          bytes = new TextEncoder().encode(decodeURIComponent(body));
        }
        return {
          size: bytes.byteLength,
          uploadedContentType: effectiveType,
          fetchedContentType: effectiveType,
          decodedBytes: [...bytes],
          decodedUtf8: new TextDecoder().decode(bytes),
        };
      },
    };

    const dataUrlObserved = await observeStorageUploadStringDataUrlVariants(dataUrlSubject);
    expect(dataUrlObserved.base64JsonDataUrl).toMatchObject({
      uploadedContentType: 'application/json',
      decodedUtf8: '{"ok":true}',
    });
    expect(dataUrlObserved.percentEncodedDataUrl).toMatchObject({
      uploadedContentType: 'text/plain',
      decodedUtf8: 'hello world!',
    });
    expect(dataUrlObserved.callerContentTypeOverride).toMatchObject({
      uploadedContentType: 'text/csv',
      decodedUtf8: 'a,1',
    });
  });

  it('executes client-storage root getBytes and malformed data_url preflight probes offline and verifies staged registration', async () => {
    const rootObserved = await getBytesRootProbe.observe();
    expect(rootObserved).toMatchObject({
      rootFullPath: '',
      rootName: '',
      threw: true,
      threwSynchronously: true,
      code: 'storage/invalid-root-operation',
      isFirebaseError: true,
      fetchCalls: 0,
    });

    const malformedObserved = await malformedDataUrlProbe.observe();
    expect(malformedObserved.missingDataPrefix).toMatchObject({
      threw: true,
      threwSynchronously: true,
      code: 'storage/invalid-format',
      isFirebaseError: true,
      mentionsDataUrlFormat: true,
      fetchCalls: 0,
    });
    expect(malformedObserved.missingComma).toMatchObject({
      threw: true,
      threwSynchronously: true,
      code: 'storage/invalid-format',
      isFirebaseError: true,
      fetchCalls: 0,
    });
    expect(malformedObserved.invalidPercentEncoding).toMatchObject({
      threw: true,
      threwSynchronously: true,
      code: 'storage/invalid-format',
      isFirebaseError: true,
      fetchCalls: 0,
    });

    for (const entry of SDK_PROBES) {
      if (entry.probe.pendingRowLink) {
        expectStagedUntilCaptured(entry.name, {
          rig: 'sdk-probes',
          filterFlag: '--probe',
        });
      }
    }
    for (const entry of CLIENT_STORAGE_PROBES) {
      if (entry.probe.pendingRowLink) {
        expectStagedUntilCaptured(entry.name, {
          rig: 'client-storage',
          filterFlag: '--probe',
        });
      }
    }
  });
});
