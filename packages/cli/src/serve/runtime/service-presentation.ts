import { isDatabaseIndexQuery, type ServiceIndexQuery, type ServiceIndexDefinition } from 'pyric/sandbox/internal';

const SERVICE_LABELS: Record<string, string> = {
  firestore: 'Firestore',
  database: 'Realtime Database',
  rtdb: 'Realtime Database',
  storage: 'Storage',
  auth: 'Authentication',
};

export function serviceLabel(service: string | null): string {
  if (!service) return 'Runtime';
  return SERVICE_LABELS[service] ?? service;
}

export function sourceLabel(service: string, path: string, query: boolean): string {
  if (service === 'rtdb' || service === 'database') return 'Realtime Database node';
  if (service === 'firestore') {
    const isCollection = query || path.split('/').filter(Boolean).length % 2 === 1;
    if (isCollection) return 'Firestore collection';
    return 'Firestore document';
  }
  return serviceLabel(service);
}

export interface IndexFact {
  label: string;
  values: Array<{ code: string; text?: string }>;
}

function indexFieldLabel(field: { arrayConfig?: string; order?: string }): string {
  if (field.arrayConfig) return 'Array contains';
  if (field.order === 'DESCENDING') return 'Descending';
  return 'Ascending';
}

/** Service adapters provide facts and definitions; shared renderers own every track and action. */
export function indexPresentation(query: ServiceIndexQuery, definition?: ServiceIndexDefinition) {
  const facts: IndexFact[] = [];
  if (isDatabaseIndexQuery(query)) {
    const order = query.orderBy;
    let field = '.priority';
    if (order?.kind === 'child') field = order.path;
    else if (order?.kind === 'value') field = '.value';
    else if (order?.kind === 'key') field = '.key';
    facts.push({ label: 'Sort', values: [{ code: field, text: 'Ascending' }] });
    facts.push({ label: 'Path', values: [{ code: query.path }] });
    if (definition && 'indexOn' in definition) {
      facts.push({ label: 'Rule path', values: [{ code: definition.path }] });
      const indexOn = definition.indexOn.length === 1 ? definition.indexOn[0] : definition.indexOn;
      return {
        facts,
        fields: definition.indexOn.map(code => ({ code, text: '' })),
        definition: { '.indexOn': indexOn },
      };
    }
  } else {
    if (query.filters.length) {
      facts.push({
        label: 'Filters',
        values: query.filters.map(filter => ({ code: filter.field, text: filter.op === '==' ? '' : `(${filter.op})` })),
      });
    }
    if (query.orders.length) {
      facts.push({
        label: 'Sort',
        values: query.orders.map(order => ({ code: order.field, text: order.direction === 'asc' ? 'Ascending' : 'Descending' })),
      });
    }
    facts.push({
      label: 'Scope',
      values: [{ code: '', text: query.queryScope === 'COLLECTION' ? 'Collection' : 'Collection group' }],
    });
    if (definition && 'fields' in definition) {
      return {
        facts,
        fields: definition.fields.map(item => ({ code: item.fieldPath, text: indexFieldLabel(item) })),
        definition,
      };
    }
  }
  return { facts, fields: [], definition: undefined };
}
