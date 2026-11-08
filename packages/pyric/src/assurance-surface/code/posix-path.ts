/**
 * Browser-clean POSIX path operations for the static SDK usage analyzer.
 * Contains zero `node:*` imports and zero `process` references so the core
 * analyzer bundles cleanly into browser environments.
 */

export function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/');
}

export function posixNormalize(input: string): string {
  const slashPath = toPosixPath(input);
  if (slashPath.length === 0) return '.';
  const isAbsolute = slashPath.startsWith('/');
  const stack: string[] = [];
  for (const part of slashPath.split('/')) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push('..');
      }
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join('/');
  if (isAbsolute) return `/${joined}`;
  return joined.length > 0 ? joined : '.';
}

export function posixJoin(...segments: string[]): string {
  const nonEmpty = segments.map(toPosixPath).filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return '.';
  return posixNormalize(nonEmpty.join('/'));
}

export function posixResolve(...segments: string[]): string {
  let resolved = '';
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = toPosixPath(segments[i]!);
    if (seg.length === 0) continue;
    resolved = resolved.length > 0 ? `${seg}/${resolved}` : seg;
    if (seg.startsWith('/')) break;
  }
  if (!resolved.startsWith('/')) {
    resolved = `/${resolved}`;
  }
  return posixNormalize(resolved);
}

export function posixDirname(input: string): string {
  const norm = posixNormalize(input);
  if (norm === '/') return '/';
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return norm.slice(0, idx);
}

function splitAbsoluteParts(absPath: string): string[] {
  if (absPath === '/') return [];
  return absPath.slice(1).split('/');
}

export function posixRelative(from: string, to: string): string {
  const absFrom = posixResolve(from);
  const absTo = posixResolve(to);
  if (absFrom === absTo) return '';
  const fromParts = splitAbsoluteParts(absFrom);
  const toParts = splitAbsoluteParts(absTo);
  let shared = 0;
  const minLen = Math.min(fromParts.length, toParts.length);
  while (shared < minLen && fromParts[shared] === toParts[shared]) {
    shared += 1;
  }
  const upCount = fromParts.length - shared;
  const out: string[] = [];
  for (let i = 0; i < upCount; i += 1) out.push('..');
  for (let i = shared; i < toParts.length; i += 1) out.push(toParts[i]!);
  return out.join('/');
}
