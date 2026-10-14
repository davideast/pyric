/**
 * `localStorageUrl()` from the consumer's seat: an app server that persisted a
 * production download URL imports the helper from `@pyric/cli/remote` (the
 * built package, as an app resolves it) and gets the URL the local host serves.
 */
import { describe, expect, it } from 'bun:test';
import { localStorageUrl } from '@pyric/cli/remote';

const HOST = 'http://localhost:5173';

describe('localStorageUrl', () => {
  it('maps a production download URL onto the byte route, keeping path and token', () => {
    const production = 'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/public%2Fhello%20x.txt?alt=media&token=tok-1';
    expect(localStorageUrl(production, HOST)).toBe(
      `${HOST}/__pyric/storage/v0/b/demo.appspot.com/o/public%2Fhello%20x.txt?alt=media&token=tok-1`,
    );
  });

  it('maps the storage.googleapis.com form', () => {
    expect(localStorageUrl('https://storage.googleapis.com/demo.appspot.com/a/b.png', `${HOST}/`)).toBe(
      `${HOST}/__pyric/storage/v0/b/demo.appspot.com/o/a%2Fb.png?alt=media`,
    );
  });

  it('leaves anything else unmapped', () => {
    expect(localStorageUrl('https://example.com/v0/b/x/o/y', HOST)).toBeUndefined();
    expect(localStorageUrl('https://firebasestorage.googleapis.com/v0/b/x', HOST)).toBeUndefined();
    expect(localStorageUrl('not a url', HOST)).toBeUndefined();
  });

  it('leaves an object path with a broken percent escape unmapped instead of throwing', () => {
    expect(localStorageUrl('https://storage.googleapis.com/demo.appspot.com/a%E0%A4%A.png', HOST)).toBeUndefined();
    expect(localStorageUrl('https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/a%E0%A4%A.png?alt=media&token=t', HOST)).toBeUndefined();
  });

  it('leaves a Cloud Storage JSON API URL unmapped rather than reading its first segment as the bucket', () => {
    const mediaLink = 'https://storage.googleapis.com/download/storage/v1/b/demo.appspot.com/o/a%2Fb.png?generation=1700000000000000&alt=media';
    expect(localStorageUrl(mediaLink, HOST)).toBeUndefined();
    expect(localStorageUrl('https://storage.googleapis.com/storage/v1/b/demo.appspot.com/o/a%2Fb.png', HOST)).toBeUndefined();
  });

  it('carries the token and drops production-only parameters such as generation', () => {
    const production = 'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/a.png?alt=media&token=tok-1&generation=1700000000000000';
    expect(localStorageUrl(production, HOST)).toBe(`${HOST}/__pyric/storage/v0/b/demo.appspot.com/o/a.png?alt=media&token=tok-1`);
  });

  it('places the byte route at the root of the host, whatever path or query the host URL carries', () => {
    const production = 'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/a.png?alt=media&token=tok-1';
    expect(localStorageUrl(production, `${HOST}/app/?x=1#top`)).toBe(
      `${HOST}/__pyric/storage/v0/b/demo.appspot.com/o/a.png?alt=media&token=tok-1`,
    );
  });
});
