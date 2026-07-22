import { describe, expect, test } from 'bun:test';
import { RequestBudget } from '../../src/storage-stdlib-real-budget.ts';
import {
  deleteStorageObjects,
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
});
