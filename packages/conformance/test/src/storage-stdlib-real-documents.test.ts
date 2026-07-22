import { describe, expect, test } from 'bun:test';
import { RequestBudget } from '../../src/storage-stdlib-real-budget.ts';
import { deleteFirestoreDocuments } from '../../src/storage-stdlib-real-documents.ts';

describe('storage stdlib real Firestore cleanup', () => {
  test('retries a transient delete and still attempts every target and verification', async () => {
    const budget = new RequestBudget({ storage: 0, firestoreWrite: 8, rules: 0, iam: 0 });
    const requests: Array<{ url: string; method?: string }> = [];
    let failed = false;
    const responses = [
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 404 }),
    ];
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method });
      if (!failed) {
        failed = true;
        throw new Error('transient transport failure');
      }
      return responses.shift() ?? new Response('unexpected', { status: 500 });
    };
    expect(await deleteFirestoreDocuments([
      { name: 'projects/p/databases/(default)/documents/probes/a', headers: { auth: {}, json: {} } },
      { name: 'projects/p/databases/(default)/documents/probes/b', headers: { auth: {}, json: {} } },
    ], budget, request)).toBe(true);
    expect(requests.filter(({ url }) => url.endsWith('/a'))).toHaveLength(3);
    expect(requests.filter(({ url }) => url.endsWith('/b'))).toHaveLength(2);
    expect(requests.filter(({ method }) => method === 'DELETE')).toHaveLength(3);
  });
});
