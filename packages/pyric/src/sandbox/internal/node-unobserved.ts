/**
 * What a Node process under the live register reports it left unobserved,
 * as it sends the lists to the live host and the host lists them under the
 * process's client (`LiveClient`): the Google hosts it called that no live
 * row observed, the firebase-admin subpaths no row serves that it loaded,
 * and the ones whose row gates their calls but records none.
 *
 * The lists carry names only. A host is a bare DNS name and a subpath is
 * `firebase-admin/<name>`, so no path, query string, value, token or URL
 * with credentials fits either shape. The register caps and dedupes what it
 * sends (`boundNodeUnobservedList`), and the host refuses a frame whose lists
 * are not in these shapes and bounds (`readNodeUnobservedLists`).
 */

/** The lists, each absent when empty. */
export interface NodeUnobservedLists {
  /** The Google and Firebase hosts the process called that no live row observed, in first-call order. */
  readonly unobserved?: readonly string[];
  /** The firebase-admin subpaths no row serves that the process loaded. */
  readonly unobservedAdmin?: readonly string[];
  /** The firebase-admin subpaths the process loaded whose row gates their calls but records none. */
  readonly gatedAdmin?: readonly string[];
}

export type NodeUnobservedListName = keyof NodeUnobservedLists;

/** The most entries one list carries. */
export const MAX_NODE_UNOBSERVED_ENTRIES = 64;

/** A DNS name, as the live network report spells a host: no port, path, query or credentials. */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/** A firebase-admin subpath. */
const ADMIN_SUBPATH = /^firebase-admin(?:\/[a-z0-9-]{1,48}){1,2}$/;

const SHAPES: Readonly<Record<NodeUnobservedListName, RegExp>> = {
  unobserved: HOST_NAME,
  unobservedAdmin: ADMIN_SUBPATH,
  gatedAdmin: ADMIN_SUBPATH,
};

export const NODE_UNOBSERVED_LIST_NAMES: readonly NodeUnobservedListName[] = ['unobserved', 'unobservedAdmin', 'gatedAdmin'];

function isEntry(name: NodeUnobservedListName, value: unknown): value is string {
  return typeof value === 'string' && SHAPES[name].test(value);
}

/**
 * A list as the register sends it: its entries in the list's shape, each
 * once, in first-seen order, at most {@link MAX_NODE_UNOBSERVED_ENTRIES}.
 */
export function boundNodeUnobservedList(name: NodeUnobservedListName, entries: readonly string[]): string[] {
  const kept = [...new Set(entries)].filter((entry) => isEntry(name, entry));
  return kept.slice(0, MAX_NODE_UNOBSERVED_ENTRIES);
}

/** One list: absent, or a bounded list of distinct entries in its shape. Null when malformed. */
function readList(name: NodeUnobservedListName, value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  const isList = Array.isArray(value) && value.length <= MAX_NODE_UNOBSERVED_ENTRIES;
  if (!isList) return null;
  const isWellFormed = value.every((entry) => isEntry(name, entry)) && new Set(value).size === value.length;
  return isWellFormed ? [...(value as string[])] : null;
}

/**
 * The lists a record carries, each absent when empty, or null when any list
 * is malformed: not an array, over the bound, repeating an entry, or
 * holding anything but a name in its shape.
 */
export function readNodeUnobservedLists(record: Readonly<Record<string, unknown>>): NodeUnobservedLists | null {
  const lists: Partial<Record<NodeUnobservedListName, string[]>> = {};
  for (const name of NODE_UNOBSERVED_LIST_NAMES) {
    const list = readList(name, record[name]);
    if (list === null) return null;
    if (list !== undefined && list.length > 0) lists[name] = list;
  }
  return lists;
}
