import { afterEach, describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getDatabase, type DataSnapshot } from '../../src/database/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function database() {
  return getDatabase(initializeApp({ sandbox: initializeSandbox() }));
}

function childKeys(snap: DataSnapshot): Array<string | null> {
  const keys: Array<string | null> = [];
  snap.forEach((child) => {
    keys.push(child.key);
  });
  return keys;
}

// `@firebase/database` keeps a node's children whatever `val()` renders them
// as: a node whose keys are 0, 1, 2 reads back as an array and still has
// children keyed '0', '1', '2' (`DataSnapshot.forEach`, `ChildrenNode.val`).
describe('a snapshot whose value is an array', () => {
  test('has one child per element, keyed by index', async () => {
    const db = database();
    await db.ref('ticks').set(['a', 'b', 'c']);

    const snap = await db.ref('ticks').once('value');

    expect(snap.val()).toEqual(['a', 'b', 'c']);
    expect(snap.numChildren()).toBe(3);
    expect(snap.hasChildren()).toBe(true);
    expect(childKeys(snap)).toEqual(['0', '1', '2']);
  });

  test('gives each child snapshot its index key, value and reference', async () => {
    const db = database();
    await db.ref('ticks').set(['a', 'b', 'c']);

    const snap = await db.ref('ticks').get();
    const children: Array<[string | null, unknown, string | null]> = [];
    snap.forEach((child) => {
      children.push([child.key, child.val(), child.ref.key]);
    });

    expect(children).toEqual([['0', 'a', '0'], ['1', 'b', '1'], ['2', 'c', '2']]);
    expect(snap.child('1').val()).toBe('b');
    expect(snap.child('1').key).toBe('1');
    expect(snap.hasChild('2')).toBe(true);
  });

  test('skips the holes of a sparse array', async () => {
    const db = database();
    await db.ref('sparse').set(['a', null, 'c']);

    const snap = await db.ref('sparse').get();

    expect(snap.numChildren()).toBe(2);
    expect(snap.hasChildren()).toBe(true);
    expect(childKeys(snap)).toEqual(['0', '2']);
    expect(snap.hasChild('1')).toBe(false);
  });

  test('iterates an array nested under an object child', async () => {
    const db = database();
    await db.ref('rooms/r1').set({ members: ['ada', 'grace'] });

    const snap = await db.ref('rooms').get();
    const nested: string[] = [];
    snap.forEach((room) => {
      room.child('members').forEach((member) => {
        nested.push(`${member.key}=${String(member.val())}`);
      });
    });

    expect(nested).toEqual(['0=ada', '1=grace']);
    expect(snap.child('r1/members').numChildren()).toBe(2);
    expect(snap.child('r1/members/1').val()).toBe('grace');
  });

  test('stops iterating when the callback returns true, and returns true', async () => {
    const db = database();
    await db.ref('ticks').set(['a', 'b', 'c']);

    const snap = await db.ref('ticks').get();
    const visited: Array<string | null> = [];
    const cancelled = snap.forEach((child) => {
      visited.push(child.key);
      return child.key === '1';
    });

    expect(cancelled).toBe(true);
    expect(visited).toEqual(['0', '1']);
  });
});
