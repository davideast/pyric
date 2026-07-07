/**
 * Minimal browser shim for Node's `path`. `@pyric/firestore-rules`'s
 * resolver runs `dirname(fileURLToPath(import.meta.url))` at module
 * load to locate its bundled stdlib. The showcase never invokes the
 * resolver's rules-parsing path at runtime, so we return harmless
 * empty strings here — the values just need to not throw during
 * top-level evaluation.
 */
export function join(...segments: string[]): string {
  return segments.join('/');
}
export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
export function resolve(...segments: string[]): string {
  return segments.filter(Boolean).join('/');
}
export function basename(p: string, ext?: string): string {
  const i = p.lastIndexOf('/');
  const base = i < 0 ? p : p.slice(i + 1);
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}
export function extname(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i);
}
/**
 * Naive relative — strips a `from` prefix from `to` and trims the
 * separator. `walk.ts` (the only consumer in the browser bundle)
 * calls it with two absolute paths inside the same root, so the
 * strip is enough. We never actually walk a directory in the browser
 * (see fs shim) so this only needs to satisfy module load.
 */
export function relative(from: string, to: string): string {
  if (to.startsWith(from)) {
    const tail = to.slice(from.length);
    return tail.startsWith('/') ? tail.slice(1) : tail;
  }
  return to;
}
export const sep = '/';
export const posix = { join, dirname, resolve, basename, extname, relative, sep };
// `@astrojs/node` imports `path` as a default. Provide one that
// aggregates the named exports so the shim works under both
// `import path from 'node:path'` and `import { join } from 'node:path'`.
const path = { join, dirname, resolve, basename, extname, relative, sep, posix };
export default path;
