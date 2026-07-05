/**
 * OverlayBacking: copy-on-write storage over an immutable base, the engine
 * behind CoW branches. Reads fall through to `base` unless shadowed by the
 * overlay or hidden by a tombstone; writes land in the overlay; deletes
 * tombstone a base path (or just drop an overlay-only doc). A fork is O(1) (an
 * empty overlay over the shared base) instead of O(keyspace) (structuredClone).
 *
 * Isolation: the base (a `snapshot()` result) is only SHALLOW-cloned by
 * snapshot(), so its nested objects are still shared with the live source and
 * any sibling branch. Handing a base doc out by reference would let a caller
 * mutate it in place and corrupt those. So base docs are deep-cloned on first
 * read (memoized in `baseCache`, so repeated reads/scans don't re-clone), which
 * restores the old clone-fork's full decoupling while keeping fork() O(1) and
 * cloning only the docs a branch actually touches. The cache is NOT the overlay:
 * a cached base read is not a write, so `diff` stays overlay-only.
 *
 * Iteration preserves base order: an updated base doc is emitted in its original
 * position (overlay value), overlay-only docs are appended, and a base doc that
 * was deleted then re-created stays in its original base position (which tracks
 * prod's __name__ key order more closely than a Map clone's move-to-end would).
 */
import type { DocBacking, DocumentData } from './local-state.js';

export class OverlayBacking implements DocBacking {
  private readonly overlay = new Map<string, DocumentData>();
  private readonly tombstones = new Set<string>();
  /** Deep-clone-on-first-read of base docs (see class doc). */
  private readonly baseCache = new Map<string, DocumentData>();
  /** Set by clear(): the base is logically dropped, only the overlay counts. */
  private cleared = false;

  constructor(private readonly base: Record<string, DocumentData>) {}

  private inBase(path: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.base, path);
  }

  /** A decoupled view of a base doc: deep clone, memoized. */
  private baseDoc(path: string): DocumentData {
    let cached = this.baseCache.get(path);
    if (cached === undefined) {
      cached = structuredClone(this.base[path]!);
      this.baseCache.set(path, cached);
    }
    return cached;
  }

  get(path: string): DocumentData | undefined {
    if (this.overlay.has(path)) return this.overlay.get(path);
    if (this.cleared || this.tombstones.has(path)) return undefined;
    return this.inBase(path) ? this.baseDoc(path) : undefined;
  }

  set(path: string, data: DocumentData): void {
    this.overlay.set(path, data);
    this.tombstones.delete(path);
  }

  has(path: string): boolean {
    if (this.overlay.has(path)) return true;
    if (this.cleared || this.tombstones.has(path)) return false;
    return this.inBase(path);
  }

  delete(path: string): boolean {
    const existed = this.has(path);
    this.overlay.delete(path);
    if (!this.cleared && this.inBase(path)) this.tombstones.add(path);
    return existed;
  }

  clear(): void {
    this.overlay.clear();
    this.tombstones.clear();
    this.baseCache.clear();
    this.cleared = true;
  }

  get size(): number {
    let n = 0;
    for (const _ of this) void _, n++;
    return n;
  }

  *keys(): IterableIterator<string> {
    for (const [path] of this) yield path;
  }

  *[Symbol.iterator](): IterableIterator<[string, DocumentData]> {
    const emitted = new Set<string>();
    if (!this.cleared) {
      for (const path of Object.keys(this.base)) {
        if (this.tombstones.has(path)) continue;
        emitted.add(path);
        yield [path, this.overlay.has(path) ? this.overlay.get(path)! : this.baseDoc(path)];
      }
    }
    for (const [path, data] of this.overlay) {
      if (emitted.has(path)) continue;
      yield [path, data];
    }
  }
}
