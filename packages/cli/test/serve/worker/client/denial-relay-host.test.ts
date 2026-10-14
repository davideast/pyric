/**
 * A rules denial on a named RTDB instance, from the client SDK through a real
 * host to the dev server's terminal line: the relayed denial names the
 * instance the reference addressed, and the default instance names none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as client from '../../../../src/serve/worker/index.js';
import { rtdbInstanceDatabase } from '../../../../src/serve/worker/client/rtdb-references.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import { formatDenialBlock } from '../../../../src/serve/namespace.js';
import { connectClient, until } from '../integration-support.js';

const MEMBERS_ONLY = {
  rules: {
    rooms: { $roomId: { '.read': "auth != null && data.child('members').child(auth.uid).exists()" } },
  },
};

describe('a denial relayed from a real host names its RTDB instance', () => {
  const realFetch = globalThis.fetch;
  const previousWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  let relayed: Array<Parameters<typeof formatDenialBlock>[0]>;

  beforeEach(() => {
    relayed = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (url === '/__pyric/denials') relayed.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { SharedWorker?: unknown }).SharedWorker = previousWorker;
  });

  it('prints the listen and the get denied on demo-app-shard-1 with that instance, and the default instance bare', async () => {
    const { ctx, db } = await connectClient();
    setDatabaseRules(ctx, 'demo-app-shard-1', MEMBERS_ONLY);
    setDatabaseRules(ctx, undefined, MEMBERS_ONLY);
    const rtdb = client.rtdbGetDatabase(db);
    const shard = rtdbInstanceDatabase(rtdb, { name: 'demo-app-shard-1', url: 'https://demo-app-shard-1.firebaseio.com' });

    const unsubscribe = client.rtdbOnValue(client.rtdbRef(shard, 'rooms/r1'), () => {}, () => {});
    await until(() => relayed.length === 1, 'the denied listener to relay');
    await expect(client.rtdbGet(client.rtdbRef(shard, 'rooms/r1'))).rejects.toThrow();
    await expect(client.rtdbGet(client.rtdbRef(rtdb, 'rooms/r2'))).rejects.toThrow();
    await until(() => relayed.length === 3, 'both denied reads to relay');
    unsubscribe();

    const requestLines = relayed.map((payload) => formatDenialBlock(payload).split('\n')[1]);
    expect(requestLines).toEqual([
      '      listen /rooms/r1 (demo-app-shard-1)',
      '      get /rooms/r1 (demo-app-shard-1)',
      '      get /rooms/r2',
    ]);
  });
});
