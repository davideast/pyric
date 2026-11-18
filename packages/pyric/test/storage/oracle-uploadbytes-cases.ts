/**
 * Oracle conformance replay cases for `uploadBytes` (`storage#24..35, #38, #118`):
 *   - `client-storage-uploadbytes-root-ref` (`storage#31`)
 *   - `storage-uploadbytes-payload-types` (`storage#24, #25, #26, #32, #33, #34`)
 *   - `storage-uploadbytes-contenttype-precedence` (`storage#27, #28, #30`)
 *   - `storage-uploadbytes-custom-metadata` (`storage#29`)
 *   - `storage-uploadbytes-overwrite-generations` (`storage#35, #38, #118`)
 */
import { expect, it } from 'bun:test';
import {
  getBytes,
  getMetadata,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from '../../src/storage/index.js';

export interface OracleUploadBytesSuiteContext {
  load: (name: string) => Record<string, unknown>;
  freshStorage: (label: string) => FirebaseStorage;
}

interface PayloadRecordedCase {
  resultRefMatchesTarget: boolean;
  metadataFullPathMatchesTarget: boolean;
  metadataNameMatchesTarget: boolean;
  metadataName: string;
  metadataBucketMatchesHandle: boolean;
  metadataBucketNonEmpty: boolean;
  metadataSize: number;
  readBytes: number[];
}

interface ContentTypeRecordedCase {
  uploadContentType: string;
  storedContentType: string;
  size: number;
  readBytes: number[];
}

export function registerOracleUploadBytesSuite(ctx: OracleUploadBytesSuiteContext): void {
  it('storage#31: uploadBytes(ref(storage), data) throws storage/invalid-root-operation synchronously', () => {
    const obs = ctx.load('client-storage-uploadbytes-root-ref.json');
    const storage = ctx.freshStorage('uploadbytes-root-ref');
    const rootRef = ref(storage);
    expect(rootRef.fullPath).toBe(obs.rootFullPath as string);
    expect(rootRef.name).toBe(obs.rootName as string);

    let threw = false;
    let threwSynchronously = false;
    let caughtCode: string | null = null;
    try {
      uploadBytes(rootRef, new Uint8Array([0x01])).catch(() => {});
    } catch (err) {
      threw = true;
      threwSynchronously = true;
      const code = (err as { code?: string }).code;
      if (typeof code === 'string') {
        caughtCode = code;
      }
    }
    expect(threw).toBe(obs.threw as boolean);
    expect(threwSynchronously).toBe(obs.threwSynchronously as boolean);
    expect(caughtCode).toBe(obs.code as string);
  });

  it('storage#24, #25, #26, #32, #33, #34: uploadBytes accepts Blob, Uint8Array, and ArrayBuffer and populates UploadResult metadata', async () => {
    const obs = ctx.load('storage-uploadbytes-payload-types.json');
    const inputBytes = obs.inputBytes as number[];
    const raw = new Uint8Array(inputBytes);
    const storage = ctx.freshStorage('uploadbytes-payloads');
    const handleBucket = ref(storage).bucket;

    const padded = new ArrayBuffer(8);
    new Uint8Array(padded).set([99, 98, ...inputBytes, 97, 96]);
    const slicedBuffer = padded.slice(2, 6);

    const cases: Array<{
      subpath: string;
      data: Blob | Uint8Array | ArrayBuffer;
      recorded: PayloadRecordedCase;
    }> = [
      {
        subpath: 'uploadbytes-payloads/from-blob.bin',
        data: new Blob([raw]),
        recorded: obs.blobPayload as PayloadRecordedCase,
      },
      {
        subpath: 'uploadbytes-payloads/from-uint8array.bin',
        data: raw,
        recorded: obs.uint8ArrayPayload as PayloadRecordedCase,
      },
      {
        subpath: 'uploadbytes-payloads/from-arraybuffer.bin',
        data: slicedBuffer,
        recorded: obs.arrayBufferPayload as PayloadRecordedCase,
      },
    ];

    for (const entry of cases) {
      const target = ref(storage, entry.subpath);
      const uploaded = await uploadBytes(target, entry.data);
      const readBuf = await getBytes(target);
      expect(uploaded.ref.fullPath === target.fullPath).toBe(entry.recorded.resultRefMatchesTarget);
      expect(uploaded.metadata.fullPath === target.fullPath).toBe(
        entry.recorded.metadataFullPathMatchesTarget,
      );
      expect(uploaded.metadata.name === target.name).toBe(entry.recorded.metadataNameMatchesTarget);
      expect(uploaded.metadata.name).toBe(entry.recorded.metadataName);
      expect(uploaded.metadata.bucket === handleBucket).toBe(
        entry.recorded.metadataBucketMatchesHandle,
      );
      expect(uploaded.metadata.bucket.length > 0).toBe(entry.recorded.metadataBucketNonEmpty);
      expect(uploaded.metadata.size).toBe(entry.recorded.metadataSize);
      expect(Array.from(new Uint8Array(readBuf))).toEqual(entry.recorded.readBytes);
    }
  });

  it('storage#27, #28, #30: uploadBytes resolves contentType precedence and rewraps empty/typed Blobs without altering bytes', async () => {
    const obs = ctx.load('storage-uploadbytes-contenttype-precedence.json');
    const raw = new Uint8Array(obs.expectedBytes as number[]);
    const storage = ctx.freshStorage('uploadbytes-contenttype');

    const cases: Array<{
      subpath: string;
      data: Blob | Uint8Array;
      metadata?: { contentType?: string };
      recorded: ContentTypeRecordedCase;
    }> = [
      {
        subpath: 'uploadbytes-ct/empty-blob-no-hint.bin',
        data: new Blob([raw]),
        recorded: obs.emptyBlobNoHint as ContentTypeRecordedCase,
      },
      {
        subpath: 'uploadbytes-ct/typed-blob-no-hint.png',
        data: new Blob([raw], { type: 'image/png' }),
        recorded: obs.typedBlobNoHint as ContentTypeRecordedCase,
      },
      {
        subpath: 'uploadbytes-ct/typed-blob-override.pdf',
        data: new Blob([raw], { type: 'image/png' }),
        metadata: { contentType: 'application/pdf' },
        recorded: obs.typedBlobCallerOverride as ContentTypeRecordedCase,
      },
      {
        subpath: 'uploadbytes-ct/empty-blob-hint.wav',
        data: new Blob([raw]),
        metadata: { contentType: 'audio/wav' },
        recorded: obs.emptyBlobCallerHint as ContentTypeRecordedCase,
      },
      {
        subpath: 'uploadbytes-ct/uint8-no-hint.bin',
        data: raw,
        recorded: obs.uint8NoHint as ContentTypeRecordedCase,
      },
    ];

    for (const entry of cases) {
      const target = ref(storage, entry.subpath);
      const uploaded = await uploadBytes(target, entry.data, entry.metadata);
      const storedMeta = await getMetadata(target);
      const downloaded = await getBytes(target);
      expect(uploaded.metadata.contentType).toBe(entry.recorded.uploadContentType);
      expect(storedMeta.contentType).toBe(entry.recorded.storedContentType);
      expect(uploaded.metadata.size).toBe(entry.recorded.size);
      expect(Array.from(new Uint8Array(downloaded))).toEqual(entry.recorded.readBytes);
    }
  });

  it('storage#29: uploadBytes omits customMetadata when unset and round-trips customMetadata keys when supplied', async () => {
    const obs = ctx.load('storage-uploadbytes-custom-metadata.json');
    const withoutExpected = obs.withoutCustomMetadata as {
      uploadHasCustomMetadataProperty: boolean;
      uploadCustomMetadata: null;
      getMetadataCustomMetadata: null;
    };
    const withExpected = obs.withCustomMetadata as {
      uploadHasCustomMetadataProperty: boolean;
      uploadCustomMetadata: Record<string, string>;
      getMetadataCustomMetadata: Record<string, string>;
    };

    const storage = ctx.freshStorage('uploadbytes-custom-meta');
    const plainRef = ref(storage, 'uploadbytes-meta/without-custom.bin');
    const plainUp = await uploadBytes(plainRef, new Uint8Array([0x6d, 0x65, 0x74, 0x61]));
    const plainMeta = await getMetadata(plainRef);
    expect('customMetadata' in plainUp.metadata).toBe(
      withoutExpected.uploadHasCustomMetadataProperty,
    );
    expect(withoutExpected.uploadCustomMetadata).toBeNull();
    expect(plainUp.metadata.customMetadata).toBeUndefined();
    expect('customMetadata' in plainMeta).toBe(withoutExpected.uploadHasCustomMetadataProperty);
    expect(withoutExpected.getMetadataCustomMetadata).toBeNull();
    expect(plainMeta.customMetadata).toBeUndefined();

    const richRef = ref(storage, 'uploadbytes-meta/with-custom.bin');
    const richUp = await uploadBytes(richRef, new Uint8Array([0x6d, 0x65, 0x74, 0x61]), {
      customMetadata: withExpected.uploadCustomMetadata,
    });
    const richMeta = await getMetadata(richRef);
    expect('customMetadata' in richUp.metadata).toBe(withExpected.uploadHasCustomMetadataProperty);
    expect(richUp.metadata.customMetadata).toEqual(withExpected.uploadCustomMetadata);
    expect(richMeta.customMetadata).toEqual(withExpected.getMetadataCustomMetadata);
  });

  it('storage#35, #38, #118: uploadBytes overwrites bytes/metadata, sets metageneration "1", and strictly advances decimal generation', async () => {
    const obs = ctx.load('storage-uploadbytes-overwrite-generations.json');
    const firstExpected = obs.firstUpload as {
      size: number;
      contentType: string;
      customMetadata: Record<string, string>;
      generationIsDecimalDigits: boolean;
      metageneration: string;
    };
    const secondExpected = obs.secondUpload as {
      size: number;
      contentType: string;
      customMetadata: Record<string, string>;
      generationIsDecimalDigits: boolean;
      metageneration: string;
    };
    const afterExpected = obs.afterOverwriteGetMetadata as {
      size: number;
      contentType: string;
      customMetadata: Record<string, string>;
      generationMatchesSecondUpload: boolean;
      metageneration: string;
    };

    const storage = ctx.freshStorage('uploadbytes-overwrite');
    const target = ref(storage, 'uploadbytes-overwrite/versioned.bin');

    const first = await uploadBytes(target, new Uint8Array([1, 2, 3, 4, 5, 6, 7]), {
      contentType: firstExpected.contentType,
      customMetadata: firstExpected.customMetadata,
    });
    expect(first.metadata.size).toBe(firstExpected.size);
    expect(/^\d+$/.test(first.metadata.generation)).toBe(firstExpected.generationIsDecimalDigits);
    expect(first.metadata.metageneration).toBe(firstExpected.metageneration);

    const second = await uploadBytes(target, new Uint8Array(obs.afterOverwriteReadBytes as number[]), {
      contentType: secondExpected.contentType,
      customMetadata: secondExpected.customMetadata,
    });
    expect(second.metadata.size).toBe(secondExpected.size);
    expect(/^\d+$/.test(second.metadata.generation)).toBe(secondExpected.generationIsDecimalDigits);
    expect(second.metadata.metageneration).toBe(secondExpected.metageneration);
    expect(second.metadata.generation !== first.metadata.generation).toBe(
      obs.generationChanged as boolean,
    );
    expect(BigInt(second.metadata.generation) > BigInt(first.metadata.generation)).toBe(
      obs.generationStrictlyIncreased as boolean,
    );

    const readBytes = Array.from(new Uint8Array(await getBytes(target)));
    expect(readBytes).toEqual(obs.afterOverwriteReadBytes as number[]);

    const stored = await getMetadata(target);
    expect(stored.size).toBe(afterExpected.size);
    expect(stored.contentType).toBe(afterExpected.contentType);
    expect(stored.customMetadata).toEqual(afterExpected.customMetadata);
    expect(stored.generation === second.metadata.generation).toBe(
      afterExpected.generationMatchesSecondUpload,
    );
    expect(stored.metageneration).toBe(afterExpected.metageneration);
  });
}
