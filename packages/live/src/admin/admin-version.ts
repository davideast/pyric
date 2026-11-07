/**
 * The version of the firebase-admin that loaded an Admin row, for a refusal
 * that names it. firebase-admin's exports don't include its package.json, so
 * this walks up from the file that required the row to the package.json
 * named `firebase-admin`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The `name` and `version` of the package.json in `dir`, or undefined when there is none. */
function packageIn(dir: string): { name?: unknown; version?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  } catch {
    return undefined;
  }
}

/** The version of the firebase-admin package that holds `requiredBy`, or undefined when it is not in one. */
export function firebaseAdminVersion(requiredBy: string | undefined): string | undefined {
  if (requiredBy === undefined) return undefined;
  let dir = dirname(requiredBy);
  while (dirname(dir) !== dir) {
    const found = packageIn(dir);
    const isAdmin = found?.name === 'firebase-admin' && typeof found.version === 'string';
    if (isAdmin) return found.version as string;
    dir = dirname(dir);
  }
  return undefined;
}
