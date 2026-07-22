/**
 * Firebase Admin-compatible field paths and DocumentSnapshot field lookup.
 *
 * Every local/remote snapshot producer delegates here so validation, dotted
 * string traversal, literal-dot FieldPath segments, and missing-value behavior
 * cannot drift between one-shot, query, transaction, and listener reads.
 */

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
  if (typeof fieldPath === 'object' && fieldPath !== null) {
    const internal = (fieldPath as { _internalPath?: { segments?: unknown } })._internalPath;
    if (Array.isArray(internal?.segments) && internal.segments.every((part) => typeof part === 'string')) {
      return [...internal.segments];
    }
  }
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
