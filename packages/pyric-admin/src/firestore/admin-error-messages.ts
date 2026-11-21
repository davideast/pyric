/**
 * `@google-cloud/firestore` error message formatting for `pyric-admin/firestore`
 * write payload and argument validation (#1976, #1977).
 */

const UNQUOTED_FIELD_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function formatAdminFieldPathSegments(segments: readonly string[]): string {
  return segments
    .map((segment) => {
      if (UNQUOTED_FIELD_SEGMENT_RE.test(segment)) {
        return segment;
      }
      const escaped = segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
      return `\`${escaped}\``;
    })
    .join('.');
}

export function formatFieldPathSuffix(segments: readonly string[]): string {
  if (segments.length === 0) {
    return '';
  }
  return ` (found in field "${formatAdminFieldPathSegments(segments)}")`;
}

function formatArgumentLabel(arg: string | number): string {
  if (typeof arg === 'string') {
    return `Value for argument "${arg}"`;
  }
  return `Element at index ${arg}`;
}

function formatInvalidArgumentMessage(
  arg: string | number,
  expectedType: string,
): string {
  return `${formatArgumentLabel(arg)} is not a valid ${expectedType}.`;
}

export function formatValueValidationPrefix(
  arg: string | number,
  expectedType: string | undefined,
  leadingMessage: string | undefined,
): string {
  const parts: string[] = [];
  if (leadingMessage !== undefined && leadingMessage.length > 0) {
    parts.push(leadingMessage);
  }
  if (expectedType !== undefined && expectedType.length > 0) {
    parts.push(formatInvalidArgumentMessage(arg, expectedType));
  }
  if (parts.length === 0) {
    return '';
  }
  return `${parts.join(' ')} `;
}

export function formatSentinelMethodName(sentinelType: string): string {
  if (sentinelType === 'deleteField') {
    return 'FieldValue.delete';
  }
  return `FieldValue.${sentinelType}`;
}

export function formatCustomObjectErrorMessage(
  arg: string | number,
  expectedType: string | undefined,
  leadingMessage: string | undefined,
  value: unknown,
  segments: readonly string[],
): string {
  let effectiveExpected = 'Firestore document';
  if (expectedType !== undefined && expectedType.length > 0) {
    effectiveExpected = expectedType;
  }
  const basePrefix = formatValueValidationPrefix(arg, effectiveExpected, leadingMessage);
  const suffix = formatFieldPathSuffix(segments);
  const isObjTag = Object.prototype.toString.call(value) === '[object Object]';

  if (isObjTag && value !== null && typeof value === 'object') {
    let typeName = 'Object';
    const ctor = (value as { constructor?: { name?: unknown } }).constructor;
    if (ctor !== undefined && typeof ctor.name === 'string' && ctor.name.length > 0) {
      typeName = ctor.name;
    }
    if (
      typeName === 'DocumentReference' ||
      typeName === 'FieldPath' ||
      typeName === 'FieldValue' ||
      typeName === 'GeoPoint' ||
      typeName === 'Timestamp'
    ) {
      return (
        `${basePrefix}Detected an object of type "${typeName}" that doesn't match the ` +
        `expected instance${suffix}. Please ensure that the ` +
        'Firestore types you are using are from the same NPM package.)'
      );
    }
    if (typeName === 'Object') {
      return `${basePrefix}Invalid use of type "${typeof value}" as a Firestore argument${suffix}.`;
    }
    return (
      `${basePrefix}Couldn't serialize object of type "${typeName}"${suffix}. ` +
      "Firestore doesn't support JavaScript objects with custom prototypes " +
      '(i.e. objects that were created via the "new" operator).'
    );
  }

  return `${basePrefix}Input is not a plain JavaScript object${suffix}.`;
}
