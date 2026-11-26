/**
 * Studio storage port shapes -- server-side MIRROR of `@pyric/studio/ports`.
 *
 * `@pyric/studio` is a CONSUMER of @pyric/cli serve routes, not a dependency
 * of it; adding a `@pyric/studio` dep here would invert the layering (and risk
 * a cycle). So the disk impls in this directory type-check against these local
 * copies, which are structurally identical to the port interfaces. Keep them in
 * lockstep with `packages/studio/src/ports.ts` -- that file is the contract.
 */

export interface WorkspaceEntry {
  /** Project-relative POSIX path. */
  path: string;
  kind: 'file' | 'dir';
}

export interface WorkspaceChange {
  path: string;
  type: 'create' | 'update' | 'delete';
}

/**
 * A Storage object carried on a branch summary strictly by SHA-256 byte
 * reference (ADR 0018), never inline base64 bytes.
 */
export interface WorkspaceBranchStorageReference {
  /** Non-default bucket holding the object; omitted for the default bucket. */
  bucket?: string;
  /** Full path within the bucket. */
  path: string;
  /** Lowercase 64-character hex SHA-256 digest of the object's bytes. */
  sha256: string;
  /** Byte length of the object. */
  size: number;
  /** Content type reported by object metadata, when set. */
  contentType?: string;
  /** User-defined custom metadata key/value pairs. */
  customMetadata: Record<string, string>;
  /** Stored Blob MIME type when present. */
  blobType?: string;
}

/**
 * One branch the project holds on disk, as the branch store reports it.
 *
 * The branch store's on-disk format, the manifest and the record bundle and
 * the event log, is read by the store alone, on the server side of this port. What
 * crosses the port is the branch already rebuilt: what the manifest recorded,
 * the Firestore documents the branch holds after its events were applied, and
 * any Storage objects represented as SHA-256 byte references.
 */
export interface WorkspaceBranch {
  name: string;
  /** When the branch was forked, as an ISO 8601 instant. */
  created: string;
  /** `live`, or the name of the checkpoint the fork was taken from. */
  base: string;
  eventCount: number;
  /** The branch's Firestore documents, by document path. */
  documents: Record<string, Record<string, unknown>>;
  /** The branch's Storage objects by SHA-256 reference; omitted when empty. */
  storage?: WorkspaceBranchStorageReference[];
}

export interface WorkspaceStore {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(dir?: string): Promise<WorkspaceEntry[]>;
  remove(path: string): Promise<void>;
  branches(): Promise<WorkspaceBranch[]>;
  watch(cb: (change: WorkspaceChange) => void): () => void;
}

export interface ProjectMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectHandle {
  meta: ProjectMeta;
  workspace: WorkspaceStore;
}

export interface ProjectStore {
  list(): Promise<ProjectMeta[]>;
  open(id: string): Promise<ProjectHandle>;
  create(input: { title?: string }): Promise<ProjectMeta>;
  update(id: string, patch: Partial<Omit<ProjectMeta, 'id'>>): Promise<void>;
  remove(id: string): Promise<void>;
}
