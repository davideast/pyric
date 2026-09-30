/**
 * Index access `value[index]` and dot access `value.name`, shared by the
 * Firestore simulator and the Storage evaluator.
 *
 * Production reads a map key with the same check as dot access: a key the
 * map does not own is an error ("Property k is undefined on object."), never
 * null, so `data['k'] == null` and `data['k'] != true` deny on a map without
 * `k`. A key present with a null value reads as null. A list index must be an
 * int within `[0, size)`; any other int is an out-of-bound error and any other
 * index type is an unsupported operation. Firestore and Storage report the
 * same verdict and text for every shape (corpus scenarios
 * `undefined-field-access`, `metadata-access` and
 * `list-map-literals-and-slice`). Each evaluator turns an
 * `IndexAccessFailure` into its own error value, so `&&`/`||` absorb it.
 */
import { describeRulesType, isRulesMap } from './rules-type.js';
import { RulesValue } from './wrappers/base.js';

/** Production's error for a failed index or key read. */
export class IndexAccessFailure {
  constructor(readonly message: string) {}
}

/** Production's error text for reading a key a map does not own. */
export function undefinedPropertyMessage(name: string): string {
  return `Property ${name} is undefined on object.`;
}

/** Production's error text for a list or string index outside `[0, size)`. */
export function indexOutOfBoundMessage(index: number, size: number): string {
  return `Index out of bound error. Index: [${index}] , size: [${size}].`;
}

/** `list[index]`: the element, or production's error for the index. */
export function indexList(list: readonly unknown[], index: unknown): unknown {
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    return new IndexAccessFailure(
      `Unsupported operation error. Received: list[${describeRulesType(index)}]. Expected: list[int].`,
    );
  }
  if (index < 0 || index >= list.length) {
    return new IndexAccessFailure(indexOutOfBoundMessage(index, list.length));
  }
  return list[index];
}

/** `map[key]`: the value of an own key, or production's error for a key the map does not own. */
export function indexMap(map: object, key: string): unknown {
  if (!Object.hasOwn(map, key)) return new IndexAccessFailure(undefinedPropertyMessage(key));
  const value = (map as Record<string, unknown>)[key];
  return value === undefined ? new IndexAccessFailure(undefinedPropertyMessage(key)) : value;
}

/** `string[index]`: the character at an int index, or production's error for the index. */
export function indexString(value: string, index: unknown): unknown {
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    return new IndexAccessFailure(
      `Unsupported operation error. Received: string[${describeRulesType(index)}]. Expected: string[int].`,
    );
  }
  if (index < 0 || index >= value.length) {
    return new IndexAccessFailure(indexOutOfBoundMessage(index, value.length));
  }
  return value[index];
}

/** A path value as index access reads it: its segments and the names bound to them. */
export interface IndexablePath {
  readonly segments: readonly string[];
  readonly bindings: Readonly<Record<string, string>>;
}

function isPath(value: unknown): value is RulesValue & IndexablePath {
  return value instanceof RulesValue && value.typeName === 'path';
}

/** Production's error for indexing a value that has no index operator, such as a duration. */
export const NO_INDEX_OPERATOR_MESSAGE = 'Function not found error: Name: [[]].';

/**
 * `value[index]` on any value, as production reads it: a list or a string by
 * int index, a map by key, a path by segment index or bound name
 * (`request.path[0]` is the first segment; an unbound name is an error, not
 * null). A wrapper value other than a path has no index operator (corpus
 * scenarios `undefined-field-access` and `list-map-literals-and-slice`).
 */
export function indexValue(value: unknown, index: unknown): unknown {
  if (Array.isArray(value)) return indexList(value, index);
  if (typeof value === 'string') return indexString(value, index);
  if (isPath(value)) {
    if (typeof index === 'number' && Number.isInteger(index)) {
      return index >= 0 && index < value.segments.length
        ? value.segments[index]
        : new IndexAccessFailure(indexOutOfBoundMessage(index, value.segments.length));
    }
    const name = String(index);
    return Object.hasOwn(value.bindings, name)
      ? value.bindings[name]
      : new IndexAccessFailure(undefinedPropertyMessage(name));
  }
  if (value instanceof RulesValue) return new IndexAccessFailure(NO_INDEX_OPERATOR_MESSAGE);
  return indexMap(value as object, String(index));
}

/**
 * `value.name` on a value that is not a wrapper: a map's own key, or
 * production's error. Dot access reads maps and paths only, so on a list,
 * string, number or bool it is a type error: `list.length` and
 * `'abc'.length` are errors, never the JavaScript property. Wrapper values
 * dispatch their own fields before this.
 */
export function readMember(value: unknown, name: string): unknown {
  if (isRulesMap(value)) return indexMap(value, name);
  return new IndexAccessFailure(`Type error. Received: [${describeRulesType(value)}] Expected: [map,path].`);
}
