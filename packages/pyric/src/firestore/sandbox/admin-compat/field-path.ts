/**
 * Firebase Admin-compatible field paths and DocumentSnapshot field lookup.
 *
 * Every local/remote snapshot producer delegates here so validation, dotted
 * string traversal, literal-dot FieldPath segments, and missing-value behavior
 * cannot drift between one-shot, query, transaction, and listener reads.
 */

import { fieldPathArgumentSegments, isFieldArgument, type UpdateField } from '../update-fields.js';

const FORBIDDEN_STRING_FIELD_PATH = /[*~/[\]]/;
const SIMPLE_FIELD_NAME = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

export class FieldPath {
  /**
   * Structural compatibility with Pyric's Web-SDK FieldPath. Keeping the
   * segment vector available under the same internal shape also lets the
   * shared listener builder accept either mapped SDK's FieldPath instance.
   */
  readonly _internalPath: { segments: string[]; offset: number; len: number };

  constructor(...segments: string[]) {
    if (Array.isArray(segments[0])) {
      throw new Error(
        'The FieldPath constructor no longer supports an array as its first argument. ' +
          'Please unpack your array and call FieldPath() with individual arguments.',
      );
    }
    if (segments.length === 0) {
      throw new Error('Function "FieldPath()" requires at least 1 argument.');
    }
    segments.forEach((segment, index) => {
      if (typeof segment !== 'string') {
        throw new Error(`Element at index ${index} is not a valid string.`);
      }
      if (segment.length === 0) {
        throw new Error(`Element at index ${index} should not be an empty string.`);
      }
    });
    this._internalPath = {
      segments: [...segments],
      offset: 0,
      len: segments.length,
    };
  }

  private static readonly DOCUMENT_ID = new FieldPath('__name__');

  static documentId(): FieldPath {
    return FieldPath.DOCUMENT_ID;
  }

  isEqual(other: FieldPath): boolean {
    const theirs = fieldPathSegments(other);
    const ours = this._internalPath.segments;
    return ours.length === theirs.length && ours.every((segment, index) => segment === theirs[index]);
  }

  toString(): string {
    return this._internalPath.segments
      .map((segment) => SIMPLE_FIELD_NAME.test(segment)
        ? segment
        : `\`${segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``)
      .join('.');
  }
}

export type SnapshotFieldPath = string | FieldPath;

function invalidFieldPath(message: string): Error {
  return new Error(`Value for argument "field" is not a valid field path. ${message}`);
}

/** Convert a validated string/FieldPath argument to literal path segments. */
export function fieldPathSegments(fieldPath: SnapshotFieldPath): readonly string[] {
  if (fieldPath instanceof FieldPath) {
    return fieldPath._internalPath.segments;
  }
  // The Web-SDK-shaped listener surface has its own FieldPath class. It uses
  // this exact internal segment vector; accepting it keeps the shared listener
  // snapshot compatible on both canonical import paths.
  const segments = fieldPathArgumentSegments(fieldPath);
  if (segments !== undefined) return segments;
  if (fieldPath === undefined) {
    throw invalidFieldPath('The path cannot be omitted.');
  }
  if (typeof fieldPath !== 'string') {
    throw invalidFieldPath('Paths can only be specified as strings or via a FieldPath object.');
  }
  if (fieldPath.includes('..')) {
    throw invalidFieldPath('Paths must not contain ".." in them.');
  }
  if (fieldPath.startsWith('.') || fieldPath.endsWith('.')) {
    throw invalidFieldPath('Paths must not start or end with ".".');
  }
  if (fieldPath.length === 0 || FORBIDDEN_STRING_FIELD_PATH.test(fieldPath)) {
    throw invalidFieldPath('Paths can\'t be empty and must not contain\n    "*~/[]".');
  }
  return fieldPath.split('.');
}

function isMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ─── Admin SDK update arguments ───────────────────────────────────────

const UPDATE_ARGUMENT_ERROR = 'Update() requires either a single JavaScript object or an '
  + 'alternating list of field/value pairs that can be followed by an optional precondition.';

/** `validateFieldPath` of the Admin SDK; `arg` is an element index or a key. */
function updateFieldSegments(arg: number | string, field: unknown): readonly string[] {
  const segments = fieldPathArgumentSegments(field);
  if (segments !== undefined) return segments;
  const name = typeof arg === 'string' ? `Value for argument "${arg}"` : `Element at index ${arg}`;
  const invalid = `${name} is not a valid field path.`;
  if (field === undefined) throw new Error(`${invalid} The path cannot be omitted.`);
  if (typeof field !== 'string') {
    throw new Error(`${invalid} Paths can only be specified as strings or via a FieldPath object.`);
  }
  if (field.includes('..')) throw new Error(`${invalid} Paths must not contain ".." in them.`);
  if (field.startsWith('.') || field.endsWith('.')) {
    throw new Error(`${invalid} Paths must not start or end with ".".`);
  }
  if (field.length === 0 || FORBIDDEN_STRING_FIELD_PATH.test(field)) {
    throw new Error(`${invalid} Paths can't be empty and must not contain\n    "*~/[]".`);
  }
  return field.split('.');
}

/**
 * Parse the arguments of an Admin SDK `DocumentReference.update`,
 * `WriteBatch.update` or `Transaction.update` call after the reference.
 * The object form takes the data map and an optional options object; the
 * field-and-value form takes alternating field paths and values, optionally
 * followed by one options object in the slot where the Admin SDK accepts a
 * precondition.
 */
export function parseAdminUpdateArguments<Options extends object>(
  dataOrField: unknown,
  rest: readonly unknown[],
): { fields: UpdateField[]; options: Options | undefined } {
  const fields: UpdateField[] = [];
  let options: Options | undefined;
  if (isFieldArgument(dataOrField)) {
    const fieldsAndValues = [dataOrField, ...rest];
    try {
      for (let i = 0; i < fieldsAndValues.length; i += 2) {
        const isTrailing = i === fieldsAndValues.length - 1;
        if (isTrailing) {
          const trailing = fieldsAndValues[i];
          if (typeof trailing !== 'object' || trailing === null) throw new Error('Input is not an object.');
          options = trailing as Options;
        } else {
          fields.push({ path: updateFieldSegments(i + 1, fieldsAndValues[i]), value: fieldsAndValues[i + 1] });
        }
      }
    } catch (error) {
      throw new Error(`${UPDATE_ARGUMENT_ERROR} ${(error as Error).message}`);
    }
  } else {
    try {
      const isMap = typeof dataOrField === 'object' && dataOrField !== null && !Array.isArray(dataOrField);
      if (!isMap) {
        throw new Error('Value for argument "dataOrField" is not a valid Firestore document. Input is not a plain JavaScript object.');
      }
      for (const [key, value] of Object.entries(dataOrField)) {
        fields.push({ path: updateFieldSegments(key, key), value });
      }
    } catch (error) {
      throw new Error(`${UPDATE_ARGUMENT_ERROR} ${(error as Error).message}`);
    }
    options = rest[0] as Options | undefined;
  }
  return { fields, options };
}

/** Firebase Admin DocumentSnapshot.get(fieldPath) over decoded document data. */
export function getSnapshotField(
  data: Record<string, unknown> | undefined,
  fieldPath: SnapshotFieldPath,
): unknown {
  const segments = fieldPathSegments(fieldPath);
  let current: unknown = data;
  for (const segment of segments) {
    if (!isMap(current)) return undefined;
    current = Object.prototype.hasOwnProperty.call(current, segment)
      ? current[segment]
      : undefined;
  }
  return current;
}
