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
