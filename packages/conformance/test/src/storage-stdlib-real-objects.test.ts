import { describe, expect, test } from 'bun:test';
import { RequestBudget } from '../../src/storage-stdlib-real-budget.ts';
import {
  deleteStorageObjects,
  firebaseStorageMetadata,
  firebaseStorageUpload,
  storageDecision,
} from '../../src/storage-stdlib-real-objects.ts';

describe('storage stdlib real object support', () => {
  test('normalizes allowed and denied Storage outcomes', () => {
    expect(storageDecision()).toEqual({ allowed: true });
    const denied = Object.assign(new Error('denied'), { code: 'storage/unauthorized' });
    expect(storageDecision(denied)).toEqual({
      allowed: false,
      code: 'storage/unauthorized',
      message: 'denied',
    });
  });

  test('deletes objects discovered by prefix verification', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const responses = [
      new Response(JSON.stringify({ items: [{ name: 'run/committed.bin' }] })),
      new Response(null, { status: 204 }),
      new Response(JSON.stringify({ items: [] })),
    ];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return responses.shift() ?? new Response(null, { status: 500 });
    }) as typeof fetch;
    try {
      const budget = new RequestBudget({ storage: 3, firestoreWrite: 0, rules: 0, iam: 0 });
      expect(await deleteStorageObjects(
        'bucket', 'run/', new Set(), { auth: {}, json: {} }, budget,
      )).toBe(true);
      expect(urls.some((url) => url.includes('committed.bin'))).toBe(true);
      expect(budget.snapshot().counts.storage).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('one-shot client requests do not retry a retryable response behind the budget', async () => {
    const budget = new RequestBudget({ storage: 2, firestoreWrite: 0, rules: 0, iam: 0 });
    let calls = 0;
    const inits: Array<RequestInit | undefined> = [];
    const request = async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      inits.push(init);
      return new Response(JSON.stringify({ error: { code: 503, message: 'retryable' } }), { status: 503 });
    };
    expect((await firebaseStorageUpload('bucket', 'run/a.bin', new Uint8Array([1]), budget, request)).allowed).toBe(false);
    expect((await firebaseStorageMetadata('bucket', 'run/a.bin', budget, request)).allowed).toBe(false);
    expect(calls).toBe(2);
    expect(budget.snapshot().counts.storage).toBe(2);
    expect(inits[0]?.headers).toEqual({
      'Content-Type': 'multipart/related; boundary=pyric-storage-probe',
      'X-Goog-Upload-Protocol': 'multipart',
    });
  });

  test('retries failed deletes while continuing through later objects and final verification', async () => {
    const budget = new RequestBudget({ storage: 8, firestoreWrite: 0, rules: 0, iam: 0 });
    const urls: string[] = [];
    let failed = false;
    const responses = [
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(JSON.stringify({ items: [] })),
      new Response(JSON.stringify({ items: [] })),
    ];
    const request = async (input: string | URL | Request) => {
      urls.push(String(input));
      if (!failed) {
        failed = true;
        throw new Error('transient transport failure');
      }
      return responses.shift() ?? new Response('unexpected', { status: 500 });
    };
    expect(await deleteStorageObjects(
      'bucket', 'run/', new Set(['run/a.bin', 'run/b.bin']), { auth: {}, json: {} }, budget, request,
    )).toBe(true);
    expect(urls.filter((url) => url.includes('a.bin'))).toHaveLength(2);
    expect(urls.some((url) => url.includes('b.bin'))).toBe(true);
  });
});
