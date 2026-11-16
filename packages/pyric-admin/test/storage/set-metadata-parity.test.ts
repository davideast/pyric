/**
 * Behavioral parity tests for `File.setMetadata()` null clearing and own
 * `"__proto__"` custom metadata preservation across both in-process and
 * SharedWorker remote arms.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps } from '../../src/app/index.js';
import { getStorage } from '../../src/storage/index.js';
import { STORAGE_ARMS } from './arms.ts';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each(STORAGE_ARMS)('File.setMetadata null clearing and proto-safe custom metadata (%s)', (_arm, open) => {
  it('clears previously settable metadata fields when patched with null and preserves unspecified fields', async () => {
    const file = getStorage(open()).bucket().file('docs/item-1.txt');
    await file.save('payload', {
      contentType: 'text/plain',
      metadata: {
        cacheControl: 'public, max-age=60',
        contentDisposition: 'inline',
        contentEncoding: 'gzip',
        contentLanguage: 'en',
        metadata: { k1: 'v1' },
      },
    });

    const [before] = await file.getMetadata();
    expect(before.cacheControl).toBe('public, max-age=60');
    expect(before.contentDisposition).toBe('inline');
    expect(before.contentEncoding).toBe('gzip');
    expect(before.contentLanguage).toBe('en');
    expect(before.contentType).toBe('text/plain');

    const [clearedSome] = await file.setMetadata({
      cacheControl: null,
      contentDisposition: null,
      contentEncoding: null,
    });
    expect(clearedSome.cacheControl).toBeUndefined();
    expect(clearedSome.contentDisposition).toBeUndefined();
    expect(clearedSome.contentEncoding).toBeUndefined();
    expect(clearedSome.contentLanguage).toBe('en');
    expect(clearedSome.contentType).toBe('text/plain');
    expect(clearedSome.metadata?.k1).toBe('v1');

    const [clearedRest] = await file.setMetadata({
      contentLanguage: null,
      contentType: null,
    });
    expect(clearedRest.contentLanguage).toBeUndefined();
    expect(clearedRest.contentType).toBeUndefined();

    const [reRead] = await file.getMetadata();
    expect(reRead.cacheControl).toBeUndefined();
    expect(reRead.contentDisposition).toBeUndefined();
    expect(reRead.contentEncoding).toBeUndefined();
    expect(reRead.contentLanguage).toBeUndefined();
    expect(reRead.contentType).toBeUndefined();
    expect(reRead.metadata?.k1).toBe('v1');
  });

  it('preserves own "__proto__" custom metadata across save, setMetadata, getMetadata, and null removal without prototype mutation', async () => {
    const file = getStorage(open()).bucket().file('docs/proto-item.txt');
    const initialCustom = JSON.parse('{"__proto__":"from-save","k1":"v1"}') as Record<string, string>;
    await file.save('payload', {
      contentType: 'text/plain',
      metadata: { metadata: initialCustom },
    });

    const [afterSave] = await file.getMetadata();
    const savedCustom = afterSave.metadata ?? {};
    expect(Object.hasOwn(savedCustom, '__proto__')).toBe(true);
    expect(savedCustom['__proto__']).toBe('from-save');
    expect(savedCustom.k1).toBe('v1');
    expect(Object.getPrototypeOf(savedCustom)).toBe(Object.prototype);

    const updateCustom = JSON.parse('{"__proto__":"kept","k2":"v2"}') as Record<string, string>;
    await file.setMetadata({
      cacheControl: null,
      metadata: updateCustom,
    });

    const [afterSet] = await file.getMetadata();
    const updatedCustom = afterSet.metadata ?? {};
    expect(Object.hasOwn(updatedCustom, '__proto__')).toBe(true);
    expect(updatedCustom['__proto__']).toBe('kept');
    expect(updatedCustom.k1).toBe('v1');
    expect(updatedCustom.k2).toBe('v2');
    expect(Object.getPrototypeOf(updatedCustom)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).k2).toBeUndefined();

    const removeProto = JSON.parse('{"__proto__":null}') as Record<string, string | null>;
    await file.setMetadata({ metadata: removeProto });

    const [afterRemove] = await file.getMetadata();
    const finalCustom = afterRemove.metadata ?? {};
    expect(Object.hasOwn(finalCustom, '__proto__')).toBe(false);
    expect(finalCustom.k1).toBe('v1');
    expect(finalCustom.k2).toBe('v2');
  });

  it('honors null settable clearing and own "__proto__" custom metadata during file.copy()', async () => {
    const bucket = getStorage(open()).bucket();
    const source = bucket.file('docs/src.txt');
    const dest = bucket.file('docs/dst.txt');
    await source.save('copy-bytes', {
      contentType: 'text/plain',
      metadata: {
        cacheControl: 'public, max-age=30',
        metadata: JSON.parse('{"__proto__":"copied","k1":"v1"}') as Record<string, string>,
      },
    });

    await source.copy(dest, {
      cacheControl: null as unknown as string,
      metadata: JSON.parse('{"__proto__":"overridden","k2":"v2"}') as Record<string, string>,
    });

    const [destMeta] = await dest.getMetadata();
    expect(destMeta.cacheControl).toBeUndefined();
    const destCustom = destMeta.metadata ?? {};
    expect(Object.hasOwn(destCustom, '__proto__')).toBe(true);
    expect(destCustom['__proto__']).toBe('overridden');
    expect(destCustom.k1).toBe('v1');
    expect(destCustom.k2).toBe('v2');
  });
});
