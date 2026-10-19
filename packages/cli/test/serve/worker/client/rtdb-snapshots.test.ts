/** RTDB worker-client snapshot hydration and recursive priority export. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClient } from '../integration-support.js';

describe('RTDB worker snapshots', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('hydrates recursive priority metadata for exportVal and toJSON', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const rows = client.rtdbRef(rtdb, 'snapshot-priorities');
    await client.rtdbSetWithPriority(client.rtdbChild(rows, 'second'), { rank: 2 }, 20);
    await client.rtdbSetWithPriority(client.rtdbChild(rows, 'first'), { rank: 1 }, 10);

    const snapshot = await client.rtdbGet(rows);
    const exported = {
      first: { rank: 1, '.priority': 10 },
      second: { rank: 2, '.priority': 20 },
    };
    expect(snapshot.exportVal()).toEqual(exported);
    expect(snapshot.toJSON()).toEqual(exported);
    expect(snapshot.child('first').priority).toBe(10);
    expect(snapshot.child('first').exportVal()).toEqual({ rank: 1, '.priority': 10 });
  });

  it('iterates an array value below the top level by index, skipping holes', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const rooms = client.rtdbRef(rtdb, 'snapshot-arrays');
    await client.rtdbSet(rooms, { r1: { members: ['ada', 'grace'] }, r2: { members: { 0: 'x', 2: 'z' } } });

    const snapshot = await client.rtdbGet(rooms);
    const nested: string[] = [];
    snapshot.forEach((room) => {
      room.child('members').forEach((member) => {
        nested.push(`${room.key}/${member.key}=${String(member.val())}`);
      });
    });

    expect(nested).toEqual(['r1/0=ada', 'r1/1=grace', 'r2/0=x', 'r2/2=z']);
    expect(snapshot.child('r2/members').size).toBe(2);
    expect(snapshot.child('r2/members').hasChildren()).toBe(true);
  });
});
