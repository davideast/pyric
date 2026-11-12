import { pathSegments } from './paths.js';

/** True for invalid Firebase keys. Mirrors `INVALID_KEY_REGEX_`
 *  (`validation.ts:45`): `.`, `#`, `$`, `/`, `[`, `]`, control chars. */
const INVALID_KEY_REGEX = /[\[\].#$/\u0000-\u001F\u007F]/;

/** A valid Firebase key — non-empty string, no forbidden chars. Mirrors
 *  `isValidKey` (`validation.ts:58`). The `.priority` / `.value` / `.sv`
 *  metadata keys are handled by the caller before this check. */
function isValidKey(key: string): boolean {
  return key.length !== 0 && !INVALID_KEY_REGEX.test(key);
}

/** True for a number RTDB rejects (NaN / ±Infinity). Mirrors
 *  `isInvalidJSONNumber` (`util.ts`). */
export function isInvalidJSONNumber(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    (Number.isNaN(value) || value === Infinity || value === -Infinity)
  );
}

/** Where in a write a validation error points, as the SDK prints it: the
 *  path's segments joined with `.`, or nothing at the root
 *  (`validationPathToErrorString`). */
function propertyText(segments: readonly string[]): string {
  return segments.length === 0 ? '' : `in property '${segments.join('.')}'`;
}

/** The start of the SDK's error for a refused argument, such as
 *  `push failed: value argument ` (`util.errorPrefix`). */
export function errorPrefix(fnName: string, argName: string): string {
  return `${fnName} failed: ${argName} argument `;
}

/**
 * Validate a value against RTDB's write rules, throwing the SDK's error (a
 * plain `Error` with the same text) on the first violation. Mirrors
 * `validateFirebaseData` (`@firebase/database` 1.1.3): `undefined`, a
 * function, `NaN` or an infinity anywhere, an invalid key, or a `.value`
 * key beside real children. An array hole is skipped, as the SDK's `each`
 * skips it; an element that is explicitly `undefined` is not. `path` is the
 * path the SDK names in the error (for `push`, the parent's), and `prefix`
 * names the call, as {@link errorPrefix} builds it.
 */
export function validateWrite(value: unknown, path: string, prefix = errorPrefix('set', 'value')): void {
  validateData(value, pathSegments(path), prefix);
}

export function validateData(value: unknown, segments: readonly string[], prefix: string): void {
  const where = propertyText(segments);
  if (value === undefined) {
    throw new Error(`${prefix}contains undefined ${where}`);
  }
  if (typeof value === 'function') {
    throw new Error(`${prefix}contains a function ${where} with contents = ${String(value)}`);
  }
  if (isInvalidJSONNumber(value)) {
    throw new Error(`${prefix}contains ${String(value)} ${where}`);
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  let hasDotValue = false;
  let hasActualChild = false;
  // Own enumerable keys, as the SDK's `each` walks them: an array hole is
  // not a key, so it is skipped.
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '.value') {
      hasDotValue = true;
    } else if (key !== '.priority' && key !== '.sv') {
      hasActualChild = true;
      if (!isValidKey(key)) {
        throw new Error(
          `${prefix} contains an invalid key (${key}) ${where}.  Keys must be non-empty strings ` +
            'and can\'t contain ".", "#", "$", "/", "[", or "]"',
        );
      }
    }
    validateData(child, [...segments, key], prefix);
  }
  if (hasDotValue && hasActualChild) {
    throw new Error(`${prefix} contains ".value" child ${where} in addition to actual children.`);
  }
}
