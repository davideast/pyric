import { describe, expect, test } from 'bun:test';
import { crawl } from '../../src/discover/crawler.js';
import { SessionStore } from '../../src/discover/session.js';
import type { PersistedCrawlState } from '../../src/discover/crawler-types.js';
import { buildMockFirestore } from './helpers/mock-firestore.js';

describe('crawl - Object.prototype collection IDs (#1464)', () => {
  test('samples and finalizes top-level and nested collections named after Object.prototype members', async () => {
    const db = buildMockFirestore({
      constructor: [{ id: 'a', fields: { count: { integerValue: '1' } } }],
      valueOf: [{ id: 'a', fields: { flag: { booleanValue: true } } }],
      toString: [{ id: 'a', fields: { label: { stringValue: 'top' } } }],
      hasOwnProperty: [{ id: 'a', fields: { ok: { booleanValue: false } } }],
      users: [
        {
          id: 'a',
          fields: { name: { stringValue: 'alice' } },
          subs: {
            toString: [{ id: 'b', fields: { nested: { integerValue: '2' } } }],
          },
        },
      ],
    });

    const result = await crawl(db);
    expect([...result.finalizedSchemas.keys()].sort()).toEqual([
      'constructor',
      'hasOwnProperty',
      'toString',
      'users',
      'users/{userId}/toString',
      'valueOf',
    ]);
    expect(result.finalizedSchemas.get('constructor')?.schema.samplesSeen).toBe(1);
    expect(result.finalizedSchemas.get('valueOf')?.schema.samplesSeen).toBe(1);
    expect(result.finalizedSchemas.get('users/{userId}/toString')?.schema.samplesSeen).toBe(1);
  });

  test('preserves prototype-named collection schemas across pause and resume', async () => {
    const db = buildMockFirestore({
      constructor: [{ id: 'a', fields: { count: { integerValue: '1' } } }],
      valueOf: [{ id: 'a', fields: { count: { integerValue: '2' } } }],
      users: [{ id: 'a', fields: { name: { stringValue: 'alice' } } }],
    });
    const sessions = new SessionStore<PersistedCrawlState>();
    let batch = await crawl(db, { maxBatchBytes: 1 }, sessions);
    let safety = 0;
    while (!batch.complete && safety < 10) {
      safety += 1;
      batch = await crawl(db, { continuation: batch.continuation, maxBatchBytes: 1 }, sessions);
    }
    expect(batch.complete).toBe(true);
    expect([...batch.finalizedSchemas.keys()].sort()).toEqual([
      'constructor',
      'users',
      'valueOf',
    ]);
  });
});
