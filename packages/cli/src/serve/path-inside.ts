/**
 * Whether a path lies inside a directory, by its path text: the directory
 * itself counts, and so does any path below it, but never a parent, a sibling
 * or another drive. Callers resolve real paths first when links matter.
 */
import { isAbsolute, relative, sep } from 'node:path';

export function isPathInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  const namesParent = fromRoot === '..' || fromRoot.startsWith(`..${sep}`);
  return !namesParent && !isAbsolute(fromRoot);
}
