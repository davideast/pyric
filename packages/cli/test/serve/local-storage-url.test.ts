import { describe, expect, it } from 'bun:test';
import { localStorageUrl } from '../../src/serve/worker/protocol/storage.js';

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
});
