import { expect, test } from 'bun:test';
import { captureIndexQuery } from 'pyric/sandbox/internal';
import { createIndexInspector, type IndexConfigClient } from '../../../src/serve/runtime/index-config-client.js';

const query = captureIndexQuery('projects', false, [{ kind: 'where', field: 'status', op: '==' }], [{ field: 'budget', direction: 'desc' }]);
test('standalone diagnostics can copy a definition without claiming a missing index', async () => {
  const inspector = createIndexInspector(undefined, () => {});
  await inspector.refresh();
  expect(inspector.finding(query).status).toBe('unavailable');
  let copied = '';
  await inspector.copy(query, { writeText: async value => { copied = value; } });
  expect(JSON.parse(copied).fields).toHaveLength(2);
  expect(inspector.state().copied).toBe(true);
  expect(inspector.state().message).toBeNull();
  inspector.dispose();
});
test('a failed recheck discards obsolete coverage and clipboard failures are reported', async () => {
  let fail = false;
  const client: IndexConfigClient = {
    read: async () => {
      if (fail) throw new Error('Configuration disconnected.');
      return { path: 'indexes.json', revision: 'revision', config: { indexes: [] } };
    },
    preview: async () => { throw new Error('unused'); },
    apply: async () => { throw new Error('unused'); },
  };
  const inspector = createIndexInspector(client, () => {});
  await inspector.refresh();
  expect(inspector.finding(query).status).toBe('missing');
  fail = true;
  await inspector.refresh();
  expect(inspector.finding(query).status).toBe('unavailable');
  await inspector.copy(query, { writeText: async () => { throw new Error('Clipboard blocked.'); } });
  expect(inspector.state().error).toBe('Clipboard blocked.');
});

test('automatic preview requires review again if the configuration changed before adding', async () => {
  const index = { collectionGroup: 'projects', queryScope: 'COLLECTION' as const, fields: [{ fieldPath: 'status', order: 'ASCENDING' as const }, { fieldPath: 'budget', order: 'DESCENDING' as const }] };
  const initial = { path: 'indexes.json', revision: 'first', config: { indexes: [] } };
  let writes = 0;
  const client: IndexConfigClient = {
    read: async () => initial,
    preview: async () => ({ ...initial, revision: 'changed', addition: index }),
    apply: async () => { ++writes; return { ...initial, revision: 'saved', config: { indexes: [index] }, addition: null }; },
  };
  const inspector = createIndexInspector(client, () => {});
  await inspector.refresh();
  inspector.prepare('query', query);
  expect(inspector.state().preview?.value.addition).toEqual(index);
  await inspector.apply('query', query);
  expect(writes).toBe(0);
  expect(inspector.state().message).toContain('Review');
  await inspector.apply('query', query);
  expect(writes).toBe(1);
  expect(inspector.finding(query).status).toBe('covered');
  expect(inspector.state().preview?.value.addition).toEqual(index);
});

test('save failure preserves the proposal for retry and reports saving separately from copying', async () => {
  const initial = { path: 'indexes.json', revision: 'first', config: { indexes: [] } };
  const inspector = createIndexInspector({
    read: async () => initial,
    preview: async () => ({ ...initial, addition: null }),
    apply: async () => { throw new Error('File is read-only.'); },
  }, () => {});
  await inspector.refresh();
  inspector.prepare('query', query);
  const saving = inspector.apply('query', query);
  expect(inspector.state().pending).toBe('apply');
  await saving;
  expect(inspector.state().saveFailed).toBe(true);
  expect(inspector.state().pending).toBeNull();
  expect(inspector.state().preview?.value.addition).toBeDefined();
  expect(inspector.state().error).toBe('File is read-only.');
  inspector.dispose();
});
