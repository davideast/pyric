/**
 * Deferred members: single methods and values of a mirrored subpath that the
 * sandbox does not model. A call fails with a `PyricDeferredApiError` naming
 * the member, in the form its upstream method fails (a throw, or a rejected
 * promise), and every deferred value carries the brand a surface check reads.
 */
import { describe, expect, test } from 'bun:test';
import {
  defineDeferredMembers,
  deferredEntry,
  deferredExport,
  deferredMember,
  isDeferredApi,
  PyricDeferredApiError,
} from '../../src/app/internal.js';

describe('deferredMember', () => {
  test('a sync member throws a PyricDeferredApiError naming it', () => {
    const method = deferredMember('pyric-admin/storage', 'File.copy', 'sync');
    expect(() => method()).toThrow(PyricDeferredApiError);
    expect(() => method()).toThrow(
      'pyric-admin/storage: File.copy is not implemented in pyric-admin/storage sandbox backend.',
    );
    expect(method.name).toBe('copy');
  });

  test('an async member returns a rejected promise instead of throwing', async () => {
    const method = deferredMember('pyric-admin/storage', 'Bucket.getFiles', 'async');
    const result = method();
    expect(result).toBeInstanceOf(Promise);
    const error = await (result as Promise<never>).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PyricDeferredApiError);
    expect((error as PyricDeferredApiError).symbol).toBe('Bucket.getFiles');
    expect((error as PyricDeferredApiError).subpath).toBe('pyric-admin/storage');
  });
});

describe('defineDeferredMembers', () => {
  class Handle {
    save(): string {
      return 'saved';
    }
  }

  test('defines each listed name the target lacks, and leaves implemented names alone', () => {
    defineDeferredMembers(Handle.prototype, 'pyric-admin/storage', 'File', {
      sync: ['save', 'publicUrl'],
      async: ['copy'],
    });
    const handle = new Handle() as Handle & Record<string, () => unknown>;
    expect(handle.save()).toBe('saved');
    expect(isDeferredApi(handle.save)).toBe(false);
    expect(isDeferredApi(handle.publicUrl)).toBe(true);
    expect(isDeferredApi(handle.copy)).toBe(true);
    expect(() => handle.publicUrl!()).toThrow('File.publicUrl is not implemented');
    expect(Object.keys(handle)).toEqual([]);
  });
});

describe('the deferred brand', () => {
  test('marks deferred exports and deferred entry exports, not ordinary functions', () => {
    const geoPoint = deferredExport('pyric-admin/firestore', 'GeoPoint');
    expect(isDeferredApi(geoPoint)).toBe(true);
    expect(() => new (geoPoint as unknown as new () => unknown)()).toThrow('GeoPoint is not implemented');
    expect(() => (geoPoint as unknown as Record<string, unknown>).latitude).toThrow(PyricDeferredApiError);
    expect(isDeferredApi(deferredEntry('functions').getFunctions)).toBe(true);
    expect(isDeferredApi(() => undefined)).toBe(false);
    expect(isDeferredApi(undefined)).toBe(false);
  });
});
