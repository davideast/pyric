/**
 * The recorder relays the Listen and Write streams on separate connections,
 * so the listener change a write released can reach it before the write's
 * answer does. Either order must tie that batch to the write and turn the
 * write's commit time into a placeholder.
 */
import { describe, expect, test } from 'bun:test';
import type { JsonObject, ListenExchange, WriteExchange } from './format.ts';
import { Transcript } from './transcript.ts';

const COMMIT_TIME = '2026-11-05T09:25:13.000000Z';
const WRITES = [{ update: { name: 'projects/demo-replay/databases/(default)/documents/rooms/garden', fields: { open: { booleanValue: true } } } }];
const ADD_TARGET = { targetId: 2, query: { parent: 'projects/demo-replay/databases/(default)/documents', structuredQuery: { from: [{ collectionId: 'rooms' }] } } };
const FIRST_BATCH: JsonObject[] = [
  { targetChange: { targetChangeType: 'ADD', targetIds: [2] } },
  { targetChange: { targetChangeType: 'CURRENT', targetIds: [2], resumeToken: 'token-1' } },
];
const GARDEN_CHANGE: JsonObject = {
  documentChange: {
    document: { name: 'projects/demo-replay/databases/(default)/documents/rooms/garden', fields: { open: { booleanValue: true } }, createTime: COMMIT_TIME, updateTime: COMMIT_TIME },
    targetIds: [2],
  },
};
const GLOBAL_CHANGE: JsonObject = { targetChange: { readTime: '2026-11-05T09:25:13.500000Z' } };
const WRITE_ANSWER: JsonObject = { writeResults: [{ updateTime: COMMIT_TIME }], commitTime: COMMIT_TIME };

type Order = 'answer first' | 'listener first';

function record(order: Order): { listener: ListenExchange; write: WriteExchange } {
  const transcript = new Transcript('demo-replay', 'transcript test');
  const listen = transcript.listenStream('reader');
  const write = transcript.writeStream('reader');
  listen.fromClient({ addTarget: ADD_TARGET });
  for (const message of FIRST_BATCH) listen.fromServer(message);
  listen.fromServer(GLOBAL_CHANGE);
  write.fromClient({ writes: WRITES });
  if (order === 'answer first') write.fromServer(WRITE_ANSWER);
  listen.fromServer(GARDEN_CHANGE);
  listen.fromServer(GLOBAL_CHANGE);
  if (order === 'listener first') write.fromServer(WRITE_ANSWER);
  const { exchanges } = transcript.recording();
  return {
    listener: exchanges.find((exchange): exchange is ListenExchange => exchange.kind === 'listen')!,
    write: exchanges.find((exchange): exchange is WriteExchange => exchange.kind === 'write')!,
  };
}

describe('a listener batch a write released', () => {
  for (const order of ['answer first', 'listener first'] as const) {
    test(`is tied to that write, ${order}`, () => {
      const { listener, write } = record(order);
      expect(listener.batches.map((batch) => batch.after)).toEqual([undefined, write.id]);
      expect(JSON.stringify(listener.batches[1])).toContain('"updateTime":{"$":"commitTime"}');
      expect(JSON.stringify(listener.batches[1])).not.toContain(COMMIT_TIME);
    });
  }

  test('a write that is never answered releases nothing', () => {
    const transcript = new Transcript('demo-replay', 'transcript test');
    const listen = transcript.listenStream('reader');
    listen.fromClient({ addTarget: ADD_TARGET });
    for (const message of FIRST_BATCH) listen.fromServer(message);
    listen.fromServer(GLOBAL_CHANGE);
    transcript.writeStream('reader').fromClient({ writes: WRITES });
    listen.fromServer(GARDEN_CHANGE);
    const listener = transcript.recording().exchanges[0] as ListenExchange;
    expect(listener.batches.map((batch) => batch.after)).toEqual([undefined, undefined]);
  });
});
