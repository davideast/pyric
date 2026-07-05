/**
 * Studio storage port shapes — server-side MIRROR of `@pyric/studio/ports`.
 *
 * `@pyric/studio` is a CONSUMER of pyric-tools' serve routes, not a dependency
 * of it; adding a `@pyric/studio` dep here would invert the layering (and risk
 * a cycle). So the disk impls in this directory type-check against these local
 * copies, which are structurally identical to the port interfaces. Keep them in
 * lockstep with `packages/studio/src/ports.ts` — that file is the contract.
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

export interface WorkspaceStore {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(dir?: string): Promise<WorkspaceEntry[]>;
  remove(path: string): Promise<void>;
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
