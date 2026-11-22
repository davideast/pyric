/**
 * Regression suite for #1961: untyped `uploadString(ref, value)` and
 * `uploadString(ref, value, 'raw')` default `contentType` to
 * `application/octet-stream` in stored metadata, `getMetadata`, and Storage
 * Security Rules (`request.resource.contentType` and `resource.contentType`),
 * matching `@firebase/storage` 0.14.5 `determineContentType_`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getBytes,
  getMetadata,
  getStorageSandbox,
  ref,
  StorageError,
  uploadString,
} from '../../src/storage/index.js';

const OCTET_ONLY_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /strict-octet/{file} {
      allow create: if request.resource.contentType == 'application/octet-stream';
      allow read: if resource.contentType == 'application/octet-stream';
    }
  }
}`;

function uniqueDbName(label: string): string {
  return `pyric-1961-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('uploadString raw default contentType (#1961)', () => {
  it('stores application/octet-stream when format and metadata are omitted', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName('omitted'),
      rules: OCTET_ONLY_RULES,
    });
    const targetRef = ref(storage, 'strict-octet/untyped.bin');

    const uploaded = await uploadString(targetRef, 'x');
    expect(uploaded.metadata.contentType).toBe('application/octet-stream');

    const fetched = await getMetadata(targetRef);
    expect(fetched.contentType).toBe('application/octet-stream');

    const rawBytes = new Uint8Array(await getBytes(targetRef));
    expect(new TextDecoder().decode(rawBytes)).toBe('x');
  });

  it('stores application/octet-stream for explicit raw format with empty or undefined contentType', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName('explicit-raw'),
      rules: OCTET_ONLY_RULES,
    });

    const emptyMetaRef = ref(storage, 'strict-octet/empty-meta.bin');
    const emptyMetaResult = await uploadString(emptyMetaRef, 'hello', 'raw', {});
    expect(emptyMetaResult.metadata.contentType).toBe('application/octet-stream');

    const blankTypeRef = ref(storage, 'strict-octet/blank-type.bin');
    const blankTypeResult = await uploadString(blankTypeRef, 'hello', 'raw', { contentType: '' });
    expect(blankTypeResult.metadata.contentType).toBe('application/octet-stream');
  });

  it('preserves explicit caller contentType overrides and rejects non-matching rules', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName('override'),
      rules: OCTET_ONLY_RULES,
    });
    const textRef = ref(storage, 'strict-octet/text.txt');

    let caught: unknown;
    try {
      await uploadString(textRef, 'hello', 'raw', { contentType: 'text/plain;charset=utf-8' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).code).toBe('storage/unauthorized');
  });
});
