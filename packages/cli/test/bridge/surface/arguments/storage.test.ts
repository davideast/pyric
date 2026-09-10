/**
 * The `storage` tool's argument vocabulary: the renames, the metadata schema
 * grouping, and the base64 round-trip check that catches a payload pasted
 * raw rather than encoded.
 */
import { describe, expect, it } from 'bun:test';

import {
  contentTypeForPath,
  CROSS_SERVICE_IAM_MODES,
  decodesAsBase64,
  metadata,
  pathArgument,
  RENAMES,
  settableMetadata,
} from '../../../../src/bridge/surface/arguments/storage.js';

describe('the renames', () => {
  it('groups metadata fields and maps payload spellings onto contentBase64', () => {
    expect(RENAMES.ref).toBe('path');
    expect(RENAMES.reference).toBe('path');
    expect(RENAMES.contentType).toBe('metadata.contentType');
    expect(RENAMES.customMetadata).toBe('metadata.customMetadata');
    expect(RENAMES.data).toBe('contentBase64');
    expect(RENAMES.bytes).toBe('contentBase64');
    expect(RENAMES.content).toBe('contentBase64');
    expect(RENAMES.folder).toBe('prefix');
  });

  it('maps the file spellings onto sourcePath and the posture onto mode', () => {
    expect(RENAMES.file).toBe('sourcePath');
    expect(RENAMES.filePath).toBe('sourcePath');
    expect(RENAMES.localPath).toBe('sourcePath');
    expect(RENAMES.crossServiceIam).toBe('mode');
    expect(RENAMES.bucketId).toBe('bucket');
  });
});

describe('settableMetadata', () => {
  it('accepts every client-settable field the SDK groups', () => {
    const parsed = settableMetadata.safeParse({
      contentType: 'text/plain',
      customMetadata: { owner: 'alice' },
      cacheControl: 'max-age=60',
      contentDisposition: 'inline',
      contentEncoding: 'gzip',
      contentLanguage: 'en',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a server-set field, which an update cannot write', () => {
    expect(settableMetadata.safeParse({ size: 12 }).success).toBe(true);
    expect(settableMetadata.safeParse({ contentType: 12 }).success).toBe(false);
  });
});

describe('CROSS_SERVICE_IAM_MODES', () => {
  it('names the two postures a project can be in', () => {
    expect([...CROSS_SERVICE_IAM_MODES]).toEqual(['granted', 'denied']);
  });
});

describe('contentTypeForPath', () => {
  it('reads the type off a known extension, whatever its case', () => {
    expect(contentTypeForPath('uploads/report.csv')).toBe('text/csv');
    expect(contentTypeForPath('uploads/logo.PNG')).toBe('image/png');
  });

  it('infers nothing from an unknown or absent extension', () => {
    expect(contentTypeForPath('uploads/archive.dat')).toBeNull();
    expect(contentTypeForPath('uploads/README')).toBeNull();
    expect(contentTypeForPath('uploads/trailing.')).toBeNull();
  });
});

describe('pathArgument and metadata', () => {
  it('requires the path as a string', () => {
    expect(pathArgument.safeParse('uploads/pic.png').success).toBe(true);
    expect(pathArgument.safeParse(undefined).success).toBe(false);
  });

  it('makes metadata and its two fields optional', () => {
    expect(metadata.safeParse(undefined).success).toBe(true);
    expect(
      metadata.safeParse({ contentType: 'image/png', customMetadata: { owner: 'alice' } })
        .success,
    ).toBe(true);
  });
});

describe('decodesAsBase64', () => {
  it('accepts the empty string', () => {
    expect(decodesAsBase64('')).toBe(true);
  });

  it('accepts a value that round trips through base64', () => {
    expect(decodesAsBase64(Buffer.from('hello').toString('base64'))).toBe(true);
  });

  it('rejects a value with characters outside the base64 alphabet', () => {
    expect(decodesAsBase64('not base64!!')).toBe(false);
  });

  it('rejects a value whose length is not a multiple of four', () => {
    expect(decodesAsBase64('abcde')).toBe(false);
  });
});
