import { pathSegments } from './sandbox/data-tree.js';

/**
 * `/.info` holds connection metadata the client reads; nothing writes it.
 * Production's SDK refuses a write there before it reaches the database,
 * and the database refuses one that arrives (capture
 * rtdb-modular-info-write-validation).
 */

/** Whether `path`'s first segment is `.info`. */
export function isInfoPath(path: string): boolean {
  return path.split('/').find((segment) => segment.length > 0) === '.info';
}

/**
 * Throw the SDK's error for a write API `fnName` called on a location under
 * `/.info`, such as `set failed = Can't modify data under /.info/`.
 */
export function validateWritablePath(fnName: string, path: string): void {
  if (isInfoPath(path)) throw new Error(`${fnName} failed = Can't modify data under /.info/`);
}

/** The database's rejection of a write under `/.info` that reached it. */
export function invalidInfoWrite(): Error {
  const error = new Error('INVALID_PARAMETERS: Invalid token in path') as Error & { code: string };
  error.code = 'INVALID_PARAMETERS';
  return error;
}

/** A key the SDK accepts in a path: non-empty, without `.`, `#`, `$`, `/`, `[`, `]` or a control character. */
const INVALID_KEY_CHARS = /[[\].#$/\u0000-\u001F\u007F]/;

/**
 * Validate `update()` keys as the SDK does before the write is sent: each
 * segment is a valid key, and no key is an ancestor of another.
 */
export function validateUpdatePaths(values: Record<string, unknown>): void {
  for (const key of Object.keys(values)) {
    const segments = pathSegments(key);
    segments.forEach((segment, index) => {
      const isTrailingPriority = segment === '.priority' && index === segments.length - 1;
      if (!isTrailingPriority && (segment.length === 0 || INVALID_KEY_CHARS.test(segment))) {
        throw new Error(
          `update failed: values argument contains an invalid key (${segment}) in path /${segments.join('/')}. ` +
          'Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"',
        );
      }
    });
  }
  const paths = Object.keys(values).map((path) => `/${pathSegments(path).join('/')}`);
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex++) {
      const left = paths[leftIndex]!;
      const right = paths[rightIndex]!;
      const [ancestor, descendant] = left.length <= right.length
        ? [left, right]
        : [right, left];
      if (ancestor === descendant || descendant.startsWith(`${ancestor}/`)) {
        throw new Error(
          `update failed: values argument contains a path ${ancestor} that is ancestor of another path ${descendant}`,
        );
      }
    }
  }
}
