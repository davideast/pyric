import type { Bound, QuerySpec } from './sandbox/query.js';

const INVALID_PATH = /[.#$\[\]\u0000-\u001f\u007f]/;
const INVALID_KEY = /[.#$/\[\]\u0000-\u001f\u007f]/;
const KEY_ERROR_SUFFIX =
  'Firebase keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]").';
const DATA_KEY_ERROR_SUFFIX =
  'Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"';
const PRIORITY_ERROR =
  'Query: When ordering by priority, the first argument passed to startAt(), startAfter() endAt(), endBefore(), or equalTo() must be a valid priority value (null, a number, or a string).';
const OBJECT_ENDPOINT_ERROR =
  'Query: First argument passed to startAt(), startAfter(), endAt(), endBefore(), or equalTo() cannot be an object.';
const KEY_ENDPOINT_ERROR =
  'Query: When ordering by key, the argument passed to startAt(), startAfter(), endAt(), endBefore(), or equalTo() must be a string.';
const KEY_SECOND_ARGUMENT_ERROR =
  'Query: When ordering by key, you may only pass one argument to startAt(), endAt(), or equalTo().';

type EndpointName = Bound['kind'];

export function validateLimit(name: 'limitToFirst' | 'limitToLast', value: unknown): void {
  if (typeof value !== 'number' || value <= 0 || Math.floor(value) !== value) {
    throw new Error(`${name}: First argument must be a positive integer.`);
  }
}

export function validateOrderByChildPath(path: unknown): asserts path is string {
  const rendered = String(path);
  if (rendered === '$key' || rendered === '$priority' || rendered === '$value') {
    const replacement = rendered === '$key'
      ? 'orderByKey'
      : rendered === '$priority' ? 'orderByPriority' : 'orderByValue';
    throw new Error(`orderByChild: "${rendered}" is invalid.  Use ${replacement}() instead.`);
  }
  if (typeof path !== 'string' || path.length === 0 || INVALID_PATH.test(path)) {
    throw new Error(
      `orderByChild failed: path argument was an invalid path = "${rendered}". `
      + 'Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"',
    );
  }
}

export function validateCursorKey(name: EndpointName, key: unknown): asserts key is string | undefined {
  if (key === undefined) return;
  if (typeof key !== 'string' || key.length === 0 || INVALID_KEY.test(key)) {
    throw new Error(
      `${name} failed: key argument was an invalid key = "${String(key)}".  ${KEY_ERROR_SUFFIX}`,
    );
  }
}

export function normalizeOptionalEndpointValue(
  name: EndpointName,
  value: unknown,
): unknown {
  return value === undefined && (name === 'startAt' || name === 'endAt') ? null : value;
}

function validateEndpointData(name: EndpointName, value: unknown): void {
  if (value === undefined) {
    throw new Error(`${name} failed: value argument contains undefined `);
  }
  if (typeof value === 'function') {
    throw new Error(`${name} failed: value argument contains a function `);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`${name} failed: value argument contains ${String(value)} `);
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== '.sv' && (key.length === 0 || INVALID_KEY.test(key))) {
      throw new Error(
        `${name} failed: value argument  contains an invalid key (${key}) .  ${DATA_KEY_ERROR_SUFFIX}`,
      );
    }
    validateEndpointData(name, child);
  }
}

function isServerValuePriority(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && Object.keys(value as Record<string, unknown>).length === 1
    && typeof (value as Record<string, unknown>)['.sv'] === 'string';
}

export function validateQuerySpec(spec: QuerySpec): void {
  if (spec.orderBy?.kind === 'child'
    && spec.orderBy.path.split('/').filter(Boolean).length === 0) {
    throw new Error('orderByChild: cannot pass in empty path. Use orderByValue() instead.');
  }
  for (const bound of spec.bounds) {
    const value = bound.value as unknown;
    validateEndpointData(bound.kind, value);
    switch (spec.orderBy?.kind ?? 'priority') {
      case 'key':
        if (typeof value !== 'string') throw new Error(KEY_ENDPOINT_ERROR);
        if (bound.key !== undefined) throw new Error(KEY_SECOND_ARGUMENT_ERROR);
        break;
      case 'priority':
        if (value !== null && typeof value !== 'string'
          && !(typeof value === 'number' && Number.isFinite(value))
          && !isServerValuePriority(value)) {
          throw new Error(PRIORITY_ERROR);
        }
        break;
      case 'child':
      case 'value':
        if (value !== null && typeof value === 'object') throw new Error(OBJECT_ENDPOINT_ERROR);
        break;
    }
  }
}
