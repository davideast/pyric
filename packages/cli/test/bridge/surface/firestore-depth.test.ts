/**
 * The firestore lane's depth methods: server-side aggregates over the
 * sandbox's document index, path and collection-group discovery, and
 * composite-index extraction and writing.
 *
 * Every assertion reads the sandbox's own state back rather than trusting a
 * method's claim about itself, per the honesty invariant: a count is checked
 * against documents this suite seeded, `discoverPaths` and
 * `findCollectionGroup` against a tree this suite built with known nesting,
 * and `writeIndexes` against the file it wrote.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotDocuments } from 'pyric/sandbox/firestore';

import { ctx, finishHandlerSuite, projectDir, run, sandbox } from './handler-harness.js';

afterAll(() => finishHandlerSuite('firestore-depth'));

/** A fingerprint of every Firestore document the sandbox holds, order-independent. */
function snapshotHash(): string {
  const documents = snapshotDocuments(sandbox);
  const sorted = Object.keys(documents)
    .sort()
    .map((path) => [path, documents[path]] as const);
  return JSON.stringify(sorted);
}

describe('getCountFromServer and getAggregateFromServer', () => {
  it('counts and aggregates the documents seeded for it, narrowed by a constraint', async () => {
    await run('firestore.setDoc', { path: 'depth-orders/a', data: { status: 'paid', total: 10 } });
    await run('firestore.setDoc', { path: 'depth-orders/b', data: { status: 'paid', total: 30 } });
    await run('firestore.setDoc', { path: 'depth-orders/c', data: { status: 'open', total: 100 } });

    const countAll = await run('firestore.getCountFromServer', { path: 'depth-orders' });
    expect((countAll.data as { count: number }).count).toBe(3);

    const countPaid = await run('firestore.getCountFromServer', {
      path: 'depth-orders',
      constraints: [{ type: 'where', field: 'status', op: '==', value: 'paid' }],
    });
    expect((countPaid.data as { count: number }).count).toBe(2);

    const aggregate = await run('firestore.getAggregateFromServer', {
      path: 'depth-orders',
      spec: { count: true, sum: 'total', average: 'total' },
      constraints: [{ type: 'where', field: 'status', op: '==', value: 'paid' }],
    });
    const data = aggregate.data as { count: number; sum: number; average: number };
    expect(data.count).toBe(2);
    expect(data.sum).toBe(40);
    expect(data.average).toBe(20);
  });

  it('changes no state: a read leaves the document snapshot unchanged', async () => {
    const before = snapshotHash();
    await run('firestore.getCountFromServer', { path: 'depth-orders' });
    await run('firestore.getAggregateFromServer', {
      path: 'depth-orders',
      spec: { count: true },
    });
    expect(snapshotHash()).toBe(before);
  });
});

describe('discoverPaths', () => {
  it('reports the right paths and counts at depth 1 and depth 2, and truncates by limit', async () => {
    await run('firestore.setDoc', { path: 'depth-tree/org-a', data: { name: 'a' } });
    await run('firestore.setDoc', { path: 'depth-tree/org-b', data: { name: 'b' } });
    await run('firestore.setDoc', {
      path: 'depth-tree/org-a/teams/team-1',
      data: { name: 'team-1' },
    });
    await run('firestore.setDoc', {
      path: 'depth-tree/org-a/teams/team-2',
      data: { name: 'team-2' },
    });
    await run('firestore.setDoc', {
      path: 'depth-tree/org-b/teams/team-3',
      data: { name: 'team-3' },
    });

    const before = snapshotHash();
    const depth1 = await run('firestore.discoverPaths', { depth: 1, limit: 200 });
    const d1 = depth1.data as { collections: Array<{ path: string; documentCount: number }> };
    const depthTreeAtOne = d1.collections.find((entry) => entry.path === 'depth-tree');
    expect(depthTreeAtOne?.documentCount).toBe(2);
    expect(d1.collections.some((entry) => entry.path.includes('teams'))).toBe(false);

    const depth2 = await run('firestore.discoverPaths', { depth: 2, limit: 200 });
    const d2 = depth2.data as { collections: Array<{ path: string; documentCount: number }> };
    expect(d2.collections.find((entry) => entry.path === 'depth-tree/org-a/teams')?.documentCount).toBe(2);
    expect(d2.collections.find((entry) => entry.path === 'depth-tree/org-b/teams')?.documentCount).toBe(1);

    const truncated = await run('firestore.discoverPaths', { depth: 2, limit: 1 });
    const dt = truncated.data as { truncated: boolean; documents: string[] };
    expect(dt.truncated).toBe(true);
    expect(dt.documents).toHaveLength(1);
    expect(snapshotHash()).toBe(before);
  });
});

describe('findCollectionGroup', () => {
  it('finds a collection id nested at two different depths', async () => {
    await run('firestore.setDoc', {
      path: 'depth-tree/org-a/comments/c1',
      data: { text: 'hi' },
    });
    await run('firestore.setDoc', {
      path: 'depth-tree/org-a/teams/team-1/comments/c2',
      data: { text: 'hello' },
    });

    const found = await run('firestore.findCollectionGroup', { collectionId: 'comments' });
    const hosts = (found.data as { hosts: Array<{ path: string; documentCount: number }> }).hosts;
    expect(hosts.find((host) => host.path === 'depth-tree/org-a/comments')?.documentCount).toBe(1);
    expect(
      hosts.find((host) => host.path === 'depth-tree/org-a/teams/team-1/comments')?.documentCount,
    ).toBe(1);
  });
});

describe('extractIndexes and writeIndexes', () => {
  const indexesPath = 'depth-firestore.indexes.json';

  afterAll(() => {
    const absolute = join(projectDir, indexesPath);
    if (existsSync(absolute)) rmSync(absolute);
  });

  it('finds the composite index a range-plus-orderBy query needs', async () => {
    const result = await run('firestore.extractIndexes', {
      queries: [
        {
          path: 'depth-orders',
          constraints: [
            { type: 'where', field: 'total', op: '>', value: 20 },
            { type: 'orderBy', field: 'status', direction: 'asc' },
          ],
        },
      ],
    });
    const indexes = (result.data as { indexes: Array<Record<string, unknown>> }).indexes;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.collectionGroup).toBe('depth-orders');
    expect(indexes[0]!.fields).toEqual([
      { fieldPath: 'total', order: 'ASCENDING' },
      { fieldPath: 'status', order: 'ASCENDING' },
    ]);
  });

  it('refuses to write without confirm, and refuses a path outside the project directory', async () => {
    const indexes = [
      { collectionGroup: 'depth-orders', queryScope: 'COLLECTION', fields: [{ fieldPath: 'total' }] },
    ];
    const unconfirmed = await run('firestore.writeIndexes', { indexes, path: indexesPath });
    expect(unconfirmed.ok).toBe(false);

    const escaping = await run('firestore.writeIndexes', {
      indexes,
      path: '../outside.json',
      confirm: true,
    });
    expect(escaping.ok).toBe(false);
    expect(existsSync(join(projectDir, '..', 'outside.json'))).toBe(false);
  });

  it('writes the definitions, and reports the diff on a second write', async () => {
    const first = [
      { collectionGroup: 'depth-orders', queryScope: 'COLLECTION', fields: [{ fieldPath: 'total' }] },
    ];
    const written = await run('firestore.writeIndexes', {
      indexes: first,
      path: indexesPath,
      confirm: true,
    });
    expect(written.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(projectDir, indexesPath), 'utf8')) as {
      indexes: unknown[];
    };
    expect(onDisk.indexes).toHaveLength(1);

    const second = [
      { collectionGroup: 'depth-orders', queryScope: 'COLLECTION', fields: [{ fieldPath: 'status' }] },
    ];
    const rewritten = await run('firestore.writeIndexes', {
      indexes: second,
      path: indexesPath,
      confirm: true,
    });
    const data = rewritten.data as { added: number; removed: number };
    expect(data.added).toBe(1);
    expect(data.removed).toBe(1);
  });
});
