import { expect, test } from 'bun:test';
import { analyzeIndexQuery, captureIndexQuery, readIndexConfig } from '../../src/rules/indexes/query-analysis.js';

const empty = { indexes: [], fieldOverrides: [] };
const query = () => captureIndexQuery('teams/north/projects', false, [{ kind: 'where', field: 'status', op: '==' }], [{ field: 'createdAt', direction: 'desc' }]);

test('captures fields without accessing query operands', () => {
  const captured = captureIndexQuery('projects', false, [{ kind: 'where', field: 'owner', op: '==', get value() { throw new Error('private operand'); } }], []);
  expect(JSON.stringify(captured)).not.toContain('value');
  expect(captured.filters).toEqual([{ field: 'owner', op: '==' }]);
});
test('multiple equality filters use automatic index merging', () => {
  const captured = captureIndexQuery('projects', false, ['owner', 'status'].map(field => ({ kind: 'where', field, op: '==' })), []);
  expect(analyzeIndexQuery(captured, empty)).toEqual({ status: 'covered', basis: 'automatic' });
});
test('filter and sort on different fields produce a precise local addition', () => {
  const finding = analyzeIndexQuery(query(), empty);
  expect(finding).toEqual({ status: 'missing', index: { collectionGroup: 'projects', queryScope: 'COLLECTION', fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'createdAt', order: 'DESCENDING' }] } });
  if (finding.status !== 'missing') throw new Error('Expected an index');
  expect(analyzeIndexQuery(query(), { indexes: [finding.index] })).toEqual({ status: 'covered', basis: 'configured' });
  expect(analyzeIndexQuery(query(), { indexes: [{ ...finding.index, queryScope: 'COLLECTION_GROUP' }] }).status).toBe('missing');
});
test('missing connection never claims that an index is absent', () => {
  expect(analyzeIndexQuery(query(), null).status).toBe('unavailable');
});
test('unsupported OR and multiple range shapes do not suggest definitions', () => {
  const or = captureIndexQuery('projects', false, [{ kind: 'or', filters: [] }], []);
  expect(analyzeIndexQuery(or, empty)).toMatchObject({ status: 'unavailable' });
  expect(analyzeIndexQuery(or, empty)).not.toHaveProperty('index');
  const ranges = captureIndexQuery('projects', false, ['a', 'b'].map(field => ({ kind: 'where', field, op: '>' })), []);
  expect(analyzeIndexQuery(ranges, empty).status).toBe('unavailable');
});
test('field overrides include inherited map and wildcard exemptions', () => {
  const captured = captureIndexQuery('projects', false, [{ kind: 'where', field: 'owner.name', op: '==' }], []);
  expect(analyzeIndexQuery(captured, { indexes: [], fieldOverrides: [{ collectionGroup: 'projects', fieldPath: 'owner', indexes: [] }] }).status).toBe('unavailable');
  expect(analyzeIndexQuery(captured, { indexes: [], fieldOverrides: [{ collectionGroup: 'projects', fieldPath: '*', indexes: [] }, { collectionGroup: 'projects', fieldPath: 'owner.name', indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }] }] }).status).toBe('covered');
});
test('collection group single-field indexes must be explicitly configured', () => {
  const captured = captureIndexQuery('projects', true, [], [{ field: 'createdAt', direction: 'desc' }]);
  expect(analyzeIndexQuery(captured, empty).status).toBe('unavailable');
  expect(analyzeIndexQuery(captured, { indexes: [], fieldOverrides: [{ collectionGroup: 'projects', fieldPath: 'createdAt', indexes: [{ queryScope: 'COLLECTION_GROUP', order: 'DESCENDING' }] }] }).status).toBe('covered');
});
test('array membership plus sorting requires an array index field', () => {
  const captured = captureIndexQuery('projects', false, [{ kind: 'where', field: 'tags', op: 'array-contains' }], [{ field: 'createdAt', direction: 'asc' }]);
  expect(analyzeIndexQuery(captured, empty)).toMatchObject({ status: 'missing', index: { fields: [{ fieldPath: 'tags', arrayConfig: 'CONTAINS' }, { fieldPath: 'createdAt', order: 'ASCENDING' }] } });
});
test('malformed index files cannot masquerade as empty configuration', () => {
  expect(() => readIndexConfig({ indexes: 'bad' })).toThrow();
  expect(() => readIndexConfig({ indexes: [], fieldOverrides: [{}] })).toThrow();
});

test('an exact one-character field override takes precedence over the wildcard', () => {
  const captured = captureIndexQuery('projects', false, [], [{ field: 'x', direction: 'asc' }]);
  expect(analyzeIndexQuery(captured, { indexes: [], fieldOverrides: [
    { collectionGroup: 'projects', fieldPath: '*', indexes: [] },
    { collectionGroup: 'projects', fieldPath: 'x', indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }] },
  ] }).status).toBe('covered');
});

test('array membership with equality can merge automatic indexes', () => {
  const captured = captureIndexQuery('projects', false, [{ kind: 'where', field: 'tags', op: 'array-contains' }, { kind: 'where', field: 'status', op: '==' }], []);
  expect(analyzeIndexQuery(captured, empty)).toEqual({ status: 'covered', basis: 'automatic' });
});
test('mixed index field modes are rejected rather than claimed as coverage', () => {
  expect(() => readIndexConfig({ indexes: [{ collectionGroup: 'projects', queryScope: 'COLLECTION', fields: [{ fieldPath: 'tags', order: 'ASCENDING', arrayConfig: 'CONTAINS' }] }] })).toThrow();
});
