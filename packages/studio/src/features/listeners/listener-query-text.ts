/**
 * One listener's query, printed as the call the developer wrote (feature:
 * Listeners).
 *
 * PURE. The attach event carries the query as data: Firestore's constraint
 * projection (scope, filters, orderBy, limit, cursors, each operand with a
 * bounded display value) and the Realtime Database's query spec (ordering,
 * bounds, limit). Neither shape is what a developer recognises, so this module
 * renders the modular SDK call that produced it, with the real operands.
 *
 * The event field is `unknown`, so every read here is a defensive one: a shape
 * this module does not recognise contributes nothing rather than throwing, and
 * a listener whose target is one document renders no call at all.
 *
 * Two strings come back. `text` is what the block prints, with any operand
 * over {@link MAX_VALUE} characters cut short; `full` carries every operand
 * whole, for the copy control and the title of a cut-short line.
 */

import type { ActiveListenerTarget } from 'pyric/sandbox';

/** How long an operand may print before the block cuts it short. */
export const MAX_VALUE = 40;

/** The indentation one nesting level adds. */
const INDENT = '  ';

export interface ListenerQueryText {
  /** The call as the block prints it, long operands cut short. */
  readonly text: string;
  /** The same call with every operand whole. */
  readonly full: string;
}

/** What one listener's query is read off. */
export interface ListenerQuerySource {
  readonly service: 'firestore' | 'database';
  readonly target: ActiveListenerTarget;
  /** The query the attach recorded, when the listener watches one. */
  readonly query?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A single-quoted string literal, with inner quotes and newlines escaped. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/** Cut one operand short at {@link MAX_VALUE}, keeping a string's quotes. */
function shorten(token: string): string {
  if (token.length <= MAX_VALUE) return token;
  if (token.startsWith("'") && token.endsWith("'")) {
    return `${token.slice(0, MAX_VALUE - 2)}…'`;
  }
  return `${token.slice(0, MAX_VALUE - 1)}…`;
}

/**
 * One operand as source text. `whole` prints every operand in full; otherwise
 * each operand is cut short on its own, so a long string inside an array is
 * cut rather than the array.
 */
function valueText(value: unknown, whole: boolean): string {
  const token = valueToken(value, whole);
  return whole ? token : shorten(token);
}

function valueToken(value: unknown, whole: boolean): string {
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (!isRecord(value)) return '…';
  switch (value.type) {
    case 'string':
      return typeof value.value === 'string' ? quote(value.value) : '…';
    case 'number':
    case 'boolean':
      return String(value.value);
    case 'null':
      return 'null';
    case 'reference':
      return typeof value.path === 'string' ? `doc(db, ${quote(value.path)})` : '…';
    case 'timestamp':
      return typeof value.iso === 'string' ? quote(value.iso) : '…';
    case 'geoPoint':
      return `GeoPoint(${String(value.latitude)}, ${String(value.longitude)})`;
    case 'bytes':
      return `Bytes(${String(value.length)})`;
    case 'vector':
      return `Vector(${String(value.length)})`;
    case 'array': {
      const values = Array.isArray(value.values) ? value.values : [];
      const items = values.map((item) => valueText(item, whole));
      if (value.truncated === true) items.push('…');
      return `[${items.join(', ')}]`;
    }
    case 'map': {
      const entries = Array.isArray(value.entries) ? value.entries : [];
      const items = entries
        .filter((entry): entry is [string, unknown] => Array.isArray(entry)
          && typeof entry[0] === 'string')
        .map(([key, item]) => `${key}: ${valueText(item, whole)}`);
      if (value.truncated === true) items.push('…');
      return items.length === 0 ? '{}' : `{ ${items.join(', ')} }`;
    }
    default:
      return '…';
  }
}

/**
 * One `where`, `or`, or `and` clause as one block, indented to `depth`. A
 * composite's closing parenthesis lands on its last child's line, the way a
 * developer closes a nested call.
 */
function filterBlock(filter: unknown, depth: number, whole: boolean): string | undefined {
  if (!isRecord(filter)) return undefined;
  const pad = INDENT.repeat(depth);
  if (filter.kind === 'where') {
    const field = typeof filter.field === 'string' ? filter.field : '';
    const op = typeof filter.op === 'string' ? filter.op : '';
    const operand = 'display' in filter ? filter.display : filter.value;
    return `${pad}where(${quote(field)}, ${quote(op)}, ${valueText(operand, whole)})`;
  }
  if (filter.kind !== 'or' && filter.kind !== 'and') return undefined;
  const nested = Array.isArray(filter.filters) ? filter.filters : [];
  const blocks = nested
    .map((entry) => filterBlock(entry, depth + 1, whole))
    .filter((block): block is string => block !== undefined);
  if (blocks.length === 0) return undefined;
  return `${pad}${filter.kind}(\n${blocks.join(',\n')})`;
}

/** The cursor call one bound names: inclusive bounds are `startAt`/`endAt`. */
function cursorBlock(
  cursor: unknown,
  edge: 'start' | 'end',
  whole: boolean,
): string | undefined {
  if (!isRecord(cursor)) return undefined;
  const values = Array.isArray(cursor.display)
    ? cursor.display
    : Array.isArray(cursor.values) ? cursor.values : [];
  if (values.length === 0) return undefined;
  const inclusive = cursor.inclusive !== false;
  const call = edge === 'start'
    ? (inclusive ? 'startAt' : 'startAfter')
    : (inclusive ? 'endAt' : 'endBefore');
  return `${INDENT}${call}(${values.map((value) => valueText(value, whole)).join(', ')})`;
}

/** The source the Firestore call reads from: one collection, or a group. */
function firestoreSource(collection: string, query: Record<string, unknown> | undefined): string {
  const scope = isRecord(query?.scope) ? query.scope : undefined;
  return scope?.kind === 'collection-group'
    ? `collectionGroup(db, ${quote(collection)})`
    : `collection(db, ${quote(collection)})`;
}

/** Every constraint of one Firestore query, in the order a call states them:
 *  filters, ordering, window, then cursors. */
function firestoreConstraints(query: Record<string, unknown>, whole: boolean): string[] {
  const lines: string[] = [];
  const filters = Array.isArray(query.filters) ? query.filters : [];
  for (const filter of filters) {
    const block = filterBlock(filter, 1, whole);
    if (block !== undefined) lines.push(block);
  }

  const orders = Array.isArray(query.orderBy) ? query.orderBy : [];
  for (const order of orders) {
    if (!isRecord(order) || typeof order.field !== 'string') continue;
    lines.push(order.direction === 'desc'
      ? `${INDENT}orderBy(${quote(order.field)}, 'desc')`
      : `${INDENT}orderBy(${quote(order.field)})`);
  }

  if (typeof query.limit === 'number') {
    lines.push(query.limitFromEnd === true
      ? `${INDENT}limitToLast(${String(query.limit)})`
      : `${INDENT}limit(${String(query.limit)})`);
  }

  const start = cursorBlock(query.start, 'start', whole);
  if (start !== undefined) lines.push(start);
  const end = cursorBlock(query.end, 'end', whole);
  if (end !== undefined) lines.push(end);
  return lines;
}

function firestoreText(
  collection: string,
  query: Record<string, unknown> | undefined,
  whole: boolean,
): string {
  const source = firestoreSource(collection, query);
  const constraints = query === undefined ? [] : firestoreConstraints(query, whole);
  if (constraints.length === 0) return source;
  return `query(${source},\n${constraints.join(',\n')})`;
}

/** The ordering call one spec names. */
function orderByCall(orderBy: unknown): string {
  if (!isRecord(orderBy)) return '';
  if (orderBy.kind === 'child') {
    return typeof orderBy.path === 'string' ? `.orderByChild(${quote(orderBy.path)})` : '';
  }
  if (orderBy.kind === 'key') return '.orderByKey()';
  if (orderBy.kind === 'value') return '.orderByValue()';
  if (orderBy.kind === 'priority') return '.orderByPriority()';
  return '';
}

const RTDB_BOUNDS = new Set(['startAt', 'startAfter', 'endAt', 'endBefore', 'equalTo']);

function databaseText(path: string, query: unknown, whole: boolean): string {
  const calls: string[] = [];
  if (isRecord(query)) {
    calls.push(orderByCall(query.orderBy));
    const bounds = Array.isArray(query.bounds) ? query.bounds : [];
    for (const bound of bounds) {
      if (!isRecord(bound) || typeof bound.kind !== 'string') continue;
      if (!RTDB_BOUNDS.has(bound.kind)) continue;
      const args = [valueText(bound.value, whole)];
      if (typeof bound.key === 'string') args.push(quote(bound.key));
      calls.push(`.${bound.kind}(${args.join(', ')})`);
    }
    const limit = query.limit;
    if (isRecord(limit)
      && typeof limit.n === 'number'
      && (limit.kind === 'limitToFirst' || limit.kind === 'limitToLast')) {
      calls.push(`.${limit.kind}(${String(limit.n)})`);
    }
  }
  return `ref(db, ${quote(path)})${calls.join('')}`;
}

/**
 * The call one listener's target names, or nothing when there is no call to
 * print: a Firestore document listener watches one record, and its path is
 * already the headline.
 */
export function listenerQueryText(source: ListenerQuerySource): ListenerQueryText | undefined {
  if (source.service === 'database') {
    const path = typeof source.target === 'string' ? source.target : '';
    if (path === '') return undefined;
    return {
      text: databaseText(path, source.query, false),
      full: databaseText(path, source.query, true),
    };
  }
  if (typeof source.target === 'string') return undefined;
  const collection = source.target.collection;
  if (collection === '') return undefined;
  const query = isRecord(source.query)
    ? source.query
    : isRecord(source.target.query) ? source.target.query : undefined;
  return {
    text: firestoreText(collection, query, false),
    full: firestoreText(collection, query, true),
  };
}
