/**
 * Field paths of an `update` write.
 *
 * Firestore's `update` takes either an object whose keys are dot-separated
 * field paths or an alternating list of field paths and values, where each
 * field path is a dot-separated string or a `FieldPath`. A `FieldPath`
 * segment may itself contain a dot: `new FieldPath('a.b')` names the
 * top-level field `a.b`, not `b` inside `a`. Both forms resolve to a list of
 * {@link UpdateField} entries whose `path` is the literal segment vector.
 *
 * Inside the sandbox engine an update payload stays a `DocumentData` map.
 * Each key is the entry's field path in a Pyric-internal encoding
 * ({@link fieldPathKey}): a segment that contains `.`, a backtick or a
 * backslash is quoted with backticks, and every other segment is written
 * bare, so a plain dotted key keeps its usual meaning.
 * {@link fieldPathKeySegments} decodes a key back to its segments, so a
 * literal dot never becomes a nested path.
 *
 * The encoding never leaves the engine. Events, errors and denial context
 * carry the decoded payload ({@link updatePayloadTree}) with the field
 * paths as segment vectors ({@link updatePayloadMask}); a consumer that
 * re-executes the update rebuilds the payload with
 * {@link updatePayloadFromTree}.
 */
import { FirebaseError } from '../../sandbox/internal/firebase-error.js';
import { isPlainObject } from '../plain-object.js';

type DocumentData = Record<string, unknown>;

/** One update entry: a literal field path and the value written there. */
export interface UpdateField {
  readonly path: readonly string[];
  readonly value: unknown;
}

/** A segment is written bare when the key decoder reads it back unchanged. */
function needsQuoting(segment: string): boolean {
  return segment.length === 0 || /[.`\\]/.test(segment);
}

/** Encode a segment vector as one update-data key. */
export function fieldPathKey(segments: readonly string[]): string {
  return segments
    .map((segment) => needsQuoting(segment)
      ? `\`${segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``
      : segment)
    .join('.');
}

/**
 * Decode an update-data key to its segments. Unquoted segments split on
 * `.`, so a plain dotted key such as `board.c1r1` reads as two segments;
 * a backtick-quoted segment is taken literally with `\` escapes removed.
 */
export function fieldPathKeySegments(key: string): string[] {
  if (!key.includes('`')) return key.split('.');
  const segments: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < key.length; i++) {
    const char = key[i];
    if (quoted) {
      if (char === '\\' && i + 1 < key.length) {
        current += key[++i];
      } else if (char === '`') {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '`') {
      quoted = true;
    } else if (char === '.') {
      segments.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments;
}

/** Build the engine's update payload. A repeated path keeps its last value. */
export function updateFieldsData(fields: readonly UpdateField[]): DocumentData {
  const data: DocumentData = {};
  for (const field of fields) data[fieldPathKey(field.path)] = field.value;
  return data;
}

function setOwn(target: DocumentData, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Decode an engine update payload to the document fields it writes: each
 * key's segments become nested maps, so `{'board.c1r1': 'x'}` reads
 * `{ board: { c1r1: 'x' } }` and a literal-dot segment stays one key.
 * Values, including transform sentinels, are kept as given.
 */
export function updatePayloadTree(data: DocumentData): DocumentData {
  const tree: DocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    const segments = fieldPathKeySegments(key);
    let cursor = tree;
    for (const segment of segments.slice(0, -1)) {
      const next = Object.hasOwn(cursor, segment) ? cursor[segment] : undefined;
      if (!isPlainObject(next)) setOwn(cursor, segment, {});
      cursor = cursor[segment] as DocumentData;
    }
    setOwn(cursor, segments[segments.length - 1], value);
  }
  return tree;
}

/** The field paths of an engine update payload, as segment vectors. */
export function updatePayloadMask(data: DocumentData): string[][] {
  return Object.keys(data).map(fieldPathKeySegments);
}

/** Rebuild an engine update payload from its decoded tree and field paths. */
export function updatePayloadFromTree(tree: DocumentData, mask: readonly (readonly string[])[]): DocumentData {
  const data: DocumentData = {};
  for (const path of mask) {
    let value: unknown = tree;
    for (const segment of path) {
      value = isPlainObject(value) && Object.hasOwn(value, segment) ? value[segment] : undefined;
    }
    setOwn(data, fieldPathKey(path), value);
  }
  return data;
}

/**
 * The engine payload behind a public one, for re-executing a recorded
 * write: an update's tree and field paths become its encoded payload again.
 */
export function enginePayloadOf(
  payload: { resourceData?: DocumentData; updateMask?: readonly (readonly string[])[] } | undefined,
): DocumentData | undefined {
  const tree = payload?.resourceData;
  if (tree === undefined) return undefined;
  const mask = payload?.updateMask;
  return mask === undefined ? tree : updatePayloadFromTree(tree, mask);
}

/** True when a write's payload is keyed by encoded field paths: a non-merge update. */
export function isFieldPathUpdate(write: { method: string; merge?: unknown }): boolean {
  return write.method === 'update' && (write.merge === undefined || write.merge === false);
}

/**
 * The public view of a write payload: a non-merge update's decoded tree
 * with its field paths, any other write's data unchanged.
 */
export function publicWritePayload(
  write: { method: string; merge?: unknown },
  data: DocumentData,
): { resourceData: DocumentData; updateMask?: string[][] } {
  if (!isFieldPathUpdate(write)) return { resourceData: data };
  return { resourceData: updatePayloadTree(data), updateMask: updatePayloadMask(data) };
}

/** The segment vector of a `FieldPath` from either mapped SDK, or undefined. */
export function fieldPathArgumentSegments(value: unknown): string[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const internal = (value as { _internalPath?: { segments?: unknown } })._internalPath;
  const segments = internal?.segments;
  const isSegmentVector = Array.isArray(segments) && segments.every((part) => typeof part === 'string');
  if (!isSegmentVector) return undefined;
  return [...(segments as string[])];
}

/** True when an `update` call's first data argument selects the field-and-value form. */
export function isFieldArgument(value: unknown): boolean {
  return typeof value === 'string' || fieldPathArgumentSegments(value) !== undefined;
}

// ─── Web SDK argument parsing ─────────────────────────────────────────

const FIELD_PATH_RESERVED = /[~*/[\]]/;
const SIMPLE_FIELD_NAME = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

/**
 * Firestore's canonical field-path string, as the SDKs print a field path
 * in messages: a segment that is not a simple identifier is backtick-quoted
 * with `\` and backtick escaped.
 */
export function canonicalFieldPath(segments: readonly string[]): string {
  return segments
    .map((segment) => {
      const escaped = segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
      return SIMPLE_FIELD_NAME.test(escaped) ? escaped : `\`${escaped}\``;
    })
    .join('.');
}

/**
 * The Web SDK refuses `undefined` anywhere in written data. The message
 * names the field when the value sits in a map; an array element has no
 * field path, as in the SDK.
 */
function assertNoUndefined(
  methodName: string,
  targetDoc: string,
  value: unknown,
  path: readonly string[] | undefined,
): void {
  if (value === undefined) {
    const field = path !== undefined && path.length > 0 ? ` in field ${canonicalFieldPath(path)}` : '';
    throw new FirebaseError(
      'invalid-argument',
      `Function ${methodName}() called with invalid data. Unsupported field value: undefined (found${field} in document ${targetDoc})`,
    );
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoUndefined(methodName, targetDoc, entry, undefined);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoUndefined(methodName, targetDoc, entry, path === undefined ? undefined : [...path, key]);
    }
  }
}

function invalidData(methodName: string, reason: string, targetDoc?: string): FirebaseError {
  const found = targetDoc === undefined ? '' : ` (found in document ${targetDoc})`;
  return new FirebaseError(
    'invalid-argument',
    `Function ${methodName}() called with invalid data. ${reason}${found}`,
  );
}

/** `fieldPathFromDotSeparatedString` of the Web SDK. */
function dotSeparatedSegments(methodName: string, path: string, targetDoc?: string): string[] {
  if (FIELD_PATH_RESERVED.test(path)) {
    throw invalidData(
      methodName,
      `Invalid field path (${path}). Paths must not contain '~', '*', '/', '[', or ']'`,
      targetDoc,
    );
  }
  const segments = path.split('.');
  if (segments.some((segment) => segment.length === 0)) {
    throw invalidData(
      methodName,
      `Invalid field path (${path}). Paths must not be empty, begin with '.', end with '.', or contain '..'`,
      targetDoc,
    );
  }
  return segments;
}

/** `fieldPathFromArgument` of the Web SDK. */
function fieldArgumentSegments(methodName: string, field: unknown, targetDoc?: string): string[] {
  const segments = fieldPathArgumentSegments(field);
  if (segments !== undefined) return segments;
  if (typeof field === 'string') return dotSeparatedSegments(methodName, field);
  throw invalidData(methodName, 'Field path arguments must be of type string or ', targetDoc);
}

/**
 * Parse the arguments after the document reference of a Web SDK
 * `updateDoc` / `WriteBatch.update` / `Transaction.update` call, with the
 * SDK's validation and error messages. In the field-and-value form a
 * repeated field path keeps its last value.
 */
export function parseUpdateArguments(
  methodName: string,
  targetDoc: string,
  dataOrField: unknown,
  rest: readonly unknown[],
): UpdateField[] {
  if (!isFieldArgument(dataOrField)) {
    if (!isPlainObject(dataOrField)) {
      throw invalidData(methodName, 'Data must be an object, but it was: ' + describe(dataOrField), targetDoc);
    }
    return Object.entries(dataOrField).map(([key, value]) => {
      const path = dotSeparatedSegments(methodName, key, targetDoc);
      assertNoUndefined(methodName, targetDoc, value, path);
      return { path, value };
    });
  }
  const [value, ...moreFieldsAndValues] = rest;
  const fields: UpdateField[] = [
    { path: fieldArgumentSegments(methodName, dataOrField, targetDoc), value },
  ];
  if (moreFieldsAndValues.length % 2 !== 0) {
    throw new FirebaseError(
      'invalid-argument',
      `Function ${methodName}() needs to be called with an even number of arguments that alternate between field names and values.`,
    );
  }
  for (let i = 0; i < moreFieldsAndValues.length; i += 2) {
    fields.push({
      path: fieldArgumentSegments(methodName, moreFieldsAndValues[i]),
      value: moreFieldsAndValues[i + 1],
    });
  }
  // Values are checked last to first and a repeated field only at its last
  // value, the order in which the SDK parses them.
  const checked: string[] = [];
  for (let i = fields.length - 1; i >= 0; i--) {
    const key = fieldPathKey(fields[i].path);
    if (checked.includes(key)) continue;
    checked.push(key);
    assertNoUndefined(methodName, targetDoc, fields[i].value, fields[i].path);
  }
  return fields;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value.length > 20 ? `${value.substring(0, 20)}...` : value}"`;
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'a custom object';
  if (typeof value === 'function') return 'a function';
  return String(value);
}
