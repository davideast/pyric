/**
 * The `request.resource` one Storage simulate case builds for its verb. The
 * verdicts these bindings produce, checked against the in-page plane, are
 * `storage.test.ts`'s subject; this file pins the bindings themselves.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref } from 'pyric/storage';
import type { StoredMetadata } from 'pyric/storage/internal';

import { simulatedRequestResource } from '../../../../src/bridge/surface/rules-engines/storage-request-resource.js';

const object = ref(getStorageSandbox(initializeSandbox()), 'docs/readme.txt');

const STORED: StoredMetadata = {
  fullPath: 'docs/readme.txt',
  name: 'readme.txt',
  bucket: object.bucket,
  generation: '7',
  metageneration: '2',
  timeCreated: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  size: 11,
  contentType: 'text/plain',
  customMetadata: { owner: 'alice' },
};

function built(operation: string, data: unknown, existing?: StoredMetadata) {
  const outcome = simulatedRequestResource(object, operation, data, existing);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.resource;
}

function refusal(operation: string, data: unknown): string {
  const outcome = simulatedRequestResource(object, operation, data, undefined);
  if (outcome.ok) throw new Error('expected a refusal');
  return outcome.reason;
}

describe('create', () => {
  it('builds an upload from the case alone, ignoring the stored object', () => {
    expect(built('create', { contentType: 'image/png', size: 5 }, STORED)).toEqual({
      name: 'docs/readme.txt',
      bucket: object.bucket,
      size: 5,
      contentType: 'image/png',
      contentDisposition: "inline; filename*=utf-8''readme.txt",
      contentEncoding: 'identity',
      contentLanguage: null,
      cacheControl: null,
      metadata: null,
      generation: null,
      metageneration: null,
      etag: null,
    });
  });

  it('gives an upload with no data the upload defaults', () => {
    const resource = built('create', undefined);
    expect(resource?.size).toBe(0);
    expect(resource?.contentType).toBe('application/octet-stream');
    expect(resource?.metadata).toBeNull();
  });

  it('treats the write umbrella as an upload', () => {
    expect(built('write', { size: 3 })?.generation).toBeNull();
  });

  it('accepts customMetadata as the spelling of metadata', () => {
    expect(built('create', { customMetadata: { owner: 'bob' } })?.metadata).toEqual({ owner: 'bob' });
  });
});

describe('update', () => {
  it('builds from the stored object when the case passes no data', () => {
    const resource = built('update', undefined, STORED);
    expect(resource?.size).toBe(11);
    expect(resource?.contentType).toBe('text/plain');
    expect(resource?.metadata).toEqual({ owner: 'alice' });
    expect(resource?.generation).toBe(7);
    expect(resource?.metageneration).toBe(2);
  });

  it('patches the stored object with the fields the case names', () => {
    const resource = built('update', { contentType: 'text/markdown', cacheControl: null }, STORED);
    expect(resource?.contentType).toBe('text/markdown');
    expect(resource?.cacheControl).toBeNull();
    expect(resource?.metadata).toEqual({ owner: 'alice' });
  });
});

describe('reads and deletes', () => {
  for (const operation of ['get', 'list', 'delete', 'read']) {
    it(`builds none for ${operation}, and refuses data`, () => {
      expect(built(operation, undefined, STORED)).toBeUndefined();
      expect(refusal(operation, {})).toBe(`a ${operation} request carries no request.resource; remove 'data'.`);
    });
  }
});

describe('field checks', () => {
  it('reads a numeric string size as its number', () => {
    expect(built('create', { size: '999999' })?.size).toBe(999999);
  });

  it('refuses an unknown field by name', () => {
    expect(refusal('create', { sise: 1 })).toStartWith('data.sise is not a field of request.resource.');
  });

  it('refuses a wrong-typed field by name', () => {
    expect(refusal('create', { size: '12kb' })).toBe('data.size must be a number or a numeric string, and it is a string.');
    expect(refusal('create', { contentType: 5 })).toBe('data.contentType must be a string, and it is a number.');
    expect(refusal('create', { metadata: ['a'] })).toBe('data.metadata must be a map of strings, and it is an array.');
    expect(refusal('create', { metadata: { owner: 5 } })).toBe('data.metadata.owner must be a string, and it is a number.');
    expect(refusal('create', { etag: 'abc' })).toBe('data.etag can only be null, and it is a string.');
  });

  it('refuses metadata and customMetadata together', () => {
    expect(refusal('create', { metadata: {}, customMetadata: {} })).toBe(
      'Pass data.metadata or data.customMetadata, not both.',
    );
  });
});
