// `pyric firestore indexes generate` finds a query's composite index whether
// the query is assigned to `q` first or passed straight into the reader
// (#2427). Before the fix, `getDocs(query(collectionGroup(...), ...))` wrote
// `{ "indexes": [] }` and printed no warning. The same holds for a query
// passed inline to onSnapshot, getCountFromServer and getAggregateFromServer.
// A query the extractor can't resolve, here one built on a helper from
// another module, is named by file and line on stderr instead of dropped.
import assert from 'node:assert/strict';
import { scenario, type App } from '../driver.ts';

const RECENT_PROJECTS_INDEX = {
  collectionGroup: 'projects',
  queryScope: 'COLLECTION_GROUP',
  fields: [
    { fieldPath: 'ownerId', order: 'ASCENDING' },
    { fieldPath: 'updatedAt', order: 'DESCENDING' },
  ],
};

/** Runs `pyric firestore indexes generate <source> --out <out>` and returns the written config and the output. */
async function generate(app: App, source: string, out: string): Promise<{ indexes: unknown[]; output: string }> {
  const { code, output } = await app.pyric(['firestore', 'indexes', 'generate', source, '--out', out]);
  assert.equal(code, 0, output);
  const config = JSON.parse(app.readFile(out)) as { indexes: unknown[] };
  return { indexes: config.indexes, output };
}

export default scenario(async (app) => {
  await app.step('a query assigned to q first writes its collection-group index', async () => {
    const { indexes, output } = await generate(app, 'src/variable.ts', 'variable.json');
    assert.deepEqual(indexes, [RECENT_PROJECTS_INDEX]);
    assert.doesNotMatch(output, /warning/, output);
  });

  await app.step('the same query passed straight into getDocs writes the same index', async () => {
    const { indexes, output } = await generate(app, 'src/inline.ts', 'inline.json');
    assert.deepEqual(indexes, [RECENT_PROJECTS_INDEX]);
    assert.doesNotMatch(output, /warning/, output);
  });

  await app.step('queries passed inline to onSnapshot, getCountFromServer and getAggregateFromServer write their indexes', async () => {
    const { indexes, output } = await generate(app, 'src/readers.ts', 'readers.json');
    assert.deepEqual(indexes, [
      {
        collectionGroup: 'tasks',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'listId', order: 'ASCENDING' },
          { fieldPath: 'dueAt', order: 'ASCENDING' },
        ],
      },
      {
        collectionGroup: 'events',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'roomId', order: 'ASCENDING' },
          { fieldPath: 'at', order: 'ASCENDING' },
        ],
      },
      {
        collectionGroup: 'orders',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'storeId', order: 'ASCENDING' },
          { fieldPath: 'status', order: 'ASCENDING' },
          { fieldPath: 'paidAt', order: 'DESCENDING' },
        ],
      },
    ]);
    assert.doesNotMatch(output, /warning/, output);
  });

  await app.step('a query built on a helper from another module is named by file and line', async () => {
    const { indexes, output } = await generate(app, 'src/helper.ts', 'helper.json');
    assert.deepEqual(indexes, []);
    assert.match(output, /warning: \S*src\/helper\.ts:5: .*query\(\.\.\.\)/, output);
  });
});
