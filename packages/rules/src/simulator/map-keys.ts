/**
 * `Map.keys()` and `Map.values()`, and the Map literal they read, shared by
 * the Firestore simulator and the Storage evaluator.
 *
 * `keys()` lists the map's own keys in ascending Unicode code point order,
 * whatever order the map was written in. Production sorts keys this way in
 * both services (corpus scenarios `required-fields-and-mapdiff` and
 * `upload-primitives-boundaries`): `'1' < '10' < '2' < 'A' < '_' < 'a'`, a
 * key sorts after its own prefix, and `'ｚ'` (U+FF5A) sorts before `'😀'`
 * (U+1F600), where UTF-16 code unit order and JavaScript's own key order
 * (integer-like keys first) differ.
 *
 * `values()` lists a Map literal's values in the order the literal wrote its
 * keys, integer-like keys included, and a repeated key keeps its first
 * position and its last value: `{'b': 1, '1': 2}.values()` is `[1, 2]` and
 * `{'a': 1, 'b': 2, 'a': 3}.values()` is `[3, 2]`. A map from the request,
 * such as `request.resource.data` or custom metadata, lists its values in
 * the order the request sent them, which is the map's JavaScript property
 * order. JavaScript puts integer-like keys first, so `mapLiteral` records a
 * literal's written order beside the map.
 *
 * Both methods take no argument; an argument is `Incorrect number of
 * arguments.`, returned as a `MapMethodFailure` carrying production's
 * message. The receiver is already a Map: `keys()`, `values()` or `get()` on
 * a List, string, Set or MapDiff is `functionNotFoundMessage`'s error, which
 * a caller reports itself. Each evaluator turns a failure into its own error
 * value, so `&&` and `||` can absorb it.
 */
export class MapMethodFailure {
  constructor(readonly message: string) {}
}

/** The Map methods production reports as "Function not found error" on another receiver type. */
export const MAP_METHOD_NAMES: ReadonlySet<string> = new Set(['diff', 'get', 'keys', 'values']);

/** Each Map literal's keys in the order written. */
const writtenOrder = new WeakMap<object, readonly string[]>();

/**
 * A Map literal's value: each entry in the order written, a repeated key
 * keeping its first position and its last value.
 */
export function mapLiteral(entries: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  const order: string[] = [];
  for (const [key, value] of entries) {
    if (!Object.hasOwn(map, key)) order.push(key);
    // defineProperty keeps a `__proto__` key an own entry, never the prototype.
    Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
  }
  writtenOrder.set(map, order);
  return map;
}

/** The Map methods that list a map's keys or values. */
export type MapListMethod = 'keys' | 'values';

/** `map.keys()` or `map.values()`, or production's failure for an argument. */
export function mapList(
  method: MapListMethod,
  map: Record<string, unknown>,
  args: readonly unknown[],
): unknown[] | MapMethodFailure {
  if (args.length !== 0) {
    return new MapMethodFailure(
      `Incorrect number of arguments. Received: ${args.length}. Expected: map.${method}().`,
    );
  }
  return method === 'keys' ? mapKeys(map) : mapValues(map);
}

/** The map's own keys in ascending Unicode code point order. */
export function mapKeys(map: Record<string, unknown>): string[] {
  return Object.keys(map).sort(compareCodePoints);
}

/** The map's values in the order its literal wrote them, or else its property order. */
export function mapValues(map: Record<string, unknown>): unknown[] {
  const order = writtenOrder.get(map) ?? Object.keys(map);
  return order.map((key) => map[key]);
}

function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a.charCodeAt(index) !== b.charCodeAt(index)) {
      // At the first differing code unit, the code points starting there
      // order the strings; a surrogate pair reads as its full code point.
      return a.codePointAt(index)! - b.codePointAt(index)!;
    }
  }
  return a.length - b.length;
}
