import { DOC_VALUE_ENCODING } from '../../firestore/internal/value-codec.js';
import { encodeStateDocument } from '../internal/state-values.js';
import { checksumDocs, pathToBucketId, type BucketRecord } from './chunk-format.js';

type Document = Record<string, unknown>;

/** Keeps path membership, not a second encoded copy of the document store. */
export class ChangedBuckets {
  private readonly paths = new Map<string, Set<string>>();
  private dirty: Set<string>;
  private needsSnapshot = true;

  constructor(
    private readonly snapshot: () => Record<string, Document>,
    private readonly read: (path: string) => Document | null,
    persistedIds: Iterable<string>,
  ) {
    this.dirty = new Set(persistedIds);
  }

  mark(path: string | null): void {
    const replacesState = path === null;
    if (replacesState) { this.needsSnapshot = true; return; }
    const id = pathToBucketId(path);
    const members = this.paths.get(id) ?? new Set<string>();
    members.add(path);
    this.paths.set(id, members);
    this.dirty.add(id);
  }

  prepare() {
    if (this.needsSnapshot) {
      const documents = this.snapshot();
      for (const id of this.paths.keys()) this.dirty.add(id);
      this.paths.clear();
      for (const path of Object.keys(documents)) this.mark(path);
      this.needsSnapshot = false;
    }
    const captured = this.dirty;
    this.dirty = new Set();
    const retry = (): void => { for (const id of captured) this.dirty.add(id); };
    const records = new Map<string, BucketRecord>();
    const removed: string[] = [];
    try {
      for (const id of captured) {
        const docs: Record<string, Document> = {};
        const members = this.paths.get(id) ?? new Set<string>();
        for (const path of members) {
          const document = this.read(path);
          const deleted = document === null;
          if (deleted) members.delete(path);
          else docs[path] = encodeStateDocument(document);
        }
        const empty = members.size === 0;
        if (empty) { this.paths.delete(id); removed.push(id); }
        else records.set(id, { docs, encoding: DOC_VALUE_ENCODING, checksum: checksumDocs(docs) });
      }
      return { records, removed, retry };
    } catch (error) { retry(); throw error; }
  }
}
