import type { IndexesConfig, IndexesConfigEntry, IndexField } from './types.js';

/** Index diagnostics contain field names and operators, never query operands. */
export interface IndexQuery {
  collectionGroup: string;
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  filters: Array<{ field: string; op: string }>;
  orders: Array<{ field: string; direction: 'asc' | 'desc' }>;
  unsupported?: string;
}
export type IndexFinding =
  | { status: 'covered'; basis: 'automatic' | 'configured' }
  | { status: 'missing'; index: IndexesConfigEntry }
  | { status: 'unavailable'; reason: string; index?: IndexesConfigEntry };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Adapters supply captured descriptors; values/cursors are deliberately never read. */
export function captureIndexQuery(path: string, group: boolean, filters: readonly unknown[], orders: readonly unknown[]): IndexQuery {
  const query: IndexQuery = { collectionGroup: path.split('/').filter(Boolean).at(-1) ?? '', queryScope: group ? 'COLLECTION_GROUP' : 'COLLECTION', filters: [], orders: [] };
  const visit = (input: unknown, depth: number): void => {
    const entry = object(input);
    if (!entry || depth > 12 || query.filters.length >= 64) { query.unsupported = 'This query exceeds the index checker’s supported limits.'; return; }
    if (entry.kind === 'and' && Array.isArray(entry.filters)) { entry.filters.forEach(child => visit(child, depth + 1)); return; }
    if (entry.kind !== 'where' || typeof entry.field !== 'string' || typeof entry.op !== 'string') { query.unsupported = 'This query uses a filter the index checker does not support yet.'; return; }
    query.filters.push({ field: entry.field, op: entry.op });
  };
  filters.forEach(entry => visit(entry, 0));
  for (const input of orders.slice(0, 64)) {
    const entry = object(input);
    if (!entry || typeof entry.field !== 'string' || (entry.direction !== 'asc' && entry.direction !== 'desc')) { query.unsupported = 'This sort order cannot be checked yet.'; continue; }
    query.orders.push({ field: entry.field, direction: entry.direction });
  }
  if (orders.length > 64) query.unsupported = 'This query exceeds the index checker’s supported limits.';
  return query;
}

function hasOneIndexMode(field: Record<string, unknown>): boolean {
  const modes = [field.order, field.arrayConfig, field.vectorConfig].filter(value => value !== undefined);
  if (modes.length !== 1) return false;
  return field.order === 'ASCENDING' || field.order === 'DESCENDING' || field.arrayConfig === 'CONTAINS' || object(field.vectorConfig) !== undefined;
}

function hasUnsupportedFilterCombination(ranges: string[], arrays: IndexQuery['filters']): boolean {
  if (ranges.length > 1 || arrays.length > 1) return true;
  return ranges.length > 0 && arrays.length > 0;
}

/** Validate before claiming coverage or allowing a file edit. Preserve unrelated metadata. */
export function readIndexConfig(value: unknown): IndexesConfig {
  const config = object(value);
  if (!config || !Array.isArray(config.indexes) || (config.fieldOverrides !== undefined && !Array.isArray(config.fieldOverrides))) throw new Error('The index configuration is invalid. Fix the file before adding an index.');
  for (const item of config.indexes) {
    const index = object(item);
    if (!index || typeof index.collectionGroup !== 'string' || !['COLLECTION', 'COLLECTION_GROUP'].includes(String(index.queryScope)) || !Array.isArray(index.fields)) throw new Error('The index configuration contains an invalid index.');
    for (const value of index.fields) {
      const field = object(value);
      if (!field || typeof field.fieldPath !== 'string' || !hasOneIndexMode(field)) throw new Error('The index configuration contains an invalid field.');
    }
  }
  for (const value of config.fieldOverrides ?? []) {
    const field = object(value);
    if (!field || typeof field.collectionGroup !== 'string' || typeof field.fieldPath !== 'string' || (field.indexes !== undefined && !Array.isArray(field.indexes))) throw new Error('The index configuration contains an invalid field override.');
  }
  return config as unknown as IndexesConfig;
}

function automaticField(config: IndexesConfig, query: IndexQuery, field: IndexField): boolean {
  const overrides = (config.fieldOverrides ?? []).map(object).filter(item => item?.collectionGroup === query.collectionGroup && typeof item.fieldPath === 'string');
  const candidates = overrides.filter(item => item && (item.fieldPath === '*' || item.fieldPath === field.fieldPath || field.fieldPath.startsWith(`${item.fieldPath}.`)))
    .sort((a, b) => (b?.fieldPath === '*' ? 0 : String(b?.fieldPath).length) - (a?.fieldPath === '*' ? 0 : String(a?.fieldPath).length));
  const override = candidates.find(item => item?.indexes !== undefined);
  if (!override) return query.queryScope === 'COLLECTION';
  return (override.indexes as unknown[]).some(value => {
    const index = object(value);
    return index?.queryScope === query.queryScope && (field.arrayConfig ? index.arrayConfig === field.arrayConfig : index?.order === field.order);
  });
}

function matches(index: IndexesConfigEntry, query: IndexQuery, equality: string[], ordered: IndexField[]): boolean {
  if (index.collectionGroup !== query.collectionGroup || index.queryScope !== query.queryScope || index.fields.some(field => field.vectorConfig)) return false;
  // Firestore appends __name__ automatically. Explicit document-ID queries are not inferred here.
  const fields = index.fields.filter(field => field.fieldPath !== '__name__');
  if (fields.length !== equality.length + ordered.length) return false;
  const prefix = fields.slice(0, equality.length);
  if (!equality.every(field => prefix.some(item => item.fieldPath === field && !!item.order))) return false;
  return ordered.every((field, offset) => {
    const actual = fields[equality.length + offset];
    return actual.fieldPath === field.fieldPath && actual.order === field.order && actual.arrayConfig === field.arrayConfig;
  });
}

/** A bounded, conservative subset. Unsupported shapes never produce a guessed requirement. */
export function analyzeIndexQuery(query: IndexQuery, config: IndexesConfig | null): IndexFinding {
  const unavailable = (reason: string): IndexFinding => ({ status: 'unavailable', reason });
  if (query.unsupported) return unavailable(query.unsupported);
  if (!query.collectionGroup || [...query.filters, ...query.orders].some(field => field.field === '__name__' || field.field.includes('`'))) return unavailable('Document ID and escaped field-path queries cannot be checked yet.');
  if (query.filters.some(filter => !['==', '<', '<=', '>', '>=', 'array-contains'].includes(filter.op))) return unavailable('This filter combination cannot be checked yet.');
  const ranges = [...new Set(query.filters.filter(filter => ['<', '<=', '>', '>='].includes(filter.op)).map(filter => filter.field))];
  const arrays = query.filters.filter(filter => filter.op === 'array-contains');
  if (hasUnsupportedFilterCombination(ranges, arrays)) return unavailable('Queries combining these range or array filters cannot be checked yet.');
  const equality = [...new Set(query.filters.filter(filter => filter.op === '==').map(filter => filter.field))].sort();
  if (equality.some(field => ranges.includes(field) || arrays.some(array => array.field === field))) return unavailable('Multiple filter types on the same field cannot be checked yet.');
  const orders = query.orders.filter(order => !equality.includes(order.field));
  if (ranges.length && orders.length && orders[0].field !== ranges[0]) return unavailable('The first sort field must match the range filter before indexing can be checked.');
  const ordered: IndexField[] = arrays.map(array => ({ fieldPath: array.field, arrayConfig: 'CONTAINS' }));
  ordered.push(...orders.map(order => ({ fieldPath: order.field, order: order.direction === 'asc' ? 'ASCENDING' as const : 'DESCENDING' as const })));
  if (ranges.length && !orders.some(order => order.field === ranges[0])) ordered.push({ fieldPath: ranges[0], order: 'ASCENDING' });
  const fields: IndexField[] = [...equality.map(fieldPath => ({ fieldPath, order: 'ASCENDING' as const })), ...ordered];
  if (new Set(fields.map(field => field.fieldPath)).size !== fields.length) return unavailable('Repeated index fields cannot be checked yet.');
  const index: IndexesConfigEntry = { collectionGroup: query.collectionGroup, queryScope: query.queryScope, fields };
  if (!config) return { status: 'unavailable', reason: 'No local index configuration is connected.', ...(fields.length > 1 ? { index } : {}) };
  if (config.indexes.some(entry => matches(entry, query, equality, ordered))) return { status: 'covered', basis: 'configured' };
  // Equality-only queries can merge single-field indexes. Do not invent a composite requirement.
  if (ordered.length === 0) {
    if (fields.every(field => automaticField(config, query, field) || automaticField(config, query, { ...field, order: 'DESCENDING' }))) return { status: 'covered', basis: 'automatic' };
    return unavailable('A field used by this query has no matching single-field index. Review its field override.');
  }
  if (fields.length === 1) {
    if (automaticField(config, query, fields[0])) return { status: 'covered', basis: 'automatic' };
    return unavailable('This query needs a single-field index. Review its field override.');
  }
  // Array membership plus equality can merge automatic indexes; a composite is an optimization.
  // https://firebase.google.com/docs/firestore/query-data/index-overview#index_merging
  if (arrays.length === 1 && orders.length === 0) {
    if (fields.every(field => automaticField(config, query, field))) return { status: 'covered', basis: 'automatic' };
    return unavailable('Array index merging with these field overrides cannot be checked yet.');
  }
  // Equality + sorting can also be served by merged compound indexes. Be conservative when present.
  if (equality.length > 1 && ordered.length === 1 && !arrays.length && !ranges.length && equality.every(field => config.indexes.some(entry => matches(entry, query, [field], ordered)))) return { status: 'covered', basis: 'configured' };
  const hasBroaderIndex = config.indexes.some(entry => entry.collectionGroup === query.collectionGroup && entry.queryScope === query.queryScope && entry.fields.length > fields.length && fields.every(field => entry.fields.some(candidate => candidate.fieldPath === field.fieldPath)));
  if (hasBroaderIndex) return unavailable('A broader index is configured. Its coverage cannot be checked yet.');
  return { status: 'missing', index };
}
