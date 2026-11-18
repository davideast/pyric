/**
 * Oracle conformance replay cases for `getBytes` and `uploadString`
 * (`storage#39, #40, #42..45, #53, #55..57`):
 *   - `client-storage-getbytes-root-ref` (`storage#57`)
 *   - `client-storage-uploadstring-malformed-data-url` (`storage#45`)
 *   - `storage-getbytes-roundtrip-and-cap` (`storage#53, #55, #56`)
 *   - `storage-uploadstring-raw-and-base64` (`storage#39, #40`)
 *   - `storage-uploadstring-data-url-variants` (`storage#42, #43, #44`)
 */
import { expect, it } from 'bun:test';
import {
  getBytes,
  getMetadata,
  ref,
  uploadBytes,
  uploadString,
  type FirebaseStorage,
} from '../../src/storage/index.js';

export interface OracleGetBytesUploadStringSuiteContext {
  load: (name: string) => Record<string, unknown>;
  freshStorage: (label: string, rules?: string) => FirebaseStorage;
}

function decodeValidUtf8OrNull(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function registerOracleGetBytesUploadStringSuite({
  load,
  freshStorage,
}: OracleGetBytesUploadStringSuiteContext): void {
  it('storage#57: client-storage-getbytes-root-ref throws storage/invalid-root-operation synchronously on the root reference', () => {
    const obs = load('client-storage-getbytes-root-ref.json');
    const storage = freshStorage('getbytes-root');
    const rootRef = ref(storage);

    expect(rootRef.fullPath).toBe(obs.rootFullPath as string);
    expect(rootRef.name).toBe(obs.rootName as string);
    expect(obs.isFirebaseError).toBe(true);
    expect(obs.errorName).toBe('FirebaseError');
    expect(obs.fetchCalls).toBe(0);
    expect((obs.message as string).length).toBeGreaterThan(0);

    let threwSync = false;
    let code: string | null = null;
    try {
      void getBytes(rootRef);
    } catch (err) {
      threwSync = true;
      expect(err).toBeInstanceOf(Error);
      const rawCode = (err as { code?: unknown }).code;
      if (typeof rawCode === 'string') {
        code = rawCode;
      }
    }
    expect(threwSync).toBe(obs.threwSynchronously as boolean);
    expect(threwSync).toBe(obs.threw as boolean);
    expect(code).toBe(obs.code as string);
  });

  it('storage#45: client-storage-uploadstring-malformed-data-url throws storage/invalid-format synchronously across malformed data_url inputs', () => {
    const obs = load('client-storage-uploadstring-malformed-data-url.json');
    const storage = freshStorage('uploadstring-malformed');
    const targetRef = ref(storage, 'pyric_oracle/uploadstring/bad.txt');

    const cases = [
      { input: 'plain-text,hello', expected: obs.missingDataPrefix as Record<string, unknown> },
      { input: 'data:text/plain;base64', expected: obs.missingComma as Record<string, unknown> },
      { input: 'data:text/plain,%ZZ', expected: obs.invalidPercentEncoding as Record<string, unknown> },
    ];

    for (const entry of cases) {
      expect(entry.expected.isFirebaseError).toBe(true);
      expect(entry.expected.errorName).toBe('FirebaseError');
      expect(entry.expected.mentionsDataUrlFormat).toBe(true);
      expect(entry.expected.fetchCalls).toBe(0);

      let threwSync = false;
      let code: string | null = null;
      try {
        void uploadString(targetRef, entry.input, 'data_url');
      } catch (err) {
        threwSync = true;
        const rawCode = (err as { code?: unknown }).code;
        if (typeof rawCode === 'string') {
          code = rawCode;
        }
      }
      expect(threwSync).toBe(entry.expected.threwSynchronously as boolean);
      expect(threwSync).toBe(entry.expected.threw as boolean);
      expect(code).toBe(entry.expected.code as string);
    }

    const rootRef = ref(storage);
    let rootThrewSync = false;
    let rootCode: string | null = null;
    try {
      void uploadString(rootRef, 'hello', 'raw');
    } catch (err) {
      rootThrewSync = true;
      const rawCode = (err as { code?: unknown }).code;
      if (typeof rawCode === 'string') {
        rootCode = rawCode;
      }
    }
    expect(rootThrewSync).toBe(true);
    expect(rootCode).toBe('storage/invalid-root-operation');
  });

  it('storage#53, #55, #56: storage-getbytes-roundtrip-and-cap returns ArrayBuffer and truncates above maxDownloadSize', async () => {
    const obs = load('storage-getbytes-roundtrip-and-cap.json');
    const storage = freshStorage('getbytes-cap');
    const targetRef = ref(storage, 'pyric_oracle/getbytes-cap/payload.bin');
    const payload = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    await uploadBytes(targetRef, payload, { contentType: 'application/octet-stream' });
    expect(payload.byteLength).toBe(obs.uploadedLength as number);

    async function readOutcome(cap?: number) {
      let result: ArrayBuffer;
      if (cap === undefined) {
        result = await getBytes(targetRef);
      } else {
        result = await getBytes(targetRef, cap);
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

    expect(await readOutcome()).toEqual(obs.unbounded);
    expect(await readOutcome(6)).toEqual(obs.truncatedMax6);
    expect(await readOutcome(16)).toEqual(obs.exactMax16);
    expect(await readOutcome(32)).toEqual(obs.aboveMax32);
  });

  it('storage#42, #43, #44: storage-uploadstring-data-url-variants matches MIME inference, percent-decoding, and caller contentType precedence', async () => {
    const obs = load('storage-uploadstring-data-url-variants.json');
    const storage = freshStorage('uploadstring-data-url');

    async function runVariant(
      subpath: string,
      dataUrl: string,
      metadata?: { contentType: string },
    ) {
      const targetRef = ref(storage, `pyric_oracle/${subpath}`);
      const uploaded = await uploadString(targetRef, dataUrl, 'data_url', metadata);
      const fetched = await getMetadata(targetRef);
      const bytes = new Uint8Array(await getBytes(targetRef));
      return {
        size: uploaded.metadata.size,
        uploadedContentType: uploaded.metadata.contentType ?? null,
        fetchedContentType: fetched.contentType ?? null,
        decodedBytes: [...bytes],
        decodedUtf8: new TextDecoder('utf-8').decode(bytes),
      };
    }

    expect(
      await runVariant('data-url/json.json', 'data:application/json;base64,eyJvayI6dHJ1ZX0='),
    ).toEqual(obs.base64JsonDataUrl);
    expect(
      await runVariant('data-url/plain.txt', 'data:text/plain,hello%20world%21'),
    ).toEqual(obs.percentEncodedDataUrl);
    expect(
      await runVariant('data-url/override.csv', 'data:text/plain;base64,YSwx', {
        contentType: 'text/csv',
      }),
    ).toEqual(obs.callerContentTypeOverride);
  });

  it('storage#39, #40: storage-uploadstring-raw-and-base64 defaults raw contentType to application/octet-stream and decodes standard base64', async () => {
    const obs = load('storage-uploadstring-raw-and-base64.json');
    const storage = freshStorage('uploadstring-raw-b64');

    async function runRawOrBase64(subpath: string, value: string, format?: 'raw' | 'base64') {
      const targetRef = ref(storage, `pyric_oracle/${subpath}`);
      let uploaded;
      if (format === undefined) {
        uploaded = await uploadString(targetRef, value);
      } else {
        uploaded = await uploadString(targetRef, value, format);
      }
      const fetched = await getMetadata(targetRef);
      const bytes = new Uint8Array(await getBytes(targetRef));
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

    expect(defaultRaw).toEqual(obs.defaultRaw);
    expect(explicitRaw).toEqual(obs.explicitRaw);
    expect(standardBase64).toEqual(obs.standardBase64);
  });
}
