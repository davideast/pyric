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
 * Inside the sandbox engine an update payload stays a `DocumentData` map so
 * event logs, request events, rules projection and persistence keep one
 * shape. Each key is the entry's field path in Firestore's canonical
 * string form ({@link fieldPathKey}): a segment that contains `.`, a
 * backtick or a backslash is quoted with backticks, the same encoding the
 * Firestore API uses for `DocumentMask.fieldPaths`. {@link fieldPathKeySegments}
 * decodes a key back to its segments, so a literal dot never becomes a
 * nested path.
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
    return Object.entries(dataOrField).map(([key, value]) => ({
      path: dotSeparatedSegments(methodName, key, targetDoc),
      value,
    }));
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
