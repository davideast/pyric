/**
 * Oracle conformance replay cases for `getMetadata` and `updateMetadata` (`storage#79..85, #87, #88`):
 *   - `client-storage-getmetadata-root-ref` (`storage#81`)
 *   - `client-storage-updatemetadata-root-ref` (`storage#88`)
 *   - `storage-getmetadata-full-shape` (`storage#79`)
 *   - `storage-metadata-missing-object-errors` (`storage#80, #87`)
 *   - `storage-updatemetadata-fields-and-bytes` (`storage#82, #85`)
 *   - `storage-updatemetadata-versioning-and-timestamps` (`storage#83, #84`)
 */
import { expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  getBytes,
  getMetadata,
  getStorageSandbox,
  ref,
  updateMetadata,
  uploadBytes,
  type FirebaseStorage,
  type FullMetadata,
} from '../../src/storage/index.js';

export interface OracleMetadataSuiteContext {
  load: (name: string) => Record<string, unknown>;
  freshStorage: (label: string, rules?: string) => FirebaseStorage;
}

const OPEN_METADATA_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

interface SettableShapeExpectation {
  size: number;
  contentType: string;
  cacheControl: string;
  contentDisposition: string;
  contentEncoding: string;
  contentLanguage: string;
  customMetadata: Record<string, string>;
}

function assertSettableShape(actual: FullMetadata, expected: SettableShapeExpectation): void {
  expect(actual.size).toBe(expected.size);
  expect(actual.contentType).toBe(expected.contentType);
  expect(actual.cacheControl).toBe(expected.cacheControl);
  expect(actual.contentDisposition).toBe(expected.contentDisposition);
  expect(actual.contentEncoding).toBe(expected.contentEncoding);
  expect(actual.contentLanguage).toBe(expected.contentLanguage);
  expect(actual.customMetadata).toEqual(expected.customMetadata);
}

export function registerOracleMetadataSuite({
  load,
  freshStorage,
}: OracleMetadataSuiteContext): void {
  it('storage#81, #88: client-storage-getmetadata-root-ref and client-storage-updatemetadata-root-ref throw synchronously on the root reference', () => {
    const getRootObs = load('client-storage-getmetadata-root-ref.json');
    const updateRootObs = load('client-storage-updatemetadata-root-ref.json');
    const storage = freshStorage('metadata-root');
    const rootRef = ref(storage);

    expect(rootRef.fullPath).toBe(getRootObs.rootFullPath as string);
    expect(rootRef.name).toBe(getRootObs.rootName as string);
    expect(getRootObs.isFirebaseError).toBe(true);
    expect(getRootObs.errorName).toBe('FirebaseError');
    expect(getRootObs.fetchCalls).toBe(0);
    expect((getRootObs.message as string).length).toBeGreaterThan(0);

    let getThrewSync = false;
    let getCode: string | null = null;
    try {
      void getMetadata(rootRef);
    } catch (err) {
      getThrewSync = true;
      expect(err).toBeInstanceOf(Error);
      getCode = String((err as { code?: unknown }).code);
    }
    expect(getThrewSync).toBe(getRootObs.threwSynchronously as boolean);
    expect(getThrewSync).toBe(getRootObs.threw as boolean);
    expect(getCode).toBe(getRootObs.code as string);

    expect(rootRef.fullPath).toBe(updateRootObs.rootFullPath as string);
    expect(rootRef.name).toBe(updateRootObs.rootName as string);
    expect(updateRootObs.isFirebaseError).toBe(true);
    expect(updateRootObs.errorName).toBe('FirebaseError');
    expect(updateRootObs.fetchCalls).toBe(0);
    expect((updateRootObs.message as string).length).toBeGreaterThan(0);

    let updateThrewSync = false;
    let updateCode: string | null = null;
    try {
      void updateMetadata(rootRef, { contentType: 'text/plain' });
    } catch (err) {
      updateThrewSync = true;
      expect(err).toBeInstanceOf(Error);
      updateCode = String((err as { code?: unknown }).code);
    }
    expect(updateThrewSync).toBe(updateRootObs.threwSynchronously as boolean);
    expect(updateThrewSync).toBe(updateRootObs.threw as boolean);
    expect(updateCode).toBe(updateRootObs.code as string);
  });

  it('storage#79: storage-getmetadata-full-shape replays FullMetadata parity between uploadBytes and getMetadata', async () => {
    const obs = load('storage-getmetadata-full-shape.json');
    const storage = freshStorage('metadata-full-shape');
    const upExpected = obs.uploadedShape as SettableShapeExpectation & {
      name: string;
      scrubbedFullPath: string;
      metageneration: string;
      bucketMatchesHandle: boolean;
      generationIsDigits: boolean;
    };
    const fetchedExpected = obs.fetchedShape as SettableShapeExpectation & {
      name: string;
      scrubbedFullPath: string;
      metageneration: string;
      bucketMatchesHandle: boolean;
      generationIsDigits: boolean;
      generationMatchesUpload: boolean;
      timeCreatedMatchesUpload: boolean;
      updatedMatchesUpload: boolean;
    };

    const targetRef = ref(storage, upExpected.scrubbedFullPath);
    const payload = new Uint8Array([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x31, 0x7d]);
    const uploaded = await uploadBytes(targetRef, payload, {
      contentType: upExpected.contentType,
      cacheControl: upExpected.cacheControl,
      contentDisposition: upExpected.contentDisposition,
      contentEncoding: upExpected.contentEncoding,
      contentLanguage: upExpected.contentLanguage,
      customMetadata: upExpected.customMetadata,
    });
    const fetched = await getMetadata(targetRef);

    expect(uploaded.metadata.name).toBe(upExpected.name);
    expect(uploaded.metadata.fullPath).toBe(upExpected.scrubbedFullPath);
    expect(uploaded.metadata.metageneration).toBe(upExpected.metageneration);
    expect(uploaded.metadata.bucket === targetRef.bucket).toBe(upExpected.bucketMatchesHandle);
    expect(/^\d+$/.test(uploaded.metadata.generation)).toBe(upExpected.generationIsDigits);
    assertSettableShape(uploaded.metadata, upExpected);

    expect(fetched.name).toBe(fetchedExpected.name);
    expect(fetched.fullPath).toBe(fetchedExpected.scrubbedFullPath);
    expect(fetched.metageneration).toBe(fetchedExpected.metageneration);
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
    assertSettableShape(fetched, fetchedExpected);
  });

  it('storage#80, #87: storage-metadata-missing-object-errors replays object-not-found on getMetadata and unauthorized on rules-governed updateMetadata', async () => {
    const obs = load('storage-metadata-missing-object-errors.json');
    const getExpected = obs.getMetadataMissing as {
      threw: boolean;
      code: string;
      errorName: string;
      isFirebaseError: boolean;
    };
    const updateExpected = obs.updateMetadataMissing as {
      threw: boolean;
      code: string;
      errorName: string;
      isFirebaseError: boolean;
    };
    expect(getExpected.isFirebaseError).toBe(true);
    expect(getExpected.errorName).toBe('FirebaseError');
    expect(updateExpected.isFirebaseError).toBe(true);
    expect(updateExpected.errorName).toBe('FirebaseError');

    const storage = freshStorage('metadata-missing');
    const missingRef = ref(storage, 'pyric_oracle/<runId>/metadata-missing/does-not-exist.bin');

    let getCode: string | null = null;
    try {
      await getMetadata(missingRef);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      getCode = String((err as { code?: unknown }).code);
    }
    expect(getCode !== null).toBe(getExpected.threw);
    expect(getCode).toBe(getExpected.code);

    let updateCode: string | null = null;
    try {
      await updateMetadata(missingRef, { contentType: 'text/plain' });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      updateCode = String((err as { code?: unknown }).code);
    }
    expect(updateCode !== null).toBe(updateExpected.threw);
    expect(updateCode).toBe(updateExpected.code);
  });

  it('storage#82, #85: storage-updatemetadata-fields-and-bytes replays settable field updates, customMetadata merge, and byte preservation', async () => {
    const obs = load('storage-updatemetadata-fields-and-bytes.json');
    const initialBytes = obs.initialBytes as number[];
    const beforeExpected = obs.beforeUpdate as SettableShapeExpectation;
    const updateExpected = obs.updateReturn as SettableShapeExpectation;
    const afterGetExpected = obs.afterGetMetadata as SettableShapeExpectation;
    const afterReadBytesExpected = obs.afterReadBytes as number[];

    const storage = freshStorage('metadata-fields-bytes');
    const targetRef = ref(storage, 'pyric_oracle/<runId>/metadata-fields/item.bin');
    const uploaded = await uploadBytes(targetRef, new Uint8Array(initialBytes), {
      contentType: beforeExpected.contentType,
      cacheControl: beforeExpected.cacheControl,
      contentDisposition: beforeExpected.contentDisposition,
      contentEncoding: beforeExpected.contentEncoding,
      contentLanguage: beforeExpected.contentLanguage,
      customMetadata: beforeExpected.customMetadata,
    });
    assertSettableShape(uploaded.metadata, beforeExpected);

    const updated = await updateMetadata(targetRef, {
      contentType: updateExpected.contentType,
      cacheControl: updateExpected.cacheControl,
      contentDisposition: updateExpected.contentDisposition,
      contentEncoding: updateExpected.contentEncoding,
      contentLanguage: updateExpected.contentLanguage,
      customMetadata: { k2: 'v2-next', k3: 'v3' },
    });
    assertSettableShape(updated, updateExpected);

    const fetched = await getMetadata(targetRef);
    assertSettableShape(fetched, afterGetExpected);

    const readBytes = Array.from(new Uint8Array(await getBytes(targetRef)));
    expect(readBytes).toEqual(afterReadBytesExpected);
  });

  it('storage#83, #84: storage-updatemetadata-versioning-and-timestamps replays +1 metageneration bumps, pinned generation/timeCreated, and advancing updated', async () => {
    const obs = load('storage-updatemetadata-versioning-and-timestamps.json');
    const sandbox = initializeSandbox({ clock: { mode: 'manual', startAt: '2026-01-01T00:00:00.000Z' } });
    const clock = getClock(sandbox);
    const storage = getStorageSandbox(sandbox, {
      dbName: `pyric-metadata-versioning-${Math.random().toString(36).slice(2, 10)}`,
      rules: OPEN_METADATA_RULES,
    });
    const targetRef = ref(storage, 'pyric_oracle/<runId>/metadata-versioning/item.bin');

    const uploaded = await uploadBytes(targetRef, new Uint8Array([1, 2, 3, 4]), {
      contentType: 'text/plain',
    });
    clock.advance(50);
    const first = await updateMetadata(targetRef, { customMetadata: { step: '1' } });
    clock.advance(50);
    const second = await updateMetadata(targetRef, { customMetadata: { step: '2' } });

    expect(uploaded.metadata.metageneration).toBe(obs.initialMetageneration as string);
    expect(first.metageneration).toBe(obs.firstUpdateMetageneration as string);
    expect(second.metageneration).toBe(obs.secondUpdateMetageneration as string);
    expect(/^\d+$/.test(uploaded.metadata.generation)).toBe(obs.generationIsDigits as boolean);
    expect(
      first.generation === uploaded.metadata.generation &&
        second.generation === uploaded.metadata.generation,
    ).toBe(obs.generationPinnedAcrossUpdates as boolean);
    expect(
      first.timeCreated === uploaded.metadata.timeCreated &&
        second.timeCreated === uploaded.metadata.timeCreated,
    ).toBe(obs.timeCreatedPinnedAcrossUpdates as boolean);

    const tCreated = Date.parse(uploaded.metadata.timeCreated);
    const t0 = Date.parse(uploaded.metadata.updated);
    const t1 = Date.parse(first.updated);
    const t2 = Date.parse(second.updated);
    expect(
      Number.isFinite(tCreated) && Number.isFinite(t0) && Number.isFinite(t1) && Number.isFinite(t2),
    ).toBe(obs.isoTimestampsValid as boolean);
    expect(t1 >= tCreated).toBe(obs.firstUpdatedNotBeforeTimeCreated as boolean);
    expect(t1 >= t0).toBe(obs.firstUpdatedNotBeforeInitialUpdated as boolean);
    expect(t2 > t0).toBe(obs.secondUpdatedStrictlyAfterInitialUpdated as boolean);
    expect(t2 >= t1).toBe(obs.secondUpdatedNotBeforeFirstUpdated as boolean);
  });
}
